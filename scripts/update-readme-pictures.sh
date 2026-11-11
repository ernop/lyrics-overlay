#!/usr/bin/env bash
# Refreshes the README's pictures, all drawn with made-up songs and devices:
# the shell e2e saves two lyric lines, cropped, from the real extension in a
# headless GNOME Shell; tests/e2e/readme-desktop.mjs stages the whole
# desktop; scripts/settings-page-picture.mjs draws the settings page in a
# headless Firefox. Each lands in build/e2e-artifacts/readme-*.png, and each
# shell run starts by clearing that directory, so the pictures are copied
# to docs/ after each step.
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
node scripts/settings-page-picture.mjs
copy_pictures
