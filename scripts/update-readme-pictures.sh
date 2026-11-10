#!/usr/bin/env bash
# Refreshes the README's pictures, drawn by the real extension in a headless
# GNOME Shell with made-up songs: the shell e2e saves the menu, the font list
# and the lyric, cropped, as build/e2e-artifacts/readme-*.png, and
# tests/e2e/readme-desktop.mjs stages the whole desktop. Each run starts by
# clearing build/e2e-artifacts, so each run's pictures are copied before the
# next one.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
copy_pictures() {
    for picture in build/e2e-artifacts/readme-*.png; do
        node scripts/copy-png-without-text.mjs "$picture" "docs/${picture##*/readme-}"
    done
}
npm run test:shell
copy_pictures
node tests/e2e/readme-desktop.mjs
copy_pictures
