#!/usr/bin/env bash
# Installs the GNOME Shell extension and enables it for the current dconf.
#   scripts/install-gnome-extension.sh [--data-home DIR] [--no-enable]
#   scripts/install-gnome-extension.sh --apply-pending [--data-home DIR]
# GNOME Shell loads extension code once per login. An installed copy is not
# overwritten under a running shell: the shell re-reads the schema each
# time it enables the old code again (after every screen unlock), and the
# old code fails on a schema it does not match. The update
# is left pending instead, and lyrics-overlay-extension-update.service puts
# it in place at the next login, before GNOME Shell starts
# (--apply-pending). GNOME's own extension-updates/ works the same way but
# only while its update machinery runs, which a desktop may block.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
uuid="lyrics-overlay@ernop"
unit="lyrics-overlay-extension-update.service"
default_data_home="$HOME/.local/share"
data_home="$default_data_home"
enable=1
apply_pending=0
while [ $# -gt 0 ]; do
    case "$1" in
        --data-home) data_home="$2"; shift 2 ;;
        --no-enable) enable=0; shift ;;
        --apply-pending) apply_pending=1; shift ;;
        *) echo "unknown option: $1" >&2; exit 2 ;;
    esac
done

source_dir="$repo/gnome-extension/$uuid"
shell_dir="$data_home/gnome-shell"
installed="$shell_dir/extensions/$uuid"
# Outside extensions/ and extension-updates/, which GNOME reads.
pending="$shell_dir/.$uuid.pending"

if [ "$apply_pending" = 1 ]; then
    if [ "$data_home" = "$default_data_home" ] && pgrep -u "$(id -u)" -x gnome-shell >/dev/null; then
        echo "GNOME Shell is running; $unit puts the pending copy in place at the next login." >&2
        exit 1
    fi
    if [ -d "$pending" ]; then
        rm -rf "$installed"
        mv "$pending" "$installed"
        echo "Installed the pending $uuid into $installed."
    fi
    exit 0
fi

if [ -d "$installed" ]; then
    target="$pending"
else
    target="$installed"
fi
mkdir -p "$shell_dir/extensions"

staging="$(mktemp -d "$shell_dir/.$uuid.XXXXXX")"
trap 'rm -rf "$staging"' EXIT
mkdir -p "$staging/icons" "$staging/schemas" "$staging/shared"
install -m 0644 "$source_dir/metadata.json" "$source_dir"/*.js "$staging/"
install -m 0644 "$source_dir"/icons/*.svg "$staging/icons/"
install -m 0644 "$source_dir"/schemas/*.gschema.xml "$staging/schemas/"
# The shared modules the shell code imports; they import nothing local themselves.
for file in $(grep -ohE "from '\./shared/[a-z0-9-]+\.js'" "$source_dir"/*.js | sed -E "s#from '\./shared/##; s#'##" | sort -u); do
    install -m 0644 "$repo/shared/$file" "$staging/shared/$file"
done
glib-compile-schemas --strict "$staging/schemas"
chmod 0755 "$staging"

# Swap in the new copy; the copy it replaces is deleted, not kept.
rm -rf "$target"
mv "$staging" "$target"
trap - EXIT

if [ "$target" = "$pending" ] && [ "$data_home" = "$default_data_home" ]; then
    units="$HOME/.config/systemd/user"
    mkdir -p "$units"
    sed "s|__WORKDIR__|$repo|g" "$repo/scripts/$unit.template" > "$units/$unit"
    systemctl --user daemon-reload
    systemctl --user enable --quiet "$unit"
fi

if [ "$enable" = 1 ]; then
    gjs -c 'const settings = new imports.gi.Gio.Settings({schema_id: "org.gnome.shell"});
const uuid = "lyrics-overlay@ernop";
const enabled = settings.get_strv("enabled-extensions");
if (!enabled.includes(uuid)) settings.set_strv("enabled-extensions", [...enabled, uuid]);
imports.gi.Gio.Settings.sync();'
fi
if [ "$target" = "$installed" ]; then
    echo "Installed $uuid into $installed; it loads at the next login."
else
    echo "Left $uuid pending in $pending; $unit puts it in place at the next login, before GNOME Shell starts."
fi
