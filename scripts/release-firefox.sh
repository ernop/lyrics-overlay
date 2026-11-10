#!/usr/bin/env bash
set -euo pipefail

# Signs the Firefox extension unlisted on AMO and opens the signed XPI in
# Firefox, whose install prompt adds it to the running profile. Never copy
# the XPI into the profile's extensions folder instead: Firefox grants a
# Manifest V3 add-on its host permissions only when it starts as a fresh
# install, and a copied-in file first starts as an enabled sideload, so it
# would run without access to YouTube or the service.
# AMO rejects version reuse: bump the version in firefox/manifest.json
# before releasing a change. dist/lyrics-overlay.xpi holds only the current
# signed build; each release replaces it.

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# Gitignored; amo-credentials.example shows its two lines.
credentials="$project_root/amo-credentials.local"
installer="$project_root/dist/lyrics-overlay.xpi"

if [[ ! -f "$credentials" ]]; then
  echo "AMO credentials not found at $credentials (see amo-credentials.example)" >&2
  exit 1
fi

cd "$project_root"
npm test
npm run lint

artifacts="$(mktemp -d)"
trap 'rm -rf "$artifacts"' EXIT

set -a
# shellcheck source=/dev/null
source "$credentials"
set +a

# Through web-ext's environment options, so the key never shows in a
# process listing.
WEB_EXT_API_KEY="$AMO_JWT_ISSUER" WEB_EXT_API_SECRET="$AMO_JWT_SECRET" \
  npx web-ext sign --channel=unlisted --source-dir firefox --artifacts-dir "$artifacts"

version="$(node -p 'require("./firefox/manifest.json").version')"
mkdir -p "$(dirname "$installer")"
cp "$artifacts"/*-"$version".xpi "$installer"
# Detached, because a Firefox that was not already running would otherwise
# hold this script open until it exits.
setsid -f firefox "$installer" >/dev/null 2>&1

echo "Signed $version. Firefox shows \"Add Lyrics Overlay?\": press Add."
