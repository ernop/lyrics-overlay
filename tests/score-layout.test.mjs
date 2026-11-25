import assert from 'node:assert/strict';
import test from 'node:test';

import {
    activeNoteIdAt,
    alignDisplayWordsToAudio,
    applyScoreEdits,
    buildLeadSheet,
    buildLineScore,
    chooseClef,
    computeHarmonyMidi,
    decomposeRhythm,
    findActiveLeadSheetPosition,
    keySignatureFor,
    layoutSystemLyrics,
    parseDisplayWords,
    planLeadSheetPage,
    sampleLeadSheetForPreview,
    sampleScoreForPreview,
    scaleDegreeLabel,
    snapPitchToScale,
    spellMidi,
} from '../shared/score-layout.js';

test('keySignatureFor covers sharp, flat, and minor keys accurately', () => {
    const cMaj = keySignatureFor({root: 0, type: 'major'});
    assert.equal(cMaj.fifths, 0);
    assert.equal(cMaj.accidentals.length, 0);

    const gMaj = keySignatureFor({root: 7, type: 'major'});
    assert.equal(gMaj.fifths, 1);
    assert.deepEqual(gMaj.accidentals, [{letter: 3, step: 38, kind: 'sharp'}]); // F#5

    const eMin = keySignatureFor({root: 4, type: 'minor'});
    assert.equal(eMin.fifths, 1); // relative minor of G major

    const fMaj = keySignatureFor({root: 5, type: 'major'});
    assert.equal(fMaj.fifths, -1);
    assert.deepEqual(fMaj.accidentals, [{letter: 6, step: 34, kind: 'flat'}]); // Bb4

    const bbMaj = keySignatureFor({root: 10, type: 'major'});
    assert.equal(bbMaj.fifths, -2);
    assert.equal(bbMaj.defaultAlter[6], -1); // B flat
    assert.equal(bbMaj.defaultAlter[2], -1); // E flat
});

test('chooseClef switches to treble-8vb for lower male voices', () => {
    assert.equal(chooseClef(64).clef, 'treble');
    assert.equal(chooseClef(64).octaveShift, 0);
    assert.equal(chooseClef(52).clef, 'treble-8vb');
    assert.equal(chooseClef(52).octaveShift, 1);
});

test('snapPitchToScale applies soft vs strict vs off cleanly', () => {
    const gMaj = {root: 7, type: 'major'};
    // F#4 (66) is in G major; F4 (65) is outside G major.
    // Borderline scoop 65.45 -> snaps to F#4 (66) in soft mode (dist 0.55 <= 0.62).
    assert.equal(snapPitchToScale(65.45, 1.0, gMaj, 'soft'), 66);
    // Centered blue note F4 (65.0) held for a full beat -> stays F4 (65) in soft mode!
    assert.equal(snapPitchToScale(65.0, 1.0, gMaj, 'soft'), 65);
    // Strict mode forces F4 (65.0) into the G major scale (64 or 66).
    const strictSnapped = snapPitchToScale(65.05, 1.0, gMaj, 'strict');
    assert.equal(strictSnapped, 66);
    // Off mode does pure chromatic rounding.
    assert.equal(snapPitchToScale(65.45, 1.0, gMaj, 'off'), 65);
});

test('spellMidi and per-bar accidentals obey key signatures', () => {
    const gSig = keySignatureFor({root: 7, type: 'major'});
    const fSharp4 = spellMidi(66, gSig, 0);
    assert.equal(fSharp4.noteName, 'F♯4');
    assert.equal(fSharp4.writtenStep, 31); // F4 space

    const fNat4 = spellMidi(65, gSig, 0);
    assert.equal(fNat4.noteName, 'F4');
    assert.equal(fNat4.alter, 0);

    // Tenor/baritone octave clef shifts written step up by 7 diatonic steps.
    const c3 = spellMidi(48, keySignatureFor({root: 0, type: 'major'}), 1);
    assert.equal(c3.noteName, 'C3');
    assert.equal(c3.writtenStep, 28); // Written on middle C ledger line
});

test('computeHarmonyMidi builds diatonic 3rds above and below in major and minor keys', () => {
    const cMaj = {root: 0, type: 'major'};
    // C4 (60) -> E4 (64) above, A3 (57) below
    assert.equal(computeHarmonyMidi(60, cMaj, +1), 64);
    assert.equal(computeHarmonyMidi(60, cMaj, -1), 57);
    // D4 (62) -> F4 (65, minor 3rd in C major!) above, B3 (59) below
    assert.equal(computeHarmonyMidi(62, cMaj, +1), 65);
    assert.equal(computeHarmonyMidi(62, cMaj, -1), 59);

    const aMin = {root: 9, type: 'minor'};
    // A4 (69) -> C5 (72, minor 3rd) above, F4 (65) below
    assert.equal(computeHarmonyMidi(69, aMin, +1), 72);
    assert.equal(computeHarmonyMidi(69, aMin, -1), 65);
});

test('decomposeRhythm maps standard beats and splits odd durations cleanly', () => {
    const q = decomposeRhythm(1.0);
    assert.equal(q.length, 1);
    assert.equal(q[0].figure, 'quarter');
    assert.equal(q[0].dots, 0);

    const dottedHalf = decomposeRhythm(3.0);
    assert.equal(dottedHalf.length, 1);
    assert.equal(dottedHalf[0].figure, 'half');
    assert.equal(dottedHalf[0].dots, 1);

    const twoAndHalf = decomposeRhythm(2.5);
    assert.equal(twoAndHalf.length, 2);
    assert.equal(twoAndHalf[0].figure, 'half');
    assert.equal(twoAndHalf[1].figure, 'eighth');
});

test('parseDisplayWords excludes countdown prefixes and handles Latin and CJK byte offsets', () => {
    const words = parseDisplayWords('3 Amazing grace, how sweet', 'Amazing grace, how sweet');
    assert.equal(words.length, 4);
    assert.equal(words[0].text, 'Amazing');
    assert.equal(words[0].byteStart, 2); // after "3 "
    assert.equal(words[0].byteEnd, 9);

    const jp = parseDisplayWords('夜に駆ける');
    assert.equal(jp.length, 5);
    assert.equal(jp[0].text, '夜');
    assert.equal(jp[0].byteStart, 0);
    assert.equal(jp[0].byteEnd, 3); // 3-byte UTF-8 kanji
});

test('buildLineScore aligns notes to words, detects melismas, beams, barlines, accidentals, and harmony', () => {
    const sample = sampleScoreForPreview();
    const lineScore = buildLineScore({
        displayText: 'Amazing grace, how sweet the sound',
        rawLineText: 'Amazing grace, how sweet the sound',
        lineStart: 0.0,
        lineEnd: 7.2,
        score: sample,
        scaleSnap: 'soft',
        harmony: 'both',
    });

    assert.ok(lineScore);
    assert.equal(lineScore.clef, 'treble');
    assert.equal(lineScore.keyLabel, 'G major');
    assert.equal(lineScore.keySig.fifths, 1);

    const notes = lineScore.items.filter(item => item.kind === 'note');
    const barlines = lineScore.items.filter(item => item.kind === 'barline');
    assert.equal(notes.length, 9);
    assert.equal(barlines.length, 4);

    // "Amazing" carries 4 notes (D4 pickup, G4 half, beamed B4-G4 eighth melisma)
    const amazingNotes = notes.filter(n => n.wordIndex === 0);
    assert.equal(amazingNotes.length, 4);
    assert.equal(amazingNotes[0].slurStart, true);
    assert.equal(amazingNotes[3].slurEnd, true);
    assert.notEqual(amazingNotes[2].beamGroup, null);
    assert.equal(amazingNotes[2].beamGroup, amazingNotes[3].beamGroup);

    // Harmony 3rd above G4 (67) in G major is B4 (71), below is E4 (64).
    assert.equal(amazingNotes[1].harmonyAbove.midi, 71);
    assert.equal(amazingNotes[1].harmonyBelow.midi, 64);

    // Active note highlight tracks playback time.
    assert.equal(activeNoteIdAt(lineScore, 2.2), notes[4].id);
    assert.equal(scaleDegreeLabel(67, {root: 7, type: 'major'}), '1');
});

test('buildLineScore resets accidentals after barlines and handles chromatic notes', () => {
    const score = {
        bpm: 120,
        meter: [4, 4],
        key: {root: 7, type: 'major'},
        medianMidi: 66,
        words: [
            {start: 0.0, end: 1.0, word: 'blue'},
            {start: 1.0, end: 2.0, word: 'note'},
            {start: 2.0, end: 3.0, word: 'back'},
        ],
        notes: [
            {start: 0.0, end: 0.9, pitch: 65.0, durBeats: 2.0, bar: 1}, // F4 natural (outside G major)
            {start: 1.0, end: 1.9, pitch: 66.0, durBeats: 2.0, bar: 1}, // F#4 in same bar -> needs sharp courtesy!
            {start: 2.0, end: 2.9, pitch: 66.0, durBeats: 2.0, bar: 2}, // F#4 in next bar -> key sig applies, no accidental
        ],
    };
    const ls = buildLineScore({
        displayText: 'blue note back',
        lineStart: 0.0,
        lineEnd: 3.0,
        score,
        scaleSnap: 'soft',
    });
    const notes = ls.items.filter(item => item.kind === 'note');
    assert.equal(notes[0].accidental, 'natural');
    assert.equal(notes[1].accidental, 'sharp');
    assert.equal(notes[2].accidental, null);
});

test('alignDisplayWordsToAudio interpolates smoothly when Whisper misses words', () => {
    const words = parseDisplayWords('one two three four');
    const aligned = alignDisplayWordsToAudio(words, [
        {start: 10.0, end: 10.5, word: 'one'},
        {start: 12.0, end: 12.6, word: 'four'},
    ], 10.0, 12.6);
    assert.equal(aligned[0].matched, true);
    assert.equal(aligned[1].matched, false);
    assert.equal(aligned[2].matched, false);
    assert.equal(aligned[3].matched, true);
    assert.ok(aligned[1].start >= 10.5 && aligned[1].end <= aligned[2].start + 1e-6);
    assert.ok(aligned[2].end <= 12.0 + 1e-6);
});

test('buildLeadSheet produces numbered measures, opening chord, ties across barlines, and systems', () => {
    const raw = {
        bpm: 96,
        meter: [4, 4],
        key: {root: 11, type: 'major'},
        medianMidi: 58,
        duration: 24,
        beats: Array.from({length: 36}, (_, i) => i * (60 / 96)),
        downbeats: Array.from({length: 9}, (_, i) => i * 4 * (60 / 96)),
        notes: [
            // First note starts on bar 2 beat 3 and ties across into bar 3!
            {id: 1, start: 4.375, end: 5.625, pitch: 54.0, durBeats: 2.0},
            {id: 2, start: 5.625, end: 6.25, pitch: 56.0, durBeats: 1.0},
            {id: 3, start: 6.25, end: 6.875, pitch: 59.0, durBeats: 1.0},
        ],
        chords: [
            {bar: 1, beatInBar: 0, start: 0.0, end: 5.0, symbol: 'B'},
            {bar: 3, beatInBar: 0, start: 5.0, end: 7.5, symbol: 'F#7'},
        ],
    };
    const sheet = buildLeadSheet(raw, {
        lyricLines: [{time: 4.3, text: 'Held across bar'}],
        scaleSnap: 'soft',
        harmony: 'above',
        barsPerSystem: 4,
    });
    assert.ok(sheet);
    assert.equal(sheet.clef, 'treble-8vb');
    assert.equal(sheet.keyLabel, 'B major');
    assert.equal(sheet.meter[0], 4);
    assert.equal(sheet.measures[0].chords[0]?.symbol, 'B', 'opening chord carries onto bar 1');
    const tiedOut = sheet.measures.flatMap(m => m.items).find(it => it.kind === 'note' && it.noteId === '1' && it.tieToNext);
    const tiedIn = sheet.measures.flatMap(m => m.items).find(it => it.kind === 'note' && it.noteId === '1' && it.tieFromPrev);
    assert.ok(tiedOut && tiedIn, 'note crossing barline splits cleanly with ties');
    assert.equal(tiedOut.harmonies.length, 1, 'harmony 3rd above attached');
    assert.equal(tiedOut.lyric, 'Held');

    const pos = findActiveLeadSheetPosition(sheet, 4.5);
    assert.equal(pos.systemIndex, 0);
    assert.equal(pos.activeNoteId, '1');
});

test('applyScoreEdits handles tempo ½×/2×, meter, key, clef, note overrides, delete, add, and chord overrides', () => {
    const raw = {
        bpm: 120,
        meter: [4, 4],
        key: {root: 0, type: 'major'},
        medianMidi: 64,
        beats: [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5],
        downbeats: [0, 2.0],
        notes: [
            {id: 1, start: 0.0, end: 0.5, pitch: 60, durBeats: 1},
            {id: 2, start: 0.5, end: 1.0, pitch: 64, durBeats: 1},
        ],
        chords: [{bar: 1, beatInBar: 0, start: 0, end: 2, symbol: 'C'}],
        edits: {
            tempoMul: 0.5,
            meter: [3, 4],
            keyOverride: {root: 7, type: 'major'},
            clef: 'treble-8vb',
            beatShift: 1,
            noteOverrides: {'1': {pitch: 67}},
            deletedNoteIds: ['2'],
            addedNotes: [{id: 'u1', start: 1.0, end: 1.5, pitch: 71, durBeats: 1}],
            chordOverrides: {'1:0': 'Gmaj7'},
        },
    };
    const eff = applyScoreEdits(raw);
    assert.equal(eff.bpm, 60);
    assert.deepEqual(eff.meter, [3, 4]);
    assert.equal(eff.notes.length, 2);
    assert.equal(eff.notes[0].pitch, 67);
    assert.equal(eff.notes[1].id, 'u1');

    const sheet = buildLeadSheet(raw, {barsPerSystem: 4});
    assert.equal(sheet.keyLabel, 'G major');
    assert.equal(sheet.clef, 'treble-8vb');
    assert.equal(sheet.measures[0].chords[0]?.symbol, 'Gmaj7');
});

test('sampleLeadSheetForPreview builds a 2-system G-major lead sheet', () => {
    const sample = sampleLeadSheetForPreview({barsPerSystem: 4});
    assert.ok(sample);
    assert.equal(sample.keyLabel, 'G major');
    assert.ok(sample.systems.length >= 2);
    assert.ok(sample.chordCount >= 3);
});

test('chooseClef minimizes weighted ledger-line excursion for wide low-register vocal melodies', () => {
    // Wide-range duet/baritone song with high chorus (median ~65) and many low verse notes (F3-B3)
    const lowVerseNotes = [
        ...Array.from({length: 12}, () => ({pitch: 55, durBeats: 1.5})), // G3
        ...Array.from({length: 10}, () => ({pitch: 57, durBeats: 1.0})), // A3
        ...Array.from({length: 16}, () => ({pitch: 65, durBeats: 1.0})), // F4
        ...Array.from({length: 16}, () => ({pitch: 69, durBeats: 1.0})), // A4
        ...Array.from({length: 6}, () => ({pitch: 72, durBeats: 1.0})),  // C5
    ];
    assert.equal(chooseClef(65, lowVerseNotes).clef, 'treble-8vb');

    // Standard treble melody (D4..D5) stays in regular treble clef
    const trebleNotes = [
        {pitch: 62, durBeats: 1},
        {pitch: 67, durBeats: 2},
        {pitch: 71, durBeats: 1},
        {pitch: 74, durBeats: 2},
    ];
    assert.equal(chooseClef(67, trebleNotes).clef, 'treble');
});

test('buildLeadSheet defaults to 6 bars per system, allows up to 12, and computes proportional visualWeight', () => {
    const beats = Array.from({length: 52}, (_, i) => i * 0.5);
    const downbeats = Array.from({length: 13}, (_, i) => i * 2.0);
    const notes = [
        // Bar 1: busy eighth-note bar
        {id: 1, start: 0.0, end: 0.25, pitch: 64, durBeats: 0.5},
        {id: 2, start: 0.25, end: 0.5, pitch: 65, durBeats: 0.5},
        {id: 3, start: 0.5, end: 0.75, pitch: 67, durBeats: 0.5},
        {id: 4, start: 0.75, end: 1.0, pitch: 69, durBeats: 0.5},
        {id: 5, start: 1.0, end: 1.25, pitch: 67, durBeats: 0.5},
        {id: 6, start: 1.25, end: 1.5, pitch: 65, durBeats: 0.5},
        // Bar 2: single whole note (sparse), Bars 3..12: one note per bar so none collapse into multi-bar rests
        ...Array.from({length: 11}, (_, idx) => ({
            id: 10 + idx,
            start: (idx + 1) * 2.0,
            end: (idx + 1) * 2.0 + 1.0,
            pitch: 62 + (idx % 5),
            durBeats: 2.0,
        })),
    ];
    const sheetDefault = buildLeadSheet({bpm: 120, meter: [4, 4], key: {root: 0, type: 'major'}, beats, downbeats, notes});
    assert.equal(sheetDefault.systems[0].measures.length, 6);
    assert.ok(sheetDefault.measures[0].visualWeight > sheetDefault.measures[1].visualWeight,
        'busy bar must receive greater proportional visualWeight than an empty bar');

    const sheetWide = buildLeadSheet({bpm: 120, meter: [4, 4], key: {root: 0, type: 'major'}, beats, downbeats, notes}, {barsPerSystem: 10});
    assert.equal(sheetWide.systems[0].measures.length, 10);

    const sheetOneBar = buildLeadSheet({bpm: 120, meter: [4, 4], key: {root: 0, type: 'major'}, beats, downbeats, notes}, {barsPerSystem: 1});
    assert.equal(sheetOneBar.systems[0].measures.length, 1);
});

test('layoutSystemLyrics avoids overlap without truncating text by shrinking moderately then staggering onto lower tiers', () => {
    const measure = (text, fontPx) => text.length * fontPx * 0.62;
    const tightEvents = [
        {x: 60, text: 'wonderful'},
        {x: 84, text: 'morning'},
        {x: 108, text: 'sunshine'},
        {x: 240, text: 'day'},
    ];
    const layout = layoutSystemLyrics(tightEvents, {
        leftBound: 20,
        rightBound: 300,
        baseFontPx: 14,
        minScale: 0.78,
        maxTiers: 3,
        measureWidth: measure,
    });
    assert.equal(layout.placements.length, tightEvents.length);
    assert.ok(layout.tierCount >= 2, `tight notes must use multi-tier staggering, got ${layout.tierCount}`);
    for (let i = 0; i < layout.placements.length; i++) {
        assert.equal(layout.placements[i].text, tightEvents[i].text, 'must never truncate or drop syllables');
        assert.ok(layout.placements[i].fontPx >= 10.5, 'must never shrink below readable minScale floor');
    }
    // Verify no two syllables on the same tier overlap horizontally
    const byTier = new Map();
    for (const p of layout.placements) {
        const arr = byTier.get(p.tier) ?? [];
        arr.push({left: p.drawX - p.width / 2, right: p.drawX + p.width / 2, text: p.text});
        byTier.set(p.tier, arr);
    }
    for (const arr of byTier.values()) {
        arr.sort((a, b) => a.left - b.left);
        for (let i = 1; i < arr.length; i++)
            assert.ok(arr[i].left >= arr[i - 1].right - 0.5, `same-tier overlap between ${arr[i - 1].text} and ${arr[i].text}`);
    }
});

test('buildLeadSheet records rawMidi, rawNoteName, and snapDelta when scale snap shifts a pitch', () => {
    const raw = {
        bpm: 120,
        meter: [4, 4],
        key: {root: 7, type: 'major'}, // G major (F# in scale; F natural snaps to F# under strict)
        beats: [0, 0.5, 1.0, 1.5, 2.0],
        downbeats: [0, 2.0],
        notes: [
            {id: 1, start: 0.0, end: 0.9, pitch: 65.35, durBeats: 2.0}, // slightly sharp F4 -> snaps to F#4 (66)
            {id: 2, start: 1.0, end: 1.9, pitch: 67.0, durBeats: 2.0},  // exact G4 -> no snap
        ],
    };
    const sheet = buildLeadSheet(raw, {scaleSnap: 'strict', barsPerSystem: 4});
    const notes = sheet.measures[0].items.filter(it => it.kind === 'note');
    assert.equal(notes[0].midi, 66);
    assert.equal(notes[0].rawMidi, 65);
    assert.equal(notes[0].snapDelta, 1);
    assert.equal(notes[0].rawNoteName, 'F4');
    assert.equal(notes[0].noteName, 'F\u266F4');
    assert.equal(notes[1].snapDelta, 0);
});

test('buildLeadSheet engraves harmonizing two-voice passages with opposite stems, 2nd-clash offset, and voiceMode filtering', () => {
    const duetRaw = {
        bpm: 120,
        meter: [4, 4],
        key: {root: 7, type: 'major'},
        beats: [0, 0.5, 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0],
        downbeats: [0, 2.0, 4.0],
        words: [
            {word: 'shine', start: 0.0, end: 0.5},
            {word: 'on', start: 0.5, end: 1.0},
            {word: 'solo', start: 2.0, end: 3.0},
        ],
        notes: [
            // Bar 1: harmonizing duet (beats 0..1 eighth notes, beat 1..2 second-interval clash A4 vs G4!)
            {id: 1, start: 0.0, end: 0.25, pitch: 71.0, durBeats: 0.5, voice: 1}, // B4
            {id: 2, start: 0.0, end: 0.25, pitch: 67.0, durBeats: 0.5, voice: 2}, // G4
            {id: 3, start: 0.25, end: 0.5, pitch: 72.0, durBeats: 0.5, voice: 1}, // C5
            {id: 4, start: 0.25, end: 0.5, pitch: 69.0, durBeats: 0.5, voice: 2}, // A4
            {id: 5, start: 0.5, end: 1.0, pitch: 69.0, durBeats: 1.0, voice: 1},  // A4
            {id: 6, start: 0.5, end: 1.0, pitch: 67.0, durBeats: 1.0, voice: 2},  // G4 (2nd below A4 -> headShiftX=1!)
            // Bar 2: solo vocal passage (voice 1 only)
            {id: 7, start: 2.0, end: 3.0, pitch: 67.0, durBeats: 2.0, voice: 1},
        ],
    };

    const both = buildLeadSheet(duetRaw, {voiceMode: 'both', barsPerSystem: 4});
    assert.equal(both.voiceCount, 2);
    assert.equal(both.hasMultipleVoices, true);
    const bar1Notes = both.measures[0].items.filter(it => it.kind === 'note');
    const v1 = bar1Notes.filter(it => it.voice === 1);
    const v2 = bar1Notes.filter(it => it.voice === 2);
    assert.equal(v1.length, 3);
    assert.equal(v2.length, 3);
    assert.ok(v1.every(n => n.stemDir === 1), 'Voice 1 in polyphonic bar must have stems UP (+1)');
    assert.ok(v2.every(n => n.stemDir === -1), 'Voice 2 in polyphonic bar must have stems DOWN (-1)');
    assert.notEqual(v1[0].beamGroup, null);
    assert.notEqual(v2[0].beamGroup, null);
    assert.notEqual(v1[0].beamGroup, v2[0].beamGroup, 'Voice 1 and Voice 2 must beam independently');
    assert.equal(v2[2].headShiftX, 1, 'simultaneous 2nd (G4 under A4) must offset Voice 2 notehead horizontally');
    assert.ok(v2.every(n => !n.lyric), 'lyrics must attach only to Voice 1, never double-printed on Voice 2');

    const topOnly = buildLeadSheet(duetRaw, {voiceMode: 'top', barsPerSystem: 4});
    assert.equal(topOnly.hasMultipleVoices, false);
    assert.equal(topOnly.measures[0].items.filter(it => it.kind === 'note').length, 3);

    const bottomOnly = buildLeadSheet(duetRaw, {voiceMode: 'bottom', barsPerSystem: 4});
    assert.equal(bottomOnly.measures[0].items.filter(it => it.kind === 'note').every(n => n.voice === 2), true);
    assert.equal(bottomOnly.measures[1].items.filter(it => it.kind === 'note').length, 1,
        'bottom voice mode must keep solo passages intact so no blank gaps appear');
});

test('planLeadSheetPage prevents crushed zoom and giant vertical voids across window shapes', () => {
    const sample = sampleLeadSheetForPreview({barsPerSystem: 4});

    // Regression: square-ish window (920x760) with pinned 6 bars + 200% zoom + Spacious spacing
    // must NEVER crush effectiveScale to ~64% or float rows down the middle of a blank page.
    const square200 = planLeadSheetPage(sample, {
        width: 920,
        height: 760,
        scale: 2.0,
        barsPerSystem: 6,
        spacing: 'spacious',
        showHeader: true,
        showMeasureNumbers: false,
        showChords: false,
        showLyrics: true,
        noteNames: 'off',
    });
    assert.equal(square200.effectiveScale, 2.0, 'zoom 200% must never be silently crushed');
    assert.equal(square200.reflowed, true, '6 bars at 200% in 920px must reflow down cleanly');
    assert.ok(square200.barsPerSystem >= 2 && square200.barsPerSystem <= 4, `expected 2..4 bars/row, got ${square200.barsPerSystem}`);
    assert.ok(square200.rows >= 3, `expected >= 3 rows to fill 760px height, got ${square200.rows}`);
    assert.ok(square200.topMargin <= 24, `systems must start near top below header, got topMargin=${square200.topMargin}`);
    const usedH = square200.rows * square200.systemH + (square200.rows - 1) * square200.systemGap;
    assert.ok(usedH / square200.bodyH >= 0.78, `vertical page coverage must stay high, got ${(usedH / square200.bodyH).toFixed(2)}`);

    // Regression: Spacious spacing must NEVER shrink effectiveScale when Bars/row is pinned and fits.
    const pinnedCompact = planLeadSheetPage(sample, {width: 1100, height: 700, scale: 1.2, barsPerSystem: 4, spacing: 'compact'});
    const pinnedSpacious = planLeadSheetPage(sample, {width: 1100, height: 700, scale: 1.2, barsPerSystem: 4, spacing: 'spacious'});
    assert.equal(pinnedCompact.effectiveScale, 1.2);
    assert.equal(pinnedSpacious.effectiveScale, 1.2);
    assert.equal(pinnedSpacious.barsPerSystem, 4);
    assert.equal(pinnedSpacious.reflowed, false);

    // Tall maximized window at 100% fills height past the old 6-row cap with zero bottom void.
    const tall100 = planLeadSheetPage(sample, {
        width: 1920,
        height: 1040,
        scale: 1.0,
        barsPerSystem: 0,
        spacing: 'normal',
        showHeader: true,
        showChords: false,
        showLyrics: true,
        noteNames: 'off',
    });
    assert.ok(tall100.rows >= 7, `tall 1040px window at 100% must exceed old 6-row cap, got ${tall100.rows}`);
    const tallUsed = tall100.rows * tall100.systemH + (tall100.rows - 1) * tall100.systemGap;
    assert.ok(tallUsed / tall100.bodyH >= 0.85, `tall window coverage must stay >= 85%, got ${(tallUsed / tall100.bodyH).toFixed(2)}`);
});

test('buildLeadSheet merges consecutive empty bars across hidden chords when showChords is false', () => {
    const spb = 0.5;
    const raw = {
        bpm: 120,
        meter: [4, 4],
        key: {root: 2, type: 'major'},
        beats: Array.from({length: 52}, (_, i) => i * spb),
        downbeats: Array.from({length: 13}, (_, i) => i * 4 * spb),
        notes: [
            {id: 1, start: 0, end: 1.0, pitch: 62, durBeats: 2},
            // Bars 2..10 are completely note-free (9 empty bars), then bar 11 has a note
            {id: 2, start: 40 * spb, end: 42 * spb, pitch: 66, durBeats: 2},
        ],
        // A chord change sits in bar 8 (breaking the 9-bar rest into 6 + 3 when chords are shown).
        chords: [
            {bar: 1, beatInBar: 0, start: 0, end: 28 * spb, symbol: 'D'},
            {bar: 8, beatInBar: 0, start: 28 * spb, end: 44 * spb, symbol: 'G'},
        ],
    };
    const withChords = buildLeadSheet(raw, {barsPerSystem: 6, showChords: true});
    const withoutChords = buildLeadSheet(raw, {barsPerSystem: 6, showChords: false});
    const multiWith = withChords.measures.filter(m => m.multiRest > 0);
    const multiWithout = withoutChords.measures.filter(m => m.multiRest > 0);
    assert.equal(multiWith.length, 1);
    assert.equal(multiWith[0].multiRest, 6, 'visible chord at bar 8 splits the rest into 6 + 3 bars');
    assert.equal(multiWithout.length, 1);
    assert.equal(multiWithout[0].multiRest, 9, 'hidden chords must not fragment a 9-bar rest into 6 + 3 single bars');
});
