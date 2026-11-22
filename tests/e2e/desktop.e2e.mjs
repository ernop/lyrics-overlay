// End-to-end: service + standalone XWayland desktop overlay in a hermetic
// headless GNOME Shell 50 with XWayland.
// Run with `npm run test:desktop`; screenshots land in build/e2e-artifacts.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {MONITOR, sleep, startHarness} from './shell-harness.mjs';

const VIDEO = 'abcdefghijk';
const LRC = [
    '[00:02.00] First line of the song',
    '[00:06.00] Second line arrives here',
    '[00:40.00] A much later line',
].join('\n');
const TOPIC = 'Provided to YouTube by Label\n\nStub Song · Stub Band\n\nStub Album\n\n℗ 2003 Label';
const ANSWERS = {
    'Stub Band|Stub Song': [
        {id: 77, trackName: 'Stub Song', artistName: 'Stub Band', albumName: 'Stub Album', duration: 180,
            instrumental: false, plainLyrics: 'First line of the song', syncedLyrics: LRC},
    ],
};
const METADATA = {
    host: 'www.youtube.com', videoId: VIDEO, title: 'Stub Song', author: 'Stub Band - Topic', lengthSeconds: 180,
    category: 'Music', musicVideoType: '', description: TOPIC, musicCards: [], mediaSession: null, ytmByline: '',
};

function media(currentTime, overrides = {}) {
    return {
        videoId: VIDEO, currentTime, duration: 180, paused: false, ended: false, stalled: false,
        playbackRate: 1, muted: false, volume: 1, adShowing: false, ...overrides,
    };
}

const EVDEV = {KEY_Control_L: 29, KEY_Shift_L: 42, KEY_Escape: 1};

/** Pointer and keyboard input through Clutter virtual devices inside the shell. */
function inputScript(steps) {
    return `(async () => {
        const {default: Clutter} = await import('gi://Clutter');
        const seat = Clutter.get_default_backend().get_default_seat();
        globalThis.__lyricsPointer ??= seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        globalThis.__lyricsKeyboard ??= seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        const pointer = globalThis.__lyricsPointer;
        const keyboard = globalThis.__lyricsKeyboard;
        const evdev = ${JSON.stringify(EVDEV)};
        const now = () => GLib.get_monotonic_time();
        const wait = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { resolve(); return GLib.SOURCE_REMOVE; }));
        if (!globalThis.__lyricsPointerReady) {
            pointer.notify_absolute_motion(now(), 400, 0);
            await wait(30);
            globalThis.__lyricsPointerReady = true;
        }
        for (const step of ${JSON.stringify(steps)}) {
            if (step.move) pointer.notify_absolute_motion(now(), step.move[0], step.move[1]);
            if (step.button) pointer.notify_button(now(), step.button, step.down ? Clutter.ButtonState.PRESSED : Clutter.ButtonState.RELEASED);
            if (step.key) keyboard.notify_key(now(), evdev[step.key], step.down ? Clutter.KeyState.PRESSED : Clutter.KeyState.RELEASED);
            if (step.scroll) pointer.notify_discrete_scroll(now(), Clutter.ScrollDirection[step.scroll], Clutter.ScrollSource.WHEEL);
            await wait(step.wait ?? 24);
        }
        return true;
    })()`;
}

function drag({from, by, modifier = null, button = 1, cancel = false}) {
    const steps = [{move: from, wait: 40}];
    if (modifier)
        steps.push({key: modifier, down: true, wait: 40});
    steps.push({button, down: true, wait: 50});
    for (let i = 1; i <= 8; i++)
        steps.push({move: [from[0] + by[0] * i / 8, from[1] + by[1] * i / 8], wait: 25});
    if (cancel) {
        steps.push({key: 'KEY_Escape', down: true, wait: 40});
        steps.push({key: 'KEY_Escape', down: false, wait: 40});
    }
    steps.push({button, down: false, wait: 80});
    if (modifier)
        steps.push({key: modifier, down: false, wait: 60});
    return inputScript(steps);
}

const near = (a, b, tol = 3) => Math.abs(a - b) <= tol;
const center = rect => [rect.x + rect.width / 2, rect.y + rect.height / 2];
const inkCenter = status => [
    status.lyricBox.x + status.inkBox.x + status.inkBox.width / 2,
    status.lyricBox.y + status.inkBox.y + status.inkBox.height / 2,
];

const installNotificationSpy = `(() => {
    // GNOME Shell exports /org/freedesktop/Notifications on its own connection
    // and relies on the separate org.gnome.Shell.Notifications D-Bus service to
    // proxy the well-known name; claiming the name here lets GNOME Shell's real
    // NotificationDaemon receive Notify() calls on the isolated test bus.
    imports.gi.Gio.bus_own_name(
        imports.gi.Gio.BusType.SESSION,
        'org.freedesktop.Notifications',
        imports.gi.Gio.BusNameOwnerFlags.NONE,
        null, null, null);
    return true;
})()`;

const notifications = `Main.messageTray.getSources().flatMap(s => s.notifications.map(n => ({title: n.title, body: n.body})))`;

const focusedTitle = 'global.display.focus_window?.get_title() ?? null';

test('standalone XWayland desktop overlay: lyrics, Ctrl+drag from Wayland focus, click-through, pitch panel, tray', {timeout: 120000}, async t => {
    const genDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyrics-desktop-gen-'));
    t.after(() => fs.rmSync(genDir, {recursive: true, force: true}));
    const releaseFile = path.join(genDir, 'release');
    const stubGen = path.join(genDir, 'stub-gen.mjs');
    fs.writeFileSync(stubGen, `
import fs from 'node:fs';
process.stderr.write('stage:transcribe\\n');
const timer = setInterval(() => {
    if (!fs.existsSync(${JSON.stringify(releaseFile)}))
        return;
    clearInterval(timer);
    process.stdout.write(JSON.stringify({
        ok: true, language: 'en', duration: 180,
        segments: [
            {start: 0.5, end: 3.0, text: 'Generated lyric arrives live', no_speech_prob: 0.02, words: [
                {start: 0.5, end: 1.0, word: 'Generated', probability: 0.95},
                {start: 1.1, end: 1.6, word: 'lyric', probability: 0.95},
                {start: 1.7, end: 2.3, word: 'arrives', probability: 0.95},
                {start: 2.4, end: 3.0, word: 'live', probability: 0.95},
            ]},
            {start: 40.0, end: 43.0, text: 'Later generated line', no_speech_prob: 0.02, words: [
                {start: 40.0, end: 41.0, word: 'Later', probability: 0.95},
                {start: 41.1, end: 42.0, word: 'generated', probability: 0.95},
                {start: 42.1, end: 43.0, word: 'line', probability: 0.95},
            ]},
        ],
    }) + '\\n');
}, 50);
`);

    const h = await startHarness({
        answers: ANSWERS,
        xwayland: true,
        enableExtension: false,
        enableRaiser: true,
        extraSettings: {
            lyricsGenerator: {
                command: [process.execPath, stubGen],
                model: 'large-v3',
                device: 'cpu',
                computeType: 'int8',
                maxDurationSeconds: 900,
                gpuGate: null,
            },
        },
    });
    t.after(() => h.close());

    await desktopScenario(h, releaseFile).catch(error => {
        error.message += `\n--- desktop log:\n${h.desktopLog.split('\n').slice(-40).join('\n')}`
            + `\n--- service log:\n${h.serviceLog.split('\n').slice(-30).join('\n')}`;
        throw error;
    });
});

async function desktopScenario(h, releaseFile) {
    await h.evalJs('Main.overview.hide(); true');
    await h.waitFor(async () => !(await h.evalJs('Main.overview.visible')), 'overview to close');
    await h.evalJs(installNotificationSpy);

    await h.startDesktop();
    const initial = await h.desktopStatus();
    assert.equal(initial.active, false);
    assert.equal(initial.lyricVisible, false);
    assert.equal(initial.trayButtonVisible, false, 'no tray button while nothing plays');
    await h.waitFor(async () => (await h.desktopStatus()).windowRaiserActive, 'GNOME Shell window raiser companion on D-Bus');

    // Start playback: tray button appears (no StatusNotifierWatcher in headless shell),
    // lyric stays hidden until opted in.
    const playing = await h.play({tabId: 4, heartbeatMs: 5000, media: media(0.2), metadata: METADATA, next: null});
    assert.equal(playing.status, 204);
    const activeStatus = await h.waitFor(async () => {
        const s = await h.desktopStatus();
        return s.active && s.lyrics === 'timed' && s.trayButtonVisible && s;
    }, 'active timed lyrics and tray button');
    assert.equal(activeStatus.lyricVisible, false, 'overlay is opt-in');
    await h.screenshot('desktop-tray-button-off');

    // Inspect window properties in GNOME Shell: tray button sits in the panel strip.
    await h.evalJs(inputScript([{move: center(activeStatus.trayButtonBox), wait: 40},
        {button: 1, down: true, wait: 40}, {button: 1, down: false, wait: 80}]));
    await h.waitFor(async () => (await h.gsettings.get('overlay-enabled')) === 'true', 'left-click on tray button to toggle overlay on');

    // Wait for the first lyric line to render and map.
    const shown = await h.waitFor(async () => {
        const s = await h.desktopStatus();
        return s.lyricVisible && s.inkBox && s.inkBox.width > 50 && s;
    }, 'first lyric line to paint');
    assert.ok(Math.abs(shown.lyricBox.x + shown.lyricBox.width / 2 - MONITOR.width / 2) <= 2, JSON.stringify(shown.lyricBox));
    await sleep(300);
    await h.screenshot('desktop-first-line');

    // Verify Mutter window metadata: NOTIFICATION, skip_taskbar, absent from Alt+Tab.
    const winMeta = await h.evalJs(`(async () => {
        const {default: Meta} = await import('gi://Meta');
        const w = global.display.list_all_windows().find(x => x.get_title() === 'Lyrics overlay');
        if (!w) return null;
        const tabList = global.display.get_tab_list(Meta.TabList.NORMAL, null)
            .filter(x => !x.is_skip_taskbar())
            .map(x => x.get_title());
        return {
            windowType: w.get_window_type(),
            expectedNotification: Meta.WindowType.NOTIFICATION,
            skipTaskbar: w.is_skip_taskbar(),
            inAltTab: tabList.includes('Lyrics overlay'),
            rect: {x: w.get_frame_rect().x, y: w.get_frame_rect().y, w: w.get_frame_rect().width, h: w.get_frame_rect().height},
        };
    })()`);
    assert.ok(winMeta, 'Lyrics overlay window must exist in Mutter');
    assert.equal(winMeta.windowType, winMeta.expectedNotification);
    assert.equal(winMeta.skipTaskbar, true);
    assert.equal(winMeta.inAltTab, false);

    // Open native Wayland windows standing in for the playing browser window,
    // the settings window, and an unrelated app (mirrors Firefox + Cursor).
    const songWindow = 'Stub Song - YouTube — Mozilla Firefox';
    const settingsWindow = 'Lyrics overlay settings — Mozilla Firefox';
    await h.openWindow(songWindow);
    await h.openWindow(settingsWindow);
    await h.openWindow('Another window');
    const focusOther = async () => {
        await h.evalJs(`(() => {
            Main.activateWindow(global.display.list_all_windows().find(w => w.get_title() === 'Another window'));
            return true;
        })()`);
        await h.waitFor(async () => (await h.evalJs(focusedTitle)) === 'Another window', 'Another window to take focus');
    };

    // Wait for the second line (holds for 34 s so no line transition interferes).
    await sleep(4200);
    const line2 = await h.waitFor(async () => {
        const s = await h.desktopStatus();
        return s.lyricVisible && s.inkBox && s.inkBox.width > 80 && s;
    }, 'second lyric line');

    // 1. Per-pixel click-through: clicking transparent padding outside inkBox must NOT fire FocusSong.
    await focusOther();
    let accidentalFocus = false;
    const clickThroughGuard = h.answerNextCommand(() => { accidentalFocus = true; return {ok: true, windowTitle: songWindow}; });
    const emptySpot = [line2.lyricBox.x + 8, line2.lyricBox.y + 8];
    assert.ok(emptySpot[0] < line2.lyricBox.x + line2.inkBox.x - 8, `empty spot ${emptySpot} must lie outside inkBox ${JSON.stringify(line2.inkBox)}`);
    await h.evalJs(inputScript([{move: emptySpot, wait: 30}, {button: 1, down: true, wait: 40}, {button: 1, down: false, wait: 60}]));
    await sleep(150);
    assert.equal(accidentalFocus, false, 'clicking empty transparent space around the lyric must pass through');

    // 2. Plain left-press on ink fires FocusSong immediately (before release!)
    //    and raises the exact matching Wayland browser window past focus-stealing prevention.
    await h.evalJs(inputScript([{move: inkCenter(line2), wait: 40}, {button: 1, down: true, wait: 80}]));
    const focusCmd = await clickThroughGuard;
    assert.deepEqual([focusCmd.op, focusCmd.tabId], ['focusTab', 4]);
    await h.evalJs(inputScript([{button: 1, down: false, wait: 60}]));
    await h.waitFor(async () => (await h.evalJs(focusedTitle)) === songWindow,
        'clicking the active lyric to actually focus the matching browser window');
    const songDemandsAttention = await h.evalJs(`global.display.list_all_windows().find(w => w.get_title() === ${JSON.stringify(songWindow)})?.demands_attention ?? true`);
    assert.equal(songDemandsAttention, false, 'browser window must be raised directly, not stuck demanding attention');

    // 2b. Delayed retitle: browser window retitles 150 ms after FocusSong answers;
    //     the raiser waits up to 1 s and still activates it.
    const delayedTitle = 'Delayed Song - YouTube — Mozilla Firefox';
    const retitleTrigger = path.join(h.env.XDG_RUNTIME_DIR, 'retitle-now');
    const retitlingProgram = path.join(h.env.XDG_RUNTIME_DIR, 'retitling-window.js');
    fs.writeFileSync(retitlingProgram, `
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=4.0';
import System from 'system';
Gtk.init();
const loop = new GLib.MainLoop(null, false);
const win = new Gtk.Window({title: System.programArgs[0], default_width: 480, default_height: 320});
win.connect('close-request', () => { loop.quit(); return false; });
GLib.timeout_add(GLib.PRIORITY_DEFAULT, 40, () => {
    if (!GLib.file_test(${JSON.stringify(retitleTrigger)}, GLib.FileTest.EXISTS))
        return GLib.SOURCE_CONTINUE;
    win.set_title(${JSON.stringify(delayedTitle)});
    return GLib.SOURCE_REMOVE;
});
win.present();
loop.run();
`);
    await h.openWindow('Old Tab — Mozilla Firefox', retitlingProgram);
    await focusOther();
    const delayedAnswer = h.answerNextCommand(() => ({ok: true, windowTitle: delayedTitle}));
    await h.evalJs(inputScript([{move: inkCenter(line2), wait: 40}, {button: 1, down: true, wait: 40}, {button: 1, down: false, wait: 60}]));
    await delayedAnswer;
    await sleep(150);
    fs.writeFileSync(retitleTrigger, 'go');
    await h.waitFor(async () => (await h.evalJs(focusedTitle)) === delayedTitle,
        'window raiser to wait for delayed browser retitle and focus the window');

    // 2c. Duplicate titles: two windows share the title -> raiser picks the most
    //     recently active matching window instead of refusing silently (e.g. two
    //     Firefox windows both showing "Lyrics overlay settings").
    const dupTitle = 'Duplicate Window — Mozilla Firefox';
    await h.openWindow(dupTitle);
    await h.openWindow(dupTitle);
    const dupSeqs = await h.evalJs(`global.display.list_all_windows()
        .filter(w => w.get_title() === ${JSON.stringify(dupTitle)})
        .map(w => w.get_stable_sequence())`);
    assert.equal(dupSeqs.length, 2);
    const preferredSeq = dupSeqs[0];
    await h.evalJs(`(() => {
        const w = global.display.list_all_windows().find(x => x.get_stable_sequence() === ${preferredSeq});
        Main.activateWindow(w);
        return true;
    })()`);
    await h.waitFor(async () => (await h.evalJs('global.display.focus_window?.get_stable_sequence() ?? null')) === preferredSeq,
        'first duplicate window to become most recently used');
    await focusOther();
    const dupAnswer = h.answerNextCommand(() => ({ok: true, windowTitle: dupTitle}));
    await h.evalJs(inputScript([{move: inkCenter(line2), wait: 40}, {button: 1, down: true, wait: 40}, {button: 1, down: false, wait: 60}]));
    await dupAnswer;
    await h.waitFor(async () => (await h.evalJs('global.display.focus_window?.get_stable_sequence() ?? null')) === preferredSeq,
        'window raiser to activate the most recently used window among duplicate titles');

    // 2d. Omitted windowTitle (Firefox withholding window.title without tabs permission):
    //     service accepts /api/command-result (no 400 / 3 s timeout).
    await focusOther();
    const untitledAnswer = h.answerNextCommand(() => ({ok: true}));
    await h.evalJs(inputScript([{move: inkCenter(line2), wait: 40}, {button: 1, down: true, wait: 40}, {button: 1, down: false, wait: 60}]));
    await untitledAnswer;
    assert.doesNotMatch(h.serviceLog, /refused \/api\/command-result/u, h.serviceLog);

    // 2e. Duplicate disable/enable unwind on lyrics-overlay-raiser@ernop keeps raising working.
    await h.evalJs(`(() => {
        const ext = Main.extensionManager.lookup('lyrics-overlay-raiser@ernop');
        ext.stateObj.disable();
        ext.stateObj.disable();
        ext.stateObj.enable();
        ext.stateObj.enable();
        return true;
    })()`);
    await h.waitFor(async () => (await h.desktopStatus()).windowRaiserActive, 'raiser re-acquired after duplicate enable');
    await focusOther();
    const afterUnwind = h.answerNextCommand(() => ({ok: true, windowTitle: songWindow}));
    await h.evalJs(inputScript([{move: inkCenter(line2), wait: 40}, {button: 1, down: true, wait: 40}, {button: 1, down: false, wait: 60}]));
    await afterUnwind;
    await h.waitFor(async () => (await h.evalJs(focusedTitle)) === songWindow,
        'clicking lyric after raiser duplicate enable/disable still raises browser window');

    // 3. Plain drag (without Ctrl) must NOT move the lyric.
    await focusOther();
    const swallowClick = h.answerNextCommand(() => ({ok: true, windowTitle: songWindow}));
    await h.evalJs(drag({from: inkCenter(line2), by: [140, -90]}));
    await swallowClick;
    const afterPlainDrag = await h.desktopStatus();
    assert.deepEqual(afterPlainDrag.savedBox, line2.savedBox, 'plain drag must never move the lyric');

    // 4. Ctrl+press without movement from Wayland focus: must NOT fire FocusSong and must NOT move.
    await focusOther();
    let ctrlTapFired = false;
    const ctrlTapGuard = h.answerNextCommand(() => { ctrlTapFired = true; return {ok: true, windowTitle: settingsWindow}; });
    await h.evalJs(drag({from: inkCenter(line2), by: [0, 0], modifier: 'KEY_Control_L'}));
    await sleep(150);
    assert.equal(ctrlTapFired, false, 'Ctrl+press without movement must do nothing');

    // 5. Ctrl+drag from native Wayland focus: MUST move the lyric and persist to GSettings!
    await focusOther();
    await h.evalJs(drag({from: inkCenter(line2), by: [140, -90], modifier: 'KEY_Control_L'}));
    const moved = await h.waitFor(async () => {
        const s = await h.desktopStatus();
        return Math.abs(s.savedBox.x - (line2.savedBox.x + 140)) <= 4
            && Math.abs(s.savedBox.y - (line2.savedBox.y - 90)) <= 4 && s;
    }, 'Ctrl+drag from Wayland focus to move the lyric');
    assert.ok(near(moved.savedBox.x, line2.savedBox.x + 140), JSON.stringify([line2.savedBox, moved.savedBox]));
    assert.ok(near(moved.savedBox.y, line2.savedBox.y - 90), JSON.stringify([line2.savedBox, moved.savedBox]));
    const storedBox = await h.gsettings.get('box');
    assert.match(storedBox, /'cx': 0\.5[789]/u, storedBox);
    await h.screenshot('desktop-after-ctrl-drag');

    // 6. Ctrl+drag + Escape cancels without changing position.
    await focusOther();
    await h.evalJs(drag({from: inkCenter(moved), by: [-160, -80], modifier: 'KEY_Control_L', cancel: true}));
    await sleep(120);
    const afterEsc = await h.desktopStatus();
    assert.ok(near(afterEsc.savedBox.x, moved.savedBox.x) && near(afterEsc.savedBox.y, moved.savedBox.y),
        `Escape must cancel Ctrl+drag: ${JSON.stringify([moved.savedBox, afterEsc.savedBox])}`);

    // 7. Right-click on the lyric fires openSettings (consumes the armed ctrlTapGuard)
    //    and raises the settings browser window.
    await focusOther();
    await h.evalJs(inputScript([{move: inkCenter(afterEsc), wait: 40}, {button: 3, down: true, wait: 40}, {button: 3, down: false, wait: 80}]));
    const settingsCmd = await ctrlTapGuard;
    assert.equal(settingsCmd.op, 'openSettings');
    await h.waitFor(async () => (await h.evalJs(focusedTitle)) === settingsWindow,
        'right-clicking the lyric to raise the settings browser window');

    // 8. Right-click on tray button with no browser listening triggers desktop notification.
    await h.evalJs(inputScript([{move: center(afterEsc.trayButtonBox), wait: 40}, {button: 3, down: true, wait: 40}, {button: 3, down: false, wait: 80}]));
    const notice = await h.waitFor(async () => (await h.evalJs(notifications))
        .find(n => n.title === 'Lyrics overlay settings did not open'), 'settings failure notification');
    assert.equal(notice.body, 'The browser extension is not listening. The page is http://localhost:8792/settings');

    // 9. Pitch panel: enable -> docks below lyric -> Ctrl+drag outer edge resizes ->
    //    Ctrl+drag body away detaches -> Ctrl+drag separate edge resizes -> Ctrl+drag back re-docks.
    await h.gsettings.set('pitch-enabled', 'true');
    const pitchBelow = await h.waitFor(async () => {
        const s = await h.desktopStatus();
        return s.pitchVisible && s.pitchBox && s;
    }, 'pitch panel docked below');
    assert.ok(near(pitchBelow.pitchBox.x, pitchBelow.savedBox.x)
        && near(pitchBelow.pitchBox.width, pitchBelow.savedBox.width)
        && near(pitchBelow.pitchBox.y, pitchBelow.savedBox.y + pitchBelow.savedBox.height + 4),
    JSON.stringify([pitchBelow.pitchBox, pitchBelow.savedBox]));
    await h.screenshot('desktop-pitch-docked');

    // Dock above so we have plenty of room to drag upward/resize.
    await h.gsettings.set('pitch-dock', "'above'");
    const pitchAbove = await h.waitFor(async () => {
        const s = await h.desktopStatus();
        return near(s.pitchBox.y + s.pitchBox.height + 4, s.savedBox.y) && s;
    }, 'pitch panel docked above');

    // Plain drag on pitch panel does nothing.
    await focusOther();
    await h.evalJs(drag({from: center(pitchAbove.pitchBox), by: [0, -140]}));
    assert.deepEqual((await h.desktopStatus()).pitchBox, pitchAbove.pitchBox, 'plain drag must not move pitch panel');

    // Ctrl+drag outer (top) edge of docked-above pitch panel grows height.
    const oldThickness = Number(await h.gsettings.get('pitch-docked-height'));
    await focusOther();
    await h.evalJs(drag({from: [pitchAbove.pitchBox.x + pitchAbove.pitchBox.width / 2, pitchAbove.pitchBox.y + 3], by: [0, -40], modifier: 'KEY_Control_L'}));
    await h.waitFor(async () => Number(await h.gsettings.get('pitch-docked-height')) > oldThickness, 'pitch panel edge resize to persist');

    // Ctrl+drag body upward detaches pitch panel to separate.
    const thicker = await h.desktopStatus();
    await focusOther();
    await h.evalJs(drag({from: center(thicker.pitchBox), by: [0, -160], modifier: 'KEY_Control_L'}));
    await h.waitFor(async () => (await h.gsettings.get('pitch-dock')) === "'separate'", 'pitch panel to detach');
    const separate = await h.desktopStatus();
    assert.ok(separate.pitchBox.y < thicker.pitchBox.y - 100, JSON.stringify([thicker.pitchBox, separate.pitchBox]));

    await h.gsettings.set('pitch-enabled', 'false');
    await h.waitFor(async () => !(await h.desktopStatus()).pitchVisible, 'pitch panel to hide when disabled');

    // 10. Generating status pill -> smoothly replaced by generated lyric.
    playing.stop();
    const genVideo = 'genoverlay1';
    const genMeta = {
        host: 'www.youtube.com', videoId: genVideo, title: 'Unsynced Track', author: 'Indie Band - Topic',
        lengthSeconds: 180, category: 'Music', musicVideoType: '',
        description: 'Provided to YouTube by Label\n\nUnsynced Track · Indie Band\n\nIndie Album\n\n℗ 2026 Label',
        musicCards: [], mediaSession: null, ytmByline: '',
    };
    const genPlaying = await h.play({tabId: 4, heartbeatMs: 5000, media: media(0.5, {videoId: genVideo}), metadata: genMeta, next: null});
    await h.waitFor(async () => {
        const s = await h.desktopStatus();
        return s.lyricVisible && s.statusVisible && s;
    }, 'quiet generating status pill');
    await sleep(250);
    await h.screenshot('desktop-generating-pill');
    fs.writeFileSync(releaseFile, 'go');
    await h.waitFor(async () => {
        const s = await h.desktopStatus();
        return s.lyricVisible && !s.statusVisible && s.inkBox && s.inkBox.width > 50 && s;
    }, 'generated timed lyric to replace status pill');

    // 11. Stopping service hides tray button & lyric; restarting service brings them back.
    genPlaying.stop();
    await h.stopService();
    await h.waitFor(async () => {
        const s = await h.desktopStatus();
        return !s.trayButtonVisible && !s.lyricVisible;
    }, 'overlay and tray button to hide without service');
    await h.restartService();
    await h.report({tabId: 4, sampledAt: Date.now(), heartbeatMs: 5000, media: media(8), metadata: METADATA, next: null});
    await h.waitFor(async () => {
        const s = await h.desktopStatus();
        return s.trayButtonVisible && s.lyricVisible;
    }, 'overlay and tray button to return after service restart');

    // 12. Restarting desktop process cleanly reconnects and restores persisted box.
    await h.stopDesktop();
    await h.startDesktop();
    const afterRestart = await h.waitFor(async () => {
        const s = await h.desktopStatus();
        return s.trayButtonVisible && s.lyricVisible && s;
    }, 'desktop to reconnect cleanly after restart');
    assert.ok(near(afterRestart.savedBox.x, moved.savedBox.x) && near(afterRestart.savedBox.y, moved.savedBox.y),
        JSON.stringify([moved.savedBox, afterRestart.savedBox]));

    assert.doesNotMatch(h.desktopLog, /JS ERROR|TypeError|ReferenceError|SyntaxError/u, h.desktopLog);
}
