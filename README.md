# Lyrics overlay

This adds a global overlay of the lyrics, plus a pitch meter, so you can sing
along to YouTube videos of songs.

![A desktop with a song's video in a window; at the bottom of the screen, the line being sung and the pitch meter's trace of the singer's voice](docs/desktop.png)

It runs on a GNOME Shell 50 desktop with YouTube in Firefox. When a YouTube
or YouTube Music tab plays a song, the line about to be sung shows above all
your windows, timed to the video, and the pitch meter draws the pitch you
sing into the microphone. Lyrics come from [LRCLIB](https://lrclib.net),
found from the video's title and YouTube's own song details; a song without
timed lyrics there shows no line.

It has three parts:

- a Firefox add-on (`firefox/`) that tells the local service what the YouTube
  tab is playing; it sends nothing off the computer;
- a service (`service/`, a gjs program run as the systemd user unit
  `lyrics-overlay.service`) that finds the lyrics, remembers your choices and
  timing for each video, decides which line shows when, follows the pitch
  you sing, and serves the settings page;
- a GNOME Shell extension (`gnome-extension/lyrics-overlay@ernop`) that draws
  the indicator, the line and the pitch panel.

## Requirements

- GNOME Shell 50 (Ubuntu 26.04 or another distribution with it)
- Firefox 142 or later
- `sudo apt install gjs gir1.2-soup-3.0 libglib2.0-bin pipewire pipewire-bin`
- Node.js and npm, only to run the tests

## Install

```
git clone https://github.com/ernop/lyrics-overlay.git
cd lyrics-overlay
scripts/install.sh
```

`scripts/install.sh` checks the requirements, creates `settings.json` from
`settings.example.json`, installs and starts the service, and installs the
shell extension. Then:

1. Log out and back in; GNOME Shell loads extensions at login.
2. Download
   [lyrics-overlay.xpi](https://github.com/ernop/lyrics-overlay/releases/latest/download/lyrics-overlay.xpi)
   and open it in Firefox (drag it onto a Firefox window); press Add.

For more fonts, `scripts/install-fonts.sh` adds about 160 of Ubuntu's font
packages for your user alone (no root). The settings page lists them at once;
GNOME Shell draws them after the next login.

To update: `git pull && scripts/install.sh`. The service restarts at once; the
shell extension changes at the next login. From 1.3.0 Firefox updates the
add-on by itself (it checks the newest GitHub release once a day), and the
settings page shows the add-on's version, with an install button when
Firefox runs an older one. Versions 1.0.0 to 1.2.0 have no update address,
so Firefox never updates them: install the newest
[lyrics-overlay.xpi](https://github.com/ernop/lyrics-overlay/releases/latest/download/lyrics-overlay.xpi)
once by hand, as in step 2 above. An add-on updated from 1.0 or 1.1 opens a page
asking for access to localhost, which it needs to find the settings tab;
press Allow there once. Going to the song works without it.

To remove:

```
systemctl --user disable --now lyrics-overlay.service
systemctl --user disable lyrics-overlay-extension-update.service   # present after an update
rm -f ~/.config/systemd/user/lyrics-overlay*.service
gnome-extensions uninstall lyrics-overlay@ernop
rm -rf ~/.local/state/lyrics-overlay   # remembered choices, timing and caches
```

and remove the add-on in Firefox's Add-ons and themes page.

## Using it

The indicator shows while YouTube plays sound and for two minutes after.

![The indicator on and off, on a dark and a light panel](docs/indicator-icons.png)

| Where | Action | Result |
|---|---|---|
| Indicator | press | lyric line on or off |
| Indicator | right-press | the settings page |
| Lyric | hover | reveals the box frame and 8 edge/corner resize handles |
| Lyric | drag edge or corner | resizes from that edge, anchoring the opposite edge |
| Lyric | drag interior | moves the box with magnetic center/edge snap (hold Shift to bypass snap; Esc cancels) |
| Lyric | quick click | goes to the song's Firefox tab and raises its window |
| Lyric | right-click | the settings page |
| Lyric | Ctrl+scroll | changes the text size |
| Pitch panel | drag an edge | resizes it |
| Pitch panel | drag a separate one | moves it; dropped against a side of the lyric, it docks there |
| Pitch panel | drag a docked one away | makes it separate |
| Pitch panel | right-press | the settings page |

Where no lyric is drawn, clicks reach the windows below.

The keyboard's media keys (play/pause, next, previous) reach YouTube through
Firefox itself, which offers each playing tab to the desktop as a media
player; this needs Firefox's `media.hardwaremediakeys.enabled` (on by
default). The keys go to the tab that played media last.

## The settings page

Everything is set on one page in Firefox, http://localhost:8792/settings, and
each change shows on the line and the pitch panel as you make it. A right
press on the indicator, the lyric or the pitch panel selects that tab, or
opens it, and raises its window; there is only ever one.

![The settings page: live stage on the left, clean three-tab inspector on the right](docs/settings.png)

| Area | What it holds |
|---|---|
| Live stage (left, sticky) | flips between **Preview** (live lyric preview over Video/Dark/Light scenes on Lyrics/Song, or live pitch trace preview on Pitch, with inline sample text) and **Screen map** (exact monitor aspect ratio, 8-handle lyric resize and drag with center snap, pitch panel docking/resizing, multi-monitor picker, placement presets) |
| Lyrics | eight focused controls beside the preview: searchable font picker, constant size (`16-256 px`, long lines wrap naturally without shrinking), Bold/Italic, 11 colors or custom hex, proportional borders (`Double` fused x-height body + crisp trim + smooth dark backing cloud, `Glow` fused body + feathered halo + soft dark cloud, `Single`, `None`), optional `Behind text` or `Full bar` backdrop, alignment, and transition |
| Pitch | docking/size, fixed or voice-following range (or fit to last 30 s), window duration, scroll in silence, trace thickness/color/background, note names, scale highlighting (detected from song, fixed or none), current-note readout, analysis rate, PipeWire microphone picker and echo cancelling |
| Song | what is playing, lyric status, timing nudges (Too fast / Too slow in 0.5 s steps, Reset), single-line lyric sets with Timed/Untimed pills (Wrong lyrics, Search again, Look up), microphone and detected scale readout, and Firefox add-on version with install button when outdated |

White with a double border (the default), then yellow with a single border,
left-aligned:

![A lyric line, white with a double border](docs/line.png)

![A lyric line, yellow with a single border, left-aligned](docs/line-yellow-left.png)

## Service settings

`settings.json` (created from `settings.example.json`; restart the service
after a change with `systemctl --user restart lyrics-overlay.service`):

| Key | Default | Meaning |
|---|---|---|
| `port` | `8792` | the service's port on 127.0.0.1; the add-on, the shell extension and the settings page use 8792 |
| `hostname` | `"lyrics.localhost"` | one more name the service answers to, such as a local proxy's |
| `lrclibBaseUrl` | `"https://lrclib.net"` | the LRCLIB server |
| `ytarchiveUrl` | `null` | a ytarchive server that receives each video played and its lyrics; `null` sends nothing |
| `stateDir` | `"~/.local/state/lyrics-overlay"` | choices, timing and caches |

## Checking that it works

With a song playing:

| Check | Expect |
|---|---|
| `systemctl --user status lyrics-overlay.service` | active (running) |
| `curl -s http://127.0.0.1:8792/api/state` | `state.lyrics` is `timed` for a song LRCLIB has timed lyrics for; `addon.status` is `current`, not `older`, `unnamed` or `unheard` |
| `gnome-extensions info lyrics-overlay@ernop` | State: ACTIVE |
| `python3 scripts/check-live-desktop.py` | the indicator and the lyric line are drawn, and where |
| `journalctl --user -u lyrics-overlay.service` | one `lookup <video>` line for each video, saying `timed`, `plain` or `none` |

If no line shows:

- `lyrics` is `none` or `plain`: LRCLIB has no timed lyrics for the song. The
  settings page's Song section can search again or pick another lyric set.
- `addon.status` is `unheard`: no add-on has reported since the service
  started. Check that the add-on is installed and enabled in Firefox and
  that the YouTube tab plays sound.
- `addon.status` is `older` or `unnamed`: Firefox runs an old add-on; use the
  settings page's install button, or install the `.xpi` as in Install.
- The extension is not ACTIVE: log out and back in once after
  `scripts/install.sh`; GNOME Shell loads extensions only at login.

## Network and privacy

- The add-on reports only to the service on this computer.
- The service asks LRCLIB for lyrics with a generic User-Agent. Every answer
  is kept for 7 days, and searches are capped at 20 a minute, 200 an hour and
  1000 a day, across restarts.
- The microphone opens only while the line and the pitch panel are on and
  YouTube is playing sound.
- While the pitch panel shows a scale detected from the song, the service
  also listens to what the computer plays (not the microphone) to find the
  key. For each video it keeps only the summed energy of each note name.
- Audio stays in memory.

## Development

```
npm install
npm test            # unit suites and the real service against a stand-in LRCLIB
npm run lint        # web-ext lint on the add-on
npm run test:shell  # a headless GNOME Shell with the extension and service
```

[docs/product.md](docs/product.md) holds the requirements and decisions,
[docs/architecture.md](docs/architecture.md) how the parts fit together, and
[docs/operations.md](docs/operations.md) install details, tests and releases.
[AGENTS.md](AGENTS.md) is the entry point for coding agents.

## License

MIT; see [LICENSE](LICENSE).
