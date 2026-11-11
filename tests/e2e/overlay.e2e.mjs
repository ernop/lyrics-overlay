// End-to-end: service + extension in a hermetic headless GNOME Shell.
// Run with `npm run test:shell`; screenshots land in build/e2e-artifacts.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
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
        {id: 78, trackName: 'Stub Song', artistName: 'Stub Band', albumName: 'Stub Live', duration: 200,
            instrumental: false, plainLyrics: 'Live words', syncedLyrics: '[00:01.00] Live words'},
    ],
};

const EXTENSION = `Main.extensionManager.lookup('lyrics-overlay@ernop')`;

/**
 * The panel boxes this user's Dash to Panel shows at the bottom right on
 * every monitor, read from the live desktop (read-only) because the
 * hermetic shell runs without Dash to Panel; null without Dash to Panel,
 * whose stock panel always shows the center box.
 */
function dashToPanelTrayBoxes() {
    const extension = path.join(os.homedir(), '.local/share/gnome-shell/extensions/dash-to-panel@jderose9.github.com');
    if (!fs.existsSync(extension))
        return null;
    const text = execFileSync('gsettings', ['--schemadir', path.join(extension, 'schemas'), 'get',
        'org.gnome.shell.extensions.dash-to-panel', 'panel-element-positions'], {encoding: 'utf8'}).trim();
    assert.ok(text.startsWith("'") && text.endsWith("'"), `unexpected panel-element-positions value: ${text}`);
    const monitors = Object.values(JSON.parse(text.slice(1, -1)));
    assert.ok(monitors.length > 0, 'Dash to Panel has no layout');
    const shown = monitors.map(elements => new Set(elements
        .filter(entry => entry.visible && entry.position === 'stackedBR')
        .map(entry => entry.element)));
    return new Set(['leftBox', 'centerBox', 'rightBox'].filter(box => shown.every(set => set.has(box))));
}

/** `rect` with a margin, kept on the screen: a README picture's area (scripts/update-readme-pictures.sh). */
function around(rect, margin = 24) {
    const x = Math.max(0, rect.x - margin);
    const y = Math.max(0, rect.y - margin);
    return {x, y, width: Math.min(MONITOR.width, rect.x + rect.width + margin) - x,
        height: Math.min(MONITOR.height, rect.y + rect.height + margin) - y};
}

function media(currentTime, overrides = {}) {
    return {videoId: VIDEO, currentTime, duration: 180, paused: false, ended: false, stalled: false,
        playbackRate: 1, muted: false, volume: 1, adShowing: false, ...overrides};
}

const METADATA = {host: 'www.youtube.com', videoId: VIDEO, title: 'Stub Song', author: 'Stub Band - Topic', lengthSeconds: 180,
    category: 'Music', musicVideoType: '', description: TOPIC, musicCards: [], mediaSession: null, ytmByline: ''};

/** Pointer and keyboard input through Clutter virtual devices inside the shell. */
function inputScript(steps) {
    return `(async () => {
        const {default: Clutter} = await import('gi://Clutter');
        const seat = Clutter.get_default_backend().get_default_seat();
        globalThis.__lyricsPointer ??= seat.create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        globalThis.__lyricsKeyboard ??= seat.create_virtual_device(Clutter.InputDeviceType.KEYBOARD_DEVICE);
        const pointer = globalThis.__lyricsPointer;
        const keyboard = globalThis.__lyricsKeyboard;
        const now = () => GLib.get_monotonic_time();
        const wait = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { resolve(); return GLib.SOURCE_REMOVE; }));
        // The pointer starts at (0, 0) inside the hot corner, whose pressure
        // barrier stops downward motion; slide out along the top edge first.
        // Clutter re-picks the actor under the pointer during a frame update,
        // so a press sent sooner goes to the actor under the old position.
        // Three updates cover one already under way, the one that takes the
        // motion, and the one after it.
        const frames = count => new Promise(resolve => {
            let seen = 0;
            const id = global.stage.connect('after-update', () => {
                if (++seen >= count) {
                    global.stage.disconnect(id);
                    resolve();
                    return;
                }
                global.stage.queue_redraw();
            });
            global.stage.queue_redraw();
        });
        const moveTo = async (x, y) => {
            pointer.notify_absolute_motion(now(), x, y);
            if (!global.stage.get_grab_actor())
                await frames(3);
        };
        // The input thread runs ahead of the stage, and a frame re-picks at
        // where the pointer is by then: motion sent before the stage has
        // taken a press can carry the press to whatever lies under the new
        // spot (a drag outward from just inside an edge lands on the window
        // beyond it). Under a grab the stage is not on the press's path.
        const pressTaken = () => new Promise((resolve, reject) => {
            const timeout = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 3000, () => {
                global.stage.disconnect(id);
                reject(new Error('the stage never took the press'));
                return GLib.SOURCE_REMOVE;
            });
            const id = global.stage.connect('captured-event', (_stage, event) => {
                if (event.type() === Clutter.EventType.BUTTON_PRESS) {
                    global.stage.disconnect(id);
                    GLib.source_remove(timeout);
                    resolve();
                }
                return Clutter.EVENT_PROPAGATE;
            });
        });
        if (!globalThis.__lyricsPointerReady) {
            await moveTo(400, 0);
            globalThis.__lyricsPointerReady = true;
        }
        for (const step of ${JSON.stringify(steps)}) {
            if (step.move) await moveTo(step.move[0], step.move[1]);
            if (step.button) {
                const taken = step.down && !global.stage.get_grab_actor() ? pressTaken() : null;
                pointer.notify_button(now(), step.button, step.down ? Clutter.ButtonState.PRESSED : Clutter.ButtonState.RELEASED);
                await taken;
            }
            if (step.key) keyboard.notify_keyval(now(), Clutter[step.key], step.down ? Clutter.KeyState.PRESSED : Clutter.KeyState.RELEASED);
            if (step.scroll) pointer.notify_discrete_scroll(now(), Clutter.ScrollDirection[step.scroll], Clutter.ScrollSource.WHEEL);
            await wait(step.wait ?? 16);
        }
        return true;
    })()`;
}

function drag({from, by, modifier = null, button = 1}) {
    const steps = [{move: from}];
    if (modifier)
        steps.push({key: modifier, down: true});
    steps.push({button, down: true});
    for (let i = 1; i <= 8; i++)
        steps.push({move: [from[0] + by[0] * i / 8, from[1] + by[1] * i / 8]});
    steps.push({button, down: false, wait: 60});
    if (modifier)
        steps.push({key: modifier, down: false, wait: 60});
    return inputScript(steps);
}

const overlayFacts = `(() => {
    const extension = ${EXTENSION}.stateObj;
    const overlay = extension._overlay;
    const layer = overlay._layers[overlay._current];
    const [gx, gy] = overlay._grip.get_transformed_position();
    return {
        visible: overlay._content.visible && overlay._root.visible,
        text: layer.text,
        opacity: layer.opacity,
        fontSize: layer.fitted?.spec.fontSize ?? null,
        align: layer.fitted?.spec.align ?? null,
        fill: layer.fitted?.fill.join(',') ?? null,
        ring: layer.fitted ? [layer.fitted.ring.inner > 0, layer.fitted.ring.outer > 0] : null,
        ringInner: layer.fitted?.ring.inner ?? null,
        ink: layer.fitted?.inkBox ?? null,
        layerWidth: layer.width,
        box: {x: overlay._root.x, y: overlay._root.y, width: overlay._root.width, height: overlay._root.height},
        grip: {visible: overlay._grip.visible, x: gx, y: gy, width: overlay._grip.width, height: overlay._grip.height},
    };
})()`;

const panelFacts = `(() => {
    const panel = ${EXTENSION}.stateObj._pitchPanel;
    return {visible: panel._root.visible && panel._frame.visible, box: panel.box,
        status: panel._view._status, lineWidth: panel._view._look.lineWidth};
})()`;

const notifications = `(async () => {
    const {getSystemSource} = await import('resource:///org/gnome/shell/ui/messageTray.js');
    return getSystemSource().notifications.map(notification => ({title: notification.title, body: notification.body}));
})()`;

/** Six seconds of a rising sung line, in the service's 100 ms batches. */
function risingFrames(base) {
    const batches = [];
    for (let at = 100; at <= 6000; at += 100) {
        const samples = [];
        for (let t = at - 80; t <= at; t += 20)
            samples.push({t: base + t, midi: 57 + Math.floor(t / 750) + 0.15 * Math.sin(t / 40)});
        batches.push({at: base + at, voiced: true, samples});
    }
    return batches;
}

/** Boxes are kept in fractional pixels and drawn at whole ones. */
const near = (a, b) => Math.abs(a - b) <= 1;

const indicatorFacts = `(() => {
    const indicator = Main.panel.statusArea['lyrics-overlay@ernop'];
    const [x, y] = indicator.get_transformed_position();
    // Until the panel lays out a newly shown indicator, its position is stale.
    return {visible: indicator.visible && indicator.mapped, placed: indicator.has_allocation(),
        box: ['left', 'center', 'right'].find(name => Main.panel['_' + name + 'Box'].contains(indicator.container)) ?? null,
        lastInBox: indicator.container.get_parent()?.get_last_child() === indicator.container,
        x, y, width: indicator.width, height: indicator.height,
        icon: indicator._icon.gicon.get_file().get_basename()};
})()`;

const focusedTitle = 'global.display.focus_window?.get_title() ?? null';

const center = rect => [rect.x + rect.width / 2, rect.y + rect.height / 2];

test('the overlay shows timed lyrics and follows the pointer rules', {timeout: 120000}, async t => {
    const h = await startHarness({answers: ANSWERS});
    t.after(() => h.close());
    await overlayScenario(h).catch(error => {
        const shellLines = h.shellLog.split('\n').filter(line => /lyrics|JS ERROR|Error/u.test(line));
        error.message += `\n--- shell log, lyrics and error lines:\n${shellLines.slice(-40).join('\n')}` +
            `\n--- service log, last lines:\n${h.serviceLog.split('\n').slice(-40).join('\n')}`;
        throw error;
    });
});

async function overlayScenario(h) {
    await h.evalJs('Main.overview.hide(); true');
    await h.waitFor(async () => !(await h.evalJs('Main.overview.visible')), 'the overview to close');
    const extension = await h.evalJs(`(() => { const e = ${EXTENSION}; return {state: e.state, error: e.error ?? ''}; })()`);
    assert.equal(extension.error, '', extension.error);

    assert.equal((await h.evalJs(indicatorFacts)).visible, false, 'no indicator while nothing plays');

    const playing = await h.play({tabId: 4, heartbeatMs: 5000, media: media(0.2), metadata: METADATA, next: null});
    assert.equal(playing.status, 204);
    await h.waitFor(async () => (await h.evalJs(`${EXTENSION}.stateObj._state?.lyrics`)) === 'timed', 'timed lyrics');
    const indicator = await h.waitFor(async () => {
        const facts = await h.evalJs(indicatorFacts);
        return facts.visible && facts.placed && facts;
    }, 'the indicator to be laid out');
    assert.equal(indicator.box, 'center');
    assert.equal(indicator.lastInBox, true, 'the indicator ends its box, beside the system menu');
    const tray = dashToPanelTrayBoxes();
    if (tray)
        assert.ok(tray.has('centerBox'), `Dash to Panel's lower-right tray shows only ${[...tray].join(', ')}`);
    assert.equal(indicator.icon, 'lyrics-off-symbolic.svg');
    assert.equal((await h.evalJs(overlayFacts)).visible, false, 'the overlay is opt-in');

    // A left press toggles the overlay on.
    await h.evalJs(inputScript([{move: center(indicator)}, {button: 1, down: true}, {button: 1, down: false, wait: 100}]));
    await h.waitFor(async () => (await h.gsettings.get('overlay-enabled')) === 'true', 'the toggle to persist');
    const shown = await h.evalJs(overlayFacts);
    assert.equal(shown.visible, true);
    assert.equal((await h.evalJs(indicatorFacts)).icon, 'lyrics-on-symbolic.svg');

    // No introduction naming the song: the box is blank until the first lyric.
    assert.ok(shown.text === '' || /^(\d )?First line of the song$/u.test(shown.text), shown.text);
    await h.waitFor(async () => /^(\d )?First line of the song$/u.test((await h.evalJs(overlayFacts)).text), 'the first lyric');
    await sleep(400);
    await h.screenshot('overlay-first-line');
    const line = await h.evalJs(overlayFacts);
    await h.screenshot('readme-line', around(line.box));
    assert.equal(line.grip.visible, true);
    assert.equal(line.opacity, 255);
    // The default box: centered, high enough that the pitch panel docked
    // below it gets its whole default height.
    assert.ok(Math.abs(line.box.x + line.box.width / 2 - MONITOR.width / 2) <= 1, JSON.stringify(line.box));

    // A plain drag on the lyric does nothing.
    await h.evalJs(drag({from: center(line.grip), by: [120, -80]}));
    assert.deepEqual((await h.evalJs(overlayFacts)).box, line.box);
    assert.equal(await h.gsettings.get('box-monitor'), '-1');

    // Ctrl+drag moves the box by the pointer's travel and stores it.
    await h.evalJs(drag({from: center(line.grip), by: [120, -80], modifier: 'KEY_Control_L'}));
    const moved = await h.evalJs(overlayFacts);
    assert.deepEqual([moved.box.x - line.box.x, moved.box.y - line.box.y, moved.box.width, moved.box.height],
        [120, -80, line.box.width, line.box.height]);
    const storedMove = await h.gsettings.get('box');
    assert.match(storedMove, /'cx': 0\.5[67]/u, storedMove);

    // A Ctrl press without movement changes nothing.
    await h.evalJs(drag({from: center(moved.grip), by: [0, 0], modifier: 'KEY_Control_L'}));
    assert.deepEqual((await h.evalJs(overlayFacts)).box, moved.box);

    // Alt+drag resizes about the center, each axis on its own.
    const pressAt = [moved.grip.x + moved.grip.width - 4, moved.grip.y + moved.grip.height - 4];
    await h.evalJs(drag({from: pressAt, by: [60, 20], modifier: 'KEY_Alt_L'}));
    const resized = await h.evalJs(overlayFacts);
    assert.deepEqual([resized.box.width - moved.box.width, resized.box.height - moved.box.height], [120, 40]);
    assert.ok(Math.abs((resized.box.x + resized.box.width / 2) - (moved.box.x + moved.box.width / 2)) <= 1);

    // Ctrl+scroll on the lyric grows the text, then stores the size.
    await h.evalJs(inputScript([{move: center(resized.grip)}, {key: 'KEY_Control_L', down: true},
        {scroll: 'UP'}, {scroll: 'UP'}, {key: 'KEY_Control_L', down: false}]));
    // Two notches are two steps; the emulated copy of each notch is ignored.
    await h.waitFor(async () => Math.abs(Number(await h.gsettings.get('font-size')) - 48 * 1.06 ** 2) < 0.01, 'the scrolled size to persist');
    await h.screenshot('overlay-moved-resized');

    // Centered by default; left alignment starts the line at the box's left
    // edge, and the color and border choices reach the painted text.
    const centered = await h.evalJs(overlayFacts);
    assert.deepEqual([centered.align, centered.fill, centered.ring], ['center', '1,1,1', [true, true]]);
    assert.ok(Math.abs(centered.ink.x + centered.ink.width / 2 - centered.layerWidth / 2) < 12, JSON.stringify(centered));
    // The border thickness scales the rings (the double border's inner one
    // is 5.5% of the size at 1x).
    assert.ok(Math.abs(centered.ringInner - Math.max(1.5, centered.fontSize * 0.055)) < 0.01, JSON.stringify(centered));
    await h.gsettings.set('text-border-scale', '2.5');
    await h.waitFor(async () => {
        const facts = await h.evalJs(overlayFacts);
        return Math.abs(facts.ringInner - 2.5 * Math.max(1.5, facts.fontSize * 0.055)) < 0.01;
    }, 'the thicker border');
    await h.screenshot('overlay-thick-border');
    await h.gsettings.reset('text-border-scale');
    await h.gsettings.set('text-align', "'left'");
    await h.gsettings.set('text-color', "'yellow'");
    await h.gsettings.set('text-border', "'single'");
    // The second line holds for half a minute, so the picture never catches
    // the change from the first.
    const left = await h.waitFor(async () => {
        const facts = await h.evalJs(overlayFacts);
        return facts.align === 'left' && facts.fill === '1,0.92,0' && facts.ring[1] === false &&
            facts.text === 'Second line arrives here' && facts;
    }, 'the left-aligned yellow single-bordered second line');
    assert.equal(left.ring[0], true);
    assert.ok(left.ink.x < 16 && left.ink.width < left.layerWidth - 40, JSON.stringify(left));
    await sleep(300);
    await h.screenshot('overlay-left-yellow-single');
    await h.screenshot('readme-line-yellow-left', around(left.box));
    for (const key of ['text-align', 'text-color', 'text-border'])
        await h.gsettings.reset(key);
    await h.waitFor(async () => (await h.evalJs(overlayFacts)).align === 'center', 'the default look to return');

    // The overview hides the overlay; leaving it brings the overlay back.
    await h.evalJs('Main.overview.show(); true');
    await h.waitFor(async () => !(await h.evalJs(overlayFacts)).visible, 'the overlay to hide in the overview');
    await h.evalJs('Main.overview.hide(); true');
    await h.waitFor(async () => (await h.evalJs(overlayFacts)).visible, 'the overlay to return');

    // A right press on the indicator, the lyric or the pitch panel asks the
    // browser for its one settings tab, then raises the window showing it.
    const songWindow = 'Stub Song - YouTube — Mozilla Firefox';
    const settingsWindow = 'Lyrics overlay settings — Mozilla Firefox';
    for (const title of [songWindow, settingsWindow, 'Another window'])
        await h.openWindow(title);
    const focusAnotherWindow = async () => {
        await h.evalJs(`(() => {
            Main.activateWindow(global.display.list_all_windows().find(window => window.get_title() === 'Another window'));
            return true;
        })()`);
        await h.waitFor(async () => (await h.evalJs(focusedTitle)) === 'Another window', 'the other window to take focus');
    };
    const lyricShowing = () => h.waitFor(async () => {
        const facts = await h.evalJs(overlayFacts);
        return facts.grip.visible && facts.text !== '' && facts;
    }, 'a lyric to show');
    const rightPressOpensSettings = async (point, what) => {
        await focusAnotherWindow();
        const answered = h.answerNextCommand(() => ({ok: true, windowTitle: settingsWindow}));
        await h.evalJs(inputScript([{move: point}, {button: 3, down: true}, {button: 3, down: false, wait: 100}]));
        assert.equal((await answered).op, 'openSettings', what);
        await h.waitFor(async () => (await h.evalJs(focusedTitle)) === settingsWindow, `the settings window to be raised (${what})`);
    };
    await rightPressOpensSettings(center(indicator), 'indicator');
    assert.equal(await h.gsettings.get('overlay-enabled'), 'true', 'a right press does not toggle');
    await rightPressOpensSettings(center((await lyricShowing()).grip), 'lyric');

    // When no browser answers, a notification says why and where the page is.
    await h.evalJs(inputScript([{move: center(indicator)}, {button: 3, down: true}, {button: 3, down: false, wait: 100}]));
    const notice = await h.waitFor(async () => (await h.evalJs(notifications))
        .find(notification => notification.title === 'Lyrics overlay settings did not open'), 'the notification');
    assert.equal(notice.body, 'The browser extension is not listening. The page is http://localhost:8792/settings');

    // The pitch panel is off until switched on; then it docks below the
    // lyric, as wide as it. It asks for the microphone; with no PipeWire
    // here the service reports the failure instead of retrying.
    assert.equal((await h.evalJs(panelFacts)).visible, false);
    await h.gsettings.set('pitch-enabled', 'true');
    const below = await h.waitFor(async () => {
        const facts = await h.evalJs(panelFacts);
        return facts.visible && facts;
    }, 'the pitch panel');
    const lyricBox = (await h.evalJs(overlayFacts)).box;
    assert.ok(near(below.box.x, lyricBox.x) && near(below.box.width, lyricBox.width) &&
        near(below.box.y, lyricBox.y + lyricBox.height + 4) && below.box.height >= 48, JSON.stringify([below.box, lyricBox]));
    await h.waitFor(async () => Boolean(await h.evalJs(`${EXTENSION}.stateObj._state.pitch.error`)), 'the microphone error', 15000);
    assert.match((await h.evalJs(panelFacts)).status, /^Microphone stopped: \S/u);
    await h.evalJs(`(() => {
        for (const frames of ${JSON.stringify(risingFrames(1_000_000))})
            ${EXTENSION}.stateObj._pitchPanel.pushFrames(frames);
        return true;
    })()`);
    await sleep(200);
    await h.screenshot('pitch-docked-below');

    // Placement and look changes from the settings page apply at once.
    await h.gsettings.set('pitch-dock', "'above'");
    const above = await h.waitFor(async () => {
        const facts = await h.evalJs(panelFacts);
        return near(facts.box.y + facts.box.height + 4, lyricBox.y) && facts;
    }, 'the panel to dock above the lyric');
    await h.gsettings.set('pitch-line-width', '0.5');
    await h.waitFor(async () => (await h.evalJs(panelFacts)).lineWidth === 0.5, 'the thin line');

    // Dragging a docked panel's outer edge sets how thick it is.
    const thickness = Number(await h.gsettings.get('pitch-docked-height'));
    await h.evalJs(drag({from: [above.box.x + above.box.width / 2, above.box.y + 3], by: [0, -40]}));
    await h.waitFor(async () => Number(await h.gsettings.get('pitch-docked-height')) > thickness, 'the thicker panel to persist');
    const thicker = await h.evalJs(panelFacts);
    assert.ok(near(thicker.box.height, above.box.height + 40) && near(thicker.box.y + thicker.box.height + 4, lyricBox.y),
        JSON.stringify([above.box, thicker.box]));

    // Dragging it away makes it separate, where it was dropped.
    await h.evalJs(drag({from: center(thicker.box), by: [0, -200]}));
    await h.waitFor(async () => (await h.gsettings.get('pitch-dock')) === "'separate'", 'the panel to come apart');
    const separate = await h.evalJs(panelFacts);
    assert.ok(near(separate.box.y, thicker.box.y - 200) && near(separate.box.x, thicker.box.x), JSON.stringify(separate.box));

    // A separate panel resizes from its edges.
    await h.evalJs(drag({from: [separate.box.x + separate.box.width - 3, separate.box.y + separate.box.height / 2], by: [-100, 0]}));
    const narrower = await h.waitFor(async () => {
        const facts = await h.evalJs(panelFacts);
        return near(facts.box.width, separate.box.width - 100) && facts;
    }, 'the narrower panel');
    assert.ok(near(narrower.box.x, separate.box.x), JSON.stringify(narrower.box));
    await h.screenshot('pitch-separate');

    // Dropped just above the lyric, it docks there again.
    const dropBy = lyricBox.y - 4 - 10 - (narrower.box.y + narrower.box.height);
    await h.evalJs(drag({from: center(narrower.box), by: [0, dropBy]}));
    await h.waitFor(async () => (await h.gsettings.get('pitch-dock')) === "'above'", 'the panel to dock again');
    const docked = await h.evalJs(panelFacts);
    assert.ok(near(docked.box.width, lyricBox.width) && near(docked.box.y + docked.box.height + 4, lyricBox.y), JSON.stringify(docked.box));

    await rightPressOpensSettings(center(docked.box), 'pitch panel');

    // The overview hides the panel too.
    await h.evalJs('Main.overview.show(); true');
    await h.waitFor(async () => !(await h.evalJs(panelFacts)).visible, 'the panel to hide in the overview');
    await h.evalJs('Main.overview.hide(); true');
    await h.waitFor(async () => (await h.evalJs(panelFacts)).visible, 'the panel to return');
    await h.gsettings.set('pitch-enabled', 'false');
    await h.waitFor(async () => !(await h.evalJs(panelFacts)).visible, 'the panel to hide when switched off');

    // A click on the lyric has the browser extension select the song's tab,
    // then raises the window showing it.
    await focusAnotherWindow();
    const beforeClick = await lyricShowing();
    const commandAnswered = h.answerNextCommand(() => ({ok: true, windowTitle: songWindow}));
    await h.evalJs(inputScript([{move: center(beforeClick.grip)}, {button: 1, down: true}, {button: 1, down: false, wait: 100}]));
    const command = await commandAnswered;
    assert.deepEqual([command.op, command.tabId], ['focusTab', 4]);
    await h.waitFor(async () => (await h.evalJs(focusedTitle)) === songWindow, 'the song window to be raised');
    await h.screenshot('lyric-click-raised-song-window');

    // Disable and enable leave exactly one overlay, pitch panel and indicator.
    const chromeCounts = `['lyricsOverlay', 'lyricsPitchPanel'].map(name =>
        Main.layoutManager.uiGroup.get_children().filter(child => child.name === name).length)`;
    await h.evalJs(`Main.extensionManager.disableExtension('lyrics-overlay@ernop')`);
    assert.deepEqual(await h.evalJs(chromeCounts), [0, 0]);
    assert.equal(await h.evalJs(`Main.panel.statusArea['lyrics-overlay@ernop'] ?? null`), null);
    await h.evalJs(`Main.extensionManager.enableExtension('lyrics-overlay@ernop')`);
    await h.waitFor(async () => (await h.evalJs(`${EXTENSION}.stateObj?._state?.lyrics`)) === 'timed', 'state after re-enable');
    assert.deepEqual(await h.evalJs(chromeCounts), [1, 1]);

    // The indicator leaves with the service and returns with it.
    playing.stop();
    await h.stopService();
    await h.waitFor(async () => !(await h.evalJs(indicatorFacts)).visible, 'the indicator to hide without the service');
    await h.restartService();
    await h.report({tabId: 4, sampledAt: Date.now(), heartbeatMs: 5000, media: media(8), metadata: METADATA, next: null});
    await h.waitFor(async () => (await h.evalJs(indicatorFacts)).visible, 'the indicator to return');

    assert.doesNotMatch(h.shellLog, /JS ERROR|lyrics-overlay.*(Error|TypeError)/u, h.shellLog);
}
