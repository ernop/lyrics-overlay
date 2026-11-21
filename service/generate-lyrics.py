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
import os
import shutil
import signal
import subprocess
import sys
import sysconfig
import tempfile
import threading
import urllib.error
import urllib.request
from pathlib import Path

_ACTIVE_CHILD: subprocess.Popen | None = None


def _emit_stage(stage: str) -> None:
    print(f"stage:{stage}", file=sys.stderr, flush=True)


def _augmented_env() -> dict[str, str]:
    """Ensures user-installed tools in ~/.local/bin (yt-dlp, deno, gpu gate) are on PATH."""
    env = os.environ.copy()
    local_bin = str(Path.home() / ".local" / "bin")
    path = env.get("PATH", "")
    parts = [p for p in path.split(os.pathsep) if p]
    if local_bin not in parts:
        env["PATH"] = os.pathsep.join([local_bin, *parts])
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
        with urllib.request.urlopen(req, timeout=5) as resp:
            if resp.status != 200:
                return False
            data = resp.read()
            if len(data) < 4096:
                return False
            target.write_bytes(data)
            return True
    except (urllib.error.URLError, TimeoutError, OSError):
        return False


def _download_youtube_audio(video_id: str, tmpdir: Path, env: dict[str, str]) -> Path:
    yt_dlp = shutil.which("yt-dlp", path=env["PATH"])
    if not yt_dlp:
        raise RuntimeError("yt-dlp is not installed")
    template = str(tmpdir / "audio.%(ext)s")
    cmd = [
        yt_dlp,
        "--no-playlist",
        "--ignore-config",
        "--no-warnings",
        "--no-progress",
        "-f",
        "bestaudio[filesize<30M]/bestaudio",
        "--max-filesize",
        "30m",
        "-o",
        template,
        f"https://www.youtube.com/watch?v={video_id}",
    ]
    code, _stdout, stderr = _run_cancellable(cmd, env=env)
    if code != 0:
        detail = next((line.strip() for line in reversed(stderr.splitlines()) if line.strip()), f"exit {code}")
        raise RuntimeError(f"audio download failed: {detail[:200]}")
    files = sorted(p for p in tmpdir.glob("audio.*") if p.is_file() and not p.name.endswith(".part"))
    if not files:
        raise RuntimeError("yt-dlp produced no audio file")
    return files[0]


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


def _decode_audio_16k(audio_path: Path, env: dict[str, str]):
    """Decodes any container (WebM/Opus, M4A, MP3, etc.) to 16 kHz mono float32 via ffmpeg."""
    import numpy as np

    ffmpeg = shutil.which("ffmpeg", path=env["PATH"])
    if not ffmpeg:
        raise RuntimeError("ffmpeg is not installed")
    proc = subprocess.Popen(
        [
            ffmpeg,
            "-nostdin",
            "-v",
            "error",
            "-i",
            str(audio_path),
            "-f",
            "f32le",
            "-acodec",
            "pcm_f32le",
            "-ac",
            "1",
            "-ar",
            "16000",
            "pipe:1",
        ],
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
    if samples.size == 0:
        raise RuntimeError("audio file has no samples")
    return samples


def _transcribe_audio(
    audio_path: Path,
    *,
    model_name: str,
    device: str,
    compute_type: str,
    prompt: str,
    env: dict[str, str],
) -> dict:
    import ctranslate2
    from faster_whisper import WhisperModel

    samples = _decode_audio_16k(audio_path, env)

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

    raw_segments, info = model.transcribe(samples, **kwargs)
    segments = []
    for seg in raw_segments:
        words = []
        for w in seg.words or []:
            words.append(
                {
                    "start": round(float(w.start or 0), 3),
                    "end": round(float(w.end or 0), 3),
                    "word": str(w.word or ""),
                    "probability": round(float(w.probability or 0), 4),
                }
            )
        segments.append(
            {
                "start": round(float(seg.start or 0), 3),
                "end": round(float(seg.end or 0), 3),
                "text": str(seg.text or ""),
                "no_speech_prob": round(float(getattr(seg, "no_speech_prob", 0) or 0), 4),
                "words": words,
            }
        )
    duration = round(float(getattr(info, "duration", 0) or 0), 3)
    language = str(getattr(info, "language", "") or "")
    del raw_segments, model
    return {
        "ok": True,
        "language": language,
        "duration": duration,
        "device": chosen_device,
        "segments": segments,
    }


def _run_with_gpu_gate(
    gate: dict,
    audio_path: Path,
    args: argparse.Namespace,
    env: dict[str, str],
) -> dict:
    gate_bin = shutil.which(str(gate.get("command", "gpu")), path=env["PATH"])
    if not gate_bin:
        raise RuntimeError(f"GPU gate command not found: {gate.get('command', 'gpu')}")
    _emit_stage("gpu-wait")
    child_cmd = [
        gate_bin,
        "run",
        "--name",
        str(gate.get("name", "Lyrics overlay")),
        "--what",
        str(gate.get("what", f"Whisper {args.model}")),
        "--gb",
        str(gate.get("gb", 7)),
        "--lane",
        str(gate.get("lane", "now")),
        "--minutes",
        str(gate.get("minutes", 5)),
    ]
    if gate.get("waitMinutes") is not None:
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
        ]
    )
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
    return json.loads(stdout)


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
    parser.add_argument("--model", default="large-v3")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--compute-type", default="auto")
    parser.add_argument("--max-duration", type=float, default=900.0)
    parser.add_argument("--prompt-file", default="")
    parser.add_argument("--gpu-gate-json", default="")
    args = parser.parse_args(argv)

    env = _augmented_env()
    prompt = _read_prompt(args.prompt_file)

    try:
        if args.transcribe_audio:
            result = _transcribe_audio(
                Path(args.transcribe_audio),
                model_name=args.model,
                device=args.device,
                compute_type=args.compute_type,
                prompt=prompt,
                env=env,
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
                    audio_path = _download_youtube_audio(args.video_id, tmpdir, env)

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
                result = _run_with_gpu_gate(gate, audio_path, args, env)
            else:
                result = _transcribe_audio(
                    audio_path,
                    model_name=args.model,
                    device=args.device,
                    compute_type=args.compute_type,
                    prompt=prompt,
                    env=env,
                )
            print(json.dumps(result, ensure_ascii=False))
            return 0
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        return 0


if __name__ == "__main__":
    raise SystemExit(main())
