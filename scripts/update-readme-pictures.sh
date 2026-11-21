#!/usr/bin/env bash
# Refreshes the README's pictures, all drawn with public-domain songs and
# made-up devices: tests/e2e/readme-desktop.mjs stages both the video desktop
# (docs/desktop.png) and the multi-app workspace with Japanese furigana
# (docs/workspace.png) in headless GNOME Shell; scripts/styles-picture.mjs
# renders multi-ring borders and offline Japanese furigana through Cairo/Pango
# and SudachiPy; scripts/settings-page-picture.mjs captures the Lyrics, Screen
# map / Pitch, and Song tabs in headless Firefox. Each lands in
# build/e2e-artifacts/readme-*.png and is copied into docs/ without PNG text
# metadata chunks.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
copy_pictures() {
    for picture in build/e2e-artifacts/readme-*.png; do
        [ -e "$picture" ] || continue
        node scripts/copy-png-without-text.mjs "$picture" "docs/${picture##*/readme-}"
    done
}
rm -f build/e2e-artifacts/readme-*.png
node tests/e2e/readme-desktop.mjs
copy_pictures
node scripts/styles-picture.mjs
copy_pictures
node scripts/settings-page-picture.mjs
copy_pictures
