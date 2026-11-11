import test from 'node:test';
import assert from 'node:assert/strict';

import {ChromaAnalyzer, detectKey, fft, KEY_SAMPLE_RATE, KEY_WINDOW} from '../shared/key-detect.js';
import {keyName, noteLabel, pitchClassNames, scalePitchClasses} from '../shared/scales.js';

const hz = midi => 440 * 2 ** ((midi - 69) / 12);

/** One window of a chord: each note with two weaker overtones, as an instrument would sound. */
function chordWindow(notes, offset) {
    const samples = new Float32Array(KEY_WINDOW);
    for (const midi of notes) {
        for (const [harmonic, gain] of [[1, 0.2], [2, 0.08], [3, 0.05]]) {
            const step = 2 * Math.PI * hz(midi) * harmonic / KEY_SAMPLE_RATE;
            for (let i = 0; i < KEY_WINDOW; i++)
                samples[i] += gain * Math.sin(step * (i + offset));
        }
    }
    return samples;
}

function keyOf(progression) {
    const analyzer = new ChromaAnalyzer();
    const total = new Float64Array(12);
    progression.forEach((chord, index) => {
        const chroma = analyzer.chroma(chordWindow(chord, index * 997));
        for (let i = 0; i < 12; i++)
            total[i] += chroma[i];
    });
    return detectKey(total);
}

test('the FFT matches a direct transform', () => {
    const n = 16;
    const signal = Array.from({length: n}, (_, i) => Math.sin(i * 1.7) + 0.3 * Math.cos(i * 0.4));
    const re = Float64Array.from(signal);
    const im = new Float64Array(n);
    fft(re, im);
    for (let k = 0; k < n; k++) {
        let sumRe = 0;
        let sumIm = 0;
        for (let t = 0; t < n; t++) {
            sumRe += signal[t] * Math.cos(-2 * Math.PI * k * t / n);
            sumIm += signal[t] * Math.sin(-2 * Math.PI * k * t / n);
        }
        assert.ok(Math.abs(re[k] - sumRe) < 1e-9 && Math.abs(im[k] - sumIm) < 1e-9, `bin ${k}`);
    }
});

test('a tone lands in its pitch class, and silence counts for nothing', () => {
    const analyzer = new ChromaAnalyzer();
    const chroma = analyzer.chroma(chordWindow([69], 0));
    assert.equal(chroma.indexOf(Math.max(...chroma)), 9, 'A');
    assert.ok(Math.abs(chroma.reduce((sum, value) => sum + value, 0) - 1) < 1e-9);
    assert.equal(analyzer.chroma(new Float32Array(KEY_WINDOW)), null);
    assert.throws(() => analyzer.chroma(new Float32Array(100)), /8192 samples/u);
});

test('chord progressions are heard in their keys', () => {
    // G major: G C D G Em C D G
    const gMajor = keyOf([[55, 59, 62], [48, 52, 55], [50, 54, 57], [55, 59, 62], [52, 55, 59], [48, 52, 55], [50, 54, 57], [55, 59, 62]]);
    assert.deepEqual([gMajor.root, gMajor.mode], [7, 'major']);
    assert.ok(gMajor.margin > 0.02, `G major by ${gMajor.margin}`);
    // D minor with its raised leading tone: Dm Gm A7 Dm Bb Gm A Dm
    const dMinor = keyOf([[50, 53, 57], [55, 58, 62], [57, 61, 64, 67], [50, 53, 57], [46, 50, 53], [55, 58, 62], [57, 61, 64], [50, 53, 57]]);
    assert.deepEqual([dMinor.root, dMinor.mode], [2, 'minor']);
    // E♭ major: Eb Ab Bb Eb Cm Ab Bb Eb
    const eFlatMajor = keyOf([[51, 55, 58], [56, 60, 63], [58, 62, 65], [51, 55, 58], [48, 51, 55], [56, 60, 63], [58, 62, 65], [51, 55, 58]]);
    assert.deepEqual([eFlatMajor.root, eFlatMajor.mode], [3, 'major']);
});

test('notes are spelled with flats in flat keys and sharps otherwise', () => {
    assert.equal(keyName({root: 10, type: 'major'}), 'B♭ major');
    assert.equal(keyName({root: 4, type: 'minor'}), 'E minor');
    assert.equal(keyName({root: 6, type: 'major'}), 'G♭ major');
    assert.equal(keyName({root: 9, type: 'dorian'}), 'A dorian');
    assert.equal(pitchClassNames({root: 2, type: 'minor'})[10], 'B♭', 'D minor is written with B♭');
    assert.equal(pitchClassNames({root: 7, type: 'major'})[6], 'F♯');
    assert.equal(pitchClassNames(null)[1], 'C♯', 'sharps without a key');
    assert.equal(noteLabel(60, pitchClassNames(null)), 'C4');
    assert.equal(noteLabel(70, pitchClassNames({root: 5, type: 'major'})), 'B♭4');
    assert.equal(noteLabel(47, pitchClassNames(null)), 'B2');
    assert.deepEqual([...scalePitchClasses({root: 7, type: 'major'})].sort((a, b) => a - b), [0, 2, 4, 6, 7, 9, 11]);
    assert.deepEqual([...scalePitchClasses({root: 9, type: 'minor-pentatonic'})].sort((a, b) => a - b), [0, 2, 4, 7, 9]);
    assert.throws(() => keyName({root: 0, type: 'whole-tone'}), /no scale type/u);
});
