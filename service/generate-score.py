#!/usr/bin/env python3
"""Acquires audio for a YouTube video (or local file) and extracts a compact
lead-vocal melody score JSON on stdout:
  1. Two-pass vocal isolation (BS-RoFormer vocals -> Mel-Band RoFormer karaoke lead vocal)
  2. Beat & downbeat tracking on the full mix (Beat This!)
  3. Clean word timestamps + language detection on the isolated lead vocal (faster-whisper)
  4. Discrete singing-note extraction (openvpi/GAME large)
  5. Global tuning offset, full-song key/scale detection, and beat-grid rhythm quantization

Never writes lyric text to stderr (logs only stage markers and concise errors).
Always deletes temporary downloaded audio and stems before exiting.
Optional --gpu-gate-json wraps ONLY the GPU analysis worker so downloading never holds GPU memory.
"""

from __future__ import annotations

import argparse
import ctypes
import gc
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

_SYSTEM_BIN_DIRS = frozenset(
    ("/usr/local/sbin", "/usr/local/bin", "/usr/sbin", "/usr/bin", "/sbin", "/bin")
)
_AUTO_PRIMARY_AUDIO_FORMAT = "bestaudio[filesize<100M]/bestaudio"
_AUTO_FALLBACK_AUDIO_FORMAT = "bestaudio[protocol^=m3u8]/best[filesize<100M]/best"
_LARGE_PRIMARY_AUDIO_FORMAT = "bestaudio[abr<=160]/bestaudio"
_LARGE_FALLBACK_AUDIO_FORMAT = "bestaudio[protocol^=m3u8]/best"
_DL_PROGRESS_RE = re.compile(r"^DL:([^/]*)/(.*)$")
_GPU_WAIT_RE = re.compile(r"waits for the GPU:\s*(.+)$")

DEFAULT_VOCAL_MODEL = "model_bs_roformer_ep_317_sdr_12.9755.ckpt"
DEFAULT_KARAOKE_MODEL = "mel_band_roformer_karaoke_becruily.ckpt"
FALLBACK_KARAOKE_MODEL = "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt"

# Krumhansl-Kessler major & minor profiles (same constants as shared/key-detect.js).
_MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88]
_MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17]


def _emit_stage(stage: str) -> None:
    print(f"stage:{stage}", file=sys.stderr, flush=True)


def _augmented_env() -> dict[str, str]:
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


def _parse_int_field(raw: str) -> int:
    text = raw.strip()
    if not text or text.upper() == "NA":
        return 0
    try:
        return max(0, int(float(text)))
    except ValueError:
        return 0


def _clear_partial_downloads(tmpdir: Path) -> None:
    for p in tmpdir.glob("audio.*"):
        try:
            p.unlink()
        except OSError:
            pass


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
            step = max(500_000, int(total * 0.04)) if total > 0 else 500_000
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
        downloaded, code, stderr = _try_format(fallback_fmt)
        if downloaded is not None:
            return downloaded
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


def _convert_wav(src: Path, dst: Path, env: dict[str, str], *, rate: int = 44100, channels: int = 2) -> Path:
    ffmpeg = shutil.which("ffmpeg", path=env["PATH"])
    if not ffmpeg:
        raise RuntimeError("ffmpeg is not installed")
    code, _out, err = _run_cancellable(
        [
            ffmpeg,
            "-nostdin",
            "-y",
            "-v",
            "error",
            "-i",
            str(src),
            "-ac",
            str(channels),
            "-ar",
            str(rate),
            "-c:a",
            "pcm_f32le",
            str(dst),
        ],
        env=env,
    )
    if code != 0:
        raise RuntimeError(f"ffmpeg decode failed: {_last_error_line(err, code)[:180]}")
    return dst


def _decode_mono_float32(audio_path: Path, env: dict[str, str], rate: int):
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
            str(rate),
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
        raise RuntimeError(f"ffmpeg pcm decode failed: {err.decode('utf-8', errors='replace')[:180]}")
    return np.frombuffer(raw, dtype=np.float32)


def _activate_cuda_libraries() -> None:
    """Loads packaged NVIDIA cuBLAS/cuDNN libraries for CTranslate2 (faster-whisper)."""
    root = Path(sysconfig.get_paths()["purelib"]) / "nvidia"
    candidates = [
        ("libcublasLt.so.12", root / "cublas" / "lib" / "libcublasLt.so.12"),
        ("libcublas.so.12", root / "cublas" / "lib" / "libcublas.so.12"),
        ("libcudnn.so.9", root / "cudnn" / "lib" / "libcudnn.so.9"),
        ("libcudnn_ops.so.9", root / "cudnn" / "lib" / "libcudnn_ops.so.9"),
        ("libcudnn_cnn.so.9", root / "cudnn" / "lib" / "libcudnn_cnn.so.9"),
        ("libcublasLt.so.13", root / "cu13" / "lib" / "libcublasLt.so.13"),
        ("libcublas.so.13", root / "cu13" / "lib" / "libcublas.so.13"),
    ]
    for soname, packaged in candidates:
        try:
            ctypes.CDLL(soname, mode=ctypes.RTLD_GLOBAL)
        except OSError:
            if packaged.exists():
                try:
                    ctypes.CDLL(str(packaged), mode=ctypes.RTLD_GLOBAL)
                except OSError:
                    pass


def _release_gpu() -> None:
    gc.collect()
    try:
        import torch

        if torch.cuda.is_available():
            torch.cuda.empty_cache()
    except Exception:
        pass


def _resolve_output_file(out_dir: Path, entry: str) -> Path:
    p = Path(entry)
    return p if p.is_absolute() else (out_dir / p)


def _audio_rms(wav_path: Path) -> float:
    import numpy as np
    import soundfile as sf

    data, _sr = sf.read(str(wav_path), dtype="float32")
    if data.size == 0:
        return 0.0
    return float(np.sqrt(np.mean(np.square(data))))


def _blend_adaptive_lead_vocal(vocals_wav: Path, lead_wav: Path, out_wav: Path) -> Path:
    """Protects duets and soft verses from Karaoke over-suppression, then peak-normalizes."""
    import numpy as np
    import soundfile as sf

    voc, sr = sf.read(str(vocals_wav), dtype="float32", always_2d=True)
    lead, sr2 = sf.read(str(lead_wav), dtype="float32", always_2d=True)
    n = min(voc.shape[0], lead.shape[0])
    if n == 0 or sr != sr2:
        return vocals_wav
    voc = voc[:n]
    lead = lead[:n]
    if lead.shape[1] != voc.shape[1]:
        lead = np.repeat(lead[:, :1], voc.shape[1], axis=1)

    # Compute 0.5 s hop / 1.0 s window RMS envelopes to detect sections where
    # Pass-2 karaoke cancelled a duet or soft passage that Pass-1 still kept.
    hop = max(1, sr // 2)
    win = max(1, sr)
    n_frames = max(1, (n + hop - 1) // hop)
    voc_mono = np.mean(voc, axis=1)
    lead_mono = np.mean(lead, axis=1)
    voc_rms = np.zeros(n_frames, dtype=np.float32)
    lead_rms = np.zeros(n_frames, dtype=np.float32)
    for idx in range(n_frames):
        s = idx * hop
        e = min(n, s + win)
        voc_rms[idx] = float(np.sqrt(np.mean(voc_mono[s:e] ** 2)))
        lead_rms[idx] = float(np.sqrt(np.mean(lead_mono[s:e] ** 2)))

    global_voc_rms = float(np.percentile(voc_rms[voc_rms > 1e-4], 70)) if np.any(voc_rms > 1e-4) else 0.0
    # Weight = 1.0 uses lead (karaoke), 0.0 falls back to Pass-1 vocals when lead collapses.
    frame_w = np.ones(n_frames, dtype=np.float32)
    if global_voc_rms > 1e-4:
        for idx in range(n_frames):
            vr = voc_rms[idx]
            lr = lead_rms[idx]
            if vr >= global_voc_rms * 0.10 and lr < vr * 0.35:
                # Smooth transition between 0.15 (pure vocals) and 0.35 (pure lead).
                ratio = lr / max(vr, 1e-6)
                frame_w[idx] = float(np.clip((ratio - 0.15) / 0.20, 0.0, 1.0))

    # Interpolate frame weights smoothly to sample resolution.
    frame_centers = np.minimum(n - 1, np.arange(n_frames, dtype=np.float32) * hop + hop * 0.5)
    sample_w = np.interp(np.arange(n, dtype=np.float32), frame_centers, frame_w).astype(np.float32)
    blended = lead * sample_w[:, None] + voc * (1.0 - sample_w[:, None])

    peak = float(np.max(np.abs(blended)))
    if peak > 1e-5:
        blended = blended * (0.89 / peak)

    sf.write(str(out_wav), blended, sr, subtype="FLOAT")
    return out_wav


def _normalize_wav_inplace(wav_path: Path) -> Path:
    import numpy as np
    import soundfile as sf

    data, sr = sf.read(str(wav_path), dtype="float32")
    peak = float(np.max(np.abs(data))) if data.size else 0.0
    if peak > 1e-5 and abs(peak - 0.89) > 0.05:
        sf.write(str(wav_path), data * (0.89 / peak), sr, subtype="FLOAT")
    return wav_path


def _write_backing_residual(vocals_wav: Path, lead_wav: Path, out_wav: Path) -> Path | None:
    """Computes phase-aligned backing-vocal residual (Pass-1 vocals minus Pass-2 lead)."""
    import numpy as np
    import soundfile as sf

    voc, sr = sf.read(str(vocals_wav), dtype="float32")
    lead, sr_l = sf.read(str(lead_wav), dtype="float32")
    if sr != sr_l or voc.size == 0 or lead.size == 0:
        return None
    if voc.ndim == 1:
        voc = voc[:, None]
    if lead.ndim == 1:
        lead = lead[:, None]
    n = min(voc.shape[0], lead.shape[0])
    c = min(voc.shape[1], lead.shape[1])
    if n < sr:
        return None
    voc = voc[:n, :c]
    lead = lead[:n, :c]
    residual = voc - lead
    voc_rms = float(np.sqrt(np.mean(voc ** 2)))
    res_rms = float(np.sqrt(np.mean(residual ** 2)))
    if voc_rms < 1e-4 or res_rms < voc_rms * 0.16:
        return None
    peak = float(np.max(np.abs(residual)))
    if peak > 1e-5:
        residual = residual * (0.89 / peak)
    sf.write(str(out_wav), residual, sr, subtype="FLOAT")
    return out_wav


def _separate_lead_vocal(
    mix_wav: Path,
    work_dir: Path,
    model_dir: Path,
    *,
    vocal_model: str,
    karaoke_model: str,
    two_pass: bool = True,
    quality: str = "standard",
) -> tuple[Path, Path, Path | None]:
    """Returns `(lead_wav, full_vocals_wav, backing_residual_wav_or_none)`."""
    import logging
    from audio_separator.separator import Separator

    model_dir.mkdir(parents=True, exist_ok=True)
    stem_dir = work_dir / "stems"
    stem_dir.mkdir(parents=True, exist_ok=True)

    # Silence verbose third-party logs so stderr carries only clean stage markers.
    logging.getLogger().setLevel(logging.ERROR)

    overlap = 4 if quality == "high" else 2
    sep_common = {
        "log_level": logging.ERROR,
        "model_file_dir": str(model_dir),
        "output_format": "WAV",
        "output_single_stem": "Vocals",
        "use_autocast": True,
        "mdxc_params": {
            "segment_size": 256,
            "override_model_segment_size": False,
            "batch_size": 2,
            "overlap": overlap,
            "pitch_shift": 0,
        },
    }

    if two_pass:
        sep1 = Separator(output_dir=str(stem_dir), **sep_common)
        sep1.load_model(model_filename=vocal_model)
        pass1_files = sep1.separate(str(mix_wav))
        del sep1
        _release_gpu()
        if not pass1_files:
            raise RuntimeError("vocal separation pass 1 produced no stem")
        vocals_wav = _resolve_output_file(stem_dir, pass1_files[0])
        vocals_rms = _audio_rms(vocals_wav)
        if vocals_rms < 1e-4:
            return vocals_wav, vocals_wav, None

        # Pass 2: split lead vocals from backing harmonies on the isolated vocal stem.
        lead_dir = work_dir / "lead"
        lead_dir.mkdir(parents=True, exist_ok=True)
        chosen_karaoke = karaoke_model
        for attempt_model in (chosen_karaoke, FALLBACK_KARAOKE_MODEL):
            try:
                sep2 = Separator(output_dir=str(lead_dir), **sep_common)
                sep2.load_model(model_filename=attempt_model)
                pass2_files = sep2.separate(str(vocals_wav))
                del sep2
                _release_gpu()
                if pass2_files:
                    lead_wav = _resolve_output_file(lead_dir, pass2_files[0])
                    backing_wav = _write_backing_residual(vocals_wav, lead_wav, work_dir / "backing_residual.wav")
                    adaptive_wav = _blend_adaptive_lead_vocal(vocals_wav, lead_wav, work_dir / "lead_adaptive.wav")
                    return adaptive_wav, vocals_wav, backing_wav
            except Exception:
                _release_gpu()
                if attempt_model == FALLBACK_KARAOKE_MODEL:
                    norm_voc = _normalize_wav_inplace(vocals_wav)
                    return norm_voc, norm_voc, None
        norm_voc = _normalize_wav_inplace(vocals_wav)
        return norm_voc, norm_voc, None

    # Single-pass karaoke fallback mode.
    sep = Separator(output_dir=str(stem_dir), **sep_common)
    sep.load_model(model_filename=karaoke_model)
    files = sep.separate(str(mix_wav))
    del sep
    _release_gpu()
    if not files:
        raise RuntimeError("karaoke separation produced no lead vocal stem")
    norm_lead = _normalize_wav_inplace(_resolve_output_file(stem_dir, files[0]))
    return norm_lead, norm_lead, None


def _track_beats(mix_wav: Path, device: str) -> tuple[list[float], list[float], float, list[int]]:
    import numpy as np
    from beat_this.inference import File2Beats

    tracker = File2Beats(checkpoint_path="final0", device=device, dbn=False)
    beats_arr, downbeats_arr = tracker(str(mix_wav))
    del tracker
    _release_gpu()

    beats = [float(x) for x in beats_arr]
    raw_downbeats = [float(x) for x in downbeats_arr]

    if len(beats) >= 2:
        diffs = np.diff(np.asarray(beats, dtype=np.float64))
        diffs = diffs[(diffs >= 0.18) & (diffs <= 2.2)]
        bpm = float(60.0 / np.median(diffs)) if diffs.size > 0 else 120.0
    else:
        bpm = 120.0

    # Fold tempo octave into natural lead-sheet vocal reading range [62, 154] BPM.
    # Avoids double-time 188 BPM cramming 4/4 bars into 1.28 s.
    folded_down = False
    while bpm > 154.0 and len(beats) >= 6:
        b_arr = np.asarray(beats, dtype=np.float64)
        if raw_downbeats:
            db_arr = np.asarray(raw_downbeats, dtype=np.float64)
            even_score = sum(1 for db in db_arr if np.min(np.abs(b_arr[0::2] - db)) < 0.08)
            odd_score = sum(1 for db in db_arr if np.min(np.abs(b_arr[1::2] - db)) < 0.08)
            parity = 1 if odd_score > even_score else 0
        else:
            parity = 0
        beats = beats[parity::2]
        bpm *= 0.5
        folded_down = True

    while bpm < 60.0 and len(beats) >= 3:
        doubled: list[float] = []
        for i in range(len(beats) - 1):
            doubled.append(beats[i])
            doubled.append((beats[i] + beats[i + 1]) * 0.5)
        doubled.append(beats[-1])
        beats = doubled
        bpm *= 2.0

    # Fill half-timed quiet intros/outros where Beat This! skipped alternate beats.
    if len(beats) >= 4:
        med_period = 60.0 / max(bpm, 30.0)
        filled: list[float] = []
        for i in range(len(beats) - 1):
            filled.append(beats[i])
            gap = beats[i + 1] - beats[i]
            if 1.65 * med_period <= gap <= 2.45 * med_period:
                filled.append((beats[i] + beats[i + 1]) * 0.5)
        filled.append(beats[-1])
        beats = filled

    # Infer meter from beat count between consecutive raw downbeats.
    meter = [4, 4]
    beats_per_bar = 4
    if len(raw_downbeats) >= 2 and len(beats) >= 4:
        b_arr = np.asarray(beats, dtype=np.float64)
        counts = []
        for i in range(len(raw_downbeats) - 1):
            c = int(np.sum((b_arr >= raw_downbeats[i] - 0.08) & (b_arr < raw_downbeats[i + 1] - 0.08)))
            if 2 <= c <= 7:
                counts.append(c)
        if counts:
            vals, freqs = np.unique(counts, return_counts=True)
            beats_per_bar = int(vals[int(np.argmax(freqs))])
            # When double-time 4/4 was folded down, Beat This! downbeats sit every 2 folded beats;
            # combine pairs into standard 4/4 lead-sheet measures.
            if folded_down and beats_per_bar == 2 and bpm >= 72.0:
                beats_per_bar = 4
            if beats_per_bar == 6:
                meter = [6, 8]
            elif beats_per_bar in (2, 3, 4, 5):
                meter = [beats_per_bar, 4]

    # Phase-lock downbeats to a regular beats_per_bar measure grid so every bar
    # has exact meter[0] beats (no spurious 2-beat or 3-beat glitches).
    if len(beats) >= beats_per_bar:
        b_arr = np.asarray(beats, dtype=np.float64)
        best_phase = 0
        if raw_downbeats:
            db_arr = np.asarray(raw_downbeats, dtype=np.float64)
            best_hits = -1
            for phase in range(beats_per_bar):
                cand = b_arr[phase::beats_per_bar]
                hits = sum(1 for db in db_arr if cand.size and np.min(np.abs(cand - db)) < 0.12)
                if hits > best_hits:
                    best_hits = hits
                    best_phase = phase
        downbeats = [round(float(x), 4) for x in beats[best_phase::beats_per_bar]]
    else:
        downbeats = [round(float(x), 4) for x in raw_downbeats]

    beats = [round(float(x), 4) for x in beats]
    return beats, downbeats, round(bpm, 2), meter


def _transcribe_lead_words(
    lead_wav: Path,
    env: dict[str, str],
    *,
    whisper_model: str,
    device: str,
    initial_prompt: str = "",
) -> tuple[list[dict], list[dict], str]:
    from faster_whisper import WhisperModel
    from huggingface_hub.errors import LocalEntryNotFoundError

    _activate_cuda_libraries()
    samples = _decode_mono_float32(lead_wav, env, 16000)
    if samples.size == 0:
        return [], [], ""

    def _run_whisper(dev: str, ctype: str) -> tuple[list[dict], list[dict], str]:
        try:
            model = WhisperModel(whisper_model, device=dev, compute_type=ctype, local_files_only=True)
        except LocalEntryNotFoundError:
            model = WhisperModel(whisper_model, device=dev, compute_type=ctype)
        try:
            kwargs: dict = {
                "word_timestamps": True,
                "vad_filter": True,
                "beam_size": 5,
                "condition_on_previous_text": False,
            }
            if initial_prompt:
                kwargs["initial_prompt"] = initial_prompt
            segments_iter, info = model.transcribe(samples, **kwargs)
            flat_words: list[dict] = []
            rich_segments: list[dict] = []
            for seg in segments_iter:
                seg_words: list[dict] = []
                for w in seg.words or []:
                    text = str(w.word or "").strip()
                    if not text:
                        continue
                    w_start = round(float(w.start or 0.0), 3)
                    w_end = round(float(w.end or w.start or 0.0), 3)
                    prob = round(float(getattr(w, "probability", 0.6) or 0.0), 3)
                    flat_words.append({"start": w_start, "end": w_end, "word": text})
                    seg_words.append({"start": w_start, "end": w_end, "word": text, "probability": prob})
                seg_text = str(getattr(seg, "text", "") or "").strip()
                if seg_text or seg_words:
                    rich_segments.append(
                        {
                            "start": round(float(seg.start or 0.0), 3),
                            "end": round(float(seg.end or seg.start or 0.0), 3),
                            "text": seg_text,
                            "no_speech_prob": round(float(getattr(seg, "no_speech_prob", 0.0) or 0.0), 3),
                            "words": seg_words,
                        }
                    )
            return flat_words, rich_segments, str(getattr(info, "language", "") or "")
        finally:
            del model
            _release_gpu()

    if device == "cuda":
        try:
            return _run_whisper("cuda", "float16")
        except Exception:
            _release_gpu()
    return _run_whisper("cpu", "int8")


def _extract_melody_notes_game(
    lead_wav: Path,
    *,
    game_repo: Path,
    game_model: Path,
    language: str,
    device: str,
) -> list[dict]:
    if not game_model.exists():
        raise RuntimeError(f"GAME checkpoint not found at {game_model}")
    repo_str = str(game_repo)
    if repo_str not in sys.path:
        sys.path.insert(0, repo_str)

    import logging
    import warnings

    warnings.filterwarnings("ignore")
    logging.getLogger("lightning.pytorch").setLevel(logging.ERROR)
    logging.getLogger("pytorch_lightning").setLevel(logging.ERROR)

    from inference.api import infer_model, load_inference_model
    from inference.callbacks import SaveCombinedFileCallback
    from inference.data import SlicedAudioFileIterableDataset
    from inference.slicer2 import Slicer
    from lib.config.schema import ValidationConfig

    collected: list[dict] = []

    class _MemoryCollector(SaveCombinedFileCallback):
        def flush(self, key, notes, logger_fn) -> None:
            for n in notes:
                dur = float(n.offset) - float(n.onset)
                pitch = float(n.pitch)
                if dur < 0.045 or pitch < 33.0 or pitch > 96.0:
                    continue
                collected.append(
                    {
                        "start": float(n.onset),
                        "end": float(n.offset),
                        "pitch": pitch,
                    }
                )

    # Silence Lightning & config formatter banners so stdout stays pure JSON.
    orig_stdout = sys.stdout
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
    try:
        model, lang_map = load_inference_model(game_model)
        lang_code = language.lower().split("-")[0] if language else ""
        lang_id = int(lang_map.get(lang_code, 0)) if isinstance(lang_map, dict) else 0
        sr = model.inference_config.features.audio_sample_rate

        dataset = SlicedAudioFileIterableDataset(
            filemap={lead_wav.name: lead_wav},
            samplerate=sr,
            slicer=Slicer(
                sr=sr,
                threshold=-48.0,
                min_length=600,
                min_interval=150,
                max_sil_kept=120,
            ),
            language=lang_id,
        )
        collector = _MemoryCollector(output_dir=lead_wav.parent)

        infer_model(
            model=model,
            dataset=dataset,
            config=ValidationConfig(
                d3pm_sample_t0=0.0,
                d3pm_sample_steps=8,
                d3pm_sample_ts=None,
                boundary_decoding_threshold=0.18,
                boundary_decoding_radius=round(0.02 / model.timestep),
                note_presence_threshold=0.15,
            ),
            batch_size=8 if device == "cuda" else 2,
            num_workers=0,
            callbacks=[collector],
        )
    finally:
        sys.stdout.close()
        sys.stdout = orig_stdout

    del model
    _release_gpu()
    collected.sort(key=lambda n: (n["start"], n["end"]))
    return collected


def _extract_cqt_secondary_voices(
    vocals_wav: Path,
    lead_notes: list[dict],
    env: dict[str, str],
) -> list[dict]:
    """Detects simultaneous harmonizing vocal notes on the full Pass-1 vocal stem
    using 36-bin/octave CQT harmonic salience after notching out the lead note's
    fundamental and overtones. Catches equal-volume male/female duets cleanly
    while rejecting solo vibrato and subharmonic octave ghosts."""
    import librosa
    import numpy as np

    if not lead_notes:
        return []
    sr = 22050
    hop = 512
    bins_per_oct = 36
    fmin_midi = 36  # C2
    n_octaves = 5   # up to C7 (MIDI 96)
    n_bins = n_octaves * bins_per_oct

    samples = _decode_mono_float32(vocals_wav, env, sr)
    if samples.size < hop * 4:
        return []

    cqt_mag = np.abs(
        librosa.cqt(
            samples,
            sr=sr,
            hop_length=hop,
            fmin=float(librosa.midi_to_hz(fmin_midi)),
            n_bins=n_bins,
            bins_per_octave=bins_per_oct,
        )
    ).astype(np.float32)
    if cqt_mag.size == 0:
        return []

    n_frames = cqt_mag.shape[1]
    bins_per_semi = bins_per_oct / 12.0  # 3.0
    # Harmonic offsets in bins for h = 1..4 (0, +12, +19.02, +24 semitones)
    harm_offsets = [int(round(12.0 * math.log2(h) * bins_per_semi)) for h in (1, 2, 3, 4)]
    harm_weights = (1.0, 0.58, 0.34, 0.18)
    # Candidate vocal range: G2 (43) .. C6 (84)
    min_cand_bin = int(round((43 - fmin_midi) * bins_per_semi))
    max_cand_bin = min(n_bins - 1, int(round((84 - fmin_midi) * bins_per_semi)))

    # Harmonic intervals to notch around primary pitch p1 (fundamental + overtones 2..6)
    notch_semis = [0.0, 12.0, 19.02, 24.0, 27.86, 31.02]
    notch_radius = int(round(0.85 * bins_per_semi))

    secondary: list[dict] = []
    for note in lead_notes:
        t0 = float(note["start"])
        t1 = float(note["end"])
        dur = t1 - t0
        if dur < 0.14:
            continue
        # Trim onset/offset transients slightly for steady-state pitch analysis
        trim = min(0.03, dur * 0.15)
        f0 = max(0, int(round((t0 + trim) * sr / hop)))
        f1 = min(n_frames, int(round((t1 - trim) * sr / hop)))
        if f1 <= f0:
            f1 = min(n_frames, f0 + 1)
        spec = np.mean(cqt_mag[:, f0:f1], axis=1)

        p1 = float(note["pitch"])
        b1 = int(round((p1 - fmin_midi) * bins_per_semi))
        if not (0 <= b1 < n_bins):
            continue

        # Measure primary fundamental & 4-harmonic salience before notching
        def _salience_at(arr: np.ndarray, b_idx: int) -> float:
            s = 0.0
            for off, wt in zip(harm_offsets, harm_weights):
                bi = b_idx + off
                if 0 <= bi < n_bins:
                    v = float(arr[bi])
                    if bi > 0:
                        v += 0.25 * float(arr[bi - 1])
                    if bi + 1 < n_bins:
                        v += 0.25 * float(arr[bi + 1])
                    s += wt * (v / 1.5)
            return s

        lo1 = max(0, b1 - 2)
        hi1 = min(n_bins, b1 + 3)
        p1_fund = float(np.max(spec[lo1:hi1]))
        p1_sal = _salience_at(spec, b1)
        if p1_fund < 1e-4 or p1_sal < 1e-4:
            continue

        # Notch primary fundamental and its overtones cleanly
        masked = spec.copy()
        for semi in notch_semis:
            nb = int(round((p1 + semi - fmin_midi) * bins_per_semi))
            if 0 <= nb < n_bins:
                masked[max(0, nb - notch_radius) : min(n_bins, nb + notch_radius + 1)] = 0.0

        # Score candidate secondary vocal pitches
        best_bin = -1
        best_score = 0.0
        for b in range(min_cand_bin, max_cand_bin + 1):
            p_cand = fmin_midi + b / bins_per_semi
            diff = abs(p_cand - p1)
            if diff < 2.2 or diff > 19.5:
                continue
            fund = float(masked[b])
            if fund < p1_fund * 0.24:
                continue
            # Guard against subharmonic octave ghosting when a solo soprano sings:
            # require strong true fundamental AND 3rd harmonic (p_cand + 19.02 = p1 + 7.02)
            # before accepting an exact lower octave.
            if abs((p1 - p_cand) - 12.0) < 0.9:
                h3_bin = b + harm_offsets[2]
                h3_val = float(masked[h3_bin]) if 0 <= h3_bin < n_bins else 0.0
                if fund < p1_fund * 0.42 or h3_val < fund * 0.14:
                    continue
            # Also require at least one supporting overtone (h2 or h3) so breath noise never triggers
            h2_bin = b + harm_offsets[1]
            h3_bin = b + harm_offsets[2]
            overtone = max(
                float(masked[h2_bin]) if 0 <= h2_bin < n_bins else 0.0,
                float(masked[h3_bin]) if 0 <= h3_bin < n_bins else 0.0,
            )
            if overtone < fund * 0.12:
                continue
            sal = _salience_at(masked, b)
            if sal > best_score:
                best_score = sal
                best_bin = b

        if best_bin >= 0 and best_score >= p1_sal * 0.28:
            # Parabolic sub-bin interpolation for clean fractional MIDI pitch
            if 0 < best_bin < n_bins - 1:
                y0, y1, y2 = float(masked[best_bin - 1]), float(masked[best_bin]), float(masked[best_bin + 1])
                denom = y0 - 2.0 * y1 + y2
                delta = 0.5 * (y0 - y2) / denom if abs(denom) > 1e-9 else 0.0
                delta = max(-0.5, min(0.5, delta))
            else:
                delta = 0.0
            p2 = fmin_midi + (best_bin + delta) / bins_per_semi
            secondary.append({"start": t0, "end": t1, "pitch": round(p2, 3), "source": "cqt"})

    return secondary


def _assign_polyphonic_voices(
    lead_notes: list[dict],
    harmony_candidates: list[dict],
    *,
    min_pairs_for_polyphony: int = 4,
) -> tuple[list[dict], int]:
    """Combines primary vocal notes with extracted secondary harmony notes.
    Whenever two notes overlap simultaneously by >= 35% of the shorter note and
    differ by >= 2.0 semitones, assigns voice 1 to the higher pitch and voice 2
    to the lower pitch. Keeps solo songs cleanly single-voice (`voiceCount=1`)."""
    primary = [dict(n, voice=1) for n in lead_notes]
    if not primary or not harmony_candidates:
        return primary, 1

    # Filter out harmony candidates that duplicate an overlapping primary note (unison/vibrato)
    # or duplicate another accepted harmony candidate at the same time.
    accepted_pairs: list[tuple[int, dict]] = []
    for cand in sorted(harmony_candidates, key=lambda n: (n["start"], n["end"])):
        c0, c1, cp = float(cand["start"]), float(cand["end"]), float(cand["pitch"])
        cdur = c1 - c0
        if cdur < 0.08:
            continue
        best_idx = -1
        best_ov = 0.0
        too_close_pitch = False
        for idx, pn in enumerate(primary):
            ov = min(c1, float(pn["end"])) - max(c0, float(pn["start"]))
            if ov <= 0.0:
                continue
            pdur = float(pn["end"]) - float(pn["start"])
            if ov >= 0.30 * min(cdur, pdur):
                if abs(cp - float(pn["pitch"])) < 2.0:
                    too_close_pitch = True
                    break
                if ov > best_ov:
                    best_ov = ov
                    best_idx = idx
        if too_close_pitch or best_idx < 0:
            continue
        # Avoid stacking two harmony notes onto the same primary note
        if any(p_idx == best_idx for p_idx, _ in accepted_pairs):
            continue
        accepted_pairs.append((best_idx, {"start": c0, "end": c1, "pitch": cp, "voice": 2}))

    if len(accepted_pairs) < min_pairs_for_polyphony:
        return primary, 1

    # Assign upper pitch = voice 1, lower pitch = voice 2 for every simultaneous pair
    extras: list[dict] = []
    for p_idx, harm in accepted_pairs:
        pn = primary[p_idx]
        if harm["pitch"] > pn["pitch"]:
            pn["voice"] = 2
            harm["voice"] = 1
        else:
            pn["voice"] = 1
            harm["voice"] = 2
        extras.append(harm)

    combined = primary + extras
    combined.sort(key=lambda n: (n["start"], -n["pitch"], n["end"]))
    return combined, 2


def _estimate_tuning_semitones(notes: list[dict]) -> float:
    """Circular weighted mean of fractional semitone deviations across held vocal notes."""
    if not notes:
        return 0.0
    sin_sum = 0.0
    cos_sum = 0.0
    weight_sum = 0.0
    for n in notes:
        dur = n["end"] - n["start"]
        if dur < 0.12:
            continue
        frac = n["pitch"] - round(n["pitch"])  # [-0.5, 0.5]
        angle = frac * 2.0 * math.pi
        sin_sum += dur * math.sin(angle)
        cos_sum += dur * math.cos(angle)
        weight_sum += dur
    if weight_sum <= 0.0:
        return 0.0
    coherence = math.hypot(sin_sum, cos_sum) / weight_sum
    if coherence < 0.25:
        return 0.0
    offset = math.atan2(sin_sum, cos_sum) / (2.0 * math.pi)
    return float(max(-0.48, min(0.48, offset)))


def _detect_song_key(mix_wav: Path, env: dict[str, str], notes: list[dict], tuning_semitones: float) -> dict:
    import numpy as np

    sr = 11025
    win = 8192
    hop = sr // 2
    samples = _decode_mono_float32(mix_wav, env, sr)
    mix_chroma = np.zeros(12, dtype=np.float64)

    if samples.size >= win:
        hann = np.hanning(win).astype(np.float32)
        freqs = np.fft.rfftfreq(win, d=1.0 / sr)
        mask = (freqs >= 65.0) & (freqs <= 2100.0)
        bins = np.nonzero(mask)[0]
        midis = 69.0 + 12.0 * np.log2(freqs[bins] / 440.0) - tuning_semitones
        nearest = np.round(midis).astype(np.int64)
        pcs = np.mod(nearest, 12)
        weights = np.cos(np.pi * (midis - nearest)) ** 2

        for start in range(0, samples.size - win + 1, hop):
            seg = samples[start : start + win]
            rms = float(np.sqrt(np.mean(seg * seg)))
            if rms < 0.003:
                continue
            mag = np.abs(np.fft.rfft(seg * hann))[bins]
            frame = np.zeros(12, dtype=np.float64)
            np.add.at(frame, pcs, weights * mag)
            tot = float(frame.sum())
            if tot > 0:
                mix_chroma += frame / tot

    vocal_chroma = np.zeros(12, dtype=np.float64)
    for n in notes:
        dur = max(0.0, n["end"] - n["start"])
        pc = int(round(n["pitch"])) % 12
        vocal_chroma[pc] += dur

    if mix_chroma.sum() > 0:
        mix_chroma /= mix_chroma.sum()
    if vocal_chroma.sum() > 0:
        vocal_chroma /= vocal_chroma.sum()

    if mix_chroma.sum() > 0 and vocal_chroma.sum() > 0:
        chroma = 0.70 * mix_chroma + 0.30 * vocal_chroma
    elif vocal_chroma.sum() > 0:
        chroma = vocal_chroma
    else:
        chroma = mix_chroma

    def _corr(profile: list[float], root: int) -> float:
        p = np.asarray(profile, dtype=np.float64)
        c = np.roll(chroma, -root)
        c_z = c - c.mean()
        p_z = p - p.mean()
        denom = math.sqrt(float(np.sum(c_z * c_z) * np.sum(p_z * p_z)))
        return float(np.sum(c_z * p_z) / denom) if denom > 0 else 0.0

    scored = []
    for root in range(12):
        scored.append({"root": root, "type": "major", "score": _corr(_MAJOR_PROFILE, root)})
        scored.append({"root": root, "type": "minor", "score": _corr(_MINOR_PROFILE, root)})
    scored.sort(key=lambda x: x["score"], reverse=True)
    best = scored[0]
    rel_root = (best["root"] + 9) % 12 if best["type"] == "major" else (best["root"] + 3) % 12
    rival = next(k for k in scored[1:] if not (k["root"] == rel_root and k["type"] != best["type"]))
    return {
        "root": int(best["root"]),
        "type": str(best["type"]),
        "margin": round(float(best["score"] - rival["score"]), 4),
    }


_SHARP_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"]
_FLAT_NAMES = ["C", "Db", "D", "Eb", "E", "F", "Gb", "G", "Ab", "A", "Bb", "B"]
_FLAT_MAJOR_ROOTS = frozenset((1, 3, 5, 6, 8, 10))
_FLAT_MINOR_ROOTS = frozenset((0, 2, 5, 7, 10))


def _chord_root_name(pc: int, key: dict) -> str:
    use_flats = (
        key.get("root") in _FLAT_MAJOR_ROOTS
        if key.get("type") == "major"
        else key.get("root") in _FLAT_MINOR_ROOTS
    )
    return (_FLAT_NAMES if use_flats else _SHARP_NAMES)[pc % 12]


def _detect_chords(
    mix_wav: Path,
    env: dict[str, str],
    beats: list[float],
    downbeats: list[float],
    meter: list[int],
    key: dict,
    tuning_semitones: float,
) -> list[dict]:
    """Beat-synchronous mix chroma chord recognizer for piano lead sheets (CPU, <0.2 s)."""
    import numpy as np

    if len(downbeats) < 2:
        return []

    sr = 11025
    win = 4096
    samples = _decode_mono_float32(mix_wav, env, sr)
    if samples.size < win:
        return []

    beats_per_bar = meter[0] if meter else 4
    # Evaluate chords per bar (3/4, 2/4) or half-bar (4/4, 6/8) for clean lead-sheet rhythm.
    slots_per_bar = 2 if beats_per_bar in (4, 6) else 1
    slot_beats = beats_per_bar / slots_per_bar

    segments: list[tuple[int, float, float, float]] = []
    for bar_idx in range(len(downbeats) - 1):
        bar_start = downbeats[bar_idx]
        bar_end = downbeats[bar_idx + 1]
        if bar_end <= bar_start + 0.25:
            continue
        for s_idx in range(slots_per_bar):
            t0 = bar_start + (bar_end - bar_start) * (s_idx / slots_per_bar)
            t1 = bar_start + (bar_end - bar_start) * ((s_idx + 1) / slots_per_bar)
            segments.append((bar_idx + 1, s_idx * slot_beats, t0, t1))

    if not segments:
        return []

    hann = np.hanning(win).astype(np.float32)
    freqs = np.fft.rfftfreq(win, d=1.0 / sr)
    mask = (freqs >= 65.0) & (freqs <= 1600.0)
    bins = np.nonzero(mask)[0]
    midis = 69.0 + 12.0 * np.log2(freqs[bins] / 440.0) - tuning_semitones
    nearest = np.round(midis).astype(np.int64)
    pcs = np.mod(nearest, 12)
    weights = np.cos(np.pi * (midis - nearest)) ** 2

    # Build 24 triad templates (12 major + 12 minor) plus 12 dominant-7th templates.
    qualities = [
        ("major", "", [0, 4, 7], [1.0, 0.85, 0.90]),
        ("minor", "m", [0, 3, 7], [1.0, 0.85, 0.90]),
        ("7", "7", [0, 4, 7, 10], [1.0, 0.80, 0.82, 0.65]),
    ]
    key_root = int(key.get("root", 0))
    scale_pcs = (
        {(key_root + s) % 12 for s in (0, 2, 4, 5, 7, 9, 11)}
        if key.get("type") == "major"
        else {(key_root + s) % 12 for s in (0, 2, 3, 5, 7, 8, 10)}
    )

    templates = []
    meta = []
    for root in range(12):
        for q_name, q_suffix, ivs, wts in qualities:
            vec = np.zeros(12, dtype=np.float64)
            for iv, wt in zip(ivs, wts):
                vec[(root + iv) % 12] = wt
            vec /= np.linalg.norm(vec)
            diatonic = all(((root + iv) % 12) in scale_pcs for iv in ivs[:3])
            prior = 0.05 if diatonic else 0.0
            if q_name == "7":
                # Prefer triads unless dominant 7th stands out clearly.
                prior -= 0.045
            templates.append(vec)
            meta.append((root, q_name, f"{_chord_root_name(root, key)}{q_suffix}", prior))

    T = np.asarray(templates, dtype=np.float64)  # (C, 12)
    priors = np.asarray([m[3] for m in meta], dtype=np.float64)
    n_chords = len(meta)
    n_segs = len(segments)

    # Compute chroma per slot.
    scores = np.zeros((n_segs, n_chords), dtype=np.float64)
    energies = np.zeros(n_segs, dtype=np.float64)
    for i, (_bar, _b_in_bar, t0, t1) in enumerate(segments):
        s0 = max(0, int(t0 * sr))
        s1 = min(samples.size, int(t1 * sr))
        if s1 - s0 < 512:
            continue
        seg = samples[s0:s1]
        rms = float(np.sqrt(np.mean(seg * seg)))
        energies[i] = rms
        if rms < 0.004:
            continue
        chroma = np.zeros(12, dtype=np.float64)
        step = max(512, win // 2)
        if seg.size < win:
            padded = np.zeros(win, dtype=np.float32)
            padded[: seg.size] = seg
            mag = np.abs(np.fft.rfft(padded * hann))[bins]
            np.add.at(chroma, pcs, weights * mag)
        else:
            for pos in range(0, seg.size - win + 1, step):
                mag = np.abs(np.fft.rfft(seg[pos : pos + win] * hann))[bins]
                np.add.at(chroma, pcs, weights * mag)
        norm = float(np.linalg.norm(chroma))
        if norm > 1e-6:
            scores[i] = (T @ (chroma / norm)) + priors

    # Viterbi smoothing across slots: stay penalty prevents noisy chord flutter.
    dp = np.zeros((n_segs, n_chords), dtype=np.float64)
    back = np.zeros((n_segs, n_chords), dtype=np.int32)
    dp[0] = scores[0]
    for i in range(1, n_segs):
        is_barline = segments[i][1] == 0.0
        # Stronger reluctance to change mid-bar than on a fresh barline.
        change_pen = 0.09 if is_barline else 0.17
        best_prev = int(np.argmax(dp[i - 1]))
        best_prev_val = dp[i - 1, best_prev]
        for c in range(n_chords):
            stay = dp[i - 1, c]
            switch = best_prev_val - change_pen
            if stay >= switch:
                dp[i, c] = stay + scores[i, c]
                back[i, c] = c
            else:
                dp[i, c] = switch + scores[i, c]
                back[i, c] = best_prev

    path = [0] * n_segs
    path[-1] = int(np.argmax(dp[-1]))
    for i in range(n_segs - 2, -1, -1):
        path[i] = int(back[i + 1, path[i + 1]])

    chords: list[dict] = []
    last_sym = None
    for i, c_idx in enumerate(path):
        bar, beat_in_bar, t0, t1 = segments[i]
        if energies[i] < 0.004:
            last_sym = None
            continue
        root, quality, symbol, _ = meta[c_idx]
        # Skip repeating the exact same chord mid-bar; repeat only on barline if changed.
        if symbol == last_sym and beat_in_bar > 0:
            continue
        if symbol == last_sym and beat_in_bar == 0:
            continue
        last_sym = symbol
        chords.append(
            {
                "bar": int(bar),
                "beatInBar": round(float(beat_in_bar), 2),
                "start": round(float(t0), 3),
                "end": round(float(t1), 3),
                "root": int(root),
                "quality": quality,
                "symbol": symbol,
            }
        )
    return chords


def _quantize_notes_to_beats(
    notes: list[dict],
    beats: list[float],
    downbeats: list[float],
    bpm: float,
    meter: list[int],
    words: list[dict],
) -> list[dict]:
    if not notes:
        return []

    sec_per_beat = 60.0 / max(30.0, bpm)
    beats_per_bar = meter[0] if meter else 4

    def _time_to_beat(t: float) -> float:
        if len(beats) < 2:
            return t / sec_per_beat
        if t <= beats[0]:
            period = max(0.2, beats[1] - beats[0])
            return (t - beats[0]) / period
        if t >= beats[-1]:
            period = max(0.2, beats[-1] - beats[-2])
            return (len(beats) - 1) + (t - beats[-1]) / period
        lo, hi = 0, len(beats) - 1
        while lo + 1 < hi:
            mid = (lo + hi) // 2
            if beats[mid] <= t:
                lo = mid
            else:
                hi = mid
        span = max(1e-4, beats[hi] - beats[lo])
        return lo + (t - beats[lo]) / span

    # Build downbeat beat indices so bar numbers follow actual detected measures.
    downbeat_beats = [_time_to_beat(db) for db in downbeats]

    def _bar_at_beat(b: float) -> int:
        if downbeat_beats:
            bar = 0
            for db_b in downbeat_beats:
                if b >= db_b - 0.12:
                    bar += 1
                else:
                    break
            return bar
        return max(0, int(math.floor(b / max(1, beats_per_bar))))

    # Decide straight (1/4 beat) vs triplet (1/3 beat) grid for the song.
    straight_err = 0.0
    triplet_err = 0.0
    total_w = 0.0
    for n in notes:
        b = _time_to_beat(n["start"])
        w = max(0.05, n["end"] - n["start"])
        straight_err += w * abs(b - round(b * 4.0) / 4.0)
        triplet_err += w * abs(b - round(b * 3.0) / 3.0)
        total_w += w
    use_triplet = total_w > 0 and (triplet_err * 1.15 < straight_err)
    grid_step = (1.0 / 3.0) if use_triplet else 0.25

    word_starts = [w["start"] for w in words]

    def _has_word_boundary_between(t1: float, t2: float) -> bool:
        for ws in word_starts:
            if t1 - 0.03 < ws < t2 + 0.03:
                return True
        return False

    # Merge tiny accidental same-pitch splits (< 45 ms gap with no new word onset)
    # strictly within the same voice so harmonizing voice 1 / voice 2 lines stay distinct.
    merged: list[dict] = []
    last_by_voice: dict[int, dict] = {}
    for n in notes:
        v = int(n.get("voice", 1) or 1)
        prev = last_by_voice.get(v)
        if (
            prev is not None
            and abs(round(n["pitch"]) - round(prev["pitch"])) == 0
            and (n["start"] - prev["end"]) < 0.045
            and not _has_word_boundary_between(prev["end"], n["start"])
        ):
            d1 = prev["end"] - prev["start"]
            d2 = n["end"] - n["start"]
            prev["pitch"] = (prev["pitch"] * d1 + n["pitch"] * d2) / max(1e-5, d1 + d2)
            prev["end"] = n["end"]
        else:
            item = dict(n)
            item["voice"] = v
            merged.append(item)
            last_by_voice[v] = item

    has_multi_voice = any(int(n.get("voice", 1) or 1) >= 2 for n in merged)
    quantized: list[dict] = []
    for idx, n in enumerate(merged, start=1):
        b_start_raw = _time_to_beat(n["start"])
        b_end_raw = _time_to_beat(n["end"])
        b_start = round(b_start_raw / grid_step) * grid_step
        dur_raw = max(grid_step, b_end_raw - b_start_raw)
        dur_beats = max(grid_step, round(dur_raw / grid_step) * grid_step)
        dur_beats = min(6.0, dur_beats)
        is_triplet = use_triplet and abs(dur_beats * 3.0 - round(dur_beats * 3.0)) < 0.05 and abs(dur_beats * 4.0 - round(dur_beats * 4.0)) > 0.1
        v = int(n.get("voice", 1) or 1)
        quantized.append(
            {
                "id": idx,
                "start": round(float(n["start"]), 3),
                "end": round(float(n["end"]), 3),
                "pitch": round(float(n["pitch"]), 3),
                "beat": round(float(b_start), 3),
                "durBeats": round(float(dur_beats), 3),
                "bar": _bar_at_beat(b_start),
                **({"voice": v} if has_multi_voice else {}),
                **({"triplet": True} if is_triplet else {}),
            }
        )
    return quantized


def _weighted_median_midi(notes: list[dict]) -> float:
    if not notes:
        return 64.0
    pairs = sorted((float(n["pitch"]), max(0.02, float(n["end"]) - float(n["start"]))) for n in notes)
    half = sum(w for _, w in pairs) / 2.0
    acc = 0.0
    for pitch, w in pairs:
        acc += w
        if acc >= half:
            return round(pitch, 2)
    return round(pairs[-1][0], 2)


def _analyze_audio(
    audio_path: Path,
    *,
    video_id: str,
    env: dict[str, str],
    game_repo: Path,
    game_model: Path,
    separator_dir: Path,
    vocal_model: str,
    karaoke_model: str,
    two_pass: bool,
    whisper_model: str,
    device_arg: str,
    quality: str = "standard",
    initial_prompt: str = "",
    keep_stems: Path | None,
) -> dict:
    import torch

    t0 = time.monotonic()
    timings: dict[str, float] = {}
    device = "cuda" if (device_arg in ("auto", "cuda") and torch.cuda.is_available()) else "cpu"
    duration = _probe_duration(audio_path, env)

    with tempfile.TemporaryDirectory(prefix="lyrics-score-work-") as work_str:
        work_dir = Path(work_str)
        mix_wav = _convert_wav(audio_path, work_dir / "mix.wav", env, rate=44100, channels=2)

        # 1. Isolate lead vocal + keep full Pass-1 vocal stem & backing residual for duet/harmony extraction
        _emit_stage("separate")
        ts = time.monotonic()
        lead_wav, vocals_wav, backing_wav = _separate_lead_vocal(
            mix_wav,
            work_dir,
            separator_dir,
            vocal_model=vocal_model,
            karaoke_model=karaoke_model,
            two_pass=two_pass,
            quality=quality,
        )
        timings["separate"] = round(time.monotonic() - ts, 2)
        if keep_stems is not None:
            keep_stems.mkdir(parents=True, exist_ok=True)
            shutil.copy2(lead_wav, keep_stems / f"{video_id or 'audio'}-lead.wav")
            if vocals_wav != lead_wav and vocals_wav.exists():
                shutil.copy2(vocals_wav, keep_stems / f"{video_id or 'audio'}-vocals.wav")
            if backing_wav is not None and backing_wav.exists():
                shutil.copy2(backing_wav, keep_stems / f"{video_id or 'audio'}-backing.wav")

        # 2. Beat & downbeat tracking on full mix
        _emit_stage("beats")
        ts = time.monotonic()
        beats, downbeats, bpm, meter = _track_beats(mix_wav, device)
        timings["beats"] = round(time.monotonic() - ts, 2)

        # 3. Clean word timestamps + full transcript segments + language detection on isolated lead vocal
        _emit_stage("words")
        ts = time.monotonic()
        words, segments, language = _transcribe_lead_words(
            lead_wav,
            env,
            whisper_model=whisper_model,
            device=device,
            initial_prompt=initial_prompt,
        )
        timings["words"] = round(time.monotonic() - ts, 2)

        # 4. Discrete singing-voice note extraction with GAME large
        _emit_stage("melody")
        ts = time.monotonic()
        lead_notes = _extract_melody_notes_game(
            lead_wav,
            game_repo=game_repo,
            game_model=game_model,
            language=language,
            device=device,
        )
        timings["melody"] = round(time.monotonic() - ts, 2)

        # 4b. Polyphonic / harmonizing second-voice extraction (backing-vocal GAME + CQT harmonic cancellation)
        _emit_stage("harmony")
        ts = time.monotonic()
        harmony_candidates: list[dict] = []
        if backing_wav is not None and backing_wav.exists():
            try:
                backing_notes = _extract_melody_notes_game(
                    backing_wav,
                    game_repo=game_repo,
                    game_model=game_model,
                    language=language,
                    device=device,
                )
                harmony_candidates.extend(backing_notes)
            except Exception:
                pass
        try:
            cqt_harmony = _extract_cqt_secondary_voices(vocals_wav, lead_notes, env)
            harmony_candidates.extend(cqt_harmony)
        except Exception:
            pass
        raw_notes, voice_count = _assign_polyphonic_voices(lead_notes, harmony_candidates)
        timings["harmony"] = round(time.monotonic() - ts, 2)

        # 5. Global tuning offset, key/scale detection, and beat quantization
        _emit_stage("quantize")
        ts = time.monotonic()
        tuning_semi = _estimate_tuning_semitones(raw_notes)
        for n in raw_notes:
            n["pitch"] -= tuning_semi
        key = _detect_song_key(mix_wav, env, raw_notes, tuning_semi)
        chords = _detect_chords(mix_wav, env, beats, downbeats, meter, key, tuning_semi)
        notes = _quantize_notes_to_beats(raw_notes, beats, downbeats, bpm, meter, words)
        median_midi = _weighted_median_midi(notes)
        timings["quantize"] = round(time.monotonic() - ts, 2)
        timings["total"] = round(time.monotonic() - t0, 2)

    return {
        "ok": True,
        "version": 2,
        "quality": quality,
        "videoId": video_id,
        "duration": round(duration, 3),
        "bpm": bpm,
        "meter": meter,
        "tuningCents": round(tuning_semi * 100.0, 1),
        "key": key,
        "medianMidi": median_midi,
        "voiceCount": voice_count,
        "language": language,
        "beats": beats,
        "downbeats": downbeats,
        "chords": chords,
        "notes": notes,
        "words": words,
        "segments": segments,
        "timings": timings,
    }


def _run_under_gpu_gate(
    worker_cmd: list[str],
    gpu_gate: dict,
    env: dict[str, str],
) -> tuple[int, str, str]:
    gate_bin = str(gpu_gate.get("command") or "gpu")
    resolved = shutil.which(gate_bin, path=env["PATH"])
    if not resolved:
        raise RuntimeError(f"GPU gate command not found: {gate_bin}")
    cmd = [
        resolved,
        "run",
        "--name",
        str(gpu_gate.get("name") or "Lyrics overlay score"),
        "--what",
        str(gpu_gate.get("what") or "Vocal separation + GAME melody"),
        "--gb",
        str(gpu_gate.get("gb", 8)),
        "--lane",
        str(gpu_gate.get("lane") or "now"),
        "--minutes",
        str(gpu_gate.get("minutes", 4)),
        "--wait",
        str(gpu_gate.get("waitMinutes", 2)),
        "--",
        *worker_cmd,
    ]

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
    stdout_chunks: list[str] = []
    stderr_lines: list[str] = []

    def _drain_stdout() -> None:
        assert proc.stdout is not None
        try:
            stdout_chunks.append(proc.stdout.read())
        finally:
            proc.stdout.close()

    out_thread = threading.Thread(target=_drain_stdout, daemon=True)
    out_thread.start()
    try:
        assert proc.stderr is not None
        for line in proc.stderr:
            stripped = line.strip()
            if stripped.startswith("stage:"):
                print(stripped, file=sys.stderr, flush=True)
                continue
            wait_match = _GPU_WAIT_RE.search(stripped)
            if wait_match:
                _emit_stage(f"gpu-wait:{wait_match.group(1).strip()}")
            stderr_lines.append(line)
        proc.stderr.close()
        out_thread.join()
        code = proc.wait()
        return code, "".join(stdout_chunks), "".join(stderr_lines)
    finally:
        _ACTIVE_CHILD = None


def _default_game_repo() -> Path:
    return Path(__file__).resolve().parent.parent / ".venv-score" / "GAME"


def _default_game_model() -> Path:
    return Path.home() / ".cache" / "lyrics-overlay" / "models" / "game" / "large" / "GAME-1.0-large" / "model.pt"


def _default_separator_dir() -> Path:
    return Path.home() / ".cache" / "lyrics-overlay" / "models" / "audio-separator"


def main() -> int:
    _install_signal_handlers()
    parser = argparse.ArgumentParser(description="Extract lead-vocal rough sheet music score JSON")
    parser.add_argument("--video-id", default="", help="YouTube video ID")
    parser.add_argument("--audio-file", default="", help="Existing local audio file (skips download)")
    parser.add_argument("--analyze-audio", default="", help="Internal worker: run GPU analysis directly on audio file")
    parser.add_argument("--ytarchive-url", default="", help="Optional ytarchive base URL for cached soundtrack")
    parser.add_argument("--cookies-from-browser", default="", help="Optional browser name for yt-dlp cookies")
    parser.add_argument("--max-duration", type=float, default=900.0, help="Skip videos longer than this (0 = no cap)")
    parser.add_argument("--device", default="auto", choices=("auto", "cuda", "cpu"))
    parser.add_argument("--whisper-model", default="large-v3")
    parser.add_argument("--vocal-model", default=DEFAULT_VOCAL_MODEL)
    parser.add_argument("--karaoke-model", default=DEFAULT_KARAOKE_MODEL)
    parser.add_argument("--single-pass", action="store_true", help="Use single-pass karaoke separation instead of 2-pass")
    parser.add_argument("--quality", default="standard", choices=("standard", "high"), help="Separation quality tier")
    parser.add_argument("--prompt-file", default="", help="Optional UTF-8 file with reference lyrics/song hint for Whisper")
    parser.add_argument("--fresh-audio", action="store_true", help="Skip cached ytarchive audio and re-download fresh audio")
    parser.add_argument("--game-repo", default=str(_default_game_repo()))
    parser.add_argument("--game-model", default=str(_default_game_model()))
    parser.add_argument("--separator-dir", default=str(_default_separator_dir()))
    parser.add_argument("--gpu-gate-json", default="", help="Optional JSON GPU gate config")
    parser.add_argument("--keep-stems", default="", help="Optional dir to keep lead vocal WAV for debugging")
    args = parser.parse_args()

    env = _augmented_env()
    keep_stems = Path(args.keep_stems) if args.keep_stems else None
    initial_prompt = ""
    if args.prompt_file:
        try:
            initial_prompt = Path(args.prompt_file).read_text(encoding="utf-8", errors="ignore").strip()[:1200]
        except OSError:
            initial_prompt = ""

    if args.analyze_audio:
        real_stdout = sys.stdout
        devnull = open(os.devnull, "w", encoding="utf-8")
        sys.stdout = devnull
        try:
            result = _analyze_audio(
                Path(args.analyze_audio),
                video_id=args.video_id,
                env=env,
                game_repo=Path(args.game_repo),
                game_model=Path(args.game_model),
                separator_dir=Path(args.separator_dir),
                vocal_model=args.vocal_model,
                karaoke_model=args.karaoke_model,
                two_pass=not args.single_pass,
                whisper_model=args.whisper_model,
                device_arg=args.device,
                quality=args.quality,
                initial_prompt=initial_prompt,
                keep_stems=keep_stems,
            )
            real_stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
            real_stdout.flush()
            return 0
        except Exception as exc:
            real_stdout.write(json.dumps({"ok": False, "error": str(exc)}) + "\n")
            real_stdout.flush()
            return 1
        finally:
            sys.stdout = real_stdout
            devnull.close()

    if not args.audio_file and not args.video_id:
        print(json.dumps({"ok": False, "error": "need --video-id or --audio-file"}), flush=True)
        return 1

    with tempfile.TemporaryDirectory(prefix="lyrics-score-dl-") as dl_str:
        dl_dir = Path(dl_str)
        try:
            if args.audio_file:
                audio_path = Path(args.audio_file)
                if not audio_path.is_file():
                    raise RuntimeError(f"audio file not found: {audio_path}")
            else:
                _emit_stage("audio")
                cached_target = dl_dir / "soundtrack.mp3"
                if (not args.fresh_audio) and args.ytarchive_url and _fetch_ytarchive_audio(args.ytarchive_url, args.video_id, cached_target):
                    audio_path = cached_target
                else:
                    audio_path = _download_youtube_audio(
                        args.video_id,
                        dl_dir,
                        env,
                        cookies_from_browser=args.cookies_from_browser,
                        allow_large=args.max_duration <= 0,
                    )

            duration = _probe_duration(audio_path, env)
            if args.max_duration > 0 and duration > args.max_duration:
                mins = round(args.max_duration / 60)
                print(
                    json.dumps(
                        {
                            "ok": False,
                            "skip": True,
                            "error": f"Video is longer than {mins} minutes",
                        }
                    ),
                    flush=True,
                )
                return 0

            if args.gpu_gate_json:
                gpu_gate = json.loads(args.gpu_gate_json)
                worker_cmd = [
                    sys.executable,
                    str(Path(__file__).resolve()),
                    "--analyze-audio",
                    str(audio_path),
                    f"--video-id={args.video_id}",
                    "--device",
                    args.device,
                    "--whisper-model",
                    args.whisper_model,
                    "--vocal-model",
                    args.vocal_model,
                    "--karaoke-model",
                    args.karaoke_model,
                    "--game-repo",
                    args.game_repo,
                    "--game-model",
                    args.game_model,
                    "--separator-dir",
                    args.separator_dir,
                    "--quality",
                    args.quality,
                ]
                if args.prompt_file:
                    worker_cmd.extend(["--prompt-file", args.prompt_file])
                if args.single_pass:
                    worker_cmd.append("--single-pass")
                if args.keep_stems:
                    worker_cmd.extend(["--keep-stems", args.keep_stems])
                _emit_stage("gpu-wait")
                code, stdout, stderr = _run_under_gpu_gate(worker_cmd, gpu_gate, env)
                if code == 75:
                    print(json.dumps({"ok": False, "busy": True, "error": "GPU is busy"}), flush=True)
                    return 0
                if stdout.strip():
                    print(stdout.strip(), flush=True)
                    return 0 if code == 0 else 1
                raise RuntimeError(_last_error_line(stderr, code))

            result = _analyze_audio(
                audio_path,
                video_id=args.video_id,
                env=env,
                game_repo=Path(args.game_repo),
                game_model=Path(args.game_model),
                separator_dir=Path(args.separator_dir),
                vocal_model=args.vocal_model,
                karaoke_model=args.karaoke_model,
                two_pass=not args.single_pass,
                whisper_model=args.whisper_model,
                device_arg=args.device,
                quality=args.quality,
                initial_prompt=initial_prompt,
                keep_stems=keep_stems,
            )
            print(json.dumps(result, ensure_ascii=False), flush=True)
            return 0
        except Exception as exc:
            print(json.dumps({"ok": False, "error": str(exc)}), flush=True)
            return 1


if __name__ == "__main__":
    raise SystemExit(main())
