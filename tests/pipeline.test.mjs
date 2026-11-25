import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildVocalFusedCandidate,
    patchScoreEdits,
    preserveSongLevelEdits,
    referencePlainLyrics,
    selectReferenceLyrics,
    summarizeIngest,
    upsertVocalFusedCandidate,
} from '../service/ingest.js';
import {
    analysisStageLabel,
    countScoreVoices,
    projectAnalysisState,
} from '../service/analyzer.js';

test('ingest: selectReferenceLyrics prefers human LRCLIB or custom lyrics over generated ones', () => {
    const rec = {
        rejectedIds: ['bad-1'],
        candidates: [
            {id: 'gen:1', generated: 'aligned', timed: true, matches: true, syncedLyrics: '[00:01.00] gen'},
            {id: 'bad-1', timed: true, matches: true, syncedLyrics: '[00:01.00] rejected'},
            {id: 'lrclib-plain', timed: false, matches: true, plainLyrics: 'Plain human text'},
            {id: 'lrclib-timed', timed: true, matches: true, syncedLyrics: '[00:01.00] Synced human text'},
        ],
    };
    const picked = selectReferenceLyrics(rec, rec.candidates[0]);
    assert.equal(picked?.id, 'lrclib-timed');
    assert.equal(referencePlainLyrics(picked), 'Synced human text');

    const onlyUnmatched = {
        rejectedIds: [],
        candidates: [
            {id: 'bad-dur', timed: false, matches: false, plainLyrics: 'Wrong 3-minute song on 2-hour video'},
        ],
    };
    assert.equal(selectReferenceLyrics(onlyUnmatched, null), null);
});

test('ingest: buildVocalFusedCandidate + upsertVocalFusedCandidate preserves LRCLIB sets intact', () => {
    const rec = {
        candidates: [
            {id: 'lrclib-1', trackName: 'Grace', artistName: 'Singer', timed: true, matches: true, syncedLyrics: '[00:10.00] Amazing grace\n[00:14.00] How sweet the sound'},
            {id: 'gen:old', generated: 'aligned', timed: true, matches: true, syncedLyrics: '[00:10.00] old'},
        ],
        rejectedIds: ['gen:old'],
        chosenId: 'lrclib-1',
        offsetSeconds: 1.5,
    };
    const fused = buildVocalFusedCandidate({
        segments: [
            {start: 10.2, end: 13.8, text: 'Amazing grace', words: [{word: 'Amazing', start: 10.2, end: 11.8}, {word: 'grace', start: 11.9, end: 13.8}]},
            {start: 14.3, end: 18.0, text: 'How sweet the sound', words: [{word: 'How', start: 14.3, end: 15.0}, {word: 'sweet', start: 15.1, end: 16.0}, {word: 'the', start: 16.1, end: 16.6}, {word: 'sound', start: 16.7, end: 18.0}]},
        ],
        refCandidate: rec.candidates[0],
        duration: 180,
        now: 1700000000000,
        seq: 1,
    });
    assert.ok(fused?.candidate?.id.startsWith('gen:vocal:'));
    const {activated} = upsertVocalFusedCandidate(rec, fused.candidate, {
        effective: rec.candidates[0],
        activateLyrics: false,
        now: 1700000000000,
    });
    assert.equal(activated, true);
    assert.equal(rec.chosenId, fused.candidate.id);
    assert.equal(rec.offsetSeconds, 0);
    assert.ok(rec.candidates.some(c => c.id === 'lrclib-1'), 'LRCLIB candidate must remain intact');
    assert.ok(!rec.candidates.some(c => c.id === 'gen:old'), 'old generated candidate must be replaced');
});

test('ingest: patchScoreEdits and preserveSongLevelEdits manage per-song overrides cleanly', () => {
    const patched = patchScoreEdits(
        {tempoMul: 0.5, chordOverrides: {'1:0': 'Gmaj7'}},
        {keyOverride: {root: 2, type: 'major'}, clef: 'treble-8vb'},
    );
    assert.deepEqual(patched, {
        tempoMul: 0.5,
        chordOverrides: {'1:0': 'Gmaj7'},
        keyOverride: {root: 2, type: 'major'},
        clef: 'treble-8vb',
    });

    const cleared = patchScoreEdits(patched, {keyOverride: null});
    assert.equal(cleared.keyOverride, undefined);
    assert.equal(cleared.clef, 'treble-8vb');

    const preserved = preserveSongLevelEdits(patched);
    assert.deepEqual(preserved, {
        tempoMul: 0.5,
        keyOverride: {root: 2, type: 'major'},
        clef: 'treble-8vb',
    });
    assert.equal(preserved.chordOverrides, undefined);
});

test('analyzer: countScoreVoices and projectAnalysisState report unified pipeline state cleanly', () => {
    assert.equal(analysisStageLabel('harmony'), 'Extracting harmonizing voices');
    assert.equal(countScoreVoices({status: 'ready', notes: [{pitch: 64}, {pitch: 67}]}), 1);
    assert.equal(countScoreVoices({status: 'ready', notes: [{pitch: 67, voice: 1}, {pitch: 60, voice: 2}]}), 2);

    const duet = projectAnalysisState({
        scoreState: {available: true, status: 'ready', quality: 'standard', bpm: 100, noteCount: 2, chordCount: 1, key: {root: 0, type: 'major'}},
        generationState: {available: true, status: 'idle'},
        scoreRecord: {status: 'ready', voiceCount: 2, notes: [{pitch: 67, voice: 1}, {pitch: 60, voice: 2}]},
        effectiveLyric: {generated: 'vocal-fused'},
        effectiveKey: {root: 0, type: 'major'},
    });
    assert.equal(duet.status, 'ready');
    assert.equal(duet.voicesDetected, 2);
    assert.equal(duet.label, 'Ready (2 vocal voices)');
    assert.equal(duet.tracks.lyrics, 'vocal-fused');
    assert.equal(duet.tracks.melody, 'ready');

    const ing = summarizeIngest({
        record: {candidates: [{id: '1', timed: true, generated: 'vocal-fused'}]},
        effective: {id: '1', timed: true, generated: 'vocal-fused'},
        scoreRecord: {status: 'ready', key: {root: 0, type: 'major'}, edits: {keyOverride: {root: 2, type: 'major'}}},
    });
    assert.equal(ing.lyricSource, 'vocal-fused');
    assert.equal(ing.keySource, 'override');
    assert.equal(ing.hasScoreEdits, true);
});
