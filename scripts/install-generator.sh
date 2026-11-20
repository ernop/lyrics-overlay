#!/usr/bin/env bash
# Optional setup for local automatic lyric timing (Whisper via faster-whisper).
# Creates a local .venv inside this checkout and configures lyricsGenerator
# in settings.json without touching system Python packages.
#
#   scripts/install-generator.sh [--cpu]
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cpu_only=0
if [ "${1:-}" = "--cpu" ]; then
    cpu_only=1
fi

missing=()
command -v python3 >/dev/null || missing+=("python3")
command -v yt-dlp >/dev/null || missing+=("yt-dlp")
command -v ffmpeg >/dev/null || missing+=("ffmpeg")
if [ "${#missing[@]}" -gt 0 ]; then
    echo "Missing: ${missing[*]}. Install them first (yt-dlp, ffmpeg, python3)." >&2
    exit 1
fi

packages=("faster-whisper")
if [ "$cpu_only" = 0 ] && command -v nvidia-smi >/dev/null 2>&1; then
    packages+=("nvidia-cublas-cu12" "nvidia-cudnn-cu12")
fi

if command -v uv >/dev/null 2>&1; then
    uv venv "$repo/.venv"
    uv pip install --python "$repo/.venv/bin/python" "${packages[@]}"
else
    python3 -m venv "$repo/.venv"
    "$repo/.venv/bin/pip" install --upgrade pip
    "$repo/.venv/bin/pip" install "${packages[@]}"
fi

if [ ! -f "$repo/settings.json" ]; then
    cp "$repo/settings.example.json" "$repo/settings.json"
fi

python3 - "$repo/settings.json" "$cpu_only" <<'PY'
import json, sys
from pathlib import Path

path = Path(sys.argv[1])
cpu_only = sys.argv[2] == "1"
data = json.loads(path.read_text(encoding="utf-8"))
existing = data.get("lyricsGenerator")
if not isinstance(existing, dict):
    data["lyricsGenerator"] = {
        "command": [".venv/bin/python", "service/generate-lyrics.py"],
        "model": "large-v3",
        "device": "cpu" if cpu_only else "auto",
        "computeType": "int8" if cpu_only else "auto",
        "maxDurationSeconds": 900,
        "gpuGate": None,
    }
    path.write_text(json.dumps(data, indent=2) + "\n", encoding="utf-8")
    print(f"Enabled lyricsGenerator in {path}.")
else:
    print(f"Kept existing lyricsGenerator configuration in {path}.")
PY

echo "Restart the service with: systemctl --user restart lyrics-overlay.service"
