# Lyrics overlay: architecture

How the lyrics overlay is built: its three parts, the contracts between
them, and the facts about YouTube's pages they rely on. What it must do and
why: [product.md](product.md). Install, test and release:
[operations.md](operations.md). Agent entry point: [../AGENTS.md](../AGENTS.md).

## Parts and data flow

```
Firefox tab (YouTube)                         GNOME Shell
  firefox/content.js                            gnome-extension/lyrics-overlay@ernop
    reads the player, page data        D-Bus      indicator, menus, overlay, pitch trace
  firefox/background.js            <---------->       ^
    POST http://lyrics.localhost:8792  net.fuseki.    |
          |                          LyricsOverlay    |
          v                                           |
  service/ (gjs, systemd user unit lyrics-overlay.service)
    http.js -> report-schema.js -> core.js -> dbus.js
          |                        |  lrclib.js (LRCLIB, budgeted, cached)
          |                        |  store.js (~/.local/state/lyrics-overlay)
          |                        |  pitch-capture.js (PipeWire, on request)
          |                        |  archive-sync.js -> ytarchive.js (when ytarchiveUrl is set)
          |  browser-commands.js (desktop -> extension: select a tab)
          |  status-page.js (http://lyrics.localhost:8792/)
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
- **Service** (`service/`, gjs). Owns every decision: song identity, lyric
  lookup, choice, timing, and which line shows when. `core.js` is free of
  GNOME and network code and runs under node in tests.
- **GNOME Shell extension** (`gnome-extension/lyrics-overlay@ernop`, GNOME
  50). Renders what the service says: the indicator and its menu, the
  same menu at the pointer on a right-click on the lyric (`lyric-menu.js`),
  the line and the pitch trace; `extension.js` raises the song's window
  after a click on the lyric. Display settings live in its GSettings schema
  (`org.gnome.shell.extensions.lyrics-overlay`).
- **Shared modules** (`shared/`): lyric parsing and display timing,
  identity derivation and candidate ranking, the request budget, overlay
  geometry, voice-wei's pitch detector, the D-Bus interface
  (`dbus-interface.js`, one definition for service and shell), the lyric
  status wording (`lyrics-status.js`, for the menu and status page) and the
  letter colors with their contrast rings (`text-ink.js`).
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

## Commands to the browser

The extension cannot be called, so the desktop reaches it through a
request it keeps open (`service/browser-commands.js`):

- `POST /api/commands {}` is held up to 25 s. It ends with 200
  `{op: 'focusTab', tabId, id}`, with 204 when the hold ran out (ask
  again), or with 409 when a newer request took its place (another
  browser is listening; ask again only after the next report, so two
  browsers cannot trade the place in a tight loop). The background script
  starts listening on each report or keep-alive and stops on 409 or when
  the service cannot be reached.
- `POST /api/command-result` answers with `{id, ok: true, windowTitle}`
  (the title the tab's window shows once selected) or
  `{id, ok: false, error}`: 204, or 409 when that command is no longer
  waiting. A command no request collects within 1.5 s, or not answered
  within 3 s, fails.
- D-Bus `FocusSong()` sends `focusTab` for the active session's tab and
  returns the extension's answer; the shell then raises the window with
  exactly that title.

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
  about it reaches the overlay, the menus or the status page.

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
`FocusSong() -> s`, signals `StateChanged`, `LineChanged`, `PitchFrames`.
All payloads are JSON strings.

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
