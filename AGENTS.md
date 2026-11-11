# Agent guide

Entry point for agents working on the lyrics overlay. Read this first, then
the doc that owns your change. Every doc in the repository is listed here.

| Doc | What it holds |
|-----|---------------|
| [README.md](README.md) | What it does, install, the controls and the settings page (with pictures), service settings, privacy |
| [docs/product.md](docs/product.md) | Owner requirements and settled decisions, with reasons |
| [docs/architecture.md](docs/architecture.md) | Parts, report contract and HTTP guards, browser commands, the ytarchive hand-off, settings, pitch capture and the song's key, what the overlay shows when, YouTube page facts, service core, D-Bus, GJS lifetime rules |
| [docs/operations.md](docs/operations.md) | Install, restart, verify, tests, release, testing lessons |

## Working method

- Trace every defect to the design choice that allowed it and fix that,
  then sweep for the same fault elsewhere; add a test that fails without
  the fix.
- State is explicit and named: reports and records are objects with named
  fields, validated at the boundary (`service/report-schema.js`). A promise
  between components travels in the data (`heartbeatMs`), not in matching
  constants.
- Requirements and decisions go into docs/product.md in the same change;
  behavior and contracts into docs/architecture.md.

## Working with the owner

Lessons from the retrospective of the first build (2026-11-10).

- Put each new piece on the owner's real desktop early: headless tests
  prove the code, not that the owner sees it. The first build ran only
  headless, and its first real line showed on the second day.
- After a step only the owner can take (an add-on prompt, a login),
  confirm it took effect before building on it or debugging behind it:
  the installed add-on version (docs/operations.md, "Verify") and
  `scripts/check-live-desktop.py`.
- Gather the changes that wait on a login, and say once what that login
  brings.
- Before building a new control surface, show its shape and get the
  owner's yes; a right-click menu was built, shipped and then rejected.
- At the start, list every requirement the request states, and check the
  list at each report. "Never flash" and note-labeled pitch lines were in
  the first request and came back as complaints.
- Before any push, private or public, read the diff for device
  identifiers and listening data. Tell the owner of a side effect on the
  real system as soon as it happens.
- Report at checkpoints rather than in one long turn, so a new request
  steers the work early.

## Test, ship, restart

1. `npm test && npm run lint` (about 4 s). When the GNOME Shell extension,
   the shell harness or the service's D-Bus side changes, also
   `npm run test:shell` (about 11 s).
2. Commit each coherent change on its own.
3. Service change: `systemctl --user restart lyrics-overlay.service`, then
   `curl -s http://127.0.0.1:8792/api/state`. Install change:
   `scripts/install.sh`.
4. GNOME Shell extension change: `scripts/install-gnome-extension.sh`; it
   takes effect at the next login (an update waits as a pending copy until
   then; docs/operations.md, "Install and restart"). After that login, with
   a song playing, `python3 scripts/check-live-desktop.py` must report the
   tray indicator drawn before the change counts as live.
5. Firefox extension change: check it in real Firefox first
   (`scripts/probe-firefox-commands.mjs` for command handling,
   `scripts/probe-real-firefox.mjs` for page reading; docs/operations.md,
   "Tests"). Then bump `firefox/manifest.json`'s version and run
   `npm run release:firefox`, only with the owner's approval for that
   release (signing uploads the code to Mozilla under the owner's account).
   It ends at Firefox's "Add Lyrics Overlay?" prompt, which the owner
   presses; never copy the XPI into the profile instead (see
   docs/operations.md, "Release the Firefox extension"). Then publish the
   signed file as a GitHub release, which the README's download link
   serves.
6. A change to what the lyric, the pitch panel or the settings page looks
   like: refresh the README's pictures with
   `scripts/update-readme-pictures.sh`, and look at each one.

## Standing rules

- The repository is public. Nothing committed names private repositories,
  private paths, other machines' layout, the owner's devices, or what the
  owner plays; test fixtures use made-up names.
- Nothing identifies the owner to a third party: LRCLIB sees a generic
  User-Agent, the add-on talks only to the service on this computer.
- LRCLIB requests go only through the persistent budget and caches in
  `service/core.js`; never add a request path around them.
- Tests never touch the real session: use `tests/isolated-session.mjs` for
  anything that starts a bus or a desktop process, and keep the real
  `~/.config/dconf/user` unchanged.
- Research YouTube's pages only in signed-out headless browsers, never in
  the in-IDE browser, which is signed in to the owner's accounts.
- Probes and logs print line keys, not lyric text.
