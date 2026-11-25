# Lyrics overlay: architecture

How the lyrics overlay is built: its three parts, the contracts between
them, and the facts about YouTube's pages they rely on. What it must do and
why: [product.md](product.md). Install, test and release:
[operations.md](operations.md). Agent entry point: [../AGENTS.md](../AGENTS.md).

## Parts and data flow

```
Firefox tab (YouTube)                         Standalone desktop frontend
  firefox/content.js                            desktop/ (gjs GTK3/XWayland,
    reads the player, page data        D-Bus      lyrics-overlay-desktop.service)
  firefox/background.js            <---------->   lyric-window, pitch-window,
    POST http://lyrics.localhost:8792  net.fuseki.  tray-sni, tray-button
          |                          LyricsOverlay      ^          ^
          v                                             |          | GSettings
  service/ (gjs, systemd user unit lyrics-overlay.service)         | (look, pitch panel)
    http.js -> report-schema.js -> core.js -> dbus.js              |
          |                        |  ingest.js (Stage 1: sources, vocal-lyric fusion, per-song edit patches)
          |                        |  analyzer.js (Stage 2: unified analysis status & multi-voice projection)
          |                        |  lrclib.js (LRCLIB, budgeted, cached)
          |                        |  lyric-generator.js -> generate-lyrics.py (optional local Whisper timing)
          |                        |  score-generator.js -> generate-score.py (vocal sep, beats, chords, GAME + CQT multi-voice melody, vocal Whisper)
          |                        |  furigana.js -> furigana.py (offline SudachiPy Japanese furigana worker)
          |                        |  store.js (~/.local/state/lyrics-overlay)
          |                        |  pitch-capture.js (PipeWire, on request; echo-cancel.js, microphones.js)
          |                        |  song-key.js (what the computer plays, while a detected scale shows)
          |                        |  archive-sync.js -> ytarchive.js (when ytarchiveUrl is set)
          |  browser-commands.js (desktop -> extension: select the song's tab, show the settings tab)
          |  GET /api/score/midi -> shared/score-midi.js (SMF Type-1 multi-track MIDI export)
          |  settings-page/ (http://localhost:8792/settings) -> settings-store.js -> GSettings
```

- **Firefox extension** (`firefox/`, Manifest V3). The content script reads
  the YouTube player and page data and sends reports through the background
  script, which adds the tab id and posts them to the service. A content
  script's own fetch would carry the page's Origin, so posting happens only
  in the background script (Origin `moz-extension://<id>`). The background
  script also keeps the command request open and carries out commands. It
  addresses the service as `http://lyrics.localhost:8792`: `*.localhost`
  is always this machine, and the host permission an install granted for
  that name survives updates (product.md, "Local service").
  `settings-access.js` names the settings page and the access needed to
  find its tab; `grant.html` is the add-on's own page that asks for it.
  The manifest's `update_url` is the newest GitHub release's
  `updates.json`, which `scripts/update-manifest.mjs` writes at each
  release from the signed file (its version, its address in that
  version's release, and its SHA-256); Firefox checks it daily.
- **Service** (`service/`, gjs). Owns every decision: song identity, lyric
  lookup, choice, timing, and which line shows when. It also serves the
  settings page, follows the sung pitch and hears the song's key. `core.js`
  is free of GNOME and network code and runs under node in tests.
- **Standalone desktop frontend** (`desktop/`, gjs + GTK3 on XWayland,
  systemd user unit `lyrics-overlay-desktop.service`). The primary
  frontend; forces `Gdk.set_allowed_backends('x11')` before `Gtk.init(null)`
  so every window has a composited 32-bit ARGB visual, exact multi-monitor
  coordinates, and `input_shape_combine_region` per-pixel click-through:
  - `lyric-window.js` (`Gtk.WindowType.TOPLEVEL`,
    `Gdk.WindowTypeHint.NOTIFICATION`, `accept_focus=true`,
    `focus_on_map=false`, `skip_taskbar`, `skip_pager`, `keep_above`,
    `stick`): renders the lyric line inside the user's max wrap width with
    `shared/text-layout.js` (tight ~2 px vertical ink trim via
    `singleLineHeight` + `normalizedLyricBox`/`commitLyricGeometry`), fades in
    composited via `cr.pushGroup()`/`cr.paintWithAlpha()`, renders the quiet
    generating status pill, and clips the X11 input shape tightly to the
    painted ink or pill (+6 px margin) so transparent space passes clicks
    through. During `Ctrl+drag` (body move or left/right edge width resize),
    incoming `setLine()` updates queue until release so the drag frame never
    pops or aborts on gaps, same-monitor moves never call `resize()` or refit
    text, and cross-monitor moves rescale wrap width proportionally. Because
    `NOTIFICATION` receives focus before `button-press-event`, `Ctrl+drag`
    receives synchronous `CONTROL_MASK`, `Shift`, and `Escape` even when a
    native Wayland window previously held focus. Rapid double clicks ignore
    `Gdk.EventType.TWO_BUTTON_PRESS`. Both `desktop/monitors.js` and
    `service/monitors.js` sort monitors with `orderMonitors()` so indices agree
    between desktop and settings.
  - `pitch-window.js` (same `TOPLEVEL` + `NOTIFICATION` window): paints the
    sung-pitch trace with `shared/pitch-painter.js`, docks against any side
    of the lyric or stands separate, and supports `Ctrl+drag` edge resize,
    move, dock, detach, and `Escape` cancel.
  - `tray-sni.js`: exports `org.kde.StatusNotifierItem` over session D-Bus
    (SVG icon name, ARGB32 `IconPixmap`, and `Menu: "/NO_DBUSMENU"` so
    `ubuntu-appindicators` does not fail property discovery), registering
    whenever `org.kde.StatusNotifierWatcher` is present.
  - `tray-button.js`: standalone `Gtk.WindowType.POPUP` (`override_redirect`)
    rendered directly inside the primary monitor's panel strip (above
    `Main.panel`), activated automatically when `tray-mode` is `panel-button`
    or `both`, or in `auto` mode when `StatusNotifierWatcher` is absent or
    Dash to Panel hides `rightBox`. Uses synchronous repaint
    (`invalidate_rect` + `process_updates` + `Gdk.flush`) because
    `override_redirect` windows do not receive `_NET_WM_FRAME_DRAWN` ticks.
    Primary press toggles `overlay-enabled`; secondary press opens settings;
    middle-drag slides horizontally along the panel and persists
    `tray-button-right-offset`.
  - `desktop-actions.js`: raises the target Firefox window after `FocusSong`
    or `OpenSettings` by calling the zero-UI GNOME Shell companion extension
    `net.fuseki.LyricsOverlayRaiser1.RaiseWindow(windowTitle)` first (passing
    the exact title reported by Firefox, bypassing Wayland focus-stealing
    prevention and selecting the right window when several Firefox windows are
    open), falling back to Firefox's MPRIS
    `org.mpris.MediaPlayer2.firefox*.Raise()` on non-GNOME desktops or when
    the helper is absent; sends failures to `org.freedesktop.Notifications`,
    checks Dash to Panel's `rightBox` visibility, compiles the GSettings
    schema from the checkout, and provides `QuietMapGuard` so managed XWayland
    windows (`score-window.js`, `score-config-panel.js`) map without stealing
    focus, without triggering GNOME Shell's `"<title>" is ready` notification,
    and without leaving `_NET_WM_STATE_DEMANDS_ATTENTION` set on the taskbar
    entry (setting `focus_on_map=false`, `accept_focus=false`,
    `skip_taskbar_hint=true`, and zeroing X11 `_NET_WM_USER_TIME` across the
    map transition, then clearing `_NET_WM_STATE_DEMANDS_ATTENTION` via
    `_NET_WM_STATE_REMOVE` after first paint before restoring `accept_focus`
    and `skip_taskbar_hint`).
  - `main.js`: single-instance session D-Bus owner
    (`net.fuseki.LyricsOverlayDesktop`, `/net/fuseki/LyricsOverlayDesktop`,
    `net.fuseki.LyricsOverlayDesktop1.GetStatus() -> s` returning read-only
    geometry/visibility/window-raiser metadata with no lyric text).
- **GNOME Shell window raiser** (`gnome-extension/lyrics-overlay-raiser@ernop`,
  GNOME 50). Minimal zero-UI companion extension (two files: `metadata.json`
  and `extension.js`, no GSettings schema or actors) installed automatically
  by `scripts/install.sh` on GNOME desktops (`scripts/install-window-raiser.sh`).
  Owns `net.fuseki.LyricsOverlayRaiser` on the session bus and exports
  `net.fuseki.LyricsOverlayRaiser1.RaiseWindow(s title) -> s`: activates the
  normal window matching `title` (preferring Firefox windows when exact
  matches include non-Firefox windows, matching stripped
  ` — Mozilla Firefox` suffixes against Firefox windows, waiting up to 1 s
  for `notify::title` / `window-created`, and raising the most recently
  active matching window when multiple windows share the title); when `title`
  is empty, activates the single or most recently active Firefox window. `enable()` and `disable()` are
  idempotent and reply to any in-flight D-Bus invocation before tearing down.
- **Legacy GNOME Shell extension** (`gnome-extension/lyrics-overlay@ernop`,
  GNOME 50). Optional in-shell frontend sharing `shared/text-layout.js`,
  `shared/service-client.js`, and `shared/pitch-painter.js`; `extension.js`
  and `overlay.js`/`pitch-panel.js`/`pitch-view.js` wrap those shared
  modules in Clutter/St actors (`disable()` is idempotent, `enable()` rolls
  back on error). Display settings live in its GSettings schema
  (`org.gnome.shell.extensions.lyrics-overlay`), compiled and shared by
  both frontends and the service.
- **Shared modules** (`shared/`): lyric parsing and display timing,
  monotone word-to-lyric alignment and hallucination-filtered transcription
  LRC building (`lyric-align.js`), identity derivation and candidate
  ranking, the request budget, overlay geometry (`overlay-geometry.js`:
  clamping, placement presets, edge zones, magnetic snapping,
  `verticalAnchorFor`, `expandedRenderBox`, `borderSpec`,
  `backdropMetrics`), Cairo/Pango lyric fitting and multi-layer border/cloud
  painting (`text-layout.js`: constant font size, font-normalized word
  spaces via `normalizedSpaceScale`, x-height word bridge, stepped solid
  rings, 3-pass separable A8 Gaussian backing cloud, Japanese furigana ruby
  layout positioned via `Pango.Layout.index_to_pos()` and painted
  layer-by-layer with proportional borders, cached masks and
  metrics), Cairo/Pango pitch panel painting (`pitch-painter.js`),
  session D-Bus client (`service-client.js`), voice-wei's pitch detector,
  the key detector (`key-detect.js`), what the pitch panel shows when
  (`pitch-layout.js`: its clock, which lines carry names, the note the
  readout holds), scales and note spelling (`scales.js`), the D-Bus
  interface (`dbus-interface.js`, one definition for service and frontends),
  the lyric status wording (`lyrics-status.js`), rough vocal sheet music
  layout and Cairo engraving (`score-layout.js`, `score-painter.js`), and
  the letter colors with
  automatic WCAG contrast rings and custom hex parsing (`text-ink.js`). The
  settings page imports `lyrics-status.js`, `scales.js`, `text-ink.js`,
  `overlay-geometry.js`, `pitch-layout.js` and `score-layout.js` as the
  service serves them.
  `scripts/install-gnome-extension.sh` scans `gnome-extension/*.js` and
  transitive `./*.js` imports inside `shared/` when installing the legacy
  extension.

## The report contract

`POST /api/report` with `{tabId, addonVersion, sampledAt, heartbeatMs,
media, metadata?, next?}`, checked field by field in
`service/report-schema.js`:

- `addonVersion`: the add-on's manifest version, added by its background
  script. Add-ons before 1.3.0 send none, which the schema records as
  `null`. `service/addon-version.js` keeps the last one heard and sets it
  against the version in the checkout's `firefox/manifest.json`; `GET
  /api/state` carries the result as `addon`: `{status, current}` while
  the status is `unheard` (nothing reported since the service started)
  or `unnamed` (the last report named no version), and
  `{status, version, current}` when it is `current`, `older` or `newer`.

- `media`: the main video's state at `sampledAt` (currentTime, duration,
  paused, ended, stalled, playbackRate, muted, volume, adShowing, videoId).
- `heartbeatMs`: the page's promise. While the video is neither paused nor
  ended the page sends another report within this many ms (5000), stalls and
  ads included; while paused or ended it is `null` and the next report waits
  for a change. The service drops a tab that misses three promised reports,
  exactly as if it had closed (`MISSED_HEARTBEATS` in `core.js`), so the
  lyric clock never runs on unreported. A report starts the tab afresh.
- `metadata`: every report carries it (except during ads), so a restarted
  service or a dropped tab recovers from one report.
- `next`: the upcoming video, when the page knows it.

`POST /api/gone {tabId}` ends a tab at once (tab closed, page hidden).
Reports are snapshots: nothing is retried, the next event sends a fresh one.

HTTP guards (`service/http.js`), as for any login-free local server: the
Host must be `127.0.0.1:<port>`, `localhost:<port>`,
`lyrics.localhost:<port>` or the `hostname` setting (403 otherwise), so a
web page cannot reach the service through a name it controls; a POST needs
JSON (415), and is refused (403) when its Origin is anything but
`moz-extension://`, or when it has no Origin and says
`Sec-Fetch-Site: cross-site`. The same guards cover every extension path
below.

The settings page's paths need the same Host. `GET /settings`, its
scripts (`settings.js`, `preview.js`), its stylesheet, the shared modules
it imports and the favicon are files read at start; `GET /` redirects to
`/settings`. Its sticky left column pairs the live preview (`Lyrics`,
`Pitch`, or `Screen map`) with the pinned active-song & lyric-sets deck;
its right inspector renders `Lyrics` and `Pitch` in a compact 2-column grid.
It reads `GET /api/state`, `/api/settings` (the schema and
the values, including writable `box` and `pitch-box`), `/api/fonts`,
`/api/microphones` and `/api/monitors` (logical monitor geometry from
Mutter's `DisplayConfig` D-Bus interface, falling back to `1920x1080`
when unavailable). Its POSTs (`/api/settings {changes}`,
`/api/settings/reset {keys}`, `/api/command {op}` validated against
`PAGE_COMMAND_OPS` exported from `service/core.js`, `/api/pitch/fit`) need
an Origin equal to `http://<Host>`, the page itself, and JSON.

libsoup (3.6, and its main branch as of 2026-11) closes the connection
after every 204 without saying so: writing one drops the length header a
204 must not carry, and the server then takes the response for one that
ends at end-of-file. A client that reuses that connection has its next
request reset; a reverse proxy in front, or the probe's relay, answers
it with a 502. So every 204 says `Connection: close`, and the 303 carries a
zero length (`respondEmpty` in `service/http.js`;
`tests/service-gjs.test.mjs` checks each kind of answer on one kept
connection).

## Commands to the browser

The extension cannot be called, so the desktop reaches it through a
request it keeps open (`service/browser-commands.js`):

- `POST /api/commands {}` is held up to 25 s. It ends with 200
  `{op: 'focusTab', tabId, id}` or `{op: 'openSettings', id}`, with 204
  when the hold ran out (ask
  again), or with 409 when a newer request took its place (another
  browser is listening; ask again only after the next report, so two
  browsers cannot trade the place in a tight loop). The background script
  starts listening on each report or keep-alive and stops on 409 or when
  the service cannot be reached.
- `POST /api/command-result` answers with `{id, ok: true, windowTitle?}`
  (the title the tab's window shows once selected; may be omitted or empty
  when Firefox's `windows.get()` returns `undefined` without `tabs`
  permission, normalized to `""`) or
  `{id, ok: false, error}`: 204, or 409 when that command is no longer
  waiting. A command no request collects within 1.5 s, or not answered
  within 3 s, fails. An unheard one is logged with whether any add-on has
  asked since the service started, or how long ago and how its last
  request ended: add-ons before 1.1 never ask, and a failure looks the
  same either way to the desktop.
- D-Bus `FocusSong()` sends `focusTab` for the active session's tab and
  returns the extension's answer; the desktop frontend then asks
  `net.fuseki.LyricsOverlayRaiser1.RaiseWindow(windowTitle)` (or falls back
  to MPRIS `Raise()`) to bring that window forward.
- D-Bus `OpenSettings()` sends `openSettings`: the add-on selects the tab
  at `http://localhost:8792/settings`, or opens it when there is none, and
  answers with its window's title. Without access to `http://localhost/*`
  it cannot tell which tab that is, so it shows `grant.html` instead.

## ytarchive hand-off

Only when `ytarchiveUrl` is set (`null` in settings.example.json).
`service/archive-sync.js` watches the state and multi-tab presence
(`{sounding, open}`) the core publishes and tells ytarchive
(`service/ytarchive.js`):

- A video is added once, when it first sounds (including a sounding
  background tab alongside an active music tab):
  `POST <ytarchiveUrl>/api/get {url, via: 'played'}`. ytarchive keeps the
  first route by which each video reached it.
- The lyric set in use follows as an LRC file (`lrcText`: `[ar:]`, `[ti:]`,
  `[al:]` and `[length:]` tags, then the timed lines, or the plain ones when
  the set is untimed): `POST /api/lyrics {video_id, lrc}`, with `lrc: null`
  when no set with words remains. It is sent again only when the set in use
  changes (`lyricsKey`, `<LRC_FORMAT>:<candidate id>`; raising `LRC_FORMAT`
  resends every song's file the next time it plays).
- When the owner stops hearing a video that was added, `ArchiveSync` sends
  `POST <ytarchiveUrl>/api/played-stop {video_id}` so ytarchive can end an
  active live stream recording cleanly (normal videos ignore it):
  - **Immediately** when its tab closes (`/api/gone`), switches to another
    video, or lapses past missed heartbeats (even when another music tab
    stays active).
  - After **60 s** (`STOP_PAUSE_MS`) when the tab stays open but paused or
    muted, cancelled if playback resumes before the timeout (or sent
    immediately if the tab closes first).
  - Stop signals are real-time only and are never written to
    `archive-outbox.json`; a failure is logged and dropped (ytarchive's own
    recording cap bounds the clip if it is unreachable).
- `archive/<id>.json` records what ytarchive has (`added`, `lyricsKey`).
  Videos with something to send wait in `archive-outbox.json` (at most 500;
  the oldest are dropped, and logged), sent at the next change and at
  service start, never on a timer. A 4xx answer drops the item (logged);
  any other failure stops sending until the next change, logged once until
  ytarchive answers again.
- The steps run one at a time in a chain whose failures are logged
  ("ytarchive hand-off failed: ..."); nothing waits for it, and nothing
  about it reaches the overlay or the settings page.

## Settings

The look and the pitch panel's settings live in the shell extension's
GSettings schema. `service/settings-store.js` compiles that schema from
this checkout at start, so the service checks exactly the keys its own
page offers whatever extension version is installed, and adds the checks
a schema cannot express. A change on the page is a `POST /api/settings`;
the service writes GSettings, and the shell redraws the line or the panel
as the key changes. Changes made on the desktop (Ctrl+wheel, drags) go to
GSettings too, and the page shows them at its next poll (each second).

## Pitch capture and the song's key

- **The sung pitch** (`service/pitch-capture.js`) runs while the shell
  asks for it (D-Bus `Command {op: 'pitch', wanted}`: overlay on, panel
  on, YouTube sounding), and stops when the shell leaves the bus. With
  echo cancelling on, a private PipeWire client (`pipewire -c`, config
  from `echo-cancel.js`) subtracts what the speakers play from the chosen
  microphone; `pw-record` reads the result, or the microphone itself.
  Each newest window is analyzed `pitch-rate` times a second with
  voice-wei's detector, and the frames go to the shell in the
  `PitchFrames` signal. `microphones.js` reads the inputs and the default
  from `pw-dump`. "Fit to my last 30 s of singing" uses the frames kept
  for that long.
- **The song's key** (`service/song-key.js`) runs while a detected scale
  is shown and the microphone runs: `pw-record` reads the default output's
  monitor at 11025 Hz, and `shared/key-detect.js` folds each 8192-sample
  window's spectrum, every third of a second, into energy per pitch class.
  The sums per video are matched against the Krumhansl-Kessler profiles
  (product.md, "The song's key comes from its sound") and saved every 30
  windows, so a replay starts from them.

## What the overlay shows when

`shared/lyric-display.js`, from the chosen timed set and the media clock:

- a line shows from 0.75 s before its time (`LEAD_SECONDS`);
- before a line that follows the start or a gap of at least 3 s, a seconds
  countdown precedes it;
- the last line holds 8 s, then nothing shows; an ended video, an ad or a
  gone tab shows nothing (`service/core.js`);
- credit lines are blanked while parsing (`shared/lrc.js`): a credit
  heading alone ("SONGWRITERS") blanks the lines after it up to the next
  blank line, and "label: names" lines are blanked on their own.

## What YouTube's pages provide (verified 2026-11-09, signed out)

- **Player**: `#movie_player`'s video element and player API for the video
  id, title, author and length.
- **youtube.com watch data** is stamped onto `ytd-watch-flexy` as `.data`
  (the object the player's `getWatchNextResponse()` returns later); its
  `video-id` attribute changes in the same task. On a fresh page load the
  player's own copy stays undefined past `yt-player-updated` with no event
  marking when it fills, and `yt-page-data-updated` fires about 0.5 s before
  the data lands, so the content script watches the `video-id` attribute.
  This brought metadata from 18.5 s to 3.9 s after load.
- **Next video on youtube.com**: the playlist panel's next entry when a
  playlist plays; otherwise, when autoplay is on
  (`.ytp-autonav-toggle-button[aria-checked]`), the player's
  `.ytp-next-button` (`href`, `data-tooltip-text`, `data-duration`). The
  watch data's autoplay renderer is present in only about one session in
  four, and the player API has no method naming the autoplay pick.
- **YouTube Music**: the media session, the player bar's title and byline,
  and the queue's selected entry and the one after it.

## Service core

- **Sessions** are per tab. Each session tracks `soundingSince` (when
  playback started or switched videos while sounding, never updated by
  heartbeats) separately from `lastSoundingAt` (for the 120 s grace window).
  `_activeSession()` ranks sounding musical tabs above non-music tabs and
  breaks ties by `soundingSince` (with paused musical tabs in grace compared
  by `lastSoundingAt` against sounding non-music tabs' `soundingSince`), so
  simultaneously playing tabs or background livestreams never ping-pong or
  cancel lyric generation. A tab quiet for the grace period (120 s) or that
  broke its heartbeat promise is forgotten.
- **Video records** (`videos/<id>.json`): identity, lookup status,
  candidates (up to 20 LRCLIB results plus pinned chosen, generated, and
  imported local-file candidates), the chosen and rejected sets, whether
  the owner marked the video as music (`userRequested`), and the timing
  offset. Written atomically, only when they change.
- **Lookups** queue per video, current video first, then the next one.
  Search answers are cached by query (`searches/<sha1>.json`) and the budget
  windows persist in `budget.json`.
- **Outputs**: a state summary and the one line to show, each emitted only
  when it changes; timers wake the core exactly when the next line starts
  or a tab next lapses, never by polling.

## Automatic lyric timing (optional)

Active only when `lyricsGenerator` is configured in `settings.json`
(`service/lyric-generator.js`, `service/generate-lyrics.py`,
`shared/lyric-align.js`):

- **Trigger**: when the active sounding song's LRCLIB lookup settles as
  `plain` or `none` (skipping instrumentals, `next` preloads, videos
  longer than `maxDurationSeconds`, and videos that already have a
  generated candidate or were marked skipped/no-vocals; raising
  `maxDurationSeconds` clears prior duration skips), or on demand via
  `Command {op: 'generate'}` (which sets `force: true` and passes
  `--max-duration 0` to bypass the automatic duration cap). Switching
  songs or stopping playback cancels automatic runs immediately via
  `SIGTERM`; explicit manual runs (`force: true`) continue in the
  background until they finish (saving into that video's record and
  notifying `ArchiveSync.observeVideoLyrics`), are replaced by a new
  `generate`, or are cancelled explicitly via `Command {op: 'cancelGenerate'}`.
  `Command {op: 'generateFromScratch'}` has the same manual lifetime and
  duration behavior, preempts any in-flight Mode A (`hasPlain`) alignment on
  the same video, passes an empty `plainLyrics` input to guarantee direct
  audio transcription instead of alignment against a possibly wrong lyric
  set, and clears the stale timed candidate from `_lineAt()` so the quiet
  timing status pill and early transcribed partials show immediately.
- **Audio & transcription**: `generate-lyrics.py` acquires audio on its own
  (streaming an already-cached `<ytarchiveUrl>/media/<videoId>/_condensed/soundtrack.mp3`
  to disk only opportunistically when configured) via `yt-dlp --no-playlist
  --ignore-config` into a `TemporaryDirectory` that is always deleted on exit.
  Both `lyric-generator.js` and `generate-lyrics.py` place `~/.local/bin`
  ahead of system bin directories (`/usr/bin`, `/usr/local/bin`) so a
  user-installed standalone `yt-dlp` beats stale distro packages. Automatic
  runs (`--max-duration > 0`) cap downloads at 100 MB
  (`-f bestaudio[filesize<100M]/bestaudio`, HTTP 403 fallback
  `bestaudio[protocol^=m3u8]/best[filesize<100M]/best`); manual forced runs
  (`--max-duration 0`) omit `--max-filesize` and request compact audio
  (`-f bestaudio[abr<=96]/bestaudio`, HTTP 403 fallback
  `bestaudio[protocol^=m3u8]/best`). Optional
  `lyricsGenerator.cookiesFromBrowser` (default `null`) passes
  `--cookies-from-browser <browser>` when explicitly configured. `yt-dlp`
  runs with `--newline --progress-delta 0.5 --progress-template` so byte
  progress streams as `stage:audio:<done>/<total>` on stderr (SI units). It
  decodes audio to 16 kHz mono float32 via `ffmpeg` (bypassing PyAV `av>=19`
  compatibility breakage in `faster-whisper`), partitioning tracks longer
  than 15 minutes into disjoint 10-minute slices anchored near `--start-at`
  (playhead forward to end, then wrapping back to `0:00`) so peak RAM stays
  bounded while producing one complete chronologically sorted transcript at
  the end. When `--stream-partials` is passed, `generate-lyrics.py` emits
  incremental NDJSON `{"partial": true, "range": [start, end], "segments":
  [...]}` lines on stdout (never lyric text on stderr); `lyric-generator.js`
  accumulates them into an in-memory early preview passed to `LyricsCore`
  via `onPartial` (shown on screen whenever the playhead falls inside a
  covered range, hiding the overlay status pill via `generation.previewing`,
  never saved to disk or handed to ytarchive until the full run finishes).
  Stderr carries `stage:audio[:<done>/<total>]`, `stage:gpu-wait[:<why>]`,
  `stage:transcribe`, and (for tracks >= 2 minutes)
  `stage:transcribe:<done>/<total>` progress lines (streamed live into
  `state.generation` and the overlay's quiet `StatusPill`). When `gpuGate`
  is configured, only the child `--transcribe-audio` step runs under the
  external GPU gate command so audio download never holds GPU memory; exit
  code 75 maps to `{ok: false, busy: true}`. For tracks longer than 15
  minutes, the GPU gate scales `--minutes` from remaining duration, steps
  down from lane `now` to `new` (or `gpuGate.longLane`), checks
  `should-yield` between slices so urgent `now` jobs can preempt cleanly,
  and resumes from `--slice-index` until the whole track completes
  atomically.
- **Alignment & persistence**: `shared/lyric-align.js` aligns LRCLIB's
  `plainLyrics` onto Whisper's word timestamps with monotone semi-global
  DP (`mode: 'aligned'`, falling back to hallucination-filtered
  `mode: 'transcribed'` when no plain lyrics exist or coverage < 0.18),
  adding blank LRC markers for instrumental gaps >= 4.5 s. The resulting
  candidate (`id: 'gen:<mode>:<seq>'`, `generatedMode: 'aligned' |
  'transcribed'`) is persisted in `videos/<id>.json`, immediately replaces
  the status pill on screen, and is handed to ytarchive by `ArchiveSync`
  through the same `lyricsKey` flow as LRCLIB lyrics.
- **Full lyrics endpoint and anonymous LRCLIB publishing**: `GET /api/lyrics`
  returns the active song's full structured lyric set (`lines` with
  effective offset-adjusted times and cached furigana segments,
  `realAlbumName`, and `bakedSyncedLyrics`). `Command {op: 'saveEditedLyrics'}`
  saves user-edited LRC or plain text as a custom candidate (`edit:*`),
  resets `offsetSeconds` to `0`, and updates the overlay and ytarchive.
  `POST /api/publish-lrclib` (settings-page `Origin`-guarded) validates
  metadata and non-empty lyrics, consumes from `LyricsCore`'s persistent
  LRCLIB budget, calls `createLrclibPublisher` (`service/lrclib.js`), solves
  LRCLIB's SHA-256 proof-of-work challenge out-of-process via
  `service/lrclib-pow.py` (4 bounded Python workers, never blocking GJS),
  and submits to `POST /api/publish` with the generic `User-Agent`.

## White-paper Piano Lead Sheet (optional)

Active when `scoreGenerator` is configured in `settings.json` and either
`score-enabled` is switched on in GSettings or the owner triggers
`Command {op: 'generateScore', quality?: 'standard'|'high'}`
(`service/score-generator.js`, `service/generate-score.py`,
`shared/score-layout.js`, `shared/score-painter.js`,
`desktop/score-window.js`, `service/settings-page/lead-sheet.js`):

- **Extraction worker** (`service/generate-score.py`, isolated `.venv-score`,
  schema `version: 2`):
  1. Acquires audio on CPU (opportunistic `ytarchive` soundtrack or `yt-dlp`)
     into a `TemporaryDirectory` that is always deleted on exit.
  2. Runs the GPU analysis child under the optional `gpuGate`:
     two-pass FP16 vocal isolation (`model_bs_roformer_ep_317_sdr_12.9755.ckpt`
     -> `mel_band_roformer_karaoke_becruily.ckpt` with `use_autocast=True`,
     `overlap=2` standard or `overlap=4` HQ, adaptive RMS blend back to full
     vocals where Karaoke over-suppresses quiet verses/duets, peak
     normalization to `-1 dBFS`), beat/downbeat tracking (`Beat This! final0`)
     with tempo-octave folding into `[62, 154]` BPM, half-timed intro beat
     fill, and regular phase-locked measures, beat-synchronous harmonic chroma
     + Viterbi chord detection (`36` templates), lead-vocal word timestamps
     (`faster-whisper large-v3`), discrete vocal note transcription
     (`openvpi/GAME-1.0-large` with `-48 dB` slicer & `0.15` presence
     threshold), circular tuning-offset estimation, combined mix+vocal
     Krumhansl-Kessler key detection, and beat-grid quantization. Stages run
     sequentially with explicit GPU memory release between models; peak VRAM
     across all sequential stages is ~5.2 GiB (leaving headroom under a 7 GB
     optional GPU gate reservation).
  3. Persists the JSON score (including stable per-note `id`, `chords`, and
     user `edits`) under `~/.local/state/lyrics-overlay/scores/<videoId>.json`
     via `store.saveScore()`.
- **Decoupled D-Bus signal, vocal-fused lyrics, floating window & in-sheet
  live config**: `LineChanged` stays pure `{text, key, ruby?}` for
  `desktop/lyric-window.js` (which renders constant-size wrapped lyrics inside
  the user's wrap width with tight vertical ink bounds). Lead-sheet data flows
  on its own `GetScore()` / `ScoreChanged(s)` channel (`core.scorePayload()`
  with `{active, videoId, title, status, quality, stage, message, score,
  lyricsLines, clock}`) and `GET /api/score` / `POST /api/score/edit`.
  `generate-score.py` accepts `--prompt-file` (0600 temp file from LRCLIB
  reference lyrics) and `--fresh-audio`, returning `segments` alongside notes
  and chords so `LyricsCore._finishScore()` fuses vocal-isolated Whisper
  timestamps with LRCLIB's canonical text/relative spacing (`shared/lyric-align.js`
  `referenceSyncedLyrics`) into a `gen:vocal:*` candidate while keeping
  LRCLIB candidates intact; `Command {op: 'refreshAll'}` chains LRCLIB
  re-search + fresh-audio score extraction.
  `shared/score-layout.js:applyScoreEdits()` + `buildLeadSheet()` (weighted
  ledger-line excursion `chooseClef`, proportional `visualWeight`, `1..12`
  bars per system, `showChords`-aware multi-bar rests) build numbered
  measures, opening-chord carry, ties across barlines, beat-grouped beams,
  multi-bar rests, and systems in `<1 ms`. `shared/score-layout.js:planLeadSheetPage()`
  is the single layout planner shared by `shared/score-painter.js`,
  `desktop/score-window.js`, and `service/settings-page/preview.js`: vertical
  rows always auto-fill canvas height top-down (bounded inter-system gaps,
  no 6-row cap), Zoom sets `sp = 8.4 * scale` honestly (auto-reflowing
  `barsPerSystem` rather than shrinking staves or letting `Spacious` crush
  pinned bars), and `paintLeadSheetPage()` renders zero-collision systems with
  `page` (default full-page flip) or `scroll` paging, default-off
  `score-show-playhead` & `score-show-active-measure`, and a top-right `⚙`
  hitbox. `desktop/score-window.js` hosts the standard OS window (plain
  left-click focuses the window normally, right-click toggles
  `desktop/score-config-panel.js`, wheel flips pages, `Ctrl+wheel` zooms and
  auto-releases pinned `score-bars-per-system` when exceeding horizontal fit).
  `service/settings-page/lead-sheet.js` renders the full-song interactive
  white-paper SVG viewer & editor (`?score=1`) with a matching collapsible
  live `⚙ Sheet options` drawer.

## D-Bus interface

Name `net.fuseki.LyricsOverlay`, path `/net/fuseki/LyricsOverlay`,
interface `net.fuseki.LyricsOverlay1` (`shared/dbus-interface.js`):
`GetState() -> s`, `GetLine() -> s`, `GetScore() -> s`, `Command(s) -> s`
(JSON ops: tooFast, tooSlow, resetOffset, choose, reject, searchAgain, lookUp,
searchQuery, importLyrics, saveEditedLyrics, generate, generateFromScratch,
cancelGenerate, generateScore, cancelScore, refreshAll, pitch),
`FocusSong() -> s`, `OpenSettings() -> s`, signals `StateChanged`,
`LineChanged`, `ScoreChanged`, `PitchFrames`. All payloads are JSON strings. `state` includes
`generation: {available, status, mode, stage, message}` and
`score: {available, status, quality, stage, message, bpm, meter, key, noteCount, chordCount, edited}`
(each with optional `background` when a manual forced run continues while
another or no video is active).

## GJS lifetime rules (learned 2026-11-09)

- **Keep every GObject the program needs in a JavaScript reference that
  lives as long as it must.** `main.js` once dropped the `Soup.Server`
  returned by `startHttp()`; the first major garbage collection closed the
  listening socket while the process stayed up. Tests now run the service
  and GNOME Shell under a full collection every 200-250 ms
  (`tests/service-under-gc.js`, `tests/collect-garbage.js`, the shell
  harness), so such a drop fails at once.
- **Never start a main loop inside a promise job.** A module evaluated by
  dynamic `import()` runs inside one; if it blocks in `loop.run()`, every
  later promise continuation stalls. Import entry points statically.
