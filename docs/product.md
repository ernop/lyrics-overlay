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

It should also make exploring unfamiliar songs more fun: the owner can leave
it on while watching YouTube, where it loads matching timed lyrics when
available or, with local generation enabled, transcribes and times the song
from scratch when they are not.

## Requirements (owner, 2026-11-09; extended 2026-11-10)

- **Tray indicator.** A small indicator sits in the lower-right tray.
  The standalone desktop frontend exports a standard
  `org.kde.StatusNotifierItem` indicator (`TraySni`) and automatically
  shows a standalone panel-strip button (`TrayButton`) when no
  `StatusNotifierWatcher` is present or when Dash to Panel hides the
  panel's `rightBox` (`tray-mode` setting: `auto`, `sni`, `panel-button`,
  or `both`; horizontal position adjustable by middle-dragging the button
  along the panel, saved in `tray-button-right-offset`). The legacy GNOME
  Shell extension appends its indicator to the center box (which Dash to
  Panel shows at bottom right beside the system menu).
  The indicator shows
  while a YouTube tab (youtube.com or music.youtube.com) plays sound, and
  disappears after it stops. It never flashes, animates or notifies. What
  it looks like: [indicator-icons.png](indicator-icons.png).
- **One press to toggle.** A primary-button press on the indicator turns the
  overlay on or off; the choice persists. A secondary press shows the
  settings page.
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
- **Constant text size and balanced wrapping (owner, 2026-11-19).** The
  chosen `font-size` (16-256 px, set with the notched slider or Ctrl+wheel)
  never shrinks mid-song for longer lines. Long lines wrap evenly across
  balanced lines at the exact chosen size, and the overlay expands
  vertically away from its anchor edge (growing upward when near the bottom
  of the screen or docked above the pitch panel, downward when near the top
  or docked below it, symmetrically in the middle), clamped inside the
  monitor work area while keeping the saved box and any docked pitch panel
  steady.
- **Typography and appearance (owner, 2026-11-19).** Eight focused lyric
  controls live beside the live preview:
  - **Font**: the desktop font or any installed English-covering family,
    chosen through an inline expandable searchable list with All / Sans /
    Serif / Display / Mono filters. More fonts (owner, 2026-11-10: "many
    more font options"): `scripts/install-fonts.sh` adds about 160 Ubuntu
    font packages for the user alone (below).
  - **Size** (`16-256 px`), **Style** (`Bold` on by default, `Italic`), and
    **Furigana** (`text-furigana`, off by default; owner, 2026-11-20): shows
    hiragana readings centered above kanji in Japanese lyrics while leaving
    okurigana, kana, ASCII numbers (such as countdowns), and non-Japanese
    lyrics untouched. Computed 100% locally and offline in sub-millisecond
    time with `sudachipy` + `sudachidict-full` (falling back to `core`/`small`
    if installed elsewhere), pre-warmed once per song in a single batch call.
    Furigana inherit the chosen font, weight, color, and concentric multi-ring
    borders at 44% of base font size (`min 12 px`), painted layer-by-layer
    with the base lyrics so kanji and furigana fuse smoothly into one
    continuous broadcast telop contour, with automatic vertical clearance on
    multi-line wrapped lyrics and live rendering in the settings page preview.
  - **Color**: 11 named presets (white, yellow, orange, red, pink, magenta,
    purple, blue, cyan, green, black) or any custom `#rrggbb` color.
  - **Border** (`None` | `Single` | `Double` | `Triple` | `Quad` | `Glow`,
    extended 2026-11-20 for Japanese broadcast telop / *fuchidori*
    multi-ring legibility): proportional to font size, with calibrated
    progressive band thicknesses and automatic WCAG contrast alternation so
    lyrics stay razor-sharp over both pure white and pure black video
    without needing a backdrop plate or murky shadow cloud. Word spaces are
    font-normalized against each font's measured space advance
    (`normalizedSpaceScale`) so wide monospace fonts tighten down to the
    same compact rhythm as proportional fonts instead of splitting words
    into islands (owner, 2026-11-20). `Single` draws 1 crisp outline
    (`0.10 em`, `0.26 em` space cap). Multi-ring modes (`Double`, `Triple`
    default, `Quad`, `Glow`) use a `0.22 em` space cap, an x-height word
    bridge clamped to each line's ink height (multi-character lines only),
    stepped solid dilation rings with 1.5 px under-overlap so small closed
    contours (dots of i/j, periods, tight kanji strokes, bold o counters)
    and inter-ring seams never punch through, and layer-by-layer painting
    across wrapped lines so stacked lines fuse vertically:
    - `Double`: `0.145 em` inner body + bold `0.080 em` contrast rim.
    - `Triple` (default): `0.125 em` inner + `0.080 em` middle contrast
      band + `0.060 em` outer dark/light seal — zero backdrop required.
    - `Quad`: `0.125 / 0.070 / 0.060 / 0.050 em` four-band telop (chromatic
      fills echo their own color in Ring 3 inside a dark outer Ring 4 seal;
      white/black fills alternate four high-contrast bands).
    - `Glow`: `0.145 em` inner body + `0.105 em` feathered outer halo.
    Each active ring's color (`text-border-1..4-color`: automatic contrast
    or any `#rrggbb`) and width (`text-border-1..4-width`: `2%–35%` of font
    size, scaling with `Ctrl+scroll`) can be customized independently in
    the settings page, alongside an optional **Soft cloud** toggle
    (`text-border-cloud`, off by default) for the 3-pass separable A8
    Gaussian dark backing cloud.
  - **Backdrop**: `None` (default), `Behind text` pill, or `Full bar`, with
    color and opacity controls shown only when enabled and `em`-proportional
    padding and corner radius computed automatically.
  - **Alignment** (`Left`, `Center`, `Right`) and **Transition**
    (`Fade (0.15 s)` default, or `Instant`).
- **Instant to drag and resize (owner, 2026-11-19: "super fast,
  draggable, ultra-instant").** A move repaints nothing; a resize or a
  Ctrl+scroll step repaints only the line that shows, from cached wrap
  widths and pre-rendered A8 border/shadow masks, in a few milliseconds.
- **No hover background; Ctrl+drag only to move (owner, 2026-11-20).**
  Hover-reveal frames and dual-purpose click+drag controls are rejected
  across all of the owner's projects:
  - Hovering the lyric does nothing visually (no scrim, no box border, no
    handles, no cursor change); outside the painted text (or timing status
    pill), empty space stays click-through.
  - A plain primary press on the lyric (or timing pill) acts immediately on
    press to focus the YouTube song tab and raise its window; it never
    starts a drag.
  - Moving the lyric requires `Ctrl+drag` on the body (freezes the drag frame
    and queues incoming line changes or silent gaps until release so the border
    never pops or aborts mid-drag; magnetic center/edge snap; hold `Shift` to
    bypass snap; `Escape` cancels; `Ctrl+press` without movement does nothing).
    The placement frame, snap guides and width readout show only during an
    active `Ctrl+drag` and vanish on release.
  - `Ctrl+drag` on the left or right edge of the lyric resizes max wrap width
    live while holding the opposite edge steady (matching left/right width
    handles on the settings page's Screen map). `Ctrl+scroll` resizes text.
  - A secondary press opens or raises the settings page. Position and wrap
    width persist as fractions of the monitor (scaled proportionally when
    dragged across monitors of different sizes).
  - The pitch panel follows the same rule: plain press does nothing and
    plain hover keeps the default cursor; `Ctrl+drag` moves, docks/detaches
    or resizes its edges (`Escape` cancels).
- **Media keys go through Firefox (owner, 2026-11-19).** The keyboard's
  play/pause, next and previous keys reach YouTube through Firefox's own
  desktop media player (MPRIS), which GNOME's media-keys service
  addresses; the overlay adds nothing. Next acts where YouTube offers a
  next video. A service-side player that always targets the song tab was
  offered and is not built.
- **The settings page (owner, 2026-11-10; redesigned 2026-11-19/20/21).**
  Every setting is on one full-width, dense two-column studio page in Firefox,
  `http://localhost:8792/settings`: a compact top bar (title, active song
  and status pill, `Full lyrics`, `Lead sheet`, `Lyrics: On/Off`,
  `Lead sheet: On/Off`, `Pitch: On/Off`), a
  sticky left column (~38%) holding the live preview (`Lyrics` over
  Video/Dark/Light scenes, `Lead sheet` live white-paper engraving preview,
  `Pitch`, or interactive `Screen map` with exact monitor aspect ratio,
  resizable-width snug-height lyric placement, natural content-matched floating
  lead sheet window, and docked/resizable pitch panel, multi-monitor picker,
  placement presets, and pitch panel docking/resizing) **plus** the pinned active-song
  deck right underneath (timing offset & nudges, song actions including
  **Refresh all** — re-checking LRCLIB, re-downloading fresh audio, and
  rebuilding both score and vocal-isolated fused lyrics — **Generate from
  scratch**, **Lead sheet**, **Extract melody**, and **Refine (HQ)**, lyric
  sets list including vocal-isolated fused sets alongside LRCLIB sets, manual
  LRCLIB search, `.lrc`/`.txt` import, and 1-line Mic/Scale/Melody/Add-on
  status) so there is no empty left-side void and everyday song controls stay
  visible while scrolling; beside a compact 2-column right Inspector (~62%)
  with three top-level sections (`Lyrics`, `Sheet music`, and `Pitch`), no
  nested subheadings, and half-column notched sliders. Action errors appear
  in a sticky banner below the top bar with a `Dismiss` button and are never
  cleared by background status polling. Its idle preview uses a familiar
  English lyric even when furigana is enabled. A right press on the
  indicator, the lyric, or the pitch panel opens it; a right press or `⚙`
  click on the floating lead sheet toggles its in-sheet live config panel
  (with a button to open full Settings/Editor). Each change applies live.
  There is one browser settings tab: a right press selects the open one and
  raises its window rather than opening another.
- **Steady wrap width, tight vertical trim, and frozen drag frame (owner,
  2026-11-25).** Lyrics keep a constant `font-size` and wrap evenly inside the
  user's chosen max wrap width (`lyric-max-lines`: `Auto` (`0`) default;
  optional `1` / `2` / `3` / `4` line cap shrinks gently down to `max(18 px,
  56% of fontSize)` before wrapping). Height is always trimmed tightly to the
  painted text, borders, and furigana (~2 px vertical AA margin) using shared
  font ascender/descender metrics so bottom-anchored lyrics sit visually flush
  on top of the monitor taskbar with a steady baseline across lines (and never
  inherit a stale phantom container height). Monitor indices follow one
  canonical left-to-right, top-to-bottom order in both desktop and settings.
- **White-paper Piano Lead Sheet — standard OS window, auto-reflow up to 350%,
  multi-tier lyrics, scale-snap arrows, MIDI export/audition, & polyphonic
  multi-voice duets (owner, 2026-11-22; refined 2026-11-23).** Optional, off
  by default (`score-enabled`, toggled in the top bar or Settings -> Sheet
  music). Modeled after a printed piano lead sheet — normal white sheet-music
  paper (`#ffffff`) with pure black ink (`#000000`), numbered measures, bold
  chord symbols above the staff, melody notes with ties/beams/rests/accidentals,
  and aligned lyrics directly below:
  - **Standard decorated GNOME OS window (`desktop/score-window.js`)**:
    Behaves like a normal desktop window (`decorated: true`, `resizable: true`,
    Alt-Tab, maximize, snap/tile to half-screen or quarter-screen, optional
    `score-always-on-top` default `false`, `×` hides the sheet cleanly), while
    mapping quietly whenever a song starts or resumes so it never steals focus
    and never triggers GNOME's `"<title>" is ready` attention notification or
    taskbar highlight (likewise for its `Lead Sheet Options` panel).
    Includes a compact dark top toolbar (`−`/`100%`/`+` zoom `60%–350%`,
    `◀`/`▶`/`Live` page controls, live `Auto · N bars × M rows` readout,
    `On top`, `Editor & MIDI`, `⚙ Options`). Window geometry persists via
    `score-box`; plain primary clicks on the sheet body simply focus and keep
    the Lead Sheet window (never hiding it or stealing focus to Firefox),
    right-click toggles `⚙ Options`, wheel flips pages, and `Ctrl+wheel` zooms.
    **Window-fill layout rules (`planLeadSheetPage`)**: vertical rows ALWAYS
    auto-fill the window height (no manual `Rows` pin and no 6-row cap),
    System 1 starts cleanly right below the header rule with balanced bounded
    inter-system gaps (never floating in the middle of a blank page), Zoom
    directly sets staff size (`sp = 8.4 × scale`), `Spacing` governs Auto
    bars/row without ever shrinking pinned bars, and zooming past what fits a
    pinned `Bars/row` automatically releases `score-bars-per-system` back to
    `Auto` so Zoom always grows smoothly up to `350%`. Multi-bar rests ignore
    hidden chord markers when `Chords` is switched off.
  - **Zero-truncation multi-tier lyrics & zero-collision engraving**:
    `layoutSystemLyrics()` keeps every syllable readable even in narrow
    windows: tries Tier 0 at full size, then gentle shrink (down to `0.78×`),
    then drops cleanly onto Tier 1/2 below with a small vertical guide tick
    under the parent notehead — never truncating or clipping words. Measures
    receive proportional `visualWeight` (busy bars breathe; rest bars stay
    compact). Weighted ledger-line excursion minimization in
    `chooseClef(medianMidi, notes)` automatically picks `treble-8vb` for wide
    low-register vocal contours while keeping regular `treble` for mid/high
    voices. Each system computes exact `highestInkY` and `lowestInkY` across
    all notes, ledger lines, stems, beams, and harmony diamonds so chords,
    bar numbers, note names, and lyrics never collide with staff ink.
  - **Scale-snap transparency (`score-show-snap-moves`, default `false`)**:
    When enabled, every note shifted by scale snapping renders a vivid
    burnt-orange (`#c2410c`) hollow ghost dot at the raw detected pitch, a
    vertical arrow to the snapped notehead, and an explicit `F→F♯` move tag.
  - **Configurable header bar & opt-in tracking cues**: `score-paging`
    defaults to `'page'` (full-page turns; `'scroll'` shifts one row at a
    time). Moving red playhead (`score-show-playhead`, default `false`) and
    yellow active-measure highlight (`score-show-active-measure`, default
    `false`) stay off until opted in. Each header item is independently
    toggleable (`score-header-title`, `score-header-key`, `score-header-time`,
    `score-header-bpm`, `score-header-clef`, `score-header-bars`,
    `score-header-page`), using clear plain labels (`Bars 1–12/48`, `Page 1/4`).
  - **Per-song Key & Clef live panel (`desktop/score-config-panel.js`)**:
    Shows and edits the active song's real key (`D major [Detected]` or
    `[Override]`) and clef via non-destructive D-Bus `editScore` patches
    without clobbering existing chord or note overrides.
  - **MIDI export & built-in WebAudio audition (`shared/score-midi.js`,
    `GET /api/score/midi`, `service/settings-page/lead-sheet.js`)**: Pure-JS
    Standard Type-1 MIDI exporter (Conductor + Voice 1 melody/lyrics + optional
    Voice 2 harmony + Chords) and zero-dependency WebAudio audition player
    inside the Lead Sheet modal (`▶ Play MIDI` / `⏹ Stop`, `Melody` / `Chords`
    / `Click` toggles, `50%–125%` speed, click any bar number to play from
    that bar, `⬇ .mid` download).
  - **Polyphonic multi-voice duet extraction (`service/generate-score.py`,
    `score-voices`)**: Pass-1 full vocal stem (`BS-RoFormer`) + Pass-2 backing
    residual (`mel_band_roformer_karaoke`) + 36-bin/octave CQT harmonic
    cancellation detect simultaneous harmonizing male/female vocal parts
    (`voice: 1` upper melody, `voice: 2` lower harmony) while keeping solo
    songs strictly single-voice. Engraves Voice 1 stems UP in pure black and
    Voice 2 stems DOWN in deep royal indigo (`#1e3a8a`) with per-voice
    beaming, 2nd-interval collision horizontal offset, separate MIDI tracks,
    and a live `Vocal voices` selector (`Both` / `Top` / `Bottom`).
  - **Unified Ingest → Analyze → Display pipeline (`service/ingest.js`,
    `service/analyzer.js`, `op: 'analyzeSong'`)**: Song sources/overrides
    (Stage 1: Ingest), audio separation/beats/chords/multi-voice melody +
    vocal-isolated lyric fusion (Stage 2: Analyze), and live Lyrics / Lead
    Sheet / Pitch presentation (Stage 3: Display) are cleanly separated and
    surfaced as a single pipeline status row on the Settings page.
  - **Interactive browser Lead Sheet viewer & editor (`?score=1`, shortcut `S`,
    `Lead sheet` button in topbar & song deck)**: full-song white-paper SVG
    lead sheet honoring all display toggles, song-level recalculation
    controls (`½×` / `1×` / `2×` tempo, `4/4` / `3/4` / `6/8` / `2/4` meter,
    key root/scale override, clef `Auto` / `Treble` / `8vb`, and `±1 beat`
    barline shift), click-to-edit chord symbols above any bar (with diatonic
    quick-picks), and click-to-edit notes (pitch `±1 st` / `±1 oct`,
    shorter/longer duration, split, merge next, delete, add note in bar,
    `Undo`/`Redo`, `Reset edits`). Edits save non-destructively onto
    `scores/<videoId>.json` via `POST /api/score/edit` and update the
    floating desktop Lead Sheet live.
  - **Multi-source vocal-isolated lyric fusion & coupled refresh**: when
    extracting a score, `LyricsCore` waits for any in-flight LRCLIB lookup
    first, passes LRCLIB's canonical text as a Whisper prompt, and reuses the
    RoFormer-isolated lead-vocal Whisper pass (`result.segments`) at zero
    extra GPU cost to fuse LRCLIB's exact words, kanji, punctuation, line
    breaks, and relative spacing on unmatched lines with exact vocal-isolated
    audio timestamps (`gen:vocal:aligned` / `gen:vocal:transcribed`), adding
    the fused set alongside LRCLIB's originals without deleting them.
    **Refresh all** (`op: 'refreshAll'`) re-queries LRCLIB, re-downloads
    fresh audio (`--fresh-audio`), and rebuilds both score and vocal-fused
    lyrics in one action.
  - **Adaptive lead-vocal extraction, tempo folding & chords**: two-pass
    RoFormer isolation (BS-RoFormer -> Mel-Band RoFormer Karaoke) with
    adaptive RMS blending back to full vocals wherever Pass-2 over-suppresses
    duets or quiet verses, peak normalization, `Beat This!` with tempo-octave
    folding into `[62, 154]` BPM, half-timed intro fill, and regular phase-locked
    measures, harmonic chroma + Viterbi chord detection (`B`, `G#m`, `F#7`, etc.),
    `openvpi/GAME-1.0-large` vocal transcription, `faster-whisper large-v3` word
    timestamps, and optional `Refine (HQ)` (`overlap=4`) re-extraction that
    preserves song-level edits.
  - **Key, harmony 3rds & display options**: Krumhansl-Kessler key detection
    fills the pitch panel's detected scale whenever live detection has not
    settled (and honors user `keyOverride` edits). `score-scale-snap`
    (`soft` / `strict` / `off`), `score-harmony` (deep blue 3rd above /
    forest green 3rd below hollow diamonds on white paper), `score-note-names`
    (`letters` / `degrees` / `off`), and `score-background-opacity`
    (`75%–100%`, default `96%`).
- **Automatic local lyric timing with quiet in-overlay status (owner,
  2026-11-20).** When `lyricsGenerator` is configured in `settings.json`
  (off by default in `settings.example.json`) and a playing song's LRCLIB
  lookup settles as `plain` (untimed lyrics only) or `none` (no match),
  the service automatically generates timed LRC lyrics locally using
  `faster-whisper` (`large-v3` on CUDA when available, or CPU):
  - **Mode A (plain-lyric alignment)** when LRCLIB has plain lyrics: runs
    Whisper with word timestamps and aligns LRCLIB's exact lines onto the
    spoken/sung words via monotone semi-global DP (skipping section headers
    like `[Chorus]`, ignoring spoken intros/outros, interpolating missed
    lines, and inserting blank LRC markers for instrumental gaps >= 4.5 s
    so countdowns work).
  - **Mode B (direct transcription)** when LRCLIB has no plain lyrics or
    plain-lyric alignment coverage falls below 18% (wrong song): cleans
    Whisper's segments (filtering silence/caption hallucinations and
    degenerate loops, splitting long segments on pauses or punctuation, and
    inserting instrumental-gap blanks).
  - **Quiet in-overlay status pill**: while generation runs (`lyrics ===
    'generating'`), the overlay shows a single compact translucent pill
    (`Timing lyrics · loading audio 34 / 73 MB (47%)`, `Timing lyrics ·
    waiting for GPU`, `Timing lyrics…`, live progress like `Timing lyrics ·
    42:10 / 2:26:37 (29%)` on multi-minute tracks, or `Aligning lyrics …`
    when LRCLIB has plain lyrics) in crisp white bold text with no animation
    or flashing, hiding immediately once timed lyrics (or early streaming
    subtitles covering the playhead) arrive. Clicking the pill still raises
    the YouTube tab; right-clicking opens the settings page.
  - **Standalone audio acquisition (2026-11-21)**: `lyrics-overlay` is an
    independent tool that owns its own audio download via `yt-dlp` without
    requiring `ytarchive` (using an already-cached `ytarchive`
    `soundtrack.mp3` only opportunistically if configured and already on disk).
    Automatic short-song downloads cap file size at 100 MB
    (`bestaudio[filesize<100M]/bestaudio`); explicit manual runs (`Generate
    timed lyrics`, `--max-duration 0`) lift the file-size cap and select a
    compact audio stream (`bestaudio[abr<=96]/bestaudio`) since Whisper
    resamples to 16 kHz mono, streaming `yt-dlp`'s byte progress into the
    `loading audio` status. When YouTube rejects the primary DASH audio
    stream with HTTP 403, `generate-lyrics.py` retries once via YouTube's
    HLS audio / progressive stream path, and supports an explicit opt-in
    `lyricsGenerator.cookiesFromBrowser` setting (default `null`, anonymous
    by default) for tracks or sessions where YouTube requires browser cookies.
  - **Long-track manual timing & early subtitles (owner, 2026-11-21)**:
    manual `Generate timed lyrics` works on multi-hour concerts and albums
    (e.g., 2.5–3 h works) and persists one complete LRC candidate atomically
    when finished (never saving partial lyrics to disk or handing partial
    lyrics to ytarchive, preserving full-libretto Mode A alignment). Tracks
    longer than 15 minutes decode and transcribe in 10-minute slices
    starting near the current playhead (`startAt - 10 s`, continuing forward
    to the end, then wrapping back to `0:00`), so peak RAM stays bounded
    (~38 MB per slice) and live early subtitles begin appearing on screen
    within seconds while transcription finishes in the background (for Mode
    A, temporary transcribed subtitles show until the full aligned libretto
    swaps in atomically). Multi-minute runs emit live `done / total (%)`
    progress (and name the GPU holder when waiting in line), and on
    GPU-gated machines tracks over 15 minutes run in the `new` lane
    (yielding politely between slices if an urgent `now` task needs the GPU,
    then resuming cleanly). Unlike automatic short-song runs—which cancel
    immediately when switching songs or stopping—an explicit manual run
    keeps running in the background if you pause or switch tabs, saves its
    completed lyrics to that video (and forwards them to ytarchive) when
    finished, surfaces background progress in Settings, and offers an
    explicit **Cancel timing** button.
  - **Discipline and persistence**: only runs automatically for the active
    sounding song (never for `next` preloads, instrumentals, or videos
    longer than `maxDurationSeconds`, default 900 s), cancels automatic runs
    immediately via `SIGTERM` if the user skips songs or stops, persists the
    generated candidate per video (`gen:aligned:*` / `gen:transcribed:*`) so
    replays are instant, automatically forwards the generated LRC to
    ytarchive when `ytarchiveUrl` is set, and offers manual `Time existing` /
    `Retry timing` / `Regenerate` / `Generate timed`, **Generate from
    scratch**, and `Cancel timing` in the pinned song deck.
    **Generate from scratch** deliberately withholds every existing lyric set
    from Whisper and directly transcribes the audio, for the case where the
    only available lyrics belong to another song; it preempts an in-flight
    plain-lyric alignment on the same song and clears the old timed candidate
    from the overlay right away so the quiet timing pill (and early
    transcribed partials) show instead of stale wrong lyrics. Manual generation always
    bypasses `maxDurationSeconds` so long works can be timed on demand even
    above the automatic cap, and raising `maxDurationSeconds` re-enables
    automatic generation for tracks previously skipped only for duration.
- **Choosing lyrics and overriding music detection (updated 2026-11-20).**
  When a video is not automatically recognized as music (`not-music`), a
  prominent **This is a music video** button appears in both the top bar
  and the Song section: one click permanently marks the video as music, raises
  its tab priority, runs LRCLIB lookup (including a title-only fallback for
  uploads whose channel is not the artist), preloads the upcoming song,
  and chains directly into automatic local lyric timing if LRCLIB has only
  untimed or no lyrics. In the Song section, **Lyric sets** lists every
  candidate with timed line counts and tags, lets the owner click any set
  to switch immediately, hide a wrong one ("Wrong lyrics: hide this set"),
  search again, run a manual LRCLIB artist/title search, generate or
  regenerate timed lyrics, or load a local `.lrc` / `.txt` lyric file
  directly (persisted per video and forwarded to ytarchive; plain `.txt`
  files can be aligned automatically onto the song's audio). Choices,
  imported files, and rejections are remembered per video.
- **Full lyrics modal view (owner, 2026-11-20; group view 2026-11-21).** A
  **Full lyrics** button in the settings page header bar and Song section
  (and keyboard shortcut `L`) opens a resizable, nearly full-viewport
  full-lyrics modal (`?lyrics=read`) at a large 32 px reading size (adjustable
  from 18–64 px), showing every line
  of the active lyric set (timed or untimed) with tabular timestamps,
  optional Japanese furigana, adjustable reading size, inline timing nudges,
  and live current-line highlighting (`Now`) with smooth auto-scroll (which
  pauses automatically if the user scrolls manually, with a one-click
  **Jump to current** button), so you can read and follow the whole song
  without watching the video window.
- **Manual review, local editing, and anonymous LRCLIB publishing (owner,
  2026-11-20).** Switching the Full lyrics modal to **Edit & publish**
  (`?lyrics=edit`, or clicking **Edit & publish to LRCLIB** on the Song
  tab) pre-fills artist, track, real album (never placeholder labels like
  `Auto-transcribed from audio`), duration, and full lyrics with any active
  timing offset already baked into the timestamps (`max(0, t - offset)`).
  The owner can fix misheard words or timestamps and **Save local edits**
  directly onto the video (updating the overlay and ytarchive and resetting
  the offset to `0`), or explicitly click **Publish to LRCLIB** to submit
  anonymously via LRCLIB's proof-of-work challenge (`POST /api/request-challenge`
  + `POST /api/publish` — no account required). Publishing is strictly
  manual (never automatic), shares LRCLIB's persistent request budget and
  generic User-Agent, and never logs lyric text.
- **The icon says the state quietly.** A note beside three text lines: a
  filled note with bold lines while the overlay is on, a hollow note with
  thin lines while it is off. Only these two (owner, 2026-11-10: "just
  on/off is enough"); the no-lyrics variants were dropped. Nothing pops up
  unasked: the one notification answers a right press whose settings page
  could not be shown, with the reason and the page's address.
- **Lookup from metadata first.** Song, artist, album and year always come
  from YouTube's own metadata for LRCLIB lookups; audio is downloaded and
  transcribed locally only when `lyricsGenerator` is configured and LRCLIB
  lacks synced lyrics.
- **Next song preloaded.** The upcoming video's lyrics are fetched while the
  current one plays, when the upcoming listing names an artist.
- **Efficient and cached.** Every answer is cached server-side and reused;
  requests to LRCLIB stay inside a persistent budget (below).
- **The pitch panel (owner, 2026-11-10; Ctrl+drag 2026-11-20).** A panel of
  its own traces the owner's sung pitch from the microphone, as voice-wei's
  Pitch page does. It shows while it is switched on, the overlay is on and
  a YouTube tab plays, with or without timed lyrics. It docks against a
  side of the lyric box (below by default, above, left or right) or stands
  separate anywhere on the screen. `Ctrl+drag` on its edges resizes it;
  `Ctrl+drag` on a separate panel moves it; dropping it against a side of
  the lyric docks it there; `Ctrl+drag` away from a docked side makes it
  separate. Plain clicks and drags never move or resize it. Every placement
  and size persists.
- **The pitch panel is configurable like voice-wei's (owner, 2026-11-10).**
  The notes shown: a fixed range from a lowest to a highest note, set in
  semitone or octave steps or fitted to the last 30 s of singing, or a span
  of semitones that follows the voice. Seconds across (2-120), whether the
  trace scrolls through silences, line thickness (0.5-12 px) and color,
  and how opaque its background is. Every semitone line can carry its note
  name (D3, E4: every line, the scale's notes, C only, or none), at a
  chosen size. The current note goes in a column at either side, in a
  corner over the trace, or nowhere, at a chosen size; its cents off the
  note are hidden unless switched on. Analyses per second: 10-100, 50 by
  default (the owner's phone traced more often than the first version's
  fixed rate).
- **Scale lines stand out (owner, 2026-11-10).** Every semitone line is
  drawn; those of the song's scale are drawn more prominently. The scale
  is detected from the song itself, fixed by the owner (any root; major,
  the three minors, the modes, either pentatonic or blues), or none, and
  the panel can name it in its corner.
- **A steady current note (owner, 2026-11-10).** The current note's slot
  is sized for the widest note name and its figures are tabular, so the
  text never shifts sideways between frames; it keeps the last note
  through gaps up to 1.5 s (consonants, breaths) instead of blinking, and
  moves to another note only once the voice is 0.15 semitone past the
  boundary between them.
- **The microphone is chosen (owner, 2026-11-10).** The settings page lists
  the system default and every PipeWire audio input; the choice persists.
  The echo canceller, on by default, subtracts what the speakers play, so
  the trace follows the singer and not the song.
- **Every video heard goes to ytarchive (owner, 2026-11-10; live stop
  2026-11-20).** When `ytarchiveUrl` is set, every YouTube video that starts
  sounding, song or not, is added to that ytarchive, which records "Played"
  as how it first arrived (beside "Bookmarklet" and "Pasted" for the owner's
  other routes). The lyrics in use follow as an LRC file, and are replaced
  when another set is chosen. When the tab closes or switches videos (or
  stays paused/muted for 60 s), the service tells ytarchive so an ongoing
  live stream recording finishes cleanly instead of running forever. Nothing
  on the settings page or the overlay concerns it: ytarchive tracks the
  video from there. This replaced the browser's "Add to ytarchive" menu
  items, which the owner found unneeded once every video is added.
  `ytarchiveUrl: null` (the default) turns it off.

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
- **Duration-gated LRCLIB matching (owner, 2026-11-25).** Trusting synced
  timestamps is separated from trusting lyric text (`shared/lyric-text.js`,
  `SEARCH_VERSION = 2`):
  - **Timed acceptance (`±2 s`):** LRCLIB synced lyrics are auto-accepted as
    timed only when `|record.duration - songDuration| <= 2 s` (matching
    LRCLIB's own `/api/get` window for whole-second rounding and platform
    fade/silence tails), `record.duration > 0`, and the last spoken lyric line
    does not overrun `songDuration + 2 s` (ignoring trailing blank and credit
    lines). Early-stopping across query variants requires the same ±2 s fit.
  - **Moderate mismatch (`2 s` to `min(60 s, 40%)`):** Timed LRCLIB records
    outside ±2 s (such as music videos with intros/outros or live cuts) are
    demoted to plain text (extracting plain lines from `syncedLyrics` if
    `plainLyrics` is empty) so local Whisper Mode A aligns those exact words
    onto the actual audio instead of playing out-of-sync timestamps.
  - **Gross mismatch (`> 60 s` or `> 40%`):** Rejected as non-matching
    (`matches: false`), preventing multi-hour videos whose description carries
    a Music card for one song from attaching that short song's lyrics.
  - **Exact playback duration & preload re-scoring:** Scoring uses a smooth
    decay `1 / (1 + diff / 10)` (no 20 s flat floor) against the player's
    float `media.duration` when playing and not in an ad (falling back to
    `lengthSeconds` otherwise). Videos preloaded from YouTube's rounded `next`
    `lengthText` re-rank from the local search cache (zero extra LRCLIB
    requests) once real playback duration arrives.
- **Lookup pacing (2026-11-10).** Only the sounding tab looks up lyrics,
  and queued lookups for tabs that stopped mattering are dropped. A search
  waits at most 12 s (usually under 1 s); up to four query variants run one
  after another. An LRCLIB "429 Too Many Requests" pauses every lookup
  until its Retry-After, persisted across restarts, instead of counting as
  a failure. Each lookup logs its outcome and timings. Before this, every
  open YouTube tab queued lookups and 429s read as failures, so a song
  could show "Looking up lyrics" for minutes.
- **Going to the song (2026-11-10; lifecycle hardened 2026-11-20; standalone
  window raiser 2026-11-20).** The browser extension selects the tab but never
  focuses the browser window itself: Firefox's focus request (and its MPRIS
  `Raise()` call) carries no Wayland activation token, so GNOME/Mutter blocks
  it with focus-stealing prevention and shows a "... is ready" notification
  instead of raising the window; MPRIS also ignores `windowTitle` across
  multiple Firefox windows and does nothing when playback is paused or has no
  MPRIS controller. On GNOME Wayland, the standalone desktop frontend calls a
  tiny zero-UI GNOME Shell companion extension (`lyrics-overlay-raiser@ernop`,
  no rendering or settings) over session D-Bus to raise the window whose
  title matches the one the extension reports (preferring Firefox windows on
  exact matches, waiting up to 1 s for the browser to retitle it, and raising
  the most recently active matching window when multiple windows share that
  title—for example two Firefox windows both showing `Lyrics overlay settings`—
  rather than failing silently). Because the add-on omits the `tabs` permission, Firefox's
  `windows.get()` can occasionally return `undefined` for `window.title` during
  a tab switch; the service accepts an omitted or empty `windowTitle` instead
  of refusing `/api/command-result`, and the raiser falls back to raising the
  single or most recently active Firefox window when no title was reported. On
  non-GNOME desktops (or before the helper extension is loaded), the desktop
  frontend falls back to Firefox's MPRIS `Raise()`. A tab switch answered more
  than 3 s after the click is dropped, so a slow browser never pulls a window
  forward unasked. On 2026-11-20, another GNOME extension disabling caused
  GNOME Shell 50 to unwind `disable()`/`enable()` twice; the older legacy
  extension threw inside `disable()` and left `this._client` unstarted
  while a stale proxy still drew lyrics, breaking every click. Both extensions'
  `disable()` are idempotent, `enable()` clears stale state and rolls back on
  error, callbacks verify `this._client === client`, and clicks inside the
  legacy edge resize zone only start resizing once pointer movement passes the
  desktop drag threshold.
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
- **The settings page lives in the service, at plain localhost
  (2026-11-10).** The service serves it and holds the settings in the shell
  extension's GSettings schema, which it compiles from its own checkout,
  so the page offers exactly the keys it checks; the shell applies each
  change as it lands. Its address is `http://localhost:8792/settings`, not
  under `lyrics.localhost`: Firefox's HTTPS-First mode exempts `localhost`
  but not its subdomains, and a tab at `lyrics.localhost` first waited
  seconds on an HTTPS attempt. Text is pure white on black, values
  outrank labels, rows are one line, and every slider shows its notches,
  labeled ends and current value.
- **One settings tab, through the add-on (1.2.0, 2026-11-10).** A right
  press asks the add-on to select the open settings tab, or open it, and
  the shell raises that window as it does the song's. To see which tab is
  the settings page the add-on needs access to `http://localhost/*`, which
  Firefox grants only when an add-on is first installed: an update that
  adds it (1.1.0 to 1.2.0) leaves it off, and a user can turn it off later.
  While it is off, the add-on shows a page of its own instead, at once
  after such an update and at each right press: one button asks Firefox
  for the access, and the page then becomes the settings tab. The
  alternative, Firefox's `tabs` permission, would be granted with the
  update but lets the add-on read the address and title of every tab.
  When no add-on is listening, the right press shows a notification with
  the reason and the page's address; the shell never starts a browser
  itself.
- **The pitch panel is part of the shell, not a window (2026-11-10).** Like
  the lyric, it floats above other windows without being one, so it never
  takes focus, a taskbar entry or a window-manager rule, and it docks by
  sharing the lyric box's coordinates. Drags on its edges and body are its
  own; a right press shows the settings page.
- **The song's key comes from its sound (2026-11-10).** While the pitch
  panel stands out a detected scale and the microphone runs for a sounding
  song, the service listens to what the computer plays (the default
  output's monitor, not the microphone): each 0.74 s window's spectrum is
  folded into energy per pitch class, summed over the song, and matched
  against the Krumhansl-Kessler major and minor key profiles. A key is
  named after about 8 s, and only when its match leads that of the best
  key with other notes by at least 0.02 (a correlation difference); its
  relative major or minor is no rival, since it has the same notes and
  draws the same scale lines. Per video only the summed energies are kept,
  so a replay starts from them; audio never leaves memory.
- **Fonts: every family that can write English (2026-11-10).** The list is
  whatever fontconfig says covers English, minus Ghostscript's two symbol
  fonts (D050000L, Standard Symbols PS), which fontconfig takes for Latin
  but which draw pictures. `scripts/install-fonts.sh` downloads about 160
  font packages from Ubuntu's archive and unpacks their TrueType and
  OpenType files into `~/.local/share/fonts/`: no root, no system change,
  rerun safely, and the page lists the new families at once (GNOME Shell
  draws them after the next login). Iosevka (99 MB) and TT2020 (76 MB) are
  left out for their size; Type 1 and web fonts are skipped because GNOME's
  text stack does not draw them.
- **The overlay hides when playback is gone, and background tabs never
  flash it out (2026-11-20).** A tab that closes says so at once. A browser
  that quits, crashes or sleeps cannot, so each report promises the next
  within 5 s while the video runs; a tab that misses three promised reports
  is dropped, and the line disappears within 15 s instead of running on to
  the end of the song (2026-11-09). When multiple unmuted YouTube tabs play
  at once (for instance, an open webcam livestream alongside a song), active
  tab selection never ranks tabs by heartbeat arrival time: sounding musical
  tabs always outrank non-music tabs, ties break by when playback started
  (`soundingSince`) rather than the latest heartbeat, and an older
  background non-music stream never steals from a just-paused song during
  its two-minute grace window.
- **The indicator lingers two minutes** after sound stops, so a pause or the
  gap between songs does not make it vanish and reappear.
- **The microphone opens only when needed**: overlay on, pitch panel on,
  and YouTube sounding. A pause of up to 10 s keeps it open rather than
  toggling; switching the overlay or the panel off closes it at once.
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
- **Firefox updates the add-on itself, and the page shows which one runs
  (owner, 2026-11-10; 1.3.0).** A self-distributed add-on updates only
  from an address its manifest names; without one, Firefox's daily check
  goes to Mozilla, sending the add-on's ID and version, and finds nothing.
  An owner ran 1.0.0 for a day while 1.1.0 and 1.2.0 were out, and tab
  switching, built for 1.1.0, looked broken. From 1.3.0 the manifest's
  `update_url` is the newest GitHub release's `updates.json`, a fixed
  address Firefox fetches without cookies; Firefox installs a newer
  version itself, without a prompt when its permissions are unchanged.
  Every report names the add-on's version, and the settings page's Song
  section shows it against the version of the service's checkout, with an
  install button when Firefox runs an older one (1.0.0 to 1.2.0 name none:
  "Older than 1.3.0"). Native messaging, the purpose-built link between an
  add-on and a desktop program, was weighed and deferred: it would replace
  the HTTP link and its held request, but adds a helper program and is
  untested in Ubuntu's snap Firefox, which reaches helpers only through a
  desktop portal.
- **Standalone XWayland desktop frontend (owner, 2026-11-20).** The
  primary desktop frontend is a standalone GJS GTK3/XWayland process
  (`desktop/`, systemd user unit `lyrics-overlay-desktop.service`),
  replacing the in-shell GNOME extension as the default install. It
  restarts in milliseconds with zero logout, is unaffected by GNOME Shell
  version changes or extension-unwind bugs, shares the exact Cairo/Pango
  layout and pitch rendering in `shared/` with zero duplication, and works
  on any X11 or Wayland+XWayland desktop. The lyric and pitch windows use
  `TOPLEVEL` with `Gdk.WindowTypeHint.NOTIFICATION` (`skip_taskbar`,
  `skip_pager`, `keep_above`, `stick`, `focus_on_map=false`,
  `accept_focus=true`): empirically verified on GNOME Shell 50 + XWayland
  so `Ctrl+drag` from a focused native Wayland window delivers synchronous
  `CONTROL_MASK`, `Shift`, and `Escape` (unlike `override_redirect`
  popups, which receive stale `state=0`), while staying out of Alt+Tab,
  taskbars, and window-border decorations and never stealing focus on map.
  Empty pixels around the lyric stay click-through via
  `input_shape_combine_region`. On GNOME Wayland, `scripts/install.sh` also
  installs a minimal zero-UI companion extension
  (`lyrics-overlay-raiser@ernop`) that exposes only `RaiseWindow(title)` over
  session D-Bus so clicks raise the exact Firefox window without hitting
  Wayland focus-stealing prevention (one logout/login to load; zero UI or
  settings, so overlay changes still restart in milliseconds with no logout).
  The legacy GNOME Shell 50 extension
  (`gnome-extension/lyrics-overlay@ernop`) stays in the repository for
  optional use (`scripts/install-gnome-extension.sh`), and `scripts/install.sh`
  disables it automatically so two overlays never draw at once.
- **Public, and installable by anyone (owner, 2026-11-10).** The repository
  is public. On any Linux desktop with XWayland or X11, `scripts/install.sh`
  installs the service and standalone desktop frontend, and the signed
  add-on comes from the GitHub release; nothing depends on the owner's
  other tools, and ytarchive is off unless `ytarchiveUrl` is set. MIT
  license. The history starts at the public release; the private history
  before it was dropped.
