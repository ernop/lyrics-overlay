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

const panelMenuRect = `(() => {
    const actor = ${EXTENSION}.stateObj._indicator.menu.actor;
    const [x, y] = actor.get_transformed_position();
    return {x, y, width: actor.width, height: actor.height};
})()`;

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
        if (!globalThis.__lyricsPointerReady) {
            await moveTo(400, 0);
            globalThis.__lyricsPointerReady = true;
        }
        for (const step of ${JSON.stringify(steps)}) {
            if (step.move) await moveTo(step.move[0], step.move[1]);
            if (step.button) pointer.notify_button(now(), step.button, step.down ? Clutter.ButtonState.PRESSED : Clutter.ButtonState.RELEASED);
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
        ink: layer.fitted?.inkBox ?? null,
        layerWidth: layer.width,
        box: {x: overlay._root.x, y: overlay._root.y, width: overlay._root.width, height: overlay._root.height},
        grip: {visible: overlay._grip.visible, x: gx, y: gy, width: overlay._grip.width, height: overlay._grip.height},
        pitchVisible: overlay._pitch.visible,
    };
})()`;

const indicatorFacts = `(() => {
    const indicator = Main.panel.statusArea['lyrics-overlay@ernop'];
    const [x, y] = indicator.get_transformed_position();
    // Until the panel lays out a newly shown indicator, its position is stale.
    return {visible: indicator.visible && indicator.mapped, placed: indicator.has_allocation(),
        box: ['left', 'center', 'right'].find(name => Main.panel['_' + name + 'Box'].contains(indicator.container)) ?? null,
        lastInBox: indicator.container.get_parent()?.get_last_child() === indicator.container,
        x, y, width: indicator.width, height: indicator.height,
        icon: indicator._icon.gicon.get_file().get_basename(), menuOpen: indicator.menu.isOpen};
})()`;

const lyricMenuFacts = `(() => {
    const lyricMenu = ${EXTENSION}.stateObj._lyricMenu;
    const menu = lyricMenu._contents._menu;
    const rect = actor => {
        const [x, y] = actor.get_transformed_position();
        return {x, y, width: actor.width, height: actor.height};
    };
    // Sections are not items; they hold items of their own.
    const flatten = items => items.flatMap(item => !item._getMenuItems ? [item] : item.actor.visible ? flatten(item._getMenuItems()) : []);
    const labels = flatten(menu._getMenuItems()).filter(item => item.visible && item.label?.text).map(item => item.label);
    return {
        open: lyricMenu.isOpen,
        box: rect(menu.box),
        pitch: rect(lyricMenu._contents._pitchItem),
        items: labels.map(label => label.text),
        help: lyricMenu._contents._helpItem.menu._getMenuItems().map(item => item.label.text),
        ink: labels.map(label => label.get_theme_node().get_foreground_color()).map(color => [color.red, color.green, color.blue].join(',')),
    };
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

    // A left press toggles the overlay on; the menu stays closed.
    await h.evalJs(inputScript([{move: center(indicator)}, {button: 1, down: true}, {button: 1, down: false, wait: 100}]));
    await h.waitFor(async () => (await h.gsettings.get('overlay-enabled')) === 'true', 'the toggle to persist');
    const shown = await h.evalJs(overlayFacts);
    assert.equal(shown.visible, true);
    assert.equal((await h.evalJs(indicatorFacts)).menuOpen, false);
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
    // The default box: centered, 86% down the work area.
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
    await h.gsettings.set('text-align', "'left'");
    await h.gsettings.set('text-color', "'yellow'");
    await h.gsettings.set('text-border', "'single'");
    const left = await h.waitFor(async () => {
        const facts = await h.evalJs(overlayFacts);
        return facts.align === 'left' && facts.fill === '1,0.92,0' && facts.ring[1] === false && facts;
    }, 'the left-aligned yellow single-bordered line');
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

    // A right press opens the menu; its neutral text is pure black or white.
    await h.evalJs(inputScript([{move: center(indicator)}, {button: 3, down: true}, {button: 3, down: false, wait: 150}]));
    assert.equal((await h.evalJs(indicatorFacts)).menuOpen, true);
    assert.equal(await h.gsettings.get('overlay-enabled'), 'true', 'a right press does not toggle');
    const ink = await h.evalJs(`(() => {
        const menu = ${EXTENSION}.stateObj._indicator._lyricsMenu;
        const colors = [menu._identityItem.label, menu._statusItem.label, menu._sizeLabel, menu._offsetLabel]
            .map(label => label.get_theme_node().get_foreground_color())
            .map(color => [color.red, color.green, color.blue].join(','));
        return {colors, identity: menu._identityItem.label.text, status: menu._statusItem.label.text};
    })()`);
    assert.equal(new Set(ink.colors).size, 1, ink.colors.join(' '));
    assert.ok(['0,0,0', '255,255,255'].includes(ink.colors[0]), ink.colors[0]);
    assert.equal(ink.identity, 'Stub Band - Stub Song - 2003 - Stub Album');
    assert.match(ink.status, /^Timed lyrics: Stub Band - Stub Song - Stub Album - 3:00$/u);
    await h.screenshot('menu');

    // Too slow, pressed in the menu, moves the song's offset and keeps the menu open.
    const tooSlow = await h.evalJs(`(() => {
        const button = ${EXTENSION}.stateObj._indicator._lyricsMenu._timingItem.get_children().find(child => child.child?.text === 'Too slow');
        const [x, y] = button.get_transformed_position();
        return {x, y, width: button.width, height: button.height};
    })()`);
    await h.evalJs(inputScript([{move: center(tooSlow)}, {button: 1, down: true}, {button: 1, down: false, wait: 150}]));
    await h.waitFor(async () => (await h.evalJs(`${EXTENSION}.stateObj._state.offsetSeconds`)) === 0.5, 'the offset');
    assert.equal((await h.evalJs(indicatorFacts)).menuOpen, true);
    assert.equal(await h.evalJs(`${EXTENSION}.stateObj._indicator._lyricsMenu._offsetLabel.text`), '+0.5 s');

    // Choosing the other lyric set switches to it and is remembered.
    await h.evalJs(`${EXTENSION}.stateObj._client.command({op: 'choose', id: 78}); true`);
    await h.waitFor(async () => (await h.evalJs(`${EXTENSION}.stateObj._state.chosen?.id`)) === 78, 'the chosen set');
    assert.match(await h.evalJs(`${EXTENSION}.stateObj._indicator._lyricsMenu._statusItem.label.text`), /your choice/u);

    // The font submenu: Bold, the desktop font, then the installed families
    // in runs by kind with a line between runs, each name in its own font.
    // However long, the list opens whole and the menu body scrolls it; the
    // menu stays on the screen.
    await h.evalJs(`${EXTENSION}.stateObj._indicator._lyricsMenu._fontItem.setSubmenuShown(true); true`);
    await sleep(600);
    const fontMenu = await h.evalJs(`(() => {
        const contents = ${EXTENSION}.stateObj._indicator._lyricsMenu;
        const submenu = contents._fontItem.menu;
        const families = new Map([...contents._familyItems].map(([family, item]) => [item, family]));
        const shape = submenu._getMenuItems().map(item => item === contents._boldItem ? 'b'
            : item.has_style_class_name('popup-separator-menu-item') ? 's' : families.get(item) === '' ? 'd' : families.has(item) ? 'f' : '?').join('');
        const [, menuY] = contents._menu.box.get_transformed_position();
        // Scrolled to the Font row, for the screenshot.
        const body = contents._fontItem.get_parent().get_parent();
        body.vadjustment.value = contents._fontItem.get_allocation_box().y1;
        // The list's box is a viewport, as tall as what shows of it; its preferred height is the whole list.
        const [, list] = submenu.box.get_preferred_height(submenu.box.width);
        return {shape, shown: submenu.actor.height, list, menuBottom: menuY + contents._menu.box.height,
            ownFont: [...families].filter(([, family]) => family).every(([item, family]) => item.label.get_theme_node().get_font().get_family() === family)};
    })()`);
    assert.match(fontMenu.shape, /^bd(sf+)+$/u, fontMenu.shape);
    assert.ok(fontMenu.ownFont, 'each family name is drawn in its family');
    assert.ok(fontMenu.shown >= fontMenu.list, `the font submenu shows ${fontMenu.shown} px of its ${fontMenu.list} px list`);
    assert.ok(fontMenu.menuBottom <= MONITOR.height, `the menu ends at ${fontMenu.menuBottom}`);
    await h.evalJs(inputScript([{move: [MONITOR.width - 2, MONITOR.height - 2], wait: 200}]));
    await h.screenshot('font-menu');
    await h.screenshot('readme-fonts', around(await h.evalJs(panelMenuRect), 8));
    await h.evalJs(`${EXTENSION}.stateObj._indicator._lyricsMenu._fontItem.setSubmenuShown(false); true`);
    await h.evalJs(`${EXTENSION}.stateObj._indicator.menu.close(); true`);

    // The light style (this desktop's) gets pure black ink.
    await h.gsettings.setDesktop('org.gnome.desktop.interface', 'color-scheme', 'prefer-light');
    await h.waitFor(async () => (await h.evalJs('Main.getStyleVariant()')) === 'light', 'the light style');
    await h.evalJs(`${EXTENSION}.stateObj._indicator.menu.open(); true`);
    await sleep(300);
    const lightInk = await h.evalJs(`(() => {
        const menu = ${EXTENSION}.stateObj._indicator._lyricsMenu;
        return [menu._identityItem.label, menu._statusItem.label, menu._sizeLabel, menu._offsetLabel]
            .map(label => label.get_theme_node().get_foreground_color())
            .map(color => [color.red, color.green, color.blue].join(','));
    })()`);
    assert.deepEqual(new Set(lightInk), new Set(['0,0,0']), lightInk.join(' '));
    await h.screenshot('menu-light');
    await h.screenshot('readme-menu', around(await h.evalJs(panelMenuRect), 8));
    await h.evalJs(`${EXTENSION}.stateObj._indicator.menu.close(); true`);

    // A right press on the lyric opens the same menu at the pointer, whole on
    // the screen and in pure black ink on this light style.
    const lyric = await h.evalJs(overlayFacts);
    const pressedAt = center(lyric.grip);
    await h.evalJs(inputScript([{move: pressedAt}, {button: 3, down: true}, {button: 3, down: false, wait: 250}]));
    const lyricMenu = await h.evalJs(lyricMenuFacts);
    assert.equal(lyricMenu.open, true);
    assert.equal((await h.evalJs(indicatorFacts)).menuOpen, false, 'the panel menu stays closed');
    assert.equal(await h.gsettings.get('overlay-enabled'), 'true', 'a right press on the lyric does not toggle');
    assert.ok(lyricMenu.box.y >= 0 && lyricMenu.box.y + lyricMenu.box.height <= MONITOR.height, JSON.stringify(lyricMenu.box));
    assert.ok(lyricMenu.box.x <= pressedAt[0] && pressedAt[0] <= lyricMenu.box.x + lyricMenu.box.width,
        `the menu ${JSON.stringify(lyricMenu.box)} is not at the press ${pressedAt}`);
    assert.deepEqual(new Set(lyricMenu.ink), new Set(['0,0,0']), lyricMenu.ink.join(' '));
    assert.deepEqual(lyricMenu.items.slice(0, 2), ['Lyrics overlay', 'Pitch trace from the microphone']);
    for (const label of ['Go to the song in Firefox', 'Mouse controls on the lyric'])
        assert.ok(lyricMenu.items.includes(label), `missing "${label}" in ${lyricMenu.items.join(' | ')}`);
    assert.deepEqual(lyricMenu.help, ['Click the lyric to go to the song', 'Right-click the lyric for this menu',
        'Ctrl+drag the lyric to move it', 'Alt+drag the lyric to resize its box', 'Ctrl+scroll on the lyric to size the text']);
    await h.screenshot('lyric-menu');

    // Its pitch switch turns the trace on and leaves the menu open. The
    // trace asks for the microphone; with no PipeWire here the service
    // reports the failure instead of retrying.
    await h.evalJs(inputScript([{move: center(lyricMenu.pitch)}, {button: 1, down: true}, {button: 1, down: false, wait: 150}]));
    await h.waitFor(async () => (await h.gsettings.get('pitch-enabled')) === 'true', 'the pitch switch to persist');
    assert.equal((await h.evalJs(lyricMenuFacts)).open, true);
    await h.evalJs(`${EXTENSION}.stateObj._lyricMenu.close(); true`);
    await h.waitFor(async () => (await h.evalJs(overlayFacts)).pitchVisible, 'the pitch strip');
    await h.waitFor(async () => Boolean(await h.evalJs(`${EXTENSION}.stateObj._state.pitch.error`)), 'the microphone error', 15000);
    assert.match(await h.evalJs(`${EXTENSION}.stateObj._overlay._pitch._status`), /^Microphone stopped: \S/u);
    await h.screenshot('overlay-pitch');
    await h.gsettings.set('pitch-enabled', 'false');

    // A click on the lyric has the browser extension select the song's tab,
    // then raises the window showing it.
    const songWindow = 'Stub Song - YouTube — Mozilla Firefox';
    await h.openWindow(songWindow);
    await h.openWindow('Another window');
    await h.evalJs(`(() => {
        Main.activateWindow(global.display.list_all_windows().find(window => window.get_title() === 'Another window'));
        return true;
    })()`);
    await h.waitFor(async () => (await h.evalJs(focusedTitle)) === 'Another window', 'the other window to take focus');
    // The chosen set's only line has ended, leaving nothing to click; the
    // first set's second line holds for half a minute.
    await h.evalJs(`${EXTENSION}.stateObj._client.command({op: 'choose', id: 77}); true`);
    const beforeClick = await h.waitFor(async () => {
        const facts = await h.evalJs(overlayFacts);
        return facts.grip.visible && facts.text === 'Second line arrives here' && facts;
    }, 'the second line to show');
    const commandAnswered = h.answerNextCommand(() => ({ok: true, windowTitle: songWindow}));
    await h.evalJs(inputScript([{move: center(beforeClick.grip)}, {button: 1, down: true}, {button: 1, down: false, wait: 100}]));
    const command = await commandAnswered;
    assert.deepEqual([command.op, command.tabId], ['focusTab', 4]);
    await h.waitFor(async () => (await h.evalJs(focusedTitle)) === songWindow, 'the song window to be raised');
    await h.screenshot('lyric-click-raised-song-window');

    // Disable and enable leave exactly one overlay and indicator.
    await h.evalJs(`Main.extensionManager.disableExtension('lyrics-overlay@ernop')`);
    assert.equal(await h.evalJs(`Main.layoutManager.uiGroup.get_children().filter(child => child.name === 'lyricsOverlay').length`), 0);
    await h.evalJs(`Main.extensionManager.enableExtension('lyrics-overlay@ernop')`);
    await h.waitFor(async () => (await h.evalJs(`${EXTENSION}.stateObj?._state?.lyrics`)) === 'timed', 'state after re-enable');
    assert.equal(await h.evalJs(`Main.layoutManager.uiGroup.get_children().filter(child => child.name === 'lyricsOverlay').length`), 1);

    // The indicator leaves with the service and returns with it.
    playing.stop();
    await h.stopService();
    await h.waitFor(async () => !(await h.evalJs(indicatorFacts)).visible, 'the indicator to hide without the service');
    await h.restartService();
    await h.report({tabId: 4, sampledAt: Date.now(), heartbeatMs: 5000, media: media(8), metadata: METADATA, next: null});
    await h.waitFor(async () => (await h.evalJs(indicatorFacts)).visible, 'the indicator to return');

    assert.doesNotMatch(h.shellLog, /JS ERROR|lyrics-overlay.*(Error|TypeError)/u, h.shellLog);
}
