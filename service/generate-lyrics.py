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
import re
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
_FIRST_PARTIAL_SECONDS = 12.0
_FIRST_SLICE_PARTIAL_STEP = 60.0
_DL_PROGRESS_RE = re.compile(r"^DL:([^/]*)/(.*)$")
_GPU_WAIT_RE = re.compile(r"waits for the GPU:\s*(.+)$")


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


def _parse_int_field(raw: str) -> int:
    text = raw.strip()
    if not text or text.upper() == "NA":
        return 0
    try:
        return max(0, int(float(text)))
    except ValueError:
        return 0


def _run_yt_dlp_with_progress(cmd: list[str], *, env: dict[str, str]) -> tuple[int, str]:
    global _ACTIVE_CHILD
    proc = subprocess.Popen(
        cmd,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        errors="replace",
    )
    _ACTIVE_CHILD = proc
    stderr_chunks: list[str] = []

    def _drain_stderr() -> None:
        assert proc.stderr is not None
        try:
            stderr_chunks.append(proc.stderr.read())
        finally:
            proc.stderr.close()

    stderr_reader = threading.Thread(target=_drain_stderr, daemon=True)
    stderr_reader.start()
    last_done = 0
    try:
        assert proc.stdout is not None
        for line in proc.stdout:
            match = _DL_PROGRESS_RE.match(line.strip())
            if not match:
                continue
            done = _parse_int_field(match.group(1))
            total = _parse_int_field(match.group(2))
            if done <= 0:
                continue
            finished = total > 0 and done >= total and done != last_done
            step = max(500_000, int(total * 0.02)) if total > 0 else 500_000
            if last_done == 0 or done - last_done >= step or finished:
                last_done = done
                _emit_stage(f"audio:{done}/{total}")
        proc.stdout.close()
        stderr_reader.join()
        code = proc.wait()
        return code, "".join(stderr_chunks)
    finally:
        _ACTIVE_CHILD = None


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
        "--newline",
        "--progress-delta",
        "0.5",
        "--progress-template",
        "download:DL:%(progress.downloaded_bytes)s/%(progress.total_bytes,progress.total_bytes_estimate)s",
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
        code, stderr = _run_yt_dlp_with_progress(cmd, env=env)
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


def _emit_partial(segments: list[dict], range_start: float, range_end: float, total_duration: float) -> None:
    print(
        json.dumps(
            {
                "partial": True,
                "range": [round(range_start, 3), round(range_end, 3)],
                "duration": round(total_duration, 3),
                "segments": segments,
            },
            ensure_ascii=False,
        ),
        flush=True,
    )


def _plan_slices(total_duration: float, slice_seconds: float, start_at: float = 0.0) -> list[tuple[float, float]]:
    """Partitions [0, total_duration) into disjoint slices starting near start_at."""
    if total_duration <= 0 or slice_seconds <= 0:
        return []
    anchor = max(0.0, math.floor(start_at) - 10.0) if start_at >= 30.0 else 0.0
    if anchor >= total_duration - 1.0:
        anchor = 0.0

    slices: list[tuple[float, float]] = []
    pos = anchor
    while pos < total_duration - 0.1:
        rem = total_duration - pos
        end = total_duration if rem <= slice_seconds * 1.1 else pos + slice_seconds
        slices.append((round(pos, 3), round(end, 3)))
        pos = end
    pos = 0.0
    while pos < anchor - 0.1:
        rem = anchor - pos
        end = anchor if rem <= slice_seconds * 1.1 else pos + slice_seconds
        slices.append((round(pos, 3), round(end, 3)))
        pos = end
    return slices


def _collect_segments(
    raw_segments,
    *,
    offset: float,
    slice_end: float,
    completed_before: float,
    total_duration: float,
    last_progress: float,
    stream_partials: bool = False,
    partial_first_step: float = _FIRST_PARTIAL_SECONDS,
    partial_step: float = _FIRST_SLICE_PARTIAL_STEP,
) -> tuple[list[dict], float]:
    segments: list[dict] = []
    pending: list[dict] = []
    batch_start = offset
    emitted_any = False
    slice_len = max(0.0, slice_end - offset)
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
        rel_end = float(seg.end or 0)
        end_sec = offset + rel_end
        item = {
            "start": round(offset + float(seg.start or 0), 3),
            "end": round(end_sec, 3),
            "text": str(seg.text or ""),
            "no_speech_prob": round(float(getattr(seg, "no_speech_prob", 0) or 0), 4),
            "words": words,
        }
        segments.append(item)
        if stream_partials:
            pending.append(item)
            threshold = partial_first_step if not emitted_any else partial_step
            if end_sec - batch_start >= threshold and pending:
                _emit_partial(pending, batch_start, end_sec, total_duration)
                pending = []
                batch_start = end_sec
                emitted_any = True
        done_sec = completed_before + (min(slice_len, rel_end) if slice_len > 0 else rel_end)
        if total_duration >= _PROGRESS_MIN_DURATION and done_sec - last_progress >= step:
            last_progress = done_sec
            _emit_progress(done_sec, total_duration)
    if stream_partials and (pending or slice_end > batch_start + 0.1):
        _emit_partial(pending, batch_start, max(slice_end, batch_start), total_duration)
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
    start_at: float = 0.0,
    slice_index: int = 0,
    stream_partials: bool = False,
    yield_check_cmd: list[str] | None = None,
    slice_seconds: float = _SLICE_SECONDS,
) -> dict:
    import ctranslate2
    from faster_whisper import WhisperModel

    effective_total = total_duration if total_duration > 0 else _probe_duration(audio_path, env)
    slice_threshold = _SLICE_THRESHOLD_SECONDS if slice_seconds >= _SLICE_SECONDS else slice_seconds
    use_slices = slice_index > 0 or start_offset > 0 or effective_total > slice_threshold

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

    planned: list[tuple[float, float]] = []
    start_idx = max(0, int(slice_index))
    completed_before = 0.0
    if use_slices and effective_total > 0:
        planned = _plan_slices(effective_total, slice_seconds, start_at=start_at)
        if start_idx == 0 and start_offset > 0:
            start_idx = next(
                (i for i, (s, _e) in enumerate(planned) if s >= start_offset - 0.1),
                len(planned),
            )
        completed_before = sum(e - s for s, e in planned[:start_idx])

    threads = max(1, min(8, (os.cpu_count() or 2) // 2))
    if completed_before > 0 and effective_total >= _PROGRESS_MIN_DURATION:
        _emit_progress(completed_before, effective_total)
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
            slice_end=duration,
            completed_before=0.0,
            total_duration=duration,
            last_progress=0.0,
            stream_partials=stream_partials and duration >= _PROGRESS_MIN_DURATION,
            partial_first_step=_FIRST_PARTIAL_SECONDS,
            partial_step=_FIRST_SLICE_PARTIAL_STEP,
        )
        del raw_segments, samples, model
        return {
            "ok": True,
            "language": language,
            "duration": duration,
            "device": chosen_device,
            "segments": segments,
        }

    all_segments: list[dict] = []
    language = ""
    yielded = False
    last_progress = completed_before
    next_slice_idx = start_idx
    next_offset = start_offset

    if planned:
        for idx in range(start_idx, len(planned)):
            s_start, s_end = planned[idx]
            s_dur = max(0.0, s_end - s_start)
            if s_dur <= 0.05:
                next_slice_idx = idx + 1
                continue
            samples = _decode_audio_16k(audio_path, env, start_sec=s_start, duration_sec=s_dur)
            if samples.size == 0:
                next_slice_idx = idx + 1
                completed_before += s_dur
                continue
            actual_slice_dur = samples.size / 16000.0
            raw_segments, info = model.transcribe(samples, **kwargs)
            if not language:
                language = str(getattr(info, "language", "") or "")
            is_playhead_slice = idx == 0
            chunk_segments, last_progress = _collect_segments(
                raw_segments,
                offset=s_start,
                slice_end=s_start + actual_slice_dur,
                completed_before=completed_before,
                total_duration=effective_total,
                last_progress=last_progress,
                stream_partials=stream_partials,
                partial_first_step=_FIRST_PARTIAL_SECONDS if is_playhead_slice else s_dur,
                partial_step=_FIRST_SLICE_PARTIAL_STEP if is_playhead_slice else s_dur,
            )
            all_segments.extend(chunk_segments)
            del raw_segments, samples

            completed_before += s_dur
            next_slice_idx = idx + 1
            next_offset = planned[next_slice_idx][0] if next_slice_idx < len(planned) else effective_total
            if effective_total >= _PROGRESS_MIN_DURATION and completed_before - last_progress >= 1.0:
                last_progress = completed_before
                _emit_progress(completed_before, effective_total)
            if next_slice_idx < len(planned) and _should_yield(yield_check_cmd, env):
                yielded = True
                break
    else:
        offset = max(0.0, float(start_offset))
        while True:
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
                slice_end=offset + actual_slice_dur,
                completed_before=offset,
                total_duration=effective_total,
                last_progress=last_progress,
                stream_partials=stream_partials,
            )
            all_segments.extend(chunk_segments)
            del raw_segments, samples
            reached_eof = actual_slice_dur < slice_seconds - 0.5
            offset = offset + (actual_slice_dur if reached_eof else slice_seconds)
            next_offset = offset
            if reached_eof:
                break
            if _should_yield(yield_check_cmd, env):
                yielded = True
                break

    if not yielded:
        all_segments.sort(key=lambda seg: (seg.get("start", 0.0), seg.get("end", 0.0)))

    del model
    return {
        "ok": True,
        "yielded": yielded,
        "nextSliceIndex": next_slice_idx,
        "completedSeconds": round(completed_before, 3),
        "nextOffset": round(next_offset, 3),
        "language": language,
        "duration": round(max(effective_total, completed_before), 3),
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

    slice_index = 0
    start_offset = 0.0
    completed_sec = 0.0
    all_segments: list[dict] = []
    language = ""
    device = ""
    final_duration = duration

    while True:
        _emit_stage("gpu-wait")
        remaining = max(0.0, duration - completed_sec)
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
        if args.max_duration > 0 and slice_index == 0 and start_offset <= 0 and gate.get("waitMinutes") is not None:
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
        if args.start_at > 0:
            child_cmd.extend(["--start-at", f"{args.start_at:.3f}"])
        if slice_index > 0:
            child_cmd.extend(["--slice-index", str(slice_index)])
        elif start_offset > 0:
            child_cmd.extend(["--start-offset", f"{start_offset:.3f}"])
        if args.stream_partials:
            child_cmd.append("--stream-partials")
        if yield_check_cmd:
            child_cmd.extend(["--yield-check-json", json.dumps(yield_check_cmd)])
        if args.prompt_file:
            child_cmd.extend(["--prompt-file", args.prompt_file])

        # Stream stderr lines and NDJSON partial lines from child concurrently.
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
        final_lines: list[str] = []

        def _drain_stdout() -> None:
            assert proc.stdout is not None
            try:
                for raw_line in proc.stdout:
                    stripped = raw_line.strip()
                    if not stripped:
                        continue
                    try:
                        parsed = json.loads(stripped)
                    except json.JSONDecodeError:
                        final_lines.append(stripped)
                        continue
                    if isinstance(parsed, dict) and parsed.get("partial"):
                        if args.stream_partials:
                            print(stripped, flush=True)
                    else:
                        final_lines.append(stripped)
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
                    wait_match = _GPU_WAIT_RE.search(stripped)
                    if wait_match:
                        _emit_stage(f"gpu-wait:{wait_match.group(1).strip()[:80]}")
                    stderr_tail.append(stripped)
                    if len(stderr_tail) > 10:
                        stderr_tail.pop(0)
            proc.stderr.close()
            stdout_reader.join()
            code = proc.wait()
        finally:
            _ACTIVE_CHILD = None

        if code == 75:
            return {"ok": False, "busy": True, "error": "GPU is busy; try again later"}
        if code != 0:
            detail = stderr_tail[-1] if stderr_tail else f"exit {code}"
            raise RuntimeError(f"transcription failed: {detail[:200]}")

        stdout = final_lines[-1] if final_lines else ""
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

        if chunk.get("yielded"):
            next_idx = int(chunk.get("nextSliceIndex") or 0)
            next_off = float(chunk.get("nextOffset") or 0.0)
            if "nextSliceIndex" in chunk and next_idx > slice_index:
                slice_index = next_idx
                completed_sec = max(completed_sec, float(chunk.get("completedSeconds") or completed_sec))
                time.sleep(1.0 if args.slice_seconds >= _SLICE_SECONDS else 0.05)
                continue
            if next_off > start_offset:
                start_offset = next_off
                completed_sec = max(completed_sec, start_offset)
                time.sleep(1.0 if args.slice_seconds >= _SLICE_SECONDS else 0.05)
                continue
        break

    all_segments.sort(key=lambda seg: (seg.get("start", 0.0), seg.get("end", 0.0)))
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
    parser.add_argument("--start-at", type=float, default=0.0)
    parser.add_argument("--slice-index", type=int, default=0)
    parser.add_argument("--stream-partials", action="store_true")
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
                start_at=args.start_at,
                slice_index=args.slice_index,
                stream_partials=args.stream_partials,
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
                    start_at=args.start_at,
                    stream_partials=args.stream_partials,
                    slice_seconds=args.slice_seconds,
                )
            print(json.dumps(result, ensure_ascii=False))
            return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
