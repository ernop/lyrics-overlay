# Lyrics overlay: architecture

How the lyrics overlay is built: its three parts, the contracts between
them, and the facts about YouTube's pages they rely on. What it must do and
why: [product.md](product.md). Install, test and release:
[operations.md](operations.md). Agent entry point: [../AGENTS.md](../AGENTS.md).

## Parts and data flow

```
Firefox tab (YouTube)                         GNOME Shell
  firefox/content.js                            gnome-extension/lyrics-overlay@ernop
    reads the player, page data        D-Bus      indicator, overlay, pitch panel
  firefox/background.js            <---------->       ^          ^
    POST http://lyrics.localhost:8792  net.fuseki.    |          | GSettings
          |                          LyricsOverlay    |          | (look, pitch panel)
          v                                           |          |
  service/ (gjs, systemd user unit lyrics-overlay.service)       |
    http.js -> report-schema.js -> core.js -> dbus.js            |
          |                        |  lrclib.js (LRCLIB, budgeted, cached)
          |                        |  store.js (~/.local/state/lyrics-overlay)
          |                        |  pitch-capture.js (PipeWire, on request; echo-cancel.js, microphones.js)
          |                        |  song-key.js (what the computer plays, while a detected scale shows)
          |                        |  archive-sync.js -> ytarchive.js (when ytarchiveUrl is set)
          |  browser-commands.js (desktop -> extension: select the song's tab, show the settings tab)
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
- **Service** (`service/`, gjs). Owns every decision: song identity, lyric
  lookup, choice, timing, and which line shows when. It also serves the
  settings page, follows the sung pitch and hears the song's key. `core.js`
  is free of GNOME and network code and runs under node in tests.
- **GNOME Shell extension** (`gnome-extension/lyrics-overlay@ernop`, GNOME
  50). Renders what the service says: the indicator, the line, and the
  pitch panel (`pitch-panel.js` places it, docked or separate, and handles
  its drags; `pitch-view.js` draws the trace). `extension.js` raises the
  window the add-on names after a click on the lyric (the song's) or a
  right press on the indicator, the lyric or the panel (the settings
  page's). Display settings live in its GSettings schema
  (`org.gnome.shell.extensions.lyrics-overlay`), which the settings page
  writes through the service.
- **Shared modules** (`shared/`): lyric parsing and display timing,
  identity derivation and candidate ranking, the request budget, overlay
  geometry, voice-wei's pitch detector, the key detector
  (`key-detect.js`), what the pitch panel shows when (`pitch-layout.js`:
  its clock, which lines carry names, the note the readout holds), scales
  and note spelling (`scales.js`), the D-Bus interface
  (`dbus-interface.js`, one definition for service and shell), the lyric
  status wording (`lyrics-status.js`) and the letter colors with their
  contrast rings (`text-ink.js`). The settings page imports
  `lyrics-status.js`, `scales.js` and `text-ink.js` as the service serves
  them.
  `scripts/install-gnome-extension.sh` copies a listed set of them into the
  installed extension's `shared/`; a shared module the shell imports must
  be added to that list, or the extension fails to load.

## The report contract

`POST /api/report` with `{tabId, sampledAt, heartbeatMs, media, metadata?,
next?}`, checked field by field in `service/report-schema.js`:

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

The settings page's paths need the same Host. `GET /settings`, its script
and style, the shared modules it imports and the favicon are files read
at start; `GET /` redirects to `/settings`. It reads `GET /api/state`,
`/api/settings` (the schema and the values), `/api/fonts` and
`/api/microphones`. Its POSTs (`/api/settings {changes}`,
`/api/settings/reset {keys}`, `/api/command {op}` for the song's
commands, `/api/pitch/fit`) need an Origin equal to `http://<Host>`, the
page itself, and JSON.

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
- `POST /api/command-result` answers with `{id, ok: true, windowTitle}`
  (the title the tab's window shows once selected) or
  `{id, ok: false, error}`: 204, or 409 when that command is no longer
  waiting. A command no request collects within 1.5 s, or not answered
  within 3 s, fails. An unheard one is logged with whether any add-on has
  asked since the service started, or how long ago and how its last
  request ended: add-ons before 1.1 never ask, and a failure looks the
  same either way to the desktop.
- D-Bus `FocusSong()` sends `focusTab` for the active session's tab and
  returns the extension's answer; the shell then raises the window with
  exactly that title.
- D-Bus `OpenSettings()` sends `openSettings`: the add-on selects the tab
  at `http://localhost:8792/settings`, or opens it when there is none, and
  answers with its window's title. Without access to `http://localhost/*`
  it cannot tell which tab that is, so it shows `grant.html` instead.

## ytarchive hand-off

Only when `ytarchiveUrl` is set (`null` in settings.example.json).
`service/archive-sync.js` watches the state the core publishes (the video
being heard and the lyric set in use) and tells ytarchive
(`service/ytarchive.js`):

- A video is added once, when it first sounds:
  `POST <ytarchiveUrl>/api/get {url, via: 'played'}`. ytarchive keeps the
  first route by which each video reached it.
- The lyric set in use follows as an LRC file (`lrcText`: `[ar:]`, `[ti:]`,
  `[al:]` and `[length:]` tags, then the timed lines, or the plain ones when
  the set is untimed): `POST /api/lyrics {video_id, lrc}`, with `lrc: null`
  when no set with words remains. It is sent again only when the set in use
  changes (`lyricsKey`, `<LRC_FORMAT>:<candidate id>`; raising `LRC_FORMAT`
  resends every song's file the next time it plays).
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

- **Sessions** are per tab; the active one is the sounding tab heard from
  most recently. A tab quiet for the grace period (120 s) or that broke its
  heartbeat promise is forgotten.
- **Video records** (`videos/<id>.json`): identity, lookup status,
  candidates (at most 10), the chosen and rejected sets, and the timing
  offset. Written atomically, only when they change.
- **Lookups** queue per video, current video first, then the next one.
  Search answers are cached by query (`searches/<sha1>.json`) and the budget
  windows persist in `budget.json`.
- **Outputs**: a state summary and the one line to show, each emitted only
  when it changes; timers wake the core exactly when the next line starts
  or a tab next lapses, never by polling.

## D-Bus interface

Name `net.fuseki.LyricsOverlay`, path `/net/fuseki/LyricsOverlay`,
interface `net.fuseki.LyricsOverlay1` (`shared/dbus-interface.js`):
`GetState() -> s`, `GetLine() -> s`, `Command(s) -> s` (JSON ops: tooFast,
tooSlow, resetOffset, choose, reject, searchAgain, lookUp, pitch),
`FocusSong() -> s`, `OpenSettings() -> s`, signals `StateChanged`,
`LineChanged`, `PitchFrames`. All payloads are JSON strings.

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
