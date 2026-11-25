import assert from 'node:assert/strict';
import test from 'node:test';

import {sampleLeadSheetForPreview} from '../shared/score-layout.js';
import {buildMidiPlaybackPlan, encodeLeadSheetMidi, parseChordSymbolToMidi} from '../shared/score-midi.js';

function readU32(bytes, offset) {
    return ((bytes[offset] << 24) >>> 0)
        | (bytes[offset + 1] << 16)
        | (bytes[offset + 2] << 8)
        | bytes[offset + 3];
}

function readU16(bytes, offset) {
    return (bytes[offset] << 8) | bytes[offset + 1];
}

test('parseChordSymbolToMidi spells major, minor, seventh, and slash chords accurately', () => {
    const gMaj = parseChordSymbolToMidi('G');
    assert.deepEqual(gMaj.map(m => m % 12), [7, 11, 2]);

    const eMin7 = parseChordSymbolToMidi('Em7');
    assert.deepEqual(eMin7.map(m => m % 12), [4, 7, 11, 2]);

    const d7SlashFSharp = parseChordSymbolToMidi('D7/F#');
    assert.equal(d7SlashFSharp[0] % 12, 6); // F# bass note first
    assert.ok(d7SlashFSharp.includes(50));  // D3 chord root present

    assert.deepEqual(parseChordSymbolToMidi('N'), []);
    assert.deepEqual(parseChordSymbolToMidi(''), []);
});

test('buildMidiPlaybackPlan produces monotonic melody, chord, and beat events', () => {
    const sheet = sampleLeadSheetForPreview({barsPerSystem: 4});
    const plan = buildMidiPlaybackPlan(sheet);
    assert.equal(plan.bpm, sheet.bpm);
    assert.ok(plan.melody.length >= 6);
    assert.ok(plan.chords.length >= 3);
    assert.ok(plan.beats.length >= 8);
    assert.ok(plan.duration > 1);
    for (let i = 1; i < plan.melody.length; i++)
        assert.ok(plan.melody[i].start >= plan.melody[i - 1].start - 1e-6);
    assert.ok(plan.melody.some(n => Boolean(n.lyric)));
});

test('encodeLeadSheetMidi emits valid Standard MIDI File format 1 with meta, melody, and chord tracks', () => {
    const sheet = sampleLeadSheetForPreview({barsPerSystem: 4});
    const bytes = encodeLeadSheetMidi(sheet, {title: 'Amazing Grace'});
    assert.ok(bytes instanceof Uint8Array);
    assert.ok(bytes.length > 80);

    // MThd header chunk
    const headerMagic = String.fromCharCode(...bytes.slice(0, 4));
    assert.equal(headerMagic, 'MThd');
    assert.equal(readU32(bytes, 4), 6);
    assert.equal(readU16(bytes, 8), 1);  // Format 1 (multi-track)
    const numTracks = readU16(bytes, 10);
    assert.equal(numTracks, 3);          // Meta + Melody + Chords
    const ppq = readU16(bytes, 12);
    assert.equal(ppq, 480);

    // Walk every MTrk chunk and ensure exact byte length + End-of-Track (FF 2F 00)
    let pos = 14;
    let foundTempo = false;
    let foundTimeSig = false;
    let foundKeySig = false;
    let foundLyric = false;
    let noteOnCount = 0;

    for (let t = 0; t < numTracks; t++) {
        assert.equal(String.fromCharCode(...bytes.slice(pos, pos + 4)), 'MTrk');
        const len = readU32(bytes, pos + 4);
        const start = pos + 8;
        const end = start + len;
        assert.ok(end <= bytes.length, `track ${t} overflows buffer`);
        // End-of-track marker must sit at the tail of each track
        assert.deepEqual([...bytes.slice(end - 3, end)], [0xff, 0x2f, 0x00]);
        for (let i = start; i < end - 2; i++) {
            if (bytes[i] === 0xff && bytes[i + 1] === 0x51 && bytes[i + 2] === 0x03)
                foundTempo = true;
            if (bytes[i] === 0xff && bytes[i + 1] === 0x58 && bytes[i + 2] === 0x04)
                foundTimeSig = true;
            if (bytes[i] === 0xff && bytes[i + 1] === 0x59 && bytes[i + 2] === 0x02)
                foundKeySig = true;
            if (bytes[i] === 0xff && bytes[i + 1] === 0x05)
                foundLyric = true;
            if ((bytes[i] & 0xf0) === 0x90 && bytes[i + 2] > 0)
                noteOnCount++;
        }
        pos = end;
    }
    assert.equal(pos, bytes.length);
    assert.equal(foundTempo, true);
    assert.equal(foundTimeSig, true);
    assert.equal(foundKeySig, true);
    assert.equal(foundLyric, true);
    assert.ok(noteOnCount >= 10);
});

test('encodeLeadSheetMidi emits separate Voice 1 (ch 0), Voice 2 (ch 1), and Chords (ch 2) tracks for polyphonic duets', async () => {
    const {buildLeadSheet} = await import('../shared/score-layout.js');
    const duet = buildLeadSheet({
        bpm: 120,
        meter: [4, 4],
        key: {root: 7, type: 'major'},
        beats: [0, 0.5, 1.0, 1.5, 2.0],
        downbeats: [0, 2.0],
        chords: [{bar: 1, beatInBar: 0, start: 0, end: 2.0, symbol: 'G'}],
        notes: [
            {id: 1, start: 0.0, end: 0.9, pitch: 71.0, durBeats: 2.0, voice: 1},
            {id: 2, start: 0.0, end: 0.9, pitch: 67.0, durBeats: 2.0, voice: 2},
            {id: 3, start: 1.0, end: 1.9, pitch: 74.0, durBeats: 2.0, voice: 1},
            {id: 4, start: 1.0, end: 1.9, pitch: 69.0, durBeats: 2.0, voice: 2},
        ],
    }, {voiceMode: 'both'});
    const plan = buildMidiPlaybackPlan(duet);
    assert.equal(plan.hasMultipleVoices, true);
    assert.equal(plan.melody.filter(n => n.voice === 1).length, 2);
    assert.equal(plan.melody.filter(n => n.voice === 2).length, 2);

    const bytes = encodeLeadSheetMidi(duet, {title: 'Duet Test'});
    assert.equal(readU16(bytes, 10), 4, 'duet with chords must emit 4 tracks (Meta + Voice 1 + Voice 2 + Chords)');
});
