#!/usr/bin/env bash
# Installs or updates lyrics-overlay for this user, and is safe to rerun:
#   - settings.json from settings.example.json, if there is none yet;
#   - the service's systemd user unit, restarted so it runs this checkout;
#   - the GNOME Shell extension (scripts/install-gnome-extension.sh).
# The Firefox add-on is installed from the signed file (README.md, "Setup").
#
#   scripts/install.sh
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
unit="lyrics-overlay.service"

missing=()
command -v gjs >/dev/null || missing+=("gjs")
command -v glib-compile-schemas >/dev/null || missing+=("libglib2.0-bin")
gjs -c "imports.gi.versions.Soup = '3.0'; imports.gi.Soup;" 2>/dev/null || missing+=("gir1.2-soup-3.0")
command -v pipewire >/dev/null || missing+=("pipewire")
command -v pw-record >/dev/null || missing+=("pipewire-bin")
if [ "${#missing[@]}" -gt 0 ]; then
    echo "Missing: ${missing[*]}. Install with: sudo apt install ${missing[*]}" >&2
    exit 1
fi
shell_version="$(gnome-shell --version 2>/dev/null | grep -oE '[0-9]+' | head -1 || true)"
if [ "$shell_version" != "50" ]; then
    echo "The desktop extension is written for GNOME Shell 50; this is GNOME Shell ${shell_version:-not found}." >&2
    exit 1
fi

if [ ! -f "$repo/settings.json" ]; then
    cp "$repo/settings.example.json" "$repo/settings.json"
    echo "Created settings.json from settings.example.json."
fi

units="$HOME/.config/systemd/user"
mkdir -p "$units"
sed "s|__WORKDIR__|$repo|g" "$repo/scripts/$unit.template" > "$units/$unit"
systemctl --user daemon-reload
systemctl --user enable --quiet "$unit"
systemctl --user restart "$unit"
echo "Started $unit; its page is http://lyrics.localhost:8792/"

"$repo/scripts/install-gnome-extension.sh"
