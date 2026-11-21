#!/usr/bin/env bash
# Installs or updates lyrics-overlay for this user, and is safe to rerun:
#   - settings.json from settings.example.json, if there is none yet;
#   - the service systemd user unit (lyrics-overlay.service), restarted;
#   - the standalone XWayland desktop frontend (lyrics-overlay-desktop.service),
#     enabled and restarted immediately with no logout required;
#   - on GNOME desktops, installs and enables the zero-UI window-raiser
#     companion extension (lyrics-overlay-raiser@ernop) so clicking a lyric
#     raises the exact Firefox window past Wayland focus-stealing prevention;
#   - disables the legacy GNOME Shell extension (lyrics-overlay@ernop) if it
#     is still enabled, so two overlays never draw at once.
# The Firefox add-on is installed from the signed file (README.md, "Setup").
#
#   scripts/install.sh
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
service_unit="lyrics-overlay.service"
desktop_unit="lyrics-overlay-desktop.service"
legacy_uuid="lyrics-overlay@ernop"
legacy_update_unit="lyrics-overlay-extension-update.service"

missing=()
command -v gjs >/dev/null || missing+=("gjs")
command -v glib-compile-schemas >/dev/null || missing+=("libglib2.0-bin")
gjs -c "imports.gi.versions.Soup = '3.0'; imports.gi.Soup;" 2>/dev/null || missing+=("gir1.2-soup-3.0")
gjs -c "imports.gi.versions.Gtk = '3.0'; imports.gi.Gtk;" 2>/dev/null || missing+=("gir1.2-gtk-3.0")
command -v pipewire >/dev/null || missing+=("pipewire")
command -v pw-record >/dev/null || missing+=("pipewire-bin")
if [ "${#missing[@]}" -gt 0 ]; then
    echo "Missing: ${missing[*]}. Install with: sudo apt install ${missing[*]}" >&2
    exit 1
fi

if [ ! -f "$repo/settings.json" ]; then
    cp "$repo/settings.example.json" "$repo/settings.json"
    echo "Created settings.json from settings.example.json."
fi

# Disable the legacy GNOME Shell extension if active so two overlays never collide.
if command -v gnome-extensions >/dev/null && gnome-extensions info "$legacy_uuid" >/dev/null 2>&1; then
    gnome-extensions disable "$legacy_uuid" >/dev/null 2>&1 || true
fi
if systemctl --user is-enabled "$legacy_update_unit" >/dev/null 2>&1; then
    systemctl --user disable "$legacy_update_unit" >/dev/null 2>&1 || true
fi
rm -rf "$HOME/.local/share/gnome-shell/.$legacy_uuid.pending"

# On GNOME desktops, install the zero-UI window-raiser companion so clicks raise
# the exact Firefox window past Wayland focus-stealing prevention.
if command -v gnome-shell >/dev/null; then
    bash "$repo/scripts/install-window-raiser.sh"
fi

units="$HOME/.config/systemd/user"
mkdir -p "$units"
sed "s|__WORKDIR__|$repo|g" "$repo/scripts/$service_unit.template" > "$units/$service_unit"
sed "s|__WORKDIR__|$repo|g" "$repo/scripts/$desktop_unit.template" > "$units/$desktop_unit"
systemctl --user daemon-reload
systemctl --user enable --quiet "$service_unit"
systemctl --user enable --quiet "$desktop_unit"
systemctl --user restart "$service_unit"
systemctl --user restart "$desktop_unit"
echo "Started $service_unit and $desktop_unit; settings at http://localhost:8792/settings"
