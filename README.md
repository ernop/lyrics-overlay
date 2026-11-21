# Lyrics overlay

Timed lyrics and a live singing pitch meter that float over your Linux desktop
while a song plays in YouTube or YouTube Music in Firefox.

It is meant for singing along casually while you watch a video or while you
work on something else. When a song starts playing in any Firefox tab — even
hidden on another workspace — the current line appears above your windows,
timed to the music, and an optional pitch meter beside or below it draws the
notes you sing into your microphone against the song's scale.

Lyrics are matched automatically, and your choices and timing adjustments are
remembered per video. Even for rare recordings or brand-new uploads that have
no lyrics anywhere online, optional local audio timing listens to the track and
builds timed lyrics automatically — usually in about 5 seconds once the song
starts playing on a local GPU — and saves them for instant replays. You can
also open a full-song lyrics view that tracks your place live, nudge timing in
half-second steps, search or load your own `.lrc`/`.txt` file, or edit and
anonymously publish verified lyrics back to LRCLIB. Layered borders keep lines
legible over bright and dark windows alike, optional offline Japanese furigana
places hiragana readings above kanji, and clicking a lyric jumps straight back
to the playing tab while empty space passes clicks through to whatever sits
behind it.

![Desktop with a song video playing; timed lyrics and the live pitch trace float at the bottom](docs/desktop.png)

## Sing from any workspace

YouTube does not need to stay on screen. While you read, write, or code in
other windows, the lyrics and pitch meter float unobtrusively over both bright
and dark apps, with a small note icon in the top bar whenever music is playing.

![Working across a light notes window and a dark code editor while timed lyrics and the live pitch trace float above](docs/workspace.png)

## Full lyrics view, local timing, and sharing back

Click **Full lyrics** (or press `L`) for a nearly fullscreen, large-text view
suited to a group following the whole song live without watching the video.
If a track had no lyrics
online, local timing transcribes and saves it automatically — and the **Edit &
publish** tab lets you fix any words and optionally publish verified lyrics
anonymously to LRCLIB.

![Full lyrics modal tracking the active line live, with auto-scroll, timing nudges, and Edit & publish tab](docs/full-lyrics.png)

## Readable over bright and dark scenes

Pick a font, size, color, and 1 to 4 concentric border rings — with automatic
high-contrast colors, custom per-ring colors and widths, or a soft glow — plus
optional offline Japanese furigana above kanji.

![Four lyric border styles and offline Japanese furigana over split dark and light backgrounds](docs/styles.png)

## Live settings and layout

Right-click the lyric, pitch panel, or top-bar note to open the single settings
page (`http://localhost:8792/settings`). Every change updates the live overlay
immediately.

![Settings page — combined Lyrics, Pitch, and Song page with live preview](docs/settings.png)

Arrange the lyric box and pitch panel directly on a map of your monitor, dock
the pitch panel on any side (or detach it), and adjust note range, scale
highlighting, and microphone choice:

![Settings page — Screen map and Pitch section](docs/settings-map.png)

For the current song, open full lyrics, nudge timing, switch lyric sets
(including locally transcribed ones), time existing words or **Generate from
scratch** when those words are wrong, search by artist and title, load a local
`.lrc` or `.txt` file, or edit and publish to LRCLIB:

![Settings page — Song section with local transcription, timing nudges, search, and file import](docs/settings-song.png)

## Everyday controls

| Action | Result |
|---|---|
| Click lyric | Jumps to the song's Firefox tab and raises its window |
| `Ctrl+drag` lyric | Moves it with center/edge snap (`Shift` bypasses snap, `Esc` cancels) |
| `Ctrl+scroll` lyric | Resizes the text |
| `Ctrl+drag` pitch panel | Moves, resizes from any edge, or docks against a side of the lyric |
| Click top-bar note | Toggles the overlay on or off |
| Right-click lyric, pitch panel, or note | Opens or raises the settings page |
| **Full lyrics** button (or `L`) | Opens the live full-song lyrics view and **Edit & publish** editor |

---

## Install

Requires a Linux desktop (Wayland with XWayland, or X11) and Firefox 142+.

```sh
sudo apt install gjs gir1.2-soup-3.0 gir1.2-gtk-3.0 libglib2.0-bin pipewire pipewire-bin
git clone https://github.com/ernop/lyrics-overlay.git
cd lyrics-overlay
scripts/install.sh
```

Then download
[lyrics-overlay.xpi](https://github.com/ernop/lyrics-overlay/releases/latest/download/lyrics-overlay.xpi),
drag it onto a Firefox window, and click **Add**. (From 1.3.0 onward, Firefox
keeps the add-on updated automatically.) On GNOME Wayland, `scripts/install.sh`
also installs a tiny zero-UI GNOME Shell helper (`lyrics-overlay-raiser@ernop`)
so clicking a lyric raises the exact Firefox window past Wayland focus-stealing
prevention; log out and back in once after first install so GNOME Shell loads
it.

### Optional extras

- **Local automatic lyric timing & offline Japanese furigana:** run
  `scripts/install-generator.sh` (creates a local `.venv` with `faster-whisper`
  and `sudachipy`), then enable `lyricsGenerator` in `settings.json` or toggle
  **Furigana** on the settings page.
- **Extra fonts:** `scripts/install-fonts.sh` unpacks extra fonts into
  `~/.local/share/fonts/` for your user.
- **Update:** `git pull && scripts/install.sh` (overlay and service changes
  restart immediately, no logout).
- **Remove:** `systemctl --user disable --now lyrics-overlay.service lyrics-overlay-desktop.service && rm -f ~/.config/systemd/user/lyrics-overlay*.service && gnome-extensions disable lyrics-overlay-raiser@ernop && rm -rf ~/.local/share/gnome-shell/extensions/lyrics-overlay-raiser@ernop`, remove the add-on in Firefox, and optionally delete `~/.local/state/lyrics-overlay` and `.venv`.

## Privacy

- The Firefox add-on talks only to the local service on this computer.
- Lyric lookups go to [LRCLIB](https://lrclib.net) with a generic User-Agent,
  cached for 7 days and strictly rate-limited. Publishing back to LRCLIB is
  strictly manual and anonymous (no account needed).
- Offline Japanese furigana and optional local audio timing run on this
  computer; temporary audio is deleted immediately and lyric text is never
  written to logs.
- Microphone and playback-key audio stay in memory and open only while music is
  playing with the pitch panel enabled.

## Technical details

The overlay consists of a small Firefox add-on (`firefox/`), a local background
service (`service/`), and a standalone desktop window process (`desktop/`).
Configuration lives in `settings.json` (copied from `settings.example.json`);
run `npm test` and `npm run lint` to run the test suite.

For full architecture, configuration keys, verification commands, and release
steps, see [docs/product.md](docs/product.md),
[docs/architecture.md](docs/architecture.md), and
[docs/operations.md](docs/operations.md).

## License

MIT; see [LICENSE](LICENSE).
