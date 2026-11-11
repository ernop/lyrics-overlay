import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
    RATE_LIMIT_DEFAULT_PAUSE_MS, RATE_LIMIT_LONGEST_PAUSE_MS, emptyBudgetState, loadedBudgetState, pauseBudget,
    retryAtFromHeader, takeBudget,
} from '../shared/budget.js';
import {GlitchFilter, PitchDetector, freqToMidi, noteName, voiceMidi} from '../shared/pitch-mpm.js';
import {
    DOCK_GAP, MIN_BOX_HEIGHT, MIN_BOX_WIDTH, balancedWrapWidth, boxFromGeometry, clampBox, dockedPanelBox, edgeResizedBox,
    fitFontSize, geometryFromBox, movedBox, resizedBox, snappedDock,
} from '../shared/overlay-geometry.js';

test('budget refuses past any window and names when it reopens', () => {
    const windows = [{seconds: 60, limit: 2}, {seconds: 3600, limit: 3}];
    let state = emptyBudgetState();
    const t0 = 3600 * 1000 * 10;
    for (const at of [t0, t0 + 1000]) {
        const decision = takeBudget(state, windows, at);
        assert.equal(decision.allowed, true);
        state = decision.state;
    }
    const refused = takeBudget(state, windows, t0 + 2000);
    assert.deepEqual([refused.allowed, refused.retryAtMs], [false, t0 + 60000]);
    const nextMinute = takeBudget(refused.state, windows, t0 + 60000);
    assert.equal(nextMinute.allowed, true);
    const hourFull = takeBudget(nextMinute.state, windows, t0 + 61000);
    assert.deepEqual([hourFull.allowed, hourFull.retryAtMs], [false, t0 + 3600 * 1000]);
});

test('a provider pause closes the budget until it ends, and only a later pause extends it', () => {
    const windows = [{seconds: 60, limit: 5}];
    const t0 = 3600 * 1000 * 10;
    const paused = pauseBudget(emptyBudgetState(), t0 + 30_000);
    assert.deepEqual(pauseBudget(paused, t0 + 10_000), paused);
    const refused = takeBudget(paused, windows, t0 + 29_999);
    assert.deepEqual([refused.allowed, refused.retryAtMs], [false, t0 + 30_000]);
    const reopened = takeBudget(refused.state, windows, t0 + 30_000);
    assert.equal(reopened.allowed, true);
    assert.equal(reopened.state.pausedUntil, t0 + 30_000);
});

test('Retry-After is read as seconds or an HTTP date, with a minute when absent and a day at most', () => {
    const now = Date.parse('2026-11-10T21:00:00Z');
    assert.equal(retryAtFromHeader('120', now), now + 120_000);
    assert.equal(retryAtFromHeader(' 0 ', now), now);
    assert.equal(retryAtFromHeader('Tue, 10 Nov 2026 21:05:00 GMT', now), now + 300_000);
    assert.equal(retryAtFromHeader('Tue, 10 Nov 2026 20:00:00 GMT', now), now, 'a past date means now');
    assert.equal(retryAtFromHeader(null, now), now + RATE_LIMIT_DEFAULT_PAUSE_MS);
    assert.equal(retryAtFromHeader('soon', now), now + RATE_LIMIT_DEFAULT_PAUSE_MS);
    assert.equal(retryAtFromHeader('9999999', now), now + RATE_LIMIT_LONGEST_PAUSE_MS);
});

test('a stored budget from before pauses loads with none, and a malformed one is refused', () => {
    assert.deepEqual(loadedBudgetState(null), emptyBudgetState());
    assert.deepEqual(loadedBudgetState({counts: {60: {start: 1, count: 2}}}), {counts: {60: {start: 1, count: 2}}, pausedUntil: 0});
    assert.throws(() => loadedBudgetState({pausedUntil: 5}), /malformed/u);
    assert.throws(() => loadedBudgetState({counts: {}, pausedUntil: 'later'}), /malformed/u);
});

function tone(freq, harmonics, sampleRate = 48000, length = 2048) {
    const buffer = new Float32Array(length);
    for (let i = 0; i < length; i++) {
        let value = 0;
        for (let h = 1; h <= harmonics; h++)
            value += Math.sin(2 * Math.PI * freq * h * i / sampleRate) / h;
        buffer[i] = 0.3 * value;
    }
    return buffer;
}

test('MPM finds sung fundamentals, including harmonic-rich ones', () => {
    const detector = new PitchDetector();
    for (const freq of [98, 220, 440]) {
        const midi = voiceMidi(detector, tone(freq, 1), 48000);
        assert.ok(Math.abs(midi - freqToMidi(freq)) < 0.1, `${freq} Hz read as ${midi}`);
        const rich = voiceMidi(detector, tone(freq, 6), 48000);
        assert.ok(Math.abs(rich - freqToMidi(freq)) < 0.1, `${freq} Hz with harmonics read as ${rich}`);
    }
    assert.equal(voiceMidi(detector, new Float32Array(2048), 48000), null);
    assert.equal(noteName(57), 'A3');
    assert.equal(noteName(60.4), 'C4');
});

test('glitch filter holds a large jump until it is confirmed', () => {
    const filter = new GlitchFilter();
    assert.equal(filter.push({time: 0, midi: 60}).length, 1);
    assert.equal(filter.push({time: 40, midi: 72}).length, 0);
    assert.equal(filter.push({time: 80, midi: 72.2}).length, 0);
    assert.equal(filter.push({time: 120, midi: 72.1}).length, 3);
    assert.equal(filter.push({time: 160, midi: 60}).length, 0);
    assert.equal(filter.push({time: 200, midi: 72}).length, 1);
});

const area = {x: 0, y: 0, width: 2560, height: 1080};

test('a docked pitch panel sits against its side of the lyric, as long as that side', () => {
    const lyric = {x: 1000, y: 500, width: 800, height: 120};
    assert.deepEqual(dockedPanelBox(lyric, 'below', 150, area), {x: 1000, y: 620 + DOCK_GAP, width: 800, height: 150});
    assert.deepEqual(dockedPanelBox(lyric, 'above', 150, area), {x: 1000, y: 500 - DOCK_GAP - 150, width: 800, height: 150});
    assert.deepEqual(dockedPanelBox(lyric, 'left', 300, area), {x: 1000 - DOCK_GAP - 300, y: 500, width: 300, height: 120});
    assert.deepEqual(dockedPanelBox(lyric, 'right', 300, area), {x: 1800 + DOCK_GAP, y: 500, width: 300, height: 120});
    // Short of room it thins to what is left, and at the minimum it overlaps the lyric rather than leave the screen.
    const low = {x: 1000, y: 900, width: 800, height: 120};
    assert.equal(dockedPanelBox(low, 'below', 300, area).height, 1080 - (1020 + DOCK_GAP));
    const bottom = {x: 1000, y: 1000, width: 800, height: 80};
    assert.deepEqual(dockedPanelBox(bottom, 'below', 300, area), {x: 1000, y: 1080 - MIN_BOX_HEIGHT, width: 800, height: MIN_BOX_HEIGHT});
    assert.equal(dockedPanelBox({x: 2400, y: 0, width: 160, height: 100}, 'right', 400, area).width, MIN_BOX_WIDTH);
    assert.throws(() => dockedPanelBox(lyric, 'under', 100, area), /unknown dock/u);
});

test('a dragged panel snaps to the lyric side it is dropped against', () => {
    const lyric = {x: 1000, y: 500, width: 800, height: 120};
    const near = 24;
    assert.equal(snappedDock({x: 1100, y: 630, width: 500, height: 150}, lyric, near), 'below');
    assert.equal(snappedDock({x: 1100, y: 340, width: 500, height: 150}, lyric, near), 'above');
    assert.equal(snappedDock({x: 1810, y: 480, width: 300, height: 150}, lyric, near), 'right');
    assert.equal(snappedDock({x: 690, y: 520, width: 300, height: 150}, lyric, near), 'left');
    assert.equal(snappedDock({x: 1100, y: 700, width: 500, height: 150}, lyric, near), null, 'too far below');
    assert.equal(snappedDock({x: 100, y: 630, width: 500, height: 150}, lyric, near), null, 'below, but beside the lyric');
});

test('edge drags resize from that edge, keeping the opposite one and the minimum size', () => {
    const start = {x: 400, y: 300, width: 600, height: 200};
    assert.deepEqual(edgeResizedBox(start, {right: true}, 50, 999, area), {x: 400, y: 300, width: 650, height: 200});
    assert.deepEqual(edgeResizedBox(start, {left: true, top: true}, -100, -50, area), {x: 300, y: 250, width: 700, height: 250});
    assert.deepEqual(edgeResizedBox(start, {left: true}, 1000, 0, area), {x: 1000 - MIN_BOX_WIDTH, y: 300, width: MIN_BOX_WIDTH, height: 200});
    assert.deepEqual(edgeResizedBox(start, {bottom: true}, 0, 5000, area), {x: 400, y: 300, width: 600, height: 1080 - 300});
    assert.deepEqual(edgeResizedBox(start, {top: true}, 0, -1000, area), {x: 400, y: 0, width: 600, height: 500});
});

test('the default lyric box leaves a panel docked below it its whole default height', () => {
    const schema = fs.readFileSync(new URL(
        '../gnome-extension/lyrics-overlay@ernop/schemas/org.gnome.shell.extensions.lyrics-overlay.gschema.xml', import.meta.url), 'utf8');
    const defaultOf = name => schema.match(new RegExp(`<key name="${name}"[^>]*>[\\s\\S]*?<default>([^<]*)</default>`, 'u'))[1];
    assert.equal(defaultOf('pitch-dock'), "'below'");
    const box = JSON.parse(defaultOf('box').replaceAll("'", '"'));
    const share = Number(defaultOf('pitch-docked-height'));
    for (const screen of [{x: 0, y: 32, width: 1920, height: 1048}, {x: 0, y: 32, width: 1600, height: 868},
        {x: 0, y: 0, width: 3840, height: 2112}]) {
        const panel = dockedPanelBox(boxFromGeometry(box, screen), 'below', share * screen.height, screen);
        assert.equal(panel.height, share * screen.height, JSON.stringify(screen));
    }
});

test('geometry round-trips through monitor fractions', () => {
    const box = boxFromGeometry({cx: 0.5, cy: 0.86, width: 0.6, height: 0.14}, area);
    assert.deepEqual(geometryFromBox(box, area), {cx: 0.5, cy: 0.86, width: 0.6, height: 0.14});
});

test('moves and resizes stay inside the work area', () => {
    const start = {x: 100, y: 100, width: 400, height: 100};
    assert.deepEqual(movedBox(start, -500, 2000, area), {x: 0, y: 980, width: 400, height: 100});
    assert.deepEqual(clampBox({x: 0, y: 0, width: 10, height: 10}, area), {x: 0, y: 0, width: 160, height: 48});
});

test('resize is free on both axes around the box center', () => {
    const start = {x: 1000, y: 500, width: 400, height: 100};
    const press = {x: 1300, y: 560};
    assert.deepEqual(resizedBox(start, press, {x: 1350, y: 540}, area), {x: 950, y: 520, width: 500, height: 60});
    const pressLeft = {x: 1100, y: 520};
    assert.deepEqual(resizedBox(start, pressLeft, {x: 1050, y: 500}, area), {x: 950, y: 480, width: 500, height: 140});
});

test('text fitting finds the largest fitting size and a balanced wrap', () => {
    assert.equal(fitFontSize(100, 10, () => true), 100);
    const fitted = fitFontSize(100, 10, size => size <= 37.2);
    assert.ok(fitted <= 37.2 && fitted > 36.6);
    const words = 'one two three four five six seven'.split(' ');
    const lineCountAt = width => {
        let lines = 1;
        let used = 0;
        for (const word of words) {
            const needed = (used ? 1 : 0) + word.length;
            if (used + needed > width && used) {
                lines++;
                used = word.length;
            } else {
                used += needed;
            }
        }
        return lines;
    };
    assert.equal(lineCountAt(30), 2);
    const balanced = balancedWrapWidth(30, lineCountAt);
    assert.equal(lineCountAt(balanced), 2);
    assert.ok(balanced < 20);
});
