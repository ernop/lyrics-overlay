# Lyrics overlay: product requirements and decisions

What the lyrics overlay is for, what it must do, and the product decisions
settled while building it, with their reasons. How it is built:
[architecture.md](architecture.md). How to install, test and release it:
[operations.md](operations.md). Agent entry point: [../AGENTS.md](../AGENTS.md).

## Purpose

When a YouTube tab plays music on this Ubuntu desktop, the owner can opt in
to one timed line of lyrics floating above the other windows, the same
one-line, properly timed display voice-wei's car view gives. Nothing ever
asks for attention: the overlay exists only when switched on, and the tray
indicator changes quietly.

## Requirements (owner, 2026-11-09; extended 2026-11-10)

- **Tray indicator.** A small indicator sits in the owner's lower-right
  tray. On this desktop, Dash to Panel hides the panel's right box and
  shows the center box at the bottom right, just left of the system menu
  (Resource Monitor is placed there for the same reason), so the indicator
  is appended to the center box; on a stock GNOME panel that puts it just
  after the clock. Where Dash to Panel is installed, the shell e2e test
  reads its live layout and fails if that box stops being shown there.
  The indicator shows
  while a YouTube tab (youtube.com or music.youtube.com) plays sound, and
  disappears after it stops. It never flashes, animates or notifies. What
  it looks like: [indicator-icons.png](indicator-icons.png).
- **One press to toggle.** A primary-button press on the indicator turns the
  overlay on or off; the choice persists. A secondary press opens the menu.
- **The overlay** is a single line of lyrics above all normal windows, not
  above fullscreen ones. It shows the line about to be sung, slightly
  ahead of it, and a seconds countdown before a line that follows an intro
  or a long gap. It never shows the song's name, artist, album or year
  (the opening identity line was removed, 2026-11-10). The last line holds
  8 s and then nothing shows; an ended video shows nothing.
- **Only lyrics (2026-11-10).** Credit lines in lyric files
  ("SONGWRITERS", "Written by: ...", 作词 ...) are never shown.
- **Timing nudges.** Too fast / Too slow move the song's lyric clock in
  0.5 s steps (voice-wei's convention: Too fast shows every line later);
  Reset returns to zero. Each video remembers its offset.
- **Text.** Size adjusts smoothly (16-256 px, a notched slider in the menu,
  or Ctrl+wheel over the text). Font: the desktop font or any installed
  standard family, listed by kind (sans, serif, monospace, the Z003
  script) with a line between kinds and each name drawn in its own font,
  bold or not. The standard families are the text families of Ubuntu's
  font packages; per-script, symbol and duplicate builds are left out
  because they cannot set a Latin lyric or repeat a listed family
  (2026-11-10). Color (2026-11-10): white, yellow, orange, red, pink, magenta,
  purple, blue, cyan, green or black. Border: double (default), single or
  none; the inner ring is whichever of black and white contrasts more with
  the letters, and the outer ring is the other, so the line reads on any
  background. Alignment: centered (default) or left within the box.
- **Transitions.** Instant, a short fade-in (default), or a quick or soft
  crossfade between lines.
- **Pointer rules (2026-11-10).** On the lyric: a click goes to the song
  (its Firefox tab is selected and its window raised); a right-click opens
  the menu at the pointer; Ctrl+drag moves the box; Alt+drag resizes it
  freely (never aspect-locked); Ctrl+wheel sizes the text. A click is never
  combined with a drag: a plain press that travels past the desktop's drag
  threshold does nothing on release. Where no lyric is drawn, clicks reach
  the windows below. Position and size persist as fractions of the monitor.
- **The menu** (the indicator's secondary press, or a right-click on the
  lyric) starts with the overlay and pitch-trace switches, then the song
  (identity, lyric status, microphone, timing, lyric sets, go to the song,
  wrong lyrics, search again), then the look (size, font, color, border,
  alignment, transition, reset position), then the mouse controls and the
  status page. It never runs off the screen: its items scroll within the
  screen's height.
- **Choosing lyrics.** The menu lists every candidate set found; the owner
  can pick one, hide a wrong one ("Wrong lyrics: hide this set"), search
  again, or look up lyrics for a video not recognized as music. Choices and
  rejections are remembered per video.
- **The icon says the state quietly.** A note beside three text lines: a
  filled note with bold lines while the overlay is on, a hollow note with
  thin lines while it is off. When no lyrics are found, the three lines
  become two dots. There is never a popup or system notification.
- **Lookup from metadata only.** Song, artist, album and year come from
  YouTube's own metadata; no audio is transcribed.
- **Next song preloaded.** The upcoming video's lyrics are fetched while the
  current one plays, when the upcoming listing names an artist.
- **Efficient and cached.** Every answer is cached server-side and reused;
  requests to LRCLIB stay inside a persistent budget (below).
- **Optional pitch trace.** A toggle shows the owner's sung pitch from the
  microphone beside the line, as voice-wei's Scales and Phrases pages do,
  with an echo canceller so the music itself is not traced. The microphone
  is GNOME's default input (2026-11-10); the menu and status page name it
  while it is open. Another microphone is chosen in GNOME Settings, Sound,
  Input.
- **Every video heard goes to ytarchive (owner, 2026-11-10).** When
  `ytarchiveUrl` is set, every YouTube video that starts sounding, song or
  not, is added to that ytarchive, which records "Played" as how it first
  arrived (beside "Bookmarklet" and "Pasted" for the owner's other routes).
  The lyrics in use follow as an LRC file, and are replaced when another
  set is chosen. There is no menu item and no status for it here:
  ytarchive tracks the video from there. This replaced the browser's "Add
  to ytarchive" menu items, which the owner found unneeded once every
  video is added. `ytarchiveUrl: null` (the default) turns it off.
- **Live status page.** `http://lyrics.localhost:8792/` refreshes itself
  every second.

## Decisions

- **Lyrics source: LRCLIB only** (keyless, publishes synced lyrics). Every
  search answer is cached for 7 days; a song with no lyrics is rechecked
  after 7 days, a failed request after 10 minutes. The budget is 20
  searches a minute, 200 an hour, 1000 a day, persisted so restarts cannot
  reset it; real use is 1-4 searches per new song. LRCLIB publishes no rate
  limit, so these are a politeness cap.
- **Nothing identifies the owner to third parties.** Requests to LRCLIB
  carry a generic browser User-Agent (`Mozilla/5.0`), no project, person or
  machine names. Reports from the browser go only to the service on this
  computer.
- **Identity sources are ranked** and the first naming both song and artist
  wins: YouTube's auto-generated "Provided to YouTube by" descriptions,
  YouTube Music's player, the description's Music card, then
  "Artist - Song" title parsing. A video whose metadata names no artist is
  not treated as a song and is not looked up unless asked, unless its
  title says it is music (2026-11-10): it names a song form (song, ballad,
  hymn, carol, shanty, lullaby, anthem, aria, madrigal), says lyrics, lyric
  video, official video or audio, or music video, or names a bracketed
  cover. A quoted phrase followed by a separator, a bracket or the end of
  the title is the song's title: `"The Lantern on the Hill" - Folk song`
  is looked up as "The Lantern on the Hill".
- **Lookup pacing (2026-11-10).** Only the sounding tab looks up lyrics,
  and queued lookups for tabs that stopped mattering are dropped. A search
  waits at most 12 s (usually under 1 s); up to four query variants run one
  after another. An LRCLIB "429 Too Many Requests" pauses every lookup
  until its Retry-After, persisted across restarts, instead of counting as
  a failure. Each lookup logs its outcome and timings. Before this, every
  open YouTube tab queued lookups and 429s read as failures, so a song
  could show "Looking up lyrics" for minutes.
- **Going to the song (2026-11-10).** The browser extension selects the
  tab but never focuses the browser window itself: Firefox's focus request
  makes GNOME show a "... is ready" notification instead of raising the
  window. The shell raises the one window whose title is exactly the one
  the extension reports, waiting up to 1 s for the browser to retitle it,
  and does nothing when two windows share that title rather than guess. A
  tab switch answered more than 3 s after the click is dropped, so a slow
  browser never pulls a window forward unasked.
- **A paused song stays clickable.** A paused video keeps the extension's
  background page alive for the two minutes its song stays on screen;
  otherwise Firefox stops that page after 30 s and a click on the lyric
  would find no one to select the tab.
- **The service hands videos to ytarchive (2026-11-10).** It already knows
  which video is heard and which lyrics are in use, so it tells ytarchive
  directly; the browser add-on knows nothing of ytarchive. A video is added
  once, its lyrics are sent again only when the set in use changes, and
  what ytarchive cannot take yet waits in a persisted outbox tried at the
  next change and at start, never on a timer (architecture.md, "ytarchive
  hand-off").
- **Menu text is pure black or white**, chosen from the menu's own
  background, overriding the theme's near-black and dimmed grays.
- **The overlay hides when playback is gone.** A tab that closes says so at
  once. A browser that quits, crashes or sleeps cannot, so each report
  promises the next within 5 s while the video runs; a tab that misses three
  promised reports is dropped, and the line disappears within 15 s instead
  of running on to the end of the song (2026-11-09).
- **The indicator lingers two minutes** after sound stops, so a pause or the
  gap between songs does not make it vanish and reappear.
- **The microphone opens only when needed**: overlay on, pitch trace on,
  and YouTube sounding. A brief pause keeps it open rather than toggling.
  Audio never leaves memory.
- **Local service (2026-11-10).** A systemd user unit on port 8792 with
  login-free local-server guards (Host, Origin). The add-on addresses it as
  `http://lyrics.localhost:8792`: Firefox and systemd-resolved resolve
  every `*.localhost` name to this machine, and Firefox grants a Manifest
  V3 add-on its host permissions only at install, so 1.0 installs, which
  hold `http://lyrics.localhost/*` (match patterns ignore ports), keep
  working after the 1.1 update without a new permission. The `hostname`
  setting names one more Host the service answers to, such as a local
  proxy's.
- **Public, and installable by anyone (owner, 2026-11-10).** The repository
  is public. On a GNOME Shell 50 desktop, `scripts/install.sh` installs
  the service and the shell extension, and the signed add-on comes from
  the GitHub release; nothing depends on the owner's other tools, and
  ytarchive is off unless `ytarchiveUrl` is set. MIT license. The history
  starts at the public release; the private history before it was dropped.
