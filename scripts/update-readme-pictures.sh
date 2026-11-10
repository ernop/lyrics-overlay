#!/usr/bin/env bash
# Refreshes the README's pictures of the menu, the font list and the lyric:
# the shell e2e saves them, cropped, as build/e2e-artifacts/readme-*.png,
# drawn by the real extension in a headless GNOME Shell with made-up songs.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
npm run test:shell
for picture in build/e2e-artifacts/readme-*.png; do
    node scripts/copy-png-without-text.mjs "$picture" "docs/${picture##*/readme-}"
done
