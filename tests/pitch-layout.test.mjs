import test from 'node:test';
import assert from 'node:assert/strict';

import {labeledLines, noteLines, PAUSE_SCROLL_MS, READOUT_HOLD_MS, ReadoutNote, TraceClock} from '../shared/pitch-layout.js';

test('the trace clock scrolls through silence, or stops shortly into it', () => {
    const scrolling = new TraceClock(true);
    scrolling.advance(1000, true);
    assert.equal(scrolling.advance(5000, false), 5000);
    assert.equal(scrolling.traceTime(4900), 4900);

    const pausing = new TraceClock(false);
    pausing.advance(1000, true);
    pausing.advance(1000 + PAUSE_SCROLL_MS, false);
    assert.equal(pausing.advance(9000, false), 1000 + PAUSE_SCROLL_MS, 'stopped in the pause');
    assert.equal(pausing.advance(9100, true), 1000 + PAUSE_SCROLL_MS + 100, 'running again with the voice');
    assert.equal(pausing.traceTime(9050), 1000 + PAUSE_SCROLL_MS + 50);
});

test('every semitone is a line, marked by the scale', () => {
    const gMajor = new Set([7, 9, 11, 0, 2, 4, 6]);
    const lines = noteLines(59.5, 67.5, gMajor, 7);
    assert.deepEqual(lines.map(line => line.midi), [60, 61, 62, 63, 64, 65, 66, 67]);
    assert.deepEqual(lines.filter(line => line.inScale).map(line => line.midi), [60, 62, 64, 66, 67]);
    assert.deepEqual(lines.filter(line => line.root).map(line => line.midi), [67]);
    assert.ok(noteLines(59.5, 61.5, null, null).every(line => !line.inScale && !line.root));
});

test('note names give way to more important ones when they would overlap', () => {
    const gMajor = new Set([7, 9, 11, 0, 2, 4, 6]);
    const at = spacing => noteLines(59.5, 72.5, gMajor, 7).map(line => ({...line, y: (72.5 - line.midi) * spacing}));
    assert.equal(labeledLines(at(20), 'all', 14, true).size, 13, 'room for every name');
    const tight = labeledLines(at(8), 'all', 14, true);
    assert.ok(tight.has(67), 'the root first');
    assert.ok(!tight.has(68) && !tight.has(66), 'not crowding the root');
    assert.ok([...tight].every(midi => [...tight].every(other => other === midi || Math.abs(other - midi) * 8 >= 14)));
    assert.deepEqual([...labeledLines(at(20), 'c', 14, true)].sort(), [60, 72]);
    assert.deepEqual([...labeledLines(at(20), 'scale', 14, true)].sort((a, b) => a - b), [60, 62, 64, 66, 67, 69, 71, 72]);
    assert.deepEqual([...labeledLines(at(20), 'scale', 14, false)].sort(), [60, 72], 'without a scale, the Cs');
    assert.equal(labeledLines(at(20), 'none', 14, true).size, 0);
    assert.throws(() => labeledLines(at(20), 'some', 14, true), /unknown note label/u);
});

test('the readout holds its note through short gaps and does not flicker on a boundary', () => {
    const readout = new ReadoutNote();
    assert.equal(readout.at(0), null);
    readout.hear({t: 1000, midi: 60.1});
    assert.equal(readout.at(1000), 60);
    assert.equal(readout.cents, 10);
    assert.equal(readout.at(1000 + READOUT_HOLD_MS), 60, 'held through a breath');
    assert.equal(readout.at(1001 + READOUT_HOLD_MS), null);
    readout.hear({t: 3000, midi: 60.6});
    assert.equal(readout.at(3000), 60, 'just past the boundary: still C');
    assert.equal(readout.cents, 60);
    readout.hear({t: 3020, midi: 60.7});
    assert.equal(readout.at(3020), 61, 'clearly C♯');
    readout.hear({t: 3040, midi: 60.45});
    assert.equal(readout.at(3040), 61, 'back near the boundary: stays C♯');
    readout.clear();
    assert.equal(readout.at(3040), null);
});
