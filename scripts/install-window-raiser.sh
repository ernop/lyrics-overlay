#!/usr/bin/env bash
# Installs the zero-UI GNOME Shell window-raiser companion extension
# (lyrics-overlay-raiser@ernop) and enables it in org.gnome.shell.
#   scripts/install-window-raiser.sh [--data-home DIR] [--no-enable]
# Safe to rerun; leaves no backup copies on disk.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
uuid="lyrics-overlay-raiser@ernop"
data_home="$HOME/.local/share"
enable=1
while [ $# -gt 0 ]; do
    case "$1" in
        --data-home) data_home="$2"; shift 2 ;;
        --no-enable) enable=0; shift ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done

source_dir="$repo/gnome-extension/$uuid"
shell_dir="$data_home/gnome-shell"
installed="$shell_dir/extensions/$uuid"
mkdir -p "$shell_dir/extensions"

changed=1
if [ -f "$installed/metadata.json" ] && [ -f "$installed/extension.js" ] \
    && cmp -s "$source_dir/metadata.json" "$installed/metadata.json" \
    && cmp -s "$source_dir/extension.js" "$installed/extension.js"; then
    changed=0
fi

if [ "$changed" = 1 ]; then
    staging="$(mktemp -d "$shell_dir/.$uuid.XXXXXX")"
    trap 'rm -rf "$staging"' EXIT
    install -m 0644 "$source_dir/metadata.json" "$source_dir/extension.js" "$staging/"
    chmod 0755 "$staging"
    # Swap in the new copy; delete the replaced copy in the same step.
    rm -rf "$installed"
    mv "$staging" "$installed"
    trap - EXIT
fi

if [ "$enable" = 1 ]; then
    gjs -c 'const settings = new imports.gi.Gio.Settings({schema_id: "org.gnome.shell"});
const uuid = "lyrics-overlay-raiser@ernop";
const enabled = settings.get_strv("enabled-extensions");
if (!enabled.includes(uuid)) settings.set_strv("enabled-extensions", [...enabled, uuid]);
const disabled = settings.get_strv("disabled-extensions");
if (disabled.includes(uuid)) settings.set_strv("disabled-extensions", disabled.filter(x => x !== uuid));
imports.gi.Gio.Settings.sync();'
fi

if [ "$changed" = 1 ]; then
    echo "Installed $uuid into $installed; log out and back in once so GNOME Shell loads it."
else
    echo "$uuid is already up to date in $installed."
fi
