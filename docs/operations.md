# Lyrics overlay: operations

Installing, restarting, verifying, testing and releasing the lyrics
overlay, and the testing lessons behind the rules. What it is for:
[product.md](product.md). How it is built:
[architecture.md](architecture.md). Agent entry point: [../AGENTS.md](../AGENTS.md).

## Install and restart

- **Service**: `scripts/install.sh`. It checks the requirements (gjs,
  libglib2.0-bin, gir1.2-soup-3.0, pipewire, pipewire-bin, GNOME Shell 50),
  copies `settings.example.json` to the gitignored `settings.json` if
  missing, renders the systemd user unit `lyrics-overlay.service`
  (`Restart=always`) for this checkout, enables and restarts it, and
  installs the GNOME Shell extension (below). Safe to rerun.
- **A proxy name** (optional): a local reverse proxy may give the service
  a name of its own, such as `http://lyrics.localhost/`; set `hostname` in
  `settings.json` to the Host it forwards, then restart the service.
- **Restart after a service change**:
  `systemctl --user restart lyrics-overlay.service`. The unit runs the
  repository's `service/` directly, so a restart picks up committed code.
- **GNOME Shell extension**: `scripts/install-gnome-extension.sh` copies
  the extension into `~/.local/share/gnome-shell/extensions/` and enables
  it; GNOME Shell loads extension code once per login. Over an installed
  copy it leaves the update pending in
  `~/.local/share/gnome-shell/.lyrics-overlay@ernop.pending` and enables
  `lyrics-overlay-extension-update.service`, which puts it in place at the
  next login, before the shell starts. Overwriting the running copy is
  unsafe: the shell re-reads the extension's schema and stylesheet each
  time it enables the old code again (after every screen unlock), and the
  old code throws on a schema that lacks its keys. GNOME's own
  `extension-updates/` works the same way only while its update machinery
  runs, which the owner's desktop blocks on purpose. `--apply-pending` is
  the login unit's step and refuses while GNOME Shell runs.
- **Firefox extension**: release Firefox installs only signed extensions;
  see Release below.

## Verify

- `curl -s http://127.0.0.1:8792/api/state` answers 200 with
  `{state, line}`; `http://lyrics.localhost:8792/` is the status page: the
  song, lyric status, matched set, timing offset, current line, microphone
  state, and every lyric set found.
- With `ytarchiveUrl` set, the service log
  (`journalctl --user -u lyrics-overlay.service`) says "ytarchive: added
  <id>" when a new video sounds and names the lyrics it sent.
- **On the live desktop**, after the login that loads a new extension
  build and with a song playing: `python3 scripts/check-live-desktop.py`
  reports whether the tray indicator and the lyric line are drawn, and
  where, from GNOME Shell's accessibility tree (read-only; no lyric text).
  It exits 1 when the service has a song but the indicator is drawn
  nowhere. Run it before telling the owner the extension is ready: the
  hermetic shell test runs the stock panel, not the owner's.

## Tests

- `npm test`: every unit suite plus the real gjs service against a stub
  LRCLIB, about 4 s. `npm run lint`: `web-ext lint` on the extension.
- `npm run test:shell`: a headless GNOME Shell with the real extension and
  service, driving the indicator, both menus and the overlay with virtual
  input, about 11 s. It stands in for the browser extension when a click
  on the lyric sends its command, and opens plain GTK windows
  (`tests/e2e/titled-window.js`) to check the right one is raised. A
  failure prints the shell's and the service's log lines. Screenshots land
  in `build/e2e-artifacts/`.
- Both service-level suites run in an isolated session
  (`tests/isolated-session.mjs`): a temporary HOME and XDG dirs, and
  private D-Bus daemons started inside them that activate only what the
  test names. Both run under constant garbage collection (see
  architecture.md, "GJS lifetime rules").
- **Real Firefox** (when the extension's page reading or the report
  contract changes): `node scripts/probe-real-firefox.mjs [URL] [SECONDS]`
  runs the extension in a headless, muted, signed-out Firefox against the
  installed service, prints each state change (line keys, never lyric
  text), then kills Firefox and checks the service drops the tab within
  40 s (15 s expected). It creates its own profile folder and always
  deletes it. Extensions that a Firefox `policies.json` force-installs
  load into its profile too, so the test browser matches the everyday
  one. Its video becomes the active song, so while the owner listens its
  lyrics would show on the owner's screen.
- **Real Firefox, commands** (when the background script's command
  handling changes): `node scripts/probe-firefox-commands.mjs [--show-log]
  [URL]` runs the extension in a signed-out headless Firefox against a
  private service on a private bus, with a stand-in for LRCLIB; the
  profile sends `lyrics.localhost:8792` to that service through an HTTP
  proxy setting. It calls FocusSong as the shell does and checks the
  extension selects the tab and names its window. The installed service
  and the owner's screen are untouched.
- **The README's pictures**: `gjs -m scripts/render-indicator-icons.js`
  draws `docs/indicator-icons.png` after an icon changes;
  `scripts/update-readme-pictures.sh` runs the shell e2e and copies the
  menu, font list and lyric line it saves, cropped, into `docs/`, without
  the time GNOME stamps in them, so an unchanged picture stays the same file.

## Release the Firefox extension

`npm run release:firefox` runs the tests and lint, signs the extension as
unlisted on addons.mozilla.org with the AMO API key in the gitignored
`amo-credentials.local` (format: `amo-credentials.example`; on the
owner's machine a link to the owner's credentials file), writes the signed
XPI to `dist/lyrics-overlay.xpi` (replacing the previous one), and opens
it in Firefox, which shows "Add Lyrics Overlay?"; pressing Add installs it
into the running profile with no restart. Signing uploads the code to
Mozilla under the owner's account, so each release needs the owner's
approval. Bump `firefox/manifest.json`'s version first; AMO refuses a
version it has already signed.

Then publish the signed file for everyone else:
`gh release create v<version> dist/lyrics-overlay.xpi --title "Firefox add-on <version>"`.
The README links `releases/latest/download/lyrics-overlay.xpi`, so the
asset keeps that name.

Never install by copying the XPI into the profile's `extensions/` folder
(the auto-load-from-archive pattern). Firefox 159 grants a Manifest V3
add-on its host permissions only when the add-on starts with reason
`ADDON_INSTALL` (`Extension.sys.mjs`, under the default
`extensions.originControls.grantByDefault`). A copied-in file is found at
the next start as a disabled sideload, and enabling it starts it with
`ADDON_ENABLE`, so it runs with no access to YouTube or `lyrics.localhost`
and silently reports nothing. auto-load-from-archive shows the effect: it
asks for every site but holds only the one origin granted by hand.

## Testing lessons (2026-11-09)

- **A private bus started from the real environment is not private.**
  Services it activates inherit the daemon's environment; an activated
  dconf-service once wrote the real `~/.config/dconf/user` during a probe
  (restored). Start buses inside the isolated session.
- **The in-IDE browser is signed in to the owner's accounts.** Loading a
  YouTube video there sends requests as the owner (watch history). Research
  YouTube's pages only in signed-out headless browsers: Playwright's
  Firefox or a web-ext temporary profile.
- **The owner's panel is not the stock panel (2026-11-10).** A change
  moved the indicator from the center box to the right box because "lower
  right tray" read like the stock right box; the comment above the line
  said otherwise and was not read. The owner's Dash to Panel hides the
  right box, so after a logout the indicator was drawn nowhere. Read the
  comment above a line before changing it, check desktop facts against
  the live configuration (`panel-element-positions`, not only
  `panel-positions`), and run `scripts/check-live-desktop.py` after the
  login. The shell e2e now asserts the indicator's box against the
  owner's live layout.
- **Run a negative check's edit, test and restore one after another.**
  Issued together, the restore can land before the test installs the
  code, and the broken version passes.
- **Check each look from a fresh start (2026-11-10).** The menu's pure
  black ink was applied only on a change from the dark style, so a menu
  first opened in the light style (the owner's) kept the theme's
  near-black. The e2e opened the panel menu dark first and missed it; the
  lyric menu, first opened light, caught it.
- **A menu taller than the room beside its opening point runs off the
  screen (2026-11-10).** GNOME's popup opens below the point, or above it
  only when it fits there, and never shrinks. Both menus scroll within a
  height cap; the e2e asserts the lyric menu is whole on a 900 px screen.
- **A submenu inside a capped menu scrolls in a strip a row tall
  (2026-11-10).** GNOME gives an opened submenu its own scroll view once
  the menu reaches its max-height; a scroll view's minimum height is near
  zero, so the scrolled menu body laid the font list out in what the other
  rows left, one row at 900 px. Our submenus never scroll on their own
  (`submenuItem` in indicator.js); the body scrolls them whole. The e2e
  compares what shows of the font submenu with its list's preferred
  height, not its allocation: the list's box is itself a viewport, as
  short as the strip.
