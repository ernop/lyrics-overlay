#!/usr/bin/env python3
"""Acquires audio for a YouTube video and produces word-timed Whisper JSON on stdout.

Never writes lyric text to stderr (logs only stage markers and concise errors).
Always deletes any downloaded temporary audio file before exiting.
Optional --gpu-gate-json wraps ONLY the Whisper transcription step so audio
downloading never holds GPU memory.
"""

from __future__ import annotations

import argparse
import ctypes
import json
import math
import os
import shutil
import signal
import subprocess
import sys
import sysconfig
import tempfile
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

_ACTIVE_CHILD: subprocess.Popen | None = None


def _emit_stage(stage: str) -> None:
    print(f"stage:{stage}", file=sys.stderr, flush=True)


_SYSTEM_BIN_DIRS = frozenset(
    ("/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin")
)
_AUTO_PRIMARY_AUDIO_FORMAT = "bestaudio[filesize<100M]/bestaudio"
_AUTO_FALLBACK_AUDIO_FORMAT = "bestaudio[protocol^=m3u8]/best[filesize<100M]/best"
_LARGE_PRIMARY_AUDIO_FORMAT = "bestaudio[abr<=96]/bestaudio"
_LARGE_FALLBACK_AUDIO_FORMAT = "bestaudio[protocol^=m3u8]/best"
_SLICE_THRESHOLD_SECONDS = 900.0
_SLICE_SECONDS = 600.0
_PROGRESS_MIN_DURATION = 120.0


def _augmented_env() -> dict[str, str]:
    """Places ~/.local/bin ahead of system bin dirs so standalone yt-dlp/deno/gpu beat distro copies."""
    env = os.environ.copy()
    local_bin = str(Path.home() / ".local" / "bin")
    parts = [p for p in env.get("PATH", "").split(os.pathsep) if p and p != local_bin]
    insert_at = next((i for i, p in enumerate(parts) if p in _SYSTEM_BIN_DIRS), len(parts))
    parts.insert(insert_at, local_bin)
    env["PATH"] = os.pathsep.join(parts)
    return env


def _install_signal_handlers() -> None:
    def _handle(signum: int, _frame) -> None:
        child = _ACTIVE_CHILD
        if child is not None and child.poll() is None:
            try:
                child.terminate()
                child.wait(timeout=3)
            except Exception:
                try:
                    child.kill()
                except Exception:
                    pass
        raise SystemExit(128 + signum)

    for sig in (signal.SIGTERM, signal.SIGINT):
        signal.signal(sig, _handle)


def _run_cancellable(cmd: list[str], *, env: dict[str, str], capture_stdout: bool = False) -> tuple[int, str, str]:
    global _ACTIVE_CHILD
    proc = subprocess.Popen(
        cmd,
        env=env,
        stdout=subprocess.PIPE if capture_stdout else subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    _ACTIVE_CHILD = proc
    try:
        stdout, stderr = proc.communicate()
        return proc.returncode, stdout or "", stderr or ""
    finally:
        _ACTIVE_CHILD = None


def _fetch_ytarchive_audio(base_url: str, video_id: str, target: Path) -> bool:
    url = f"{base_url.rstrip('/')}/media/{video_id}/_condensed/soundtrack.mp3"
    req = urllib.request.Request(url, method="GET")
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            if resp.status != 200:
                return False
            written = 0
            with target.open("wb") as fh:
                while True:
                    chunk = resp.read(65536)
                    if not chunk:
                        break
                    fh.write(chunk)
                    written += len(chunk)
            if written < 4096:
                target.unlink(missing_ok=True)
                return False
            return True
    except (urllib.error.URLError, TimeoutError, OSError):
        target.unlink(missing_ok=True)
        return False


def _is_http_403(stderr: str) -> bool:
    lower = stderr.lower()
    return "http error 403" in lower or "403: forbidden" in lower


def _last_error_line(stderr: str, code: int) -> str:
    return next((line.strip() for line in reversed(stderr.splitlines()) if line.strip()), f"exit {code}")


def _clear_partial_downloads(tmpdir: Path) -> None:
    for p in tmpdir.glob("audio.*"):
        try:
            p.unlink()
        except OSError:
            pass


def _download_youtube_audio(
    video_id: str,
    tmpdir: Path,
    env: dict[str, str],
    *,
    cookies_from_browser: str = "",
    allow_large: bool = False,
) -> Path:
    yt_dlp = shutil.which("yt-dlp", path=env["PATH"])
    if not yt_dlp:
        raise RuntimeError("yt-dlp is not installed")
    template = str(tmpdir / "audio.%(ext)s")
    base_cmd = [
        yt_dlp,
        "--no-playlist",
        "--ignore-config",
        "--no-warnings",
        "--no-progress",
    ]
    if not allow_large:
        base_cmd.extend(["--max-filesize", "100m"])
    if cookies_from_browser:
        base_cmd.extend(["--cookies-from-browser", cookies_from_browser])

    primary_fmt = _LARGE_PRIMARY_AUDIO_FORMAT if allow_large else _AUTO_PRIMARY_AUDIO_FORMAT
    fallback_fmt = _LARGE_FALLBACK_AUDIO_FORMAT if allow_large else _AUTO_FALLBACK_AUDIO_FORMAT

    def _try_format(fmt: str) -> tuple[Path | None, int, str]:
        _clear_partial_downloads(tmpdir)
        cmd = [*base_cmd, "-f", fmt, "-o", template, f"https://www.youtube.com/watch?v={video_id}"]
        code, _stdout, stderr = _run_cancellable(cmd, env=env)
        if code != 0:
            return None, code, stderr
        files = sorted(p for p in tmpdir.glob("audio.*") if p.is_file() and not p.name.endswith(".part"))
        if not files:
            raise RuntimeError("yt-dlp produced no audio file")
        return files[0], 0, stderr

    downloaded, code, stderr = _try_format(primary_fmt)
    if downloaded is not None:
        return downloaded

    if _is_http_403(stderr):
        # YouTube intermittently returns HTTP 403 on anonymous DASH audio streams;
        # retry once via YouTube's separate HLS audio / progressive stream path.
        downloaded, code, stderr = _try_format(fallback_fmt)
        if downloaded is not None:
            return downloaded
        detail = _last_error_line(stderr, code)
        if _is_http_403(stderr) and not cookies_from_browser:
            raise RuntimeError(
                f"audio download failed (HTTP 403; update yt-dlp or set lyricsGenerator.cookiesFromBrowser): {detail[:160]}"
            )
        raise RuntimeError(f"audio download failed: {detail[:200]}")

    detail = _last_error_line(stderr, code)
    raise RuntimeError(f"audio download failed: {detail[:200]}")


def _probe_duration(audio_path: Path, env: dict[str, str]) -> float:
    ffprobe = shutil.which("ffprobe", path=env["PATH"])
    if not ffprobe:
        return 0.0
    code, stdout, _stderr = _run_cancellable(
        [
            ffprobe,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(audio_path),
        ],
        env=env,
        capture_stdout=True,
    )
    if code != 0:
        return 0.0
    try:
        return float(stdout.strip())
    except ValueError:
        return 0.0


def _activate_cuda_libraries() -> tuple[bool, str]:
    """Loads pip-installed NVIDIA cuBLAS/cuDNN libraries without requiring LD_LIBRARY_PATH."""
    root = Path(sysconfig.get_paths()["purelib"]) / "nvidia"
    libraries = (
        ("libcublasLt.so.12", root / "cublas" / "lib" / "libcublasLt.so.12"),
        ("libcublas.so.12", root / "cublas" / "lib" / "libcublas.so.12"),
        ("libcudnn.so.9", root / "cudnn" / "lib" / "libcudnn.so.9"),
    )
    try:
        for soname, packaged in libraries:
            try:
                ctypes.CDLL(soname, mode=ctypes.RTLD_GLOBAL)
            except OSError:
                ctypes.CDLL(str(packaged), mode=ctypes.RTLD_GLOBAL)
    except OSError as exc:
        return False, str(exc)
    return True, ""


def _load_whisper(WhisperModel, model_name: str, **kwargs):
    """Uses locally cached weights without hitting Hugging Face when already cached."""
    from huggingface_hub.errors import LocalEntryNotFoundError

    try:
        return WhisperModel(model_name, local_files_only=True, **kwargs)
    except LocalEntryNotFoundError:
        return WhisperModel(model_name, **kwargs)


def _decode_audio_16k(
    audio_path: Path,
    env: dict[str, str],
    *,
    start_sec: float = 0.0,
    duration_sec: float | None = None,
):
    """Decodes any container (WebM/Opus, M4A, MP3, etc.) to 16 kHz mono float32 via ffmpeg."""
    import numpy as np

    ffmpeg = shutil.which("ffmpeg", path=env["PATH"])
    if not ffmpeg:
        raise RuntimeError("ffmpeg is not installed")
    cmd = [ffmpeg, "-nostdin", "-v", "error"]
    if start_sec > 0:
        cmd.extend(["-ss", f"{start_sec:.3f}"])
    cmd.extend(["-i", str(audio_path)])
    if duration_sec is not None:
        cmd.extend(["-t", f"{duration_sec:.3f}"])
    cmd.extend(
        [
            "-f",
            "f32le",
            "-acodec",
            "pcm_f32le",
            "-ac",
            "1",
            "-ar",
            "16000",
            "pipe:1",
        ]
    )
    proc = subprocess.Popen(
        cmd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )
    global _ACTIVE_CHILD
    _ACTIVE_CHILD = proc
    try:
        raw, err = proc.communicate()
    finally:
        _ACTIVE_CHILD = None
    if proc.returncode != 0:
        detail = err.decode("utf-8", errors="replace").strip()[:200]
        raise RuntimeError(f"audio decode failed: {detail or f'exit {proc.returncode}'}")
    samples = np.frombuffer(raw, dtype=np.float32)
    if samples.size == 0 and start_sec <= 0:
        raise RuntimeError("audio file has no samples")
    return samples


def _should_yield(yield_check_cmd: list[str] | None, env: dict[str, str]) -> bool:
    if not yield_check_cmd:
        return False
    try:
        proc = subprocess.run(
            yield_check_cmd,
            env=env,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=5,
        )
        return proc.returncode == 0
    except (OSError, subprocess.SubprocessError):
        return False


def _emit_progress(done_sec: float, total_duration: float) -> None:
    if total_duration < _PROGRESS_MIN_DURATION:
        return
    done = int(min(total_duration, max(0.0, done_sec)))
    total = int(round(total_duration))
    if total > 0:
        _emit_stage(f"transcribe:{done}/{total}")


def _collect_segments(
    raw_segments,
    *,
    offset: float,
    total_duration: float,
    last_progress: float,
) -> tuple[list[dict], float]:
    segments: list[dict] = []
    step = max(5.0, total_duration / 100.0) if total_duration > 0 else 5.0
    for seg in raw_segments:
        words = []
        for w in seg.words or []:
            words.append(
                {
                    "start": round(offset + float(w.start or 0), 3),
                    "end": round(offset + float(w.end or 0), 3),
                    "word": str(w.word or ""),
                    "probability": round(float(w.probability or 0), 4),
                }
            )
        end_sec = offset + float(seg.end or 0)
        segments.append(
            {
                "start": round(offset + float(seg.start or 0), 3),
                "end": round(end_sec, 3),
                "text": str(seg.text or ""),
                "no_speech_prob": round(float(getattr(seg, "no_speech_prob", 0) or 0), 4),
                "words": words,
            }
        )
        if total_duration >= _PROGRESS_MIN_DURATION and end_sec - last_progress >= step:
            last_progress = end_sec
            _emit_progress(end_sec, total_duration)
    return segments, last_progress


def _transcribe_audio(
    audio_path: Path,
    *,
    model_name: str,
    device: str,
    compute_type: str,
    prompt: str,
    env: dict[str, str],
    total_duration: float = 0.0,
    start_offset: float = 0.0,
    yield_check_cmd: list[str] | None = None,
    slice_seconds: float = _SLICE_SECONDS,
) -> dict:
    import ctranslate2
    from faster_whisper import WhisperModel

    effective_total = total_duration if total_duration > 0 else _probe_duration(audio_path, env)
    slice_threshold = _SLICE_THRESHOLD_SECONDS if slice_seconds >= _SLICE_SECONDS else slice_seconds
    use_slices = start_offset > 0 or effective_total > slice_threshold

    chosen_device = device
    chosen_compute = compute_type
    if chosen_device in ("auto", "cuda"):
        cuda_ok, _cuda_err = _activate_cuda_libraries()
        has_cuda = cuda_ok and ctranslate2.get_cuda_device_count() > 0
        if has_cuda:
            chosen_device = "cuda"
            if chosen_compute == "auto":
                chosen_compute = "float16"
        else:
            chosen_device = "cpu"
            if chosen_compute in ("auto", "float16"):
                chosen_compute = "int8"
    else:
        chosen_device = "cpu"
        if chosen_compute in ("auto", "float16"):
            chosen_compute = "int8"

    threads = max(1, min(8, (os.cpu_count() or 2) // 2))
    if start_offset > 0 and effective_total >= _PROGRESS_MIN_DURATION:
        _emit_progress(start_offset, effective_total)
    else:
        _emit_stage("transcribe")
    model = _load_whisper(
        WhisperModel,
        model_name,
        device=chosen_device,
        compute_type=chosen_compute,
        cpu_threads=threads,
    )

    kwargs: dict = {
        "beam_size": 5,
        "vad_filter": False,
        "word_timestamps": True,
        "condition_on_previous_text": False,
    }
    if prompt:
        kwargs["initial_prompt"] = prompt[:700]

    if not use_slices:
        samples = _decode_audio_16k(audio_path, env)
        raw_segments, info = model.transcribe(samples, **kwargs)
        duration = round(float(getattr(info, "duration", 0) or effective_total or 0), 3)
        language = str(getattr(info, "language", "") or "")
        segments, _last = _collect_segments(
            raw_segments,
            offset=0.0,
            total_duration=duration,
            last_progress=0.0,
        )
        del raw_segments, samples, model
        return {
            "ok": True,
            "language": language,
            "duration": duration,
            "device": chosen_device,
            "segments": segments,
        }

    offset = max(0.0, float(start_offset))
    last_progress = offset
    all_segments: list[dict] = []
    language = ""
    yielded = False
    next_offset = offset

    while True:
        if effective_total > 0 and offset >= effective_total - 0.1:
            break
        samples = _decode_audio_16k(audio_path, env, start_sec=offset, duration_sec=slice_seconds)
        if samples.size == 0:
            break
        actual_slice_dur = samples.size / 16000.0
        raw_segments, info = model.transcribe(samples, **kwargs)
        if not language:
            language = str(getattr(info, "language", "") or "")
        chunk_segments, last_progress = _collect_segments(
            raw_segments,
            offset=offset,
            total_duration=effective_total,
            last_progress=last_progress,
        )
        all_segments.extend(chunk_segments)
        del raw_segments, samples

        reached_eof = actual_slice_dur < slice_seconds - 0.5
        offset = offset + (actual_slice_dur if reached_eof else slice_seconds)
        next_offset = offset
        if effective_total >= _PROGRESS_MIN_DURATION and next_offset - last_progress >= 1.0:
            last_progress = next_offset
            _emit_progress(next_offset, effective_total)
        if reached_eof or (effective_total > 0 and next_offset >= effective_total - 0.1):
            break
        if _should_yield(yield_check_cmd, env):
            yielded = True
            break

    del model
    return {
        "ok": True,
        "yielded": yielded,
        "nextOffset": round(next_offset, 3),
        "language": language,
        "duration": round(max(effective_total, offset), 3),
        "device": chosen_device,
        "segments": all_segments,
    }


def _run_with_gpu_gate(
    gate: dict,
    audio_path: Path,
    duration: float,
    args: argparse.Namespace,
    env: dict[str, str],
) -> dict:
    gate_bin = shutil.which(str(gate.get("command", "gpu")), path=env["PATH"])
    if not gate_bin:
        raise RuntimeError(f"GPU gate command not found: {gate.get('command', 'gpu')}")

    slice_threshold = _SLICE_THRESHOLD_SECONDS if args.slice_seconds >= _SLICE_SECONDS else args.slice_seconds
    is_long = duration > slice_threshold
    configured_lane = str(gate.get("lane", "now"))
    lane = str(gate.get("longLane", "new")) if (is_long and configured_lane == "now") else configured_lane
    who = str(gate.get("name", "Lyrics overlay"))
    yield_check_cmd = [gate_bin, "should-yield", "--lane", lane, "--name", who] if (is_long and lane != "now") else []
    base_minutes = int(gate.get("minutes", 5))

    start_offset = 0.0
    all_segments: list[dict] = []
    language = ""
    device = ""
    final_duration = duration

    while True:
        _emit_stage("gpu-wait")
        remaining = max(0.0, duration - start_offset)
        est_minutes = (
            max(base_minutes, math.ceil((remaining / 60.0) / 6.0) + 2)
            if remaining > 0
            else base_minutes
        )
        child_cmd = [
            gate_bin,
            "run",
            "--name",
            who,
            "--what",
            str(gate.get("what", f"Whisper {args.model}")),
            "--gb",
            str(gate.get("gb", 7)),
            "--lane",
            lane,
            "--minutes",
            str(est_minutes),
        ]
        # Short automatic runs fail fast if the GPU is busy; manual forced runs
        # and runs resuming after politely yielding wait in line until ready.
        if args.max_duration > 0 and start_offset <= 0 and gate.get("waitMinutes") is not None:
            child_cmd.extend(["--wait", str(gate["waitMinutes"])])
        child_cmd.extend(
            [
                "--",
                sys.executable,
                str(Path(__file__).resolve()),
                "--transcribe-audio",
                str(audio_path),
                "--model",
                args.model,
                "--device",
                args.device,
                "--compute-type",
                args.compute_type,
                "--slice-seconds",
                str(args.slice_seconds),
            ]
        )
        if duration > 0:
            child_cmd.extend(["--total-duration", f"{duration:.3f}"])
        if start_offset > 0:
            child_cmd.extend(["--start-offset", f"{start_offset:.3f}"])
        if yield_check_cmd:
            child_cmd.extend(["--yield-check-json", json.dumps(yield_check_cmd)])
        if args.prompt_file:
            child_cmd.extend(["--prompt-file", args.prompt_file])

        # Stream stderr lines from child so stage:transcribe reaches the service immediately.
        global _ACTIVE_CHILD
        proc = subprocess.Popen(
            child_cmd,
            env=env,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
        _ACTIVE_CHILD = proc
        stderr_tail: list[str] = []
        stdout_chunks: list[str] = []

        def _drain_stdout() -> None:
            assert proc.stdout is not None
            try:
                stdout_chunks.append(proc.stdout.read())
            finally:
                proc.stdout.close()

        # Drain stdout on a dedicated thread while streaming stderr stage markers so
        # large word-level transcripts (>64 KB pipe buffer) never deadlock the child.
        stdout_reader = threading.Thread(target=_drain_stdout, daemon=True)
        stdout_reader.start()
        try:
            assert proc.stderr is not None
            for line in proc.stderr:
                stripped = line.strip()
                if stripped.startswith("stage:"):
                    print(stripped, file=sys.stderr, flush=True)
                elif stripped:
                    stderr_tail.append(stripped)
                    if len(stderr_tail) > 10:
                        stderr_tail.pop(0)
            proc.stderr.close()
            stdout_reader.join()
            stdout = "".join(stdout_chunks)
            code = proc.wait()
        finally:
            _ACTIVE_CHILD = None

        if code == 75:
            return {"ok": False, "busy": True, "error": "GPU is busy; try again later"}
        if code != 0:
            detail = stderr_tail[-1] if stderr_tail else f"exit {code}"
            raise RuntimeError(f"transcription failed: {detail[:200]}")

        chunk = json.loads(stdout)
        if not chunk.get("ok"):
            return chunk
        all_segments.extend(chunk.get("segments") or [])
        if not language and chunk.get("language"):
            language = str(chunk["language"])
        if not device and chunk.get("device"):
            device = str(chunk["device"])
        if chunk.get("duration"):
            final_duration = max(final_duration, float(chunk["duration"]))

        next_offset = float(chunk.get("nextOffset") or 0.0)
        if chunk.get("yielded") and next_offset > start_offset:
            start_offset = next_offset
            time.sleep(1.0 if args.slice_seconds >= _SLICE_SECONDS else 0.05)
            continue
        break

    return {
        "ok": True,
        "language": language,
        "duration": round(final_duration, 3),
        "device": device,
        "segments": all_segments,
    }


def _read_prompt(path: str | None) -> str:
    if not path:
        return ""
    try:
        return Path(path).read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def main(argv: list[str] | None = None) -> int:
    _install_signal_handlers()
    parser = argparse.ArgumentParser(description="Generate timed Whisper word JSON for lyrics-overlay.")
    parser.add_argument("--video-id", default="")
    parser.add_argument("--audio-file", default="")
    parser.add_argument("--transcribe-audio", default="")
    parser.add_argument("--ytarchive-url", default="")
    parser.add_argument("--cookies-from-browser", default="")
    parser.add_argument("--model", default="large-v3")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--compute-type", default="auto")
    parser.add_argument("--max-duration", type=float, default=900.0)
    parser.add_argument("--total-duration", type=float, default=0.0)
    parser.add_argument("--start-offset", type=float, default=0.0)
    parser.add_argument("--slice-seconds", type=float, default=_SLICE_SECONDS)
    parser.add_argument("--yield-check-json", default="")
    parser.add_argument("--prompt-file", default="")
    parser.add_argument("--gpu-gate-json", default="")
    args = parser.parse_args(argv)

    env = _augmented_env()
    prompt = _read_prompt(args.prompt_file)

    try:
        if args.transcribe_audio:
            yield_check_cmd = json.loads(args.yield_check_json) if args.yield_check_json else None
            result = _transcribe_audio(
                Path(args.transcribe_audio),
                model_name=args.model,
                device=args.device,
                compute_type=args.compute_type,
                prompt=prompt,
                env=env,
                total_duration=args.total_duration,
                start_offset=args.start_offset,
                yield_check_cmd=yield_check_cmd,
                slice_seconds=args.slice_seconds,
            )
            print(json.dumps(result, ensure_ascii=False))
            return 0

        with tempfile.TemporaryDirectory(prefix="lyrics-overlay-gen-") as raw_tmp:
            tmpdir = Path(raw_tmp)
            if args.audio_file:
                audio_path = Path(args.audio_file)
                if not audio_path.is_file():
                    raise RuntimeError("audio file not found")
            else:
                if not args.video_id:
                    raise RuntimeError("missing --video-id")
                _emit_stage("audio")
                cached = tmpdir / "soundtrack.mp3"
                if args.ytarchive_url and _fetch_ytarchive_audio(args.ytarchive_url, args.video_id, cached):
                    audio_path = cached
                else:
                    audio_path = _download_youtube_audio(
                        args.video_id,
                        tmpdir,
                        env,
                        cookies_from_browser=args.cookies_from_browser,
                        allow_large=args.max_duration <= 0,
                    )

            duration = _probe_duration(audio_path, env)
            if args.max_duration > 0 and duration > args.max_duration:
                mins = int(round(args.max_duration / 60))
                print(
                    json.dumps(
                        {
                            "ok": False,
                            "skip": True,
                            "error": f"Video is longer than {mins} minutes",
                        }
                    )
                )
                return 0

            gate = json.loads(args.gpu_gate_json) if args.gpu_gate_json else None
            if gate and args.device != "cpu":
                result = _run_with_gpu_gate(gate, audio_path, duration, args, env)
            else:
                result = _transcribe_audio(
                    audio_path,
                    model_name=args.model,
                    device=args.device,
                    compute_type=args.compute_type,
                    prompt=prompt,
                    env=env,
                    total_duration=duration,
                    slice_seconds=args.slice_seconds,
                )
            print(json.dumps(result, ensure_ascii=False))
            return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
