#!/usr/bin/env bash
# Sets up the optional isolated Python 3.12 environment (.venv-score) and
# pre-caches the open-source models used by service/generate-score.py:
#   1. BS-RoFormer (vocals/instrumental) + Mel-Band RoFormer Karaoke (lead vocal)
#   2. Beat This! (final0) beat + downbeat tracker
#   3. faster-whisper large-v3 word timestamps (cached on first run or pre-fetched)
#   4. openvpi GAME-1.0-large vocal MIDI note transcription
#
# Re-runnable; skips steps already present on disk.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VENV="$ROOT/.venv-score"
CACHE_ROOT="${XDG_CACHE_HOME:-$HOME/.cache}/lyrics-overlay/models"
SEP_DIR="$CACHE_ROOT/audio-separator"
GAME_DIR="$CACHE_ROOT/game/large"
GAME_REPO="$VENV/GAME"

PYTHON_BIN="${PYTHON_BIN:-python3.12}"
if ! command -v "$PYTHON_BIN" >/dev/null 2>&1; then
    PYTHON_BIN="python3"
fi

echo "[score] Using Python: $($PYTHON_BIN --version)"
if [[ ! -x "$VENV/bin/python" ]]; then
    echo "[score] Creating $VENV ..."
    "$PYTHON_BIN" -m venv "$VENV"
fi

"$VENV/bin/pip" install --upgrade pip wheel setuptools
echo "[score] Installing PyTorch + audio/MIDI pipeline packages ..."
"$VENV/bin/pip" install \
    torch torchaudio \
    numpy scipy librosa audioread soundfile \
    "audio-separator[gpu]" \
    faster-whisper \
    nvidia-cublas-cu12 nvidia-cudnn-cu12 \
    einops rotary-embedding-torch soxr \
    transformers lightning omegaconf click tqdm \
    git+https://github.com/CPJKU/beat_this.git

if [[ ! -d "$GAME_REPO/.git" ]]; then
    echo "[score] Cloning openvpi/GAME (v1.0.3) into $GAME_REPO ..."
    git clone --depth 1 --branch v1.0.3 https://github.com/openvpi/GAME.git "$GAME_REPO"
fi

mkdir -p "$SEP_DIR" "$GAME_DIR"

if [[ ! -d "$GAME_DIR/GAME-1.0-large" ]]; then
    echo "[score] Downloading GAME-1.0-large checkpoint ..."
    ARCHIVE="$GAME_DIR/GAME-1.0-large.zip"
    curl -L --fail --progress-bar \
        -o "$ARCHIVE" \
        "https://github.com/openvpi/GAME/releases/download/v1.0.0/GAME-1.0-large.zip"
    python3 -m zipfile -e "$ARCHIVE" "$GAME_DIR"
    rm -f "$ARCHIVE"
fi

echo "[score] Pre-caching audio-separator & Beat This! checkpoints ..."
"$VENV/bin/python" - <<'PY'
import os
import pathlib
from audio_separator.separator import Separator
from beat_this.inference import load_checkpoint

sep_dir = str(pathlib.Path(os.environ.get("XDG_CACHE_HOME", pathlib.Path.home() / ".cache")) / "lyrics-overlay/models/audio-separator")
os.makedirs(sep_dir, exist_ok=True)
sep = Separator(model_file_dir=sep_dir, output_dir="/tmp")
for model in [
    "model_bs_roformer_ep_317_sdr_12.9755.ckpt",
    "mel_band_roformer_karaoke_becruily.ckpt",
]:
    try:
        sep.download_model_files(model)
        print("Cached", model, flush=True)
    except Exception as exc:
        print("Warning:", model, exc, flush=True)
        if "becruily" in model:
            alt = "mel_band_roformer_karaoke_aufr33_viperx_sdr_10.1956.ckpt"
            sep.download_model_files(alt)
            print("Cached fallback", alt, flush=True)

load_checkpoint("final0", device="cpu")
print("Cached beat_this final0", flush=True)
PY

echo "[score] Done! Configure scoreGenerator in settings.json to point at $VENV/bin/python and $ROOT/service/generate-score.py."
