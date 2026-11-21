# Lyrics overlay: operations

Installing, restarting, verifying, testing and releasing the lyrics
overlay, and the testing lessons behind the rules. What it is for:
[product.md](product.md). How it is built:
[architecture.md](architecture.md). Agent entry point: [../AGENTS.md](../AGENTS.md).

## Install and restart

- **Service and desktop frontend**: `scripts/install.sh`. It checks the
  requirements (`gjs`, `libglib2.0-bin`, `gir1.2-soup-3.0`,
  `gir1.2-gtk-3.0`, `pipewire`, `pipewire-bin`), copies
  `settings.example.json` to the gitignored `settings.json` if missing,
  disables the legacy `lyrics-overlay@ernop` GNOME Shell extension if
  enabled, installs and enables the tiny zero-UI `lyrics-overlay-raiser@ernop`
  GNOME Shell window-raiser companion on GNOME desktops
  (`scripts/install-window-raiser.sh`; takes one logout/login the first time
  so GNOME Shell loads it, then never needs logout for overlay edits), renders
  both `lyrics-overlay.service` and `lyrics-overlay-desktop.service`
  (`PartOf=graphical-session.target`) for this checkout, and enables and
  restarts both immediately. Safe to rerun.
- **A proxy name** (optional): a local reverse proxy may give the service
  a name of its own, such as `http://lyrics.localhost/`; set `hostname` in
  `settings.json` to the Host it forwards, then restart the service.
  Add-on 1.0 reached the service that way; 1.1 and later use port 8792
  directly.
- **Automatic lyric timing** (optional): `scripts/install-generator.sh`
  creates a gitignored `.venv` in the repo root with `faster-whisper`,
  NVIDIA CUDA runtime libraries (`nvidia-cublas-cu12`, `nvidia-cudnn-cu12`),
  and `sudachipy` + `sudachidict-full`. Configure `lyricsGenerator` in
  `settings.json` and restart `lyrics-overlay.service`:

  ```json
  "lyricsGenerator": {
    "command": [".venv/bin/python", "service/generate-lyrics.py"],
    "model": "large-v3",
    "device": "cuda",
    "computeType": "float16",
    "maxDurationSeconds": 900,
    "cookiesFromBrowser": null,
    "gpuGate": null
  }
  ```

  Set `device: "cpu"` and `computeType: "int8"` on CPU-only machines;
  `cookiesFromBrowser` (optional, default `null`, e.g. `"firefox"`) passes
  `--cookies-from-browser` to `yt-dlp` if YouTube returns HTTP 403 on
  anonymous audio downloads or tracks larger than ~10 MB; `gpuGate` optionally
  wraps runs through a shared local GPU coordinator
  (`{command, name, what, gb, lane, minutes, waitMinutes}`). Both
  `service/lyric-generator.js` and `service/generate-lyrics.py` place
  `~/.local/bin` ahead of system bin directories on `PATH` because `systemd
  --user` omits it (and so standalone `~/.local/bin/yt-dlp` beats an outdated
  distro `/usr/bin/yt-dlp`, alongside `deno`, `uv`, and optional local GPU
  gate scripts).
  `generate-lyrics.py` decodes audio with `ffmpeg` directly so it does not
  break on `av >= 19` (which removed `metadata_errors` expected by
  `faster-whisper.decode_audio`).
- **Japanese furigana** (optional): install `sudachipy` and
  `sudachidict-full` into `.venv` (`uv pip install --python .venv/bin/python sudachipy sudachidict-full`, also installed by `scripts/install-generator.sh`), or into system `python3`. Toggle **Furigana** under Settings -> Lyrics -> Typography.
- **More fonts** (optional): `scripts/install-fonts.sh` downloads about
  160 of Ubuntu's font packages and unpacks their TrueType and OpenType
  files into `~/.local/share/fonts/`, for this user alone; safe to rerun
  (product.md, "Fonts"). Restart `lyrics-overlay-desktop.service` to pick
  up newly added fonts immediately.
- **Restart after a change**:
  - Service: `systemctl --user restart lyrics-overlay.service`.
  - Desktop frontend: `systemctl --user restart lyrics-overlay-desktop.service`
    (picks up `desktop/` and `shared/` edits in milliseconds, no logout).
- **Legacy GNOME Shell extension** (optional):
  `scripts/install-gnome-extension.sh` still installs the in-shell GNOME
  50 extension into `~/.local/share/gnome-shell/extensions/` (staging
  updates into `.lyrics-overlay@ernop.pending` for next login via
  `lyrics-overlay-extension-update.service`). Do not run it alongside
  `lyrics-overlay-desktop.service`.
- **Firefox extension**: release Firefox installs only signed extensions;
  see Release below.

## Verify

- `systemctl --user status lyrics-overlay.service lyrics-overlay-desktop.service`
  shows both `active (running)`.
- `curl -s http://127.0.0.1:8792/api/state` answers 200 with
  `{state, line, addon}`; `http://localhost:8792/settings` is the settings
  page, which also shows the song, its lyric status, timing and lyric
  sets, the microphone, the scale heard and the add-on's version.
- **Which add-on Firefox runs**: `addon` in `/api/state` (the settings
  page's "Firefox add-on" row) names the version of the add-on that last
  reported, against the checkout's; add-ons before 1.3.0 name none. Before
  any add-on has reported, or to see what is installed rather than what
  reports, the profile's `extensions.json` entry for
  `lyrics-overlay@local` holds the active version (read it; never edit the
  profile). A failed click logs in the service whether any add-on has
  asked for commands since the service started; add-ons before 1.1 never
  do.
- With `ytarchiveUrl` set, the service log
  (`journalctl --user -u lyrics-overlay.service`) says "ytarchive: added
  <id>" when a new video sounds and names the lyrics it sent.
- **On the live desktop**, with a song playing:
  `python3 scripts/check-live-desktop.py` queries
  `net.fuseki.LyricsOverlayDesktop1.GetStatus()` (read-only; no lyric text)
  and prints tray button, StatusNotifierItem, window raiser, lyric window,
  ink hit-box, and pitch panel status (falling back to GNOME Shell's
  accessibility tree if the legacy extension is active). It exits 1 when
  the service has a song but no tray indicator is active.

## Tests

- `npm test`: every unit suite plus the real gjs service against a stub
  LRCLIB, about 4 s. `npm run lint`: `web-ext lint` on the extension.
- `npm run test:desktop`: a hermetic headless GNOME Shell 50 **with
  XWayland**, running the real `service/`, standalone `desktop/`, and
  `lyrics-overlay-raiser@ernop` under constant GC (~16 s). Tests tray button
  toggle, per-pixel click-through, immediate focus on plain press (verifying
  Mutter actually focuses the matching Wayland browser window across exact
  title, delayed retitle, ambiguous duplicate titles, empty `windowTitle`,
  and duplicate `disable()`/`enable()` cycles on the raiser), `Ctrl+drag` from
  a focused native Wayland window (using real Linux evdev keycodes), `Escape`
  cancel, right-click settings + `org.freedesktop.Notifications` error notice,
  pitch panel docking/resizing/detaching with `Ctrl+drag`, quiet generating
  status pill, service stop/restart, and desktop restart persistence.
  Screenshots land in `build/e2e-artifacts/`.
- `npm run test:shell`: a headless GNOME Shell 50 with the legacy
  extension and service (~11 s). Screenshots land in `build/e2e-artifacts/`.
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
  profile sends the add-on's and the settings page's addresses to that
  service through an HTTP proxy setting, via a relay that counts page
  loads. Two runs, about a minute together. A fresh install: the service
  knows the add-on as the checkout's version, FocusSong selects the song's
  tab and names its window, the first OpenSettings opens the settings page
  and the second selects that same tab. An update from the last release
  without localhost access (`OLD_RELEASE`), which names no version:
  OpenSettings shows the add-on's page asking for it, the settings page
  never loads, and the updated add-on names the checkout's version. Commands start once Firefox has run 20 s (below,
  "Testing lessons"). It fails on any error the add-on logs; web-ext
  passes Firefox's output to the log only with `--verbose`. The
  installed service and the owner's screen are untouched.
- **The README's pictures**: `gjs -m scripts/render-indicator-icons.js`
  draws `docs/indicator-icons.png` after an icon changes;
  `scripts/update-readme-pictures.sh` runs `tests/e2e/readme-desktop.mjs`
  (`docs/desktop.png` and `docs/workspace.png`), `scripts/styles-picture.mjs`
  (`docs/styles.png`), and   `scripts/settings-page-picture.mjs` (`docs/settings.png`,
  `docs/settings-map.png`, `docs/settings-song.png`, and `docs/full-lyrics.png`
  in headless Firefox with made-up microphones) and copies each picture into
  `docs/` without PNG text chunks so an unchanged picture stays the same file.

## Release the Firefox extension

`npm run release:firefox` runs the tests and lint, signs the extension as
unlisted on addons.mozilla.org with the AMO API key in the gitignored
`amo-credentials.local` (format: `amo-credentials.example`; on the
owner's machine a link to the owner's credentials file), writes the signed
XPI to `dist/lyrics-overlay.xpi` (replacing the previous one) and its
update manifest to `dist/updates.json`, and opens the XPI in Firefox,
which shows "Add Lyrics Overlay?"; pressing Add installs it into the
running profile with no restart. Signing uploads the code to Mozilla
under the owner's account, so each release needs the owner's approval.
Bump `firefox/manifest.json`'s version first; AMO refuses a version it
has already signed. The add-on is self-hosted, so `npm run lint` runs
web-ext with `--self-hosted`, which allows `update_url`.

Then publish both files, as the script prints:
`gh release create v<version> dist/lyrics-overlay.xpi dist/updates.json --title "Firefox add-on <version>"`.
Each installed add-on from 1.3.0 reads
`releases/latest/download/updates.json` daily and updates itself from the
version's own release; the README and the settings page link
`releases/latest/download/lyrics-overlay.xpi`, so the assets keep their
names (`tests/update-manifest.test.mjs`). Check after publishing that the
latest `updates.json` names the new version and that its link answers
with `application/x-xpinstall`.

Never install by copying the XPI into the profile's `extensions/` folder
(the auto-load-from-archive pattern). Firefox 159 grants a Manifest V3
add-on its host permissions only when the add-on starts with reason
`ADDON_INSTALL` (`Extension.sys.mjs`, under the default
`extensions.originControls.grantByDefault`). A copied-in file is found at
the next start as a disabled sideload, and enabling it starts it with
`ADDON_ENABLE`, so it runs with no access to YouTube or `lyrics.localhost`
and silently reports nothing. auto-load-from-archive shows the effect: it
asks for every site but holds only the one origin granted by hand.

## Publishing lessons (2026-11-10)

- **A force-push does not take history off GitHub.** The repository's
  Activity page lists each force push with the commit it replaced, and
  GitHub serves a replaced commit by its ID for as long as it keeps the
  objects. Anything committed here is public for good; to start over, push
  to a newly created repository.

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
- **Compare the keys a test writes, not the settings file's time
  (2026-11-11).** The real desktop writes its dconf database by itself,
  several times a minute while the owner works, so a check of
  `~/.config/dconf/user`'s modification time failed runs that had
  written nothing there. The service test compares the real session's
  lyrics overlay settings before and after, and the shell harness the
  real value of the first key it writes (`realDconf` in
  `tests/isolated-session.mjs`).
- **Run a negative check's edit, test and restore one after another.**
  Issued together, the restore can land before the test installs the
  code, and the broken version passes.
- **Check each look from a fresh start (2026-11-10).** A style applied
  only on a change from another style is missing when the first one shown
  is the owner's: the removed menus kept the theme's near-black ink when
  first opened light. Test each look as the first thing shown.
- **Find out which add-on the browser runs before debugging the command
  channel (2026-11-10).** The owner's clicks on the lyric failed
  with "the browser extension is not listening" while every lab run
  passed; Firefox still ran 1.0.0, which has no command channel, because
  the 1.1.0 install prompt was never accepted. One read of the profile's
  `extensions.json` would have settled it (Verify, above).
- **web-ext hides Firefox's output unless `--verbose` (2026-11-10).** The
  command probe's check of the add-on's log read nothing and could not
  fail until then.
- **A fresh headless Firefox is slow to hand on responses in its first
  seconds (2026-11-10).** In its first 5-12 s it held a response the relay
  had written within 7 ms for about 3 s, past the service's answer budget;
  never after 20 s, so the command probe waits that long. Throttling was
  not the cause. The 3 s budget is the product's (product.md, "Going to
  the song"), so the probe waits rather than the budget growing.
- **A keep-alive client finds unannounced closes (2026-11-10).** libsoup
  closed the connection after every 204 without saying so (architecture.md,
  "The report contract"); browsers mostly reconnect, but the probe's relay
  and a reverse proxy in front of the service reused the closing
  connection and lost the request.
  The service test now sends every kind of answer over one kept
  connection.
- **Bound every wait on a browser (2026-11-10).** The settings picture
  awaited `document.fonts.ready` over WebDriver BiDi with no limit and once
  hung for minutes; each request now has a limit, and the page-side wait
  its own, so the script's deadline holds.
- **A probe ends its processes in `finally`, and never exits inside the
  `try` (2026-11-10).** A scratch probe's `process.exit` skipped that
  cleanup and left a bus, a service and Firefox running.
- **GNOME Shell 50 can unwind `disable()`/`enable()` twice when another
  extension changes state (2026-11-20).** Disabling another extension
  triggered duplicate `disable()` and `enable()` calls on the running
  extension: `disable()` threw on null `this._settings`, then `enable()`
  threw on a duplicate `Main.panel.statusArea` role before starting its
  `ServiceClient`, leaving lyrics visible from a stale proxy while every
  click logged "the lyrics service is not running". `disable()` is now
  idempotent, `enable()` clears stale state and rolls back on failure,
  and `tests/e2e/overlay.e2e.mjs` explicitly exercises duplicate
  `disable()`/`enable()` calls followed by clicking the lyric.
- **XWayland modifier delivery, double-clicks, and override-redirect
  repaints (2026-11-20).** Four subtle Wayland+XWayland rules verified in
  headless GNOME Shell 50 (`tests/e2e/desktop.e2e.mjs`):
  - Wayland only sends `wl_keyboard.modifiers` to the keyboard-focused
    client; an unfocused XWayland `POPUP` (`override_redirect`) receives
    `button-press-event` with stale `state = 0`, breaking `Ctrl+drag` when
    a native Wayland window has focus. `TOPLEVEL` with
    `Gdk.WindowTypeHint.NOTIFICATION` and `accept_focus=true` focuses
    synchronously before `button-press-event` (delivering `CONTROL_MASK`,
    `Shift`, and `Escape`), while staying out of Alt+Tab and taskbars and
    never stealing focus on map.
  - Clutter's virtual `notify_keyval()` does not update XKB modifier state
    for Wayland/XWayland clients; e2e tests must send real Linux evdev
    keycodes via `notify_key()` (`29` Left Ctrl, `42` Left Shift, `1` Esc).
  - GTK3 emits `Gdk.EventType.TWO_BUTTON_PRESS` in addition to
    `BUTTON_PRESS` on rapid clicks; handlers must filter
    `ev.get_event_type() !== Gdk.EventType.BUTTON_PRESS`.
  - Override-redirect `POPUP` windows (needed for `TrayButton` to sit
    above GNOME Shell's `panelBox`, since managed `DOCK` windows sit below
    it) do not receive `_NET_WM_FRAME_DRAWN` ticks from Mutter, so
    `queue_draw()` alone can leave pixels stale until pointer motion;
    calling `invalidate_rect(null, true)`, `process_updates(true)`, and
    `Gdk.flush()` repaints synchronously every time.
