// Pure music-theory, word-to-note alignment, and rough sheet-music layout
// engine. Free of GNOME, Cairo, and Node dependencies so service/, desktop/,
// settings-page/, and node tests run the exact same code.

import {keyName, noteLabel, pitchClassNames, SCALES, scalePitchClasses} from './scales.js';

// C4 (middle C) is diatonic step 28 (4 * 7 + 0).
// Standard treble staff 5 lines: E4(30), G4(32), B4(34), D5(36), F5(38).
export const MIDDLE_STAFF_STEP = 34; // B4
export const STAFF_BOTTOM_STEP = 30; // E4
export const STAFF_TOP_STEP = 38; // F5
export const OCTAVE_CLEF_MEDIAN_MIDI = 63; // Eb4; below this use vocal tenor/baritone treble-8vb clef

const NATURAL_PC = [0, 2, 4, 5, 7, 9, 11]; // C D E F G A B
const LETTER_NAMES = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const SHARP_ORDER_LETTERS = [3, 0, 4, 1, 5, 2, 6]; // F C G D A E B
const SHARP_ORDER_STEPS = [38, 35, 39, 36, 33, 37, 34]; // F5 C5 G5 D5 A4 E5 B4
const FLAT_ORDER_LETTERS = [6, 2, 5, 1, 4, 0, 3]; // B E A D G C F
const FLAT_ORDER_STEPS = [34, 37, 33, 36, 32, 35, 31]; // B4 E5 A4 D5 G4 C5 F4

// Parent major pitch class -> circle-of-fifths count (-6 flats .. +5 sharps),
// matching FLAT_MAJOR_ROOTS in shared/scales.js (F, Bb, Eb, Ab, Db, Gb).
const PARENT_MAJOR_FIFTHS = [0, -5, 2, -3, 4, -1, -6, 1, -4, 3, -2, 5];

// Standard single-notehead rhythmic figures (in quarter-note beats).
const RHYTHM_FIGURES = [
    {beats: 4.0, figure: 'whole', dots: 0, flags: 0, hollow: true, stem: false, triplet: false},
    {beats: 3.0, figure: 'half', dots: 1, flags: 0, hollow: true, stem: true, triplet: false},
    {beats: 2.0, figure: 'half', dots: 0, flags: 0, hollow: true, stem: true, triplet: false},
    {beats: 1.5, figure: 'quarter', dots: 1, flags: 0, hollow: false, stem: true, triplet: false},
    {beats: 1.0, figure: 'quarter', dots: 0, flags: 0, hollow: false, stem: true, triplet: false},
    {beats: 0.75, figure: 'eighth', dots: 1, flags: 1, hollow: false, stem: true, triplet: false},
    {beats: 0.5, figure: 'eighth', dots: 0, flags: 1, hollow: false, stem: true, triplet: false},
    {beats: 1 / 3, figure: 'eighth', dots: 0, flags: 1, hollow: false, stem: true, triplet: true},
    {beats: 0.25, figure: 'sixteenth', dots: 0, flags: 2, hollow: false, stem: true, triplet: false},
];

const REST_FIGURES = [
    {beats: 4.0, figure: 'whole', dots: 0},
    {beats: 2.0, figure: 'half', dots: 0},
    {beats: 1.5, figure: 'quarter', dots: 1},
    {beats: 1.0, figure: 'quarter', dots: 0},
    {beats: 0.5, figure: 'eighth', dots: 0},
];

const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;
const utf8 = new TextEncoder();

function normalizeWordToken(text) {
    return String(text ?? '')
        .normalize('NFKD')
        .replace(/\p{M}+/gu, '')
        .toLowerCase()
        .replace(/['\u2019`]/gu, '')
        .replace(/[^\p{L}\p{N}]/gu, '');
}

/**
 * Computes the treble-clef key signature for `{root, type}` (or null for C major / no key).
 * @param {{root: number, type: string}|null} key
 */
export function keySignatureFor(key) {
    const defaultAlter = [0, 0, 0, 0, 0, 0, 0];
    if (!key || !(key.type in SCALES)) {
        return {fifths: 0, accidentals: [], defaultAlter, parentMajor: 0};
    }
    const parentMajor = ((key.root + SCALES[key.type].parentMajor) % 12 + 12) % 12;
    const fifths = PARENT_MAJOR_FIFTHS[parentMajor];
    const accidentals = [];
    if (fifths > 0) {
        for (let i = 0; i < fifths; i++) {
            const letter = SHARP_ORDER_LETTERS[i];
            defaultAlter[letter] = 1;
            accidentals.push({letter, step: SHARP_ORDER_STEPS[i], kind: 'sharp'});
        }
    } else if (fifths < 0) {
        for (let i = 0; i < -fifths; i++) {
            const letter = FLAT_ORDER_LETTERS[i];
            defaultAlter[letter] = -1;
            accidentals.push({letter, step: FLAT_ORDER_STEPS[i], kind: 'flat'});
        }
    }
    return {fifths, accidentals, defaultAlter, parentMajor};
}

/**
 * Chooses treble vs treble-8vb (vocal tenor/baritone octave clef).
 * When note pitches are provided, minimizes weighted ledger-line excursion
 * (heavily penalizing low notes <= C4 that create crowded ledger lines below
 * the staff) with a mild preference for standard treble when both fit cleanly.
 */
export function chooseClef(medianMidi, notes = null) {
    if (Array.isArray(notes) && notes.length) {
        const penalty = (writtenMidi) => {
            if (writtenMidi < 64) {
                const low = 64 - writtenMidi;
                return low <= 4 ? low * 1.2 : 4.8 + (low - 4) * 3.0;
            }
            if (writtenMidi > 77) {
                const high = writtenMidi - 77;
                return high <= 4 ? high * 0.9 : 3.6 + (high - 4) * 2.2;
            }
            return 0;
        };
        let totalW = 0;
        let trebleCost = 0;
        let octCost = 0;
        for (const n of notes) {
            const p = Number(n?.pitch ?? n?.midi);
            if (!Number.isFinite(p))
                continue;
            const w = Math.max(0.25, Number(n.durBeats) || ((Number(n.end) - Number(n.start)) || 0.5));
            totalW += w;
            trebleCost += w * penalty(p);
            octCost += w * penalty(p + 12);
        }
        if (totalW > 0) {
            // Mild 0.35 bias keeps standard treble when both clefs fit comfortably.
            if (octCost / totalW + 0.35 < trebleCost / totalW)
                return {clef: 'treble-8vb', octaveShift: 1};
            return {clef: 'treble', octaveShift: 0};
        }
    }
    if (Number.isFinite(medianMidi) && medianMidi < OCTAVE_CLEF_MEDIAN_MIDI)
        return {clef: 'treble-8vb', octaveShift: 1};
    return {clef: 'treble', octaveShift: 0};
}

/**
 * Snaps a continuous MIDI pitch into a discrete semitone with optional scale bias.
 * - `'off'`: pure chromatic rounding.
 * - `'soft'`: pulls borderline scoops/bends into the active scale while keeping
 *   clearly held chromatic/blue notes honest with explicit accidentals.
 * - `'strict'`: locks every note to the nearest pitch in the active scale.
 * @param {number} continuousPitch
 * @param {number} durBeats
 * @param {{root: number, type: string}|null} key
 * @param {'soft'|'strict'|'off'} mode
 */
export function snapPitchToScale(continuousPitch, durBeats, key, mode = 'soft') {
    const nearest = Math.round(continuousPitch);
    if (!key || mode === 'off' || !(key.type in SCALES))
        return nearest;
    const pcs = scalePitchClasses(key);
    const nearestPc = ((nearest % 12) + 12) % 12;
    if (pcs.has(nearestPc))
        return nearest;

    let bestMidi = nearest;
    let bestDist = Infinity;
    const maxDelta = mode === 'strict' ? 4 : 1;
    for (let delta = -maxDelta; delta <= maxDelta; delta++) {
        const cand = nearest + delta;
        const pc = ((cand % 12) + 12) % 12;
        if (!pcs.has(pc))
            continue;
        const dist = Math.abs(cand - continuousPitch);
        if (dist < bestDist) {
            bestDist = dist;
            bestMidi = cand;
        }
    }
    if (mode === 'strict')
        return bestMidi;
    const threshold = durBeats < 0.35 ? 0.78 : 0.62;
    return bestDist <= threshold ? bestMidi : nearest;
}

/**
 * Spells a sounding MIDI note as a diatonic letter + octave + alteration
 * consistent with `keySig`, plus its written staff step under `octaveShift`.
 */
export function spellMidi(midi, keySig, octaveShift = 0) {
    const pc = ((midi % 12) + 12) % 12;
    const {defaultAlter, fifths} = keySig;

    // 1. Check whether any diatonic letter in the active key signature matches `pc`.
    let chosenLetter = -1;
    let chosenAlter = 0;
    for (let letter = 0; letter < 7; letter++) {
        const alt = defaultAlter[letter];
        if (((NATURAL_PC[letter] + alt) % 12 + 12) % 12 === pc) {
            chosenLetter = letter;
            chosenAlter = alt;
            break;
        }
    }

    // 2. Chromatic pitch outside the key signature: spell with flats in flat keys,
    // sharps otherwise (matching shared/scales.js), preferring naturals when pc is natural.
    if (chosenLetter < 0) {
        const natLetter = NATURAL_PC.indexOf(pc);
        if (natLetter >= 0) {
            chosenLetter = natLetter;
            chosenAlter = 0;
        } else if (fifths < 0) {
            // Flat spelling: next natural letter lowered by 1 semitone.
            const upperPc = (pc + 1) % 12;
            chosenLetter = NATURAL_PC.indexOf(upperPc);
            chosenAlter = -1;
        } else {
            // Sharp spelling: previous natural letter raised by 1 semitone.
            const lowerPc = (pc + 11) % 12;
            chosenLetter = NATURAL_PC.indexOf(lowerPc);
            chosenAlter = 1;
        }
    }

    // Compute sounding octave accounting for enharmonic C-flat / B-sharp boundary.
    const soundingNaturalMidi = midi - chosenAlter;
    const octave = Math.floor(soundingNaturalMidi / 12) - 1;
    const writtenStep = (octave + octaveShift) * 7 + chosenLetter;
    const alterSymbol = chosenAlter === 1 ? '\u266f' : chosenAlter === -1 ? '\u266d' : '';
    return {
        midi,
        letter: chosenLetter,
        octave,
        alter: chosenAlter,
        writtenStep,
        noteName: `${LETTER_NAMES[chosenLetter]}${alterSymbol}${octave}`,
    };
}

/** Computes the scale degree label ("1".."7", or "♯4"/"♭7" for chromatic notes). */
export function scaleDegreeLabel(midi, key) {
    if (!key || !(key.type in SCALES))
        return '';
    const rel = (((midi - key.root) % 12) + 12) % 12;
    const steps = SCALES[key.type].steps;
    const exactIdx = steps.indexOf(rel);
    if (exactIdx >= 0)
        return String(exactIdx + 1);
    // Chromatic note: name relative to adjacent major degree.
    const flatNames = ['1', '\u266d2', '2', '\u266d3', '3', '4', '\u266d5', '5', '\u266d6', '6', '\u266d7', '7'];
    const sharpNames = ['1', '\u266f1', '2', '\u266f2', '3', '4', '\u266f4', '5', '\u266f5', '6', '\u266f6', '7'];
    const names = keySignatureFor(key).fifths < 0 ? flatNames : sharpNames;
    return names[rel];
}

/**
 * Computes a diatonic 3rd harmony note above (`direction = +1`) or below (`direction = -1`)
 * `midi` within `key`. Returns null when no key is active.
 */
export function computeHarmonyMidi(midi, key, direction) {
    if (!key || !(key.type in SCALES))
        return null;
    const steps = SCALES[key.type].steps;
    const baseOctave = Math.floor((midi - key.root) / 12);
    const scaleMidis = [];
    for (let oct = baseOctave - 2; oct <= baseOctave + 2; oct++) {
        for (const step of steps)
            scaleMidis.push(key.root + oct * 12 + step);
    }
    // Locate nearest scale pitch to `midi`.
    let nearestIdx = 0;
    let bestDist = Infinity;
    for (let i = 0; i < scaleMidis.length; i++) {
        const d = Math.abs(scaleMidis[i] - midi);
        if (d < bestDist) {
            bestDist = d;
            nearestIdx = i;
        }
    }
    if (steps.length >= 7) {
        const targetIdx = nearestIdx + 2 * direction;
        return scaleMidis[targetIdx] ?? null;
    }
    // Pentatonic / hexatonic scales: pick the scale tone closest to a 3rd (~3.5 semitones away).
    const ideal = midi + 3.5 * direction;
    let best = null;
    let bestErr = Infinity;
    for (const cand of scaleMidis) {
        if ((direction > 0 && cand <= midi) || (direction < 0 && cand >= midi))
            continue;
        const err = Math.abs(cand - ideal);
        if (err < bestErr) {
            bestErr = err;
            best = cand;
        }
    }
    return best;
}

/**
 * Decomposes a beat duration into 1 or 2 standard notation figures (tied when split).
 * Keeps rough vocal sheet music clean and sight-readable.
 */
export function decomposeRhythm(durBeats, allowTriplet = false) {
    const clamped = Math.max(0.25, Math.min(6.0, Number.isFinite(durBeats) ? durBeats : 0.5));
    const candidates = allowTriplet
        ? RHYTHM_FIGURES
        : RHYTHM_FIGURES.filter(fig => !fig.triplet);

    let bestSingle = candidates[0];
    let bestErr = Infinity;
    for (const fig of candidates) {
        const err = Math.abs(fig.beats - clamped);
        if (err < bestErr) {
            bestErr = err;
            bestSingle = fig;
        }
    }
    // Single figure is close enough (within ~18% or 0.18 beats).
    if (bestErr <= Math.max(0.16, clamped * 0.16))
        return [{...bestSingle}];

    // Try a clean 2-note tied pair (e.g. 2.5 = half + eighth, 3.5 = half + dotted quarter).
    let bestPair = null;
    let bestPairErr = bestErr;
    for (const a of candidates) {
        if (a.triplet || a.beats >= clamped)
            continue;
        for (const b of candidates) {
            if (b.triplet || b.beats > a.beats)
                continue;
            const err = Math.abs(a.beats + b.beats - clamped);
            if (err + 0.04 < bestPairErr) {
                bestPairErr = err;
                bestPair = [{...a}, {...b}];
            }
        }
    }
    return bestPair ?? [{...bestSingle}];
}

function chooseRestFigure(gapBeats) {
    if (!Number.isFinite(gapBeats) || gapBeats < 0.45)
        return null;
    let best = REST_FIGURES[REST_FIGURES.length - 1];
    let bestErr = Infinity;
    for (const fig of REST_FIGURES) {
        const err = Math.abs(fig.beats - gapBeats);
        if (err < bestErr) {
            bestErr = err;
            best = fig;
        }
    }
    return {...best};
}

/**
 * Splits a displayed lyric string into visual word spans with exact UTF-8 byte
 * offsets suitable for `Pango.Layout.index_to_pos()`.
 * Preserves an optional leading countdown prefix (e.g. "3 ") outside word spans.
 */
export function parseDisplayWords(displayText, rawLineText = displayText) {
    const full = String(displayText ?? '');
    const raw = String(rawLineText ?? full);
    let prefixBytes = 0;
    let lyricBody = full;
    if (raw && full !== raw && full.endsWith(raw)) {
        const prefix = full.slice(0, full.length - raw.length);
        prefixBytes = utf8.encode(prefix).length;
        lyricBody = raw;
    }

    const words = [];
    let bytePos = prefixBytes;
    const chars = [...lyricBody];
    let i = 0;

    while (i < chars.length) {
        if (/\s/u.test(chars[i])) {
            bytePos += utf8.encode(chars[i]).length;
            i++;
            continue;
        }
        if (CJK_CHAR.test(chars[i])) {
            // Each CJK character/kana mora acts as an individual musical syllable anchor.
            const ch = chars[i];
            const byteLen = utf8.encode(ch).length;
            const norm = normalizeWordToken(ch);
            words.push({
                index: words.length,
                text: ch,
                norm,
                weight: 1,
                byteStart: bytePos,
                byteEnd: bytePos + byteLen,
                lastCharByte: bytePos,
            });
            bytePos += byteLen;
            i++;
            continue;
        }
        // Contiguous non-whitespace, non-CJK word (Latin, Cyrillic, punctuation attached).
        const startByte = bytePos;
        let lastCharByte = bytePos;
        let wordText = '';
        while (i < chars.length && !/\s/u.test(chars[i]) && !CJK_CHAR.test(chars[i])) {
            const ch = chars[i];
            const byteLen = utf8.encode(ch).length;
            lastCharByte = bytePos;
            wordText += ch;
            bytePos += byteLen;
            i++;
        }
        const norm = normalizeWordToken(wordText);
        // Approximate vowel-group syllable weight for fallback time interpolation.
        const syllables = Math.max(1, (norm.match(/[aeiouy]+/gu) ?? []).length);
        words.push({
            index: words.length,
            text: wordText,
            norm,
            weight: syllables,
            byteStart: startByte,
            byteEnd: bytePos,
            lastCharByte,
        });
    }
    return words;
}

function tokenSimilarity(a, b) {
    if (!a || !b)
        return 0;
    if (a === b)
        return 1.0;
    if (a.length >= 3 && b.length >= 3 && (a.startsWith(b) || b.startsWith(a)))
        return 0.8;
    // Fast bounded Levenshtein ratio for short words.
    const m = a.length;
    const n = b.length;
    if (Math.abs(m - n) > Math.max(m, n) * 0.5)
        return 0;
    const prev = new Int32Array(n + 1);
    const curr = new Int32Array(n + 1);
    for (let j = 0; j <= n; j++)
        prev[j] = j;
    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
        }
        prev.set(curr);
    }
    const ratio = 1 - prev[n] / Math.max(m, n);
    return ratio >= 0.62 ? ratio : 0;
}

/**
 * Maps each display word in a lyric line to an audio time span `[start, end]`
 * using monotone DP against Whisper's timed words from the isolated lead vocal,
 * with smooth syllable-weighted interpolation for any unmatched words.
 */
export function alignDisplayWordsToAudio(displayWords, scoreWords, lineStart, lineEnd) {
    const n = displayWords.length;
    if (!n)
        return [];
    const safeStart = Number.isFinite(lineStart) ? lineStart : 0;
    const safeEnd = Number.isFinite(lineEnd) && lineEnd > safeStart ? lineEnd : safeStart + 4;

    // Expand Whisper words into normalized tokens (splitting CJK characters individually).
    const audioTokens = [];
    for (const w of Array.isArray(scoreWords) ? scoreWords : []) {
        const ws = Number(w.start);
        const we = Number(w.end);
        if (!Number.isFinite(ws) || !Number.isFinite(we))
            continue;
        if (we < safeStart - 1.5 || ws > safeEnd + 1.5)
            continue;
        const raw = String(w.word ?? '').trim();
        if (!raw)
            continue;
        const cjkChars = [...raw].filter(ch => CJK_CHAR.test(ch));
        if (cjkChars.length && cjkChars.length === [...raw].filter(ch => !/\s/u.test(ch)).length) {
            const dur = Math.max(0.04, we - ws) / cjkChars.length;
            for (let k = 0; k < cjkChars.length; k++) {
                audioTokens.push({
                    norm: normalizeWordToken(cjkChars[k]),
                    start: ws + k * dur,
                    end: ws + (k + 1) * dur,
                });
            }
        } else {
            const norm = normalizeWordToken(raw);
            if (norm)
                audioTokens.push({norm, start: ws, end: Math.max(ws + 0.04, we)});
        }
    }

    const matched = new Array(n).fill(null);
    const m = audioTokens.length;
    if (m > 0) {
        // Semi-global monotone DP: free skip in audioTokens, small gap penalty in displayWords.
        const NEG = -1e9;
        const dp = Array.from({length: n + 1}, () => new Float64Array(m + 1).fill(NEG));
        const back = Array.from({length: n + 1}, () => new Uint8Array(m + 1)); // 1=diag, 2=up(skip display), 3=left(skip audio)
        for (let j = 0; j <= m; j++)
            dp[0][j] = 0;
        for (let i = 1; i <= n; i++) {
            dp[i][0] = -0.35 * i;
            back[i][0] = 2;
        }
        for (let i = 1; i <= n; i++) {
            const dw = displayWords[i - 1];
            const expectedFrac = (i - 0.5) / n;
            const expectedTime = safeStart + expectedFrac * (safeEnd - safeStart);
            for (let j = 1; j <= m; j++) {
                const aw = audioTokens[j - 1];
                const sim = tokenSimilarity(dw.norm, aw.norm);
                // Mild time proximity tie-breaker so repeated chorus words prefer the line's time window.
                const mid = (aw.start + aw.end) / 2;
                const timePenalty = Math.min(0.45, Math.abs(mid - expectedTime) * 0.08);
                let best = dp[i][j - 1]; // skip audio token (free)
                let dir = 3;
                const up = dp[i - 1][j] - 0.35; // skip display word
                if (up > best) {
                    best = up;
                    dir = 2;
                }
                if (sim > 0) {
                    const diag = dp[i - 1][j - 1] + sim * 2.0 - timePenalty;
                    if (diag > best) {
                        best = diag;
                        dir = 1;
                    }
                }
                dp[i][j] = best;
                back[i][j] = dir;
            }
        }
        let bestJ = 0;
        for (let j = 1; j <= m; j++) {
            if (dp[n][j] > dp[n][bestJ])
                bestJ = j;
        }
        let i = n;
        let j = bestJ;
        while (i > 0 && j > 0) {
            const dir = back[i][j];
            if (dir === 1) {
                matched[i - 1] = {start: audioTokens[j - 1].start, end: audioTokens[j - 1].end, matched: true};
                i--;
                j--;
            } else if (dir === 2) {
                i--;
            } else {
                j--;
            }
        }
    }

    // Interpolate any unmatched words smoothly between matched anchors (or line bounds).
    const result = displayWords.map((w, idx) => ({
        ...w,
        start: matched[idx]?.start ?? null,
        end: matched[idx]?.end ?? null,
        matched: Boolean(matched[idx]),
    }));

    let pos = 0;
    while (pos < n) {
        if (result[pos].start !== null) {
            pos++;
            continue;
        }
        const runStart = pos;
        while (pos < n && result[pos].start === null)
            pos++;
        const runEnd = pos;
        const leftTime = runStart > 0 ? result[runStart - 1].end : safeStart;
        const rightTime = runEnd < n ? result[runEnd].start : safeEnd;
        const span = Math.max(0.08 * (runEnd - runStart), rightTime - leftTime);
        let totalWeight = 0;
        for (let k = runStart; k < runEnd; k++)
            totalWeight += result[k].weight;
        let cursor = leftTime;
        for (let k = runStart; k < runEnd; k++) {
            const dur = span * (result[k].weight / Math.max(1, totalWeight));
            result[k].start = cursor;
            result[k].end = cursor + dur;
            cursor += dur;
        }
    }

    return result;
}

/**
 * Builds the rough sheet music model for one active lyric line from the song's
 * cached vocal score.
 *
 * @param {{
 *   displayText: string,
 *   rawLineText?: string,
 *   lineStart: number,
 *   lineEnd: number,
 *   prevLineEnd?: number|null,
 *   nextLineStart?: number|null,
 *   score: {
 *     bpm?: number,
 *     meter?: [number, number],
 *     key?: {root: number, type: string}|null,
 *     medianMidi?: number,
 *     notes?: Array<{start: number, end: number, pitch: number, beat?: number, durBeats?: number, bar?: number, triplet?: boolean}>,
 *     words?: Array<{start: number, end: number, word: string}>,
 *   },
 *   overrideKey?: {root: number, type: string}|null,
 *   scaleSnap?: 'soft'|'strict'|'off',
 *   harmony?: 'off'|'above'|'below'|'both',
 * }} input
 */
export function buildLineScore({
    displayText,
    rawLineText = displayText,
    lineStart,
    lineEnd,
    prevLineEnd = null,
    nextLineStart = null,
    score,
    overrideKey = undefined,
    scaleSnap = 'soft',
    harmony = 'off',
}) {
    if (!score || !Array.isArray(score.notes) || !score.notes.length)
        return null;

    const key = overrideKey !== undefined ? overrideKey : (score.key ?? null);
    const keySig = keySignatureFor(key);
    const {clef, octaveShift} = chooseClef(score.medianMidi, score.notes);
    const bpm = Math.max(30, Math.min(260, Number(score.bpm) || 120));
    const meter = Array.isArray(score.meter) && score.meter.length === 2 ? score.meter : [4, 4];

    const displayWords = parseDisplayWords(displayText, rawLineText);
    const timedWords = alignDisplayWordsToAudio(displayWords, score.words ?? [], lineStart, lineEnd);

    // Narrow note selection window cleanly so adjacent lines never duplicate notes.
    const firstWordStart = timedWords.length ? timedWords[0].start : lineStart;
    const lastWordEnd = timedWords.length ? timedWords[timedWords.length - 1].end : lineEnd;
    const rawWinStart = Math.min(lineStart, firstWordStart) - 0.14;
    const rawWinEnd = Math.max(lineEnd, lastWordEnd) + 0.14;
    const winStart = Number.isFinite(prevLineEnd) ? Math.max(rawWinStart, prevLineEnd) : rawWinStart;
    const winEnd = Number.isFinite(nextLineStart) ? Math.min(rawWinEnd, nextLineStart) : rawWinEnd;

    const rawNotes = score.notes.filter(note => {
        const mid = (note.start + note.end) / 2;
        return mid >= winStart && mid < winEnd;
    });

    if (!rawNotes.length) {
        return {
            clef,
            octaveShift,
            key,
            keyLabel: key ? keyName(key) : '',
            keySig,
            bpm: Math.round(bpm),
            meter,
            lineStart,
            lineEnd,
            words: timedWords.map(w => ({
                index: w.index,
                text: w.text,
                byteStart: w.byteStart,
                byteEnd: w.byteEnd,
                lastCharByte: w.lastCharByte,
                start: w.start,
                end: w.end,
            })),
            items: [],
        };
    }

    // Assign each raw note monotonically to its best-matching display word.
    const assigned = [];
    let minWordIdx = 0;
    for (const note of rawNotes) {
        let wordIndex = 0;
        if (timedWords.length) {
            let bestIdx = minWordIdx;
            let bestScore = -Infinity;
            const noteMid = (note.start + note.end) / 2;
            for (let wi = minWordIdx; wi < timedWords.length; wi++) {
                const w = timedWords[wi];
                const overlap = Math.max(0, Math.min(note.end, w.end) - Math.max(note.start, w.start));
                const wordMid = (w.start + w.end) / 2;
                const dist = Math.abs(noteMid - wordMid);
                // Prefer actual overlap; otherwise nearest word with slight forward resistance.
                const scoreVal = overlap > 0
                    ? 10 + overlap / Math.max(0.05, note.end - note.start) - (wi - minWordIdx) * 0.05
                    : -dist - (wi - minWordIdx) * 0.08;
                if (scoreVal > bestScore) {
                    bestScore = scoreVal;
                    bestIdx = wi;
                }
            }
            wordIndex = bestIdx;
            minWordIdx = bestIdx;
        }
        assigned.push({note, wordIndex});
    }

    // Build engraving items: barlines, rests, tied noteheads, accidentals, harmony thirds.
    const items = [];
    const barAlter = new Map();
    const secPerBeat = 60 / bpm;
    let prevBar = assigned[0].note.bar ?? null;
    let prevEnd = null;
    let noteId = 0;

    for (let idx = 0; idx < assigned.length; idx++) {
        const {note, wordIndex} = assigned[idx];
        const bar = Number.isInteger(note.bar) ? note.bar : prevBar;

        // Rest for clear pause between consecutive sung notes.
        if (prevEnd !== null) {
            const gapSec = note.start - prevEnd;
            const gapBeats = gapSec / secPerBeat;
            const rest = chooseRestFigure(gapBeats);
            if (rest) {
                items.push({
                    kind: 'rest',
                    wordIndex,
                    start: prevEnd,
                    end: note.start,
                    figure: rest.figure,
                    dots: rest.dots,
                    beats: rest.beats,
                });
            }
        }

        // Barline when crossing into a new measure.
        if (prevBar !== null && bar !== null && bar > prevBar) {
            items.push({kind: 'barline', bar, wordIndex});
            barAlter.clear();
        }
        prevBar = bar;

        const durBeats = Number.isFinite(note.durBeats) && note.durBeats > 0
            ? note.durBeats
            : Math.max(0.25, (note.end - note.start) / secPerBeat);
        const snappedMidi = snapPitchToScale(note.pitch, durBeats, key, scaleSnap);
        const spelled = spellMidi(snappedMidi, keySig, octaveShift);

        const alterKey = `${spelled.octave}:${spelled.letter}`;
        const activeAlter = barAlter.has(alterKey) ? barAlter.get(alterKey) : keySig.defaultAlter[spelled.letter];
        let accidental = null;
        if (spelled.alter !== activeAlter) {
            accidental = spelled.alter === 1 ? 'sharp' : spelled.alter === -1 ? 'flat' : 'natural';
            barAlter.set(alterKey, spelled.alter);
        }

        const figures = decomposeRhythm(durBeats, Boolean(note.triplet));
        const totalFigBeats = figures.reduce((sum, f) => sum + f.beats, 0);
        const noteSpanSec = Math.max(0.05, note.end - note.start);

        let harmonyAbove = null;
        let harmonyBelow = null;
        if (key && (harmony === 'above' || harmony === 'both')) {
            const hm = computeHarmonyMidi(snappedMidi, key, +1);
            if (hm !== null) {
                const hs = spellMidi(hm, keySig, octaveShift);
                harmonyAbove = {
                    midi: hm,
                    writtenStep: hs.writtenStep,
                    noteName: hs.noteName,
                    accidental: hs.alter !== keySig.defaultAlter[hs.letter]
                        ? (hs.alter === 1 ? 'sharp' : hs.alter === -1 ? 'flat' : 'natural')
                        : null,
                };
            }
        }
        if (key && (harmony === 'below' || harmony === 'both')) {
            const hm = computeHarmonyMidi(snappedMidi, key, -1);
            if (hm !== null) {
                const hs = spellMidi(hm, keySig, octaveShift);
                harmonyBelow = {
                    midi: hm,
                    writtenStep: hs.writtenStep,
                    noteName: hs.noteName,
                    accidental: hs.alter !== keySig.defaultAlter[hs.letter]
                        ? (hs.alter === 1 ? 'sharp' : hs.alter === -1 ? 'flat' : 'natural')
                        : null,
                };
            }
        }

        let tCursor = note.start;
        for (let fIdx = 0; fIdx < figures.length; fIdx++) {
            const fig = figures[fIdx];
            const segDur = noteSpanSec * (fig.beats / totalFigBeats);
            const segStart = tCursor;
            const segEnd = fIdx === figures.length - 1 ? note.end : tCursor + segDur;
            tCursor = segEnd;
            items.push({
                kind: 'note',
                id: noteId++,
                wordIndex,
                start: segStart,
                end: segEnd,
                midi: snappedMidi,
                writtenStep: spelled.writtenStep,
                accidental: fIdx === 0 ? accidental : null,
                noteName: spelled.noteName,
                degree: scaleDegreeLabel(snappedMidi, key),
                figure: fig.figure,
                dots: fig.dots,
                flags: fig.flags,
                hollow: fig.hollow,
                stem: fig.stem,
                stemDir: spelled.writtenStep >= MIDDLE_STAFF_STEP ? -1 : 1,
                triplet: fig.triplet,
                beats: fig.beats,
                tieFromPrev: fIdx > 0,
                tieToNext: fIdx < figures.length - 1,
                beamGroup: null,
                slurStart: false,
                slurEnd: false,
                harmonyAbove,
                harmonyBelow,
            });
        }
        prevEnd = note.end;
    }

    // Group adjacent eighth/16th notes into readable beams (broken at rests, barlines, or every 4 notes).
    let beamGroupId = 0;
    let run = [];
    const flushBeam = () => {
        if (run.length >= 2) {
            const gid = beamGroupId++;
            // Stem direction for the whole beam group follows the note farthest from middle line.
            let maxDist = -1;
            let groupDir = 1;
            for (const item of run) {
                const dist = Math.abs(item.writtenStep - MIDDLE_STAFF_STEP);
                if (dist > maxDist) {
                    maxDist = dist;
                    groupDir = item.writtenStep >= MIDDLE_STAFF_STEP ? -1 : 1;
                }
            }
            for (const item of run) {
                item.beamGroup = gid;
                item.stemDir = groupDir;
            }
        }
        run = [];
    };
    for (const item of items) {
        if (item.kind === 'note' && item.flags >= 1) {
            run.push(item);
            if (run.length >= 4)
                flushBeam();
        } else {
            flushBeam();
        }
    }
    flushBeam();

    // Mark melisma slurs where 2+ distinct notes (not just tied pairs) fall on the same word.
    let melisma = [];
    const flushMelisma = () => {
        const distinctPitches = new Set(melisma.map(n => n.midi));
        if (melisma.length >= 2 && distinctPitches.size >= 2) {
            melisma[0].slurStart = true;
            melisma[melisma.length - 1].slurEnd = true;
        }
        melisma = [];
    };
    for (const item of items) {
        if (item.kind === 'barline')
            continue;
        if (item.kind !== 'note') {
            flushMelisma();
            continue;
        }
        if (melisma.length && melisma[0].wordIndex !== item.wordIndex)
            flushMelisma();
        melisma.push(item);
    }
    flushMelisma();

    return {
        clef,
        octaveShift,
        key,
        keyLabel: key ? keyName(key) : '',
        keySig,
        bpm: Math.round(bpm),
        meter,
        lineStart,
        lineEnd,
        words: timedWords.map(w => ({
            index: w.index,
            text: w.text,
            byteStart: w.byteStart,
            byteEnd: w.byteEnd,
            lastCharByte: w.lastCharByte,
            start: w.start,
            end: w.end,
        })),
        items,
    };
}

/**
 * Returns the id of the currently sounding note at `mediaTime` (or null).
 * Uses a tiny 0.04 s lookahead so visual highlight feels locked to the beat.
 */
export function activeNoteIdAt(lineScore, mediaTime) {
    if (!lineScore || !Array.isArray(lineScore.items) || !Number.isFinite(mediaTime))
        return null;
    const t = mediaTime + 0.04;
    for (const item of lineScore.items) {
        if (item.kind === 'note' && t >= item.start && t <= item.end)
            return item.id;
    }
    return null;
}

/**
 * Sample score for the Settings page live preview ("Amazing grace, how sweet the sound" in G major).
 */
export function sampleScoreForPreview() {
    // Classic Amazing Grace opening phrase in G major (3/4, 72 BPM):
    // A-(D4) ma-(G4 half) zing(B4-G4) grace,(B4 half) how(A4) sweet(G4 half) the(E4) sound(D4 half)
    return {
        bpm: 72,
        meter: [3, 4],
        key: {root: 7, type: 'major', margin: 0.25},
        medianMidi: 67,
        words: [
            {start: 0.0, end: 1.8, word: 'Amazing'},
            {start: 1.8, end: 3.1, word: 'grace'},
            {start: 3.1, end: 3.8, word: 'how'},
            {start: 3.8, end: 5.0, word: 'sweet'},
            {start: 5.0, end: 5.7, word: 'the'},
            {start: 5.7, end: 7.2, word: 'sound'},
        ],
        notes: [
            {id: 1, start: 0.0, end: 0.65, pitch: 62.0, durBeats: 1.0, bar: 0},
            {id: 2, start: 0.65, end: 1.5, pitch: 67.0, durBeats: 2.0, bar: 1},
            {id: 3, start: 1.5, end: 1.68, pitch: 71.0, durBeats: 0.5, bar: 1},
            {id: 4, start: 1.68, end: 1.85, pitch: 67.0, durBeats: 0.5, bar: 1},
            {id: 5, start: 1.85, end: 3.1, pitch: 71.0, durBeats: 2.0, bar: 2},
            {id: 6, start: 3.1, end: 3.8, pitch: 69.0, durBeats: 1.0, bar: 2},
            {id: 7, start: 3.8, end: 5.0, pitch: 67.0, durBeats: 2.0, bar: 3},
            {id: 8, start: 5.0, end: 5.7, pitch: 64.0, durBeats: 1.0, bar: 3},
            {id: 9, start: 5.7, end: 7.2, pitch: 62.0, durBeats: 2.0, bar: 4},
        ],
        chords: [
            {bar: 1, beatInBar: 0, start: 0.65, end: 3.8, symbol: 'G'},
            {bar: 3, beatInBar: 0, start: 3.8, end: 5.7, symbol: 'C'},
            {bar: 4, beatInBar: 0, start: 5.7, end: 7.2, symbol: 'G'},
        ],
    };
}

// ---------------------------------------------------------------------------
// Measure-based Piano Lead Sheet engine (full song -> numbered bars -> systems)
// ---------------------------------------------------------------------------

function barBeatsForMeter(meter) {
    const num = Math.max(2, Math.min(12, Math.round(Number(meter?.[0]) || 4)));
    const den = Number(meter?.[1]) === 8 ? 8 : 4;
    // Quarter-note beats per measure (e.g. 4/4 -> 4, 3/4 -> 3, 2/4 -> 2, 6/8 -> 3).
    return den === 8 ? num * 0.5 : num;
}

function quantizeGrid(v, step = 0.25) {
    return Math.round(v / step) * step;
}

function splitLyricTokens(text) {
    const cleaned = String(text ?? '').trim();
    if (!cleaned)
        return [];
    if (CJK_CHAR.test(cleaned) && !/\s/u.test(cleaned)) {
        const chars = [...cleaned].filter(ch => !/^[\p{P}\p{S}]$/u.test(ch));
        const chunks = [];
        for (let i = 0; i < chars.length; i += 2)
            chunks.push(chars.slice(i, i + 2).join(''));
        return chunks;
    }
    return cleaned.split(/\s+/u).filter(Boolean);
}

/**
 * Non-destructively applies user `score.edits` (tempo ½×/2×, meter, key, clef,
 * beat shift, individual note pitch/duration/delete/add, chord overrides).
 */
export function applyScoreEdits(rawScore) {
    if (!rawScore || !Array.isArray(rawScore.notes))
        return null;
    const edits = rawScore.edits && typeof rawScore.edits === 'object' ? rawScore.edits : {};
    const tempoMul = edits.tempoMul === 0.5 || edits.tempoMul === 2 ? edits.tempoMul : 1;
    const baseBpm = Number(rawScore.bpm) > 0 ? Number(rawScore.bpm) : 120;
    const bpm = baseBpm * tempoMul;
    const meter = Array.isArray(edits.meter) && edits.meter.length === 2
        ? [Math.round(edits.meter[0]), Math.round(edits.meter[1])]
        : (Array.isArray(rawScore.meter) && rawScore.meter.length === 2 ? [...rawScore.meter] : [4, 4]);
    const key = edits.keyOverride ?? rawScore.key ?? null;
    const beatShift = Number.isFinite(Number(edits.beatShift)) ? Math.round(Number(edits.beatShift)) : 0;

    let beats = Array.isArray(rawScore.beats) ? rawScore.beats.map(Number).filter(Number.isFinite) : [];
    if (tempoMul === 0.5 && beats.length >= 4) {
        beats = beats.filter((_, idx) => idx % 2 === 0);
    } else if (tempoMul === 2 && beats.length >= 2) {
        const doubled = [];
        for (let i = 0; i < beats.length - 1; i++) {
            doubled.push(beats[i]);
            doubled.push((beats[i] + beats[i + 1]) * 0.5);
        }
        doubled.push(beats[beats.length - 1]);
        beats = doubled;
    }

    const deleted = new Set((edits.deletedNoteIds ?? []).map(String));
    const overrides = edits.noteOverrides ?? {};
    const notes = [];
    for (let i = 0; i < rawScore.notes.length; i++) {
        const n = rawScore.notes[i];
        const id = String(n.id ?? (i + 1));
        if (deleted.has(id))
            continue;
        const ov = overrides[id];
        const pitch = Number.isFinite(Number(ov?.pitch)) ? Number(ov.pitch) : Number(n.pitch);
        const start = Number.isFinite(Number(ov?.start)) ? Number(ov.start) : Number(n.start);
        const end = Number.isFinite(Number(ov?.end)) ? Number(ov.end) : Number(n.end);
        const durBeats = Number.isFinite(Number(ov?.durBeats))
            ? Number(ov.durBeats)
            : (Number.isFinite(Number(n.durBeats)) ? Number(n.durBeats) * tempoMul : null);
        if (!Number.isFinite(pitch) || !Number.isFinite(start) || !Number.isFinite(end) || end <= start)
            continue;
        notes.push({
            ...n,
            id,
            pitch,
            start,
            end,
            ...(durBeats !== null ? {durBeats} : {}),
            ...(Number.isFinite(Number(ov?.beat)) ? {beatOverride: Number(ov.beat)} : {}),
            edited: Boolean(ov),
        });
    }
    for (const added of (edits.addedNotes ?? [])) {
        if (!added || deleted.has(String(added.id)))
            continue;
        const start = Number(added.start);
        const end = Number(added.end);
        const pitch = Number(added.pitch);
        if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || !Number.isFinite(pitch))
            continue;
        notes.push({
            id: String(added.id),
            start,
            end,
            pitch,
            ...(Number.isFinite(Number(added.beat)) ? {beatOverride: Number(added.beat)} : {}),
            ...(Number.isFinite(Number(added.durBeats)) ? {durBeats: Number(added.durBeats)} : {}),
            added: true,
            edited: true,
        });
    }
    notes.sort((a, b) => a.start - b.start || a.end - b.end);

    const midis = notes.map(n => n.pitch).sort((a, b) => a - b);
    const medianMidi = midis.length ? midis[Math.floor(midis.length / 2)] : (Number(rawScore.medianMidi) || 64);

    return {
        ...rawScore,
        bpm,
        meter,
        key,
        clefOverride: edits.clef ?? 'auto',
        beatShift,
        medianMidi,
        beats,
        notes,
        chords: Array.isArray(rawScore.chords) ? rawScore.chords : [],
        chordOverrides: edits.chordOverrides ?? {},
        edited: Object.keys(edits).length > 0,
    };
}

function buildBeatTimeMap(beats, bpm, duration) {
    const spb = 60 / Math.max(30, Math.min(240, bpm || 120));
    const grid = beats.length >= 2
        ? beats.slice().sort((a, b) => a - b)
        : Array.from({length: Math.max(4, Math.ceil((duration || 30) / spb) + 2)}, (_, i) => i * spb);

    const timeToBeat = t => {
        if (t <= grid[0])
            return (t - grid[0]) / spb;
        const last = grid.length - 1;
        if (t >= grid[last])
            return last + (t - grid[last]) / spb;
        let lo = 0;
        let hi = last;
        while (lo + 1 < hi) {
            const mid = (lo + hi) >> 1;
            if (grid[mid] <= t)
                lo = mid;
            else
                hi = mid;
        }
        const span = Math.max(0.05, grid[hi] - grid[lo]);
        return lo + (t - grid[lo]) / span;
    };

    const beatToTime = b => {
        if (b <= 0)
            return grid[0] + b * spb;
        const last = grid.length - 1;
        if (b >= last)
            return grid[last] + (b - last) * spb;
        const idx = Math.floor(b);
        const frac = b - idx;
        return grid[idx] + frac * (grid[idx + 1] - grid[idx]);
    };

    return {grid, spb, timeToBeat, beatToTime};
}

function packRestSpan(startBeatInBar, durBeats, barBeats) {
    const rests = [];
    let pos = quantizeGrid(startBeatInBar);
    let rem = quantizeGrid(durBeats);
    let guard = 0;
    while (rem >= 0.24 && guard++ < 16) {
        let pick = 0.25;
        let fig = {figure: 'sixteenth', dots: 0};
        const onBarStart = Math.abs(pos) < 0.01;
        const onBeat = Math.abs(pos - Math.round(pos)) < 0.01;
        const onHalf = Math.abs(pos) < 0.01 || (barBeats >= 4 && Math.abs(pos - 2) < 0.01);
        if (onBarStart && rem >= barBeats - 0.01) {
            pick = barBeats;
            fig = {figure: 'whole', dots: 0, wholeBar: true};
        } else if (onHalf && rem >= 2 - 0.01) {
            pick = 2;
            fig = {figure: 'half', dots: 0};
        } else if (onBeat && rem >= 1.5 - 0.01 && Math.abs((pos + 1.5) - barBeats) < 0.01 && barBeats === 3) {
            pick = 1.5;
            fig = {figure: 'quarter', dots: 1};
        } else if (onBeat && rem >= 1 - 0.01) {
            pick = 1;
            fig = {figure: 'quarter', dots: 0};
        } else if (Math.abs(pos * 2 - Math.round(pos * 2)) < 0.01 && rem >= 0.5 - 0.01) {
            pick = 0.5;
            fig = {figure: 'eighth', dots: 0};
        } else {
            pick = 0.25;
            fig = {figure: 'sixteenth', dots: 0};
        }
        rests.push({
            kind: 'rest',
            beatInBar: pos,
            beats: pick,
            figure: fig.figure,
            dots: fig.dots,
            wholeBar: Boolean(fig.wholeBar),
        });
        pos = quantizeGrid(pos + pick);
        rem = quantizeGrid(rem - pick);
    }
    return rests;
}

function splitNoteDurationForBar(startInBar, durBeats, barBeats) {
    // Keep 4/4 beaming/readability clean: split notes that awkwardly cross the middle
    // of a 4/4 bar unless they start on beat 0 (whole/dotted-half) or beat 1 (syncopated half).
    const parts = [];
    const mid = barBeats === 4 ? 2 : (barBeats === 3 ? null : null);
    if (mid !== null && startInBar > 0.01 && startInBar < mid && startInBar + durBeats > mid + 0.01) {
        const isCleanSyncopation = Math.abs(startInBar - 1) < 0.01 && Math.abs(durBeats - 2) < 0.01;
        if (!isCleanSyncopation) {
            const left = quantizeGrid(mid - startInBar);
            const right = quantizeGrid(durBeats - left);
            parts.push(...decomposeRhythm(left, false), ...decomposeRhythm(right, false));
            return parts;
        }
    }
    return decomposeRhythm(durBeats, false);
}

/**
 * Builds a complete, measure-by-measure Piano Lead Sheet layout for a song:
 * numbered bars, chord symbols above the staff, melody notes with ties across
 * barlines, beat-grouped beams, per-bar accidentals, aligned lyrics underneath,
 * and systems (`barsPerSystem` measures per staff line).
 */
export function buildLeadSheet(rawScore, {
    lyricLines = [],
    keyOverride = null,
    scaleSnap = 'soft',
    harmony = 'off',
    voiceMode = 'both',
    barsPerSystem = 6,
    showChords = true,
} = {}) {
    const score = applyScoreEdits(rawScore);
    if (!score || !score.notes.length)
        return null;

    const effectiveKey = score.key ?? keyOverride ?? null;
    const keySig = keySignatureFor(effectiveKey);
    const autoClef = chooseClef(score.medianMidi, score.notes);
    const clef = score.clefOverride === 'treble'
        ? 'treble'
        : (score.clefOverride === 'treble-8vb' ? 'treble-8vb' : autoClef.clef);
    const octaveShift = clef === 'treble-8vb' ? 1 : 0;
    const meter = score.meter;
    const barBeats = barBeatsForMeter(meter);
    const spb = 60 / Math.max(30, Math.min(240, score.bpm || 120));
    const maxNoteEnd = score.notes.reduce((m, n) => Math.max(m, n.end), 0);
    const duration = Math.max(Number(score.duration) || 0, maxNoteEnd + spb);
    const {timeToBeat, beatToTime} = buildBeatTimeMap(score.beats, score.bpm, duration);

    // Anchor downbeat 0 on the first downbeat (or beat 0), shifted by user `beatShift`.
    let anchorBeat = 0;
    if (Array.isArray(score.downbeats) && score.downbeats.length)
        anchorBeat = Math.round(timeToBeat(score.downbeats[0]));
    anchorBeat += score.beatShift;

    const firstNoteBeat = timeToBeat(score.notes[0].start);
    let originBeat = anchorBeat;
    while (originBeat > firstNoteBeat + 0.05)
        originBeat -= barBeats;
    while (originBeat + barBeats <= firstNoteBeat - 0.1)
        originBeat += barBeats;

    // Convert notes to quantized song-beat coordinates relative to `originBeat`,
    // preserving multi-voice labels (`voice: 1` upper, `voice: 2` lower harmony).
    const allQNotes = score.notes.map(n => {
        const rawBeat = n.beatOverride !== undefined ? n.beatOverride : (timeToBeat(n.start) - originBeat);
        const startBeat = Math.max(0, quantizeGrid(rawBeat));
        const rawDur = Number.isFinite(n.durBeats)
            ? n.durBeats
            : Math.max(0.25, timeToBeat(n.end) - timeToBeat(n.start));
        const durBeats = Math.max(0.25, Math.min(barBeats * 2, quantizeGrid(rawDur)));
        const voice = Number(n.voice) === 2 ? 2 : 1;
        return {
            id: String(n.id),
            start: n.start,
            end: n.end,
            pitch: n.pitch,
            voice,
            startBeat,
            durBeats,
            edited: Boolean(n.edited),
            added: Boolean(n.added),
            lyric: '',
        };
    });

    const sourceHasMultipleVoices = allQNotes.some(n => n.voice === 2);
    const normVoiceMode = voiceMode === 'top' || voiceMode === 'bottom' ? voiceMode : 'both';

    // Filter voices cleanly according to user preference while keeping solo passages intact.
    let qNotes;
    if (!sourceHasMultipleVoices || normVoiceMode === 'both') {
        qNotes = allQNotes;
    } else if (normVoiceMode === 'top') {
        qNotes = allQNotes.filter(n => n.voice === 1);
    } else {
        const v2Notes = allQNotes.filter(n => n.voice === 2);
        const overlapsV2 = n => v2Notes.some(v2 =>
            Math.min(n.startBeat + n.durBeats, v2.startBeat + v2.durBeats)
            - Math.max(n.startBeat, v2.startBeat) >= 0.12);
        qNotes = allQNotes.filter(n => n.voice === 2 || !overlapsV2(n));
    }
    if (!qNotes.length)
        qNotes = allQNotes;

    // Resolve overlaps independently within each voice so simultaneous harmony notes stay stacked!
    for (const v of [1, 2]) {
        const stream = qNotes.filter(n => n.voice === v);
        stream.sort((a, b) => a.startBeat - b.startBeat || a.start - b.start);
        for (let i = 0; i + 1 < stream.length; i++) {
            const cur = stream[i];
            const nxt = stream[i + 1];
            if (nxt.startBeat <= cur.startBeat)
                nxt.startBeat = quantizeGrid(cur.startBeat + 0.25);
            if (cur.startBeat + cur.durBeats > nxt.startBeat)
                cur.durBeats = Math.max(0.25, quantizeGrid(nxt.startBeat - cur.startBeat));
        }
    }
    qNotes.sort((a, b) => a.startBeat - b.startBeat || a.voice - b.voice || b.pitch - a.pitch);
    const hasMultipleVoices = qNotes.some(n => n.voice === 2) && qNotes.some(n => n.voice === 1);

    // Attach lyrics directly beneath notes on the primary vocal timeline (never double-printed on Voice 2).
    const lyricTargets = hasMultipleVoices ? qNotes.filter(n => n.voice === 1) : qNotes;
    const cleanLines = Array.isArray(lyricLines)
        ? lyricLines.filter(l => l && Number.isFinite(l.time) && String(l.text ?? '').trim())
        : [];
    if (cleanLines.length) {
        for (let li = 0; li < cleanLines.length; li++) {
            const line = cleanLines[li];
            const nextTime = li + 1 < cleanLines.length ? cleanLines[li + 1].time : (duration + 2);
            const winStart = line.time - 0.22;
            const winEnd = Math.min(nextTime - 0.06, line.time + 14);
            const notesInWin = lyricTargets.filter(n => !n.lyric && n.start >= winStart && n.start < winEnd);
            const tokens = splitLyricTokens(line.text);
            if (!notesInWin.length || !tokens.length)
                continue;
            if (tokens.length <= notesInWin.length) {
                for (let ti = 0; ti < tokens.length; ti++) {
                    const ni = tokens.length === 1
                        ? 0
                        : Math.round((ti / (tokens.length - 1)) * (notesInWin.length - 1));
                    const target = notesInWin[ni];
                    target.lyric = target.lyric ? `${target.lyric} ${tokens[ti]}` : tokens[ti];
                }
            } else {
                const perNote = tokens.length / notesInWin.length;
                for (let ni = 0; ni < notesInWin.length; ni++) {
                    const lo = Math.round(ni * perNote);
                    const hi = Math.max(lo + 1, Math.round((ni + 1) * perNote));
                    const chunk = tokens.slice(lo, hi).join(' ');
                    if (chunk)
                        notesInWin[ni].lyric = chunk;
                }
            }
        }
    } else if (Array.isArray(score.words) && score.words.length) {
        const usedNotes = new Set();
        for (const w of score.words) {
            const word = String(w.word ?? '').trim();
            if (!word)
                continue;
            const mid = (Number(w.start) + Number(w.end)) * 0.5;
            let best = null;
            let bestDist = 0.45;
            for (const n of lyricTargets) {
                if (usedNotes.has(n.id))
                    continue;
                const d = Math.abs(n.start - mid);
                if (d < bestDist) {
                    bestDist = d;
                    best = n;
                }
            }
            if (best) {
                best.lyric = word;
                usedNotes.add(best.id);
            }
        }
    }

    const lastBeat = qNotes.reduce((m, n) => Math.max(m, n.startBeat + n.durBeats), barBeats);
    const totalBars = Math.max(1, Math.ceil(lastBeat / barBeats));

    // Bucket note slices into measures (splitting notes that cross barlines with ties).
    const barBuckets = Array.from({length: totalBars}, () => []);
    for (const n of qNotes) {
        let cursor = n.startBeat;
        let rem = n.durBeats;
        let pieceIdx = 0;
        while (rem >= 0.24) {
            const barIdx = Math.floor(cursor / barBeats);
            if (barIdx < 0 || barIdx >= totalBars)
                break;
            const beatInBar = quantizeGrid(cursor - barIdx * barBeats);
            const room = quantizeGrid(barBeats - beatInBar);
            const take = Math.min(rem, room);
            const tieToNext = rem - take >= 0.24;
            barBuckets[barIdx].push({
                noteId: n.id,
                voice: n.voice,
                pieceIdx,
                beatInBar,
                durBeats: take,
                start: beatToTime(originBeat + cursor),
                end: beatToTime(originBeat + cursor + take),
                rawStart: n.start,
                rawEnd: n.end,
                pitch: n.pitch,
                lyric: pieceIdx === 0 ? n.lyric : '',
                tieFromPrev: pieceIdx > 0,
                tieToNext,
                edited: n.edited,
                added: n.added,
            });
            cursor = quantizeGrid(cursor + take);
            rem = quantizeGrid(rem - take);
            pieceIdx++;
        }
    }

    // Bucket chords into measures and apply user chordOverrides.
    const barChords = Array.from({length: totalBars}, () => new Map());
    let openingChord = '';
    for (const c of score.chords) {
        if (!c || !c.symbol)
            continue;
        const t = Number(c.start);
        if (!Number.isFinite(t))
            continue;
        const relBeat = timeToBeat(t) - originBeat;
        const snapped = Math.round(relBeat);
        if (snapped < 0) {
            // Remember the latest chord sounding before bar 1 so bar 1 beat 0 inherits it.
            openingChord = String(c.symbol);
            continue;
        }
        const barIdx = Math.floor(snapped / barBeats);
        if (barIdx < 0 || barIdx >= totalBars)
            continue;
        const beatInBar = snapped - barIdx * barBeats;
        if (!barChords[barIdx].has(beatInBar))
            barChords[barIdx].set(beatInBar, String(c.symbol));
    }
    if (openingChord && totalBars > 0 && !barChords[0].has(0))
        barChords[0].set(0, openingChord);
    for (const [keyStr, sym] of Object.entries(score.chordOverrides ?? {})) {
        const parts = keyStr.split(':');
        const barNum = Math.round(Number(parts[0]));
        const beatInBar = parts.length > 1 ? Math.round(Number(parts[1])) : 0;
        const barIdx = barNum - 1;
        if (barIdx < 0 || barIdx >= totalBars || beatInBar < 0 || beatInBar >= barBeats)
            continue;
        if (!sym)
            barChords[barIdx].delete(beatInBar);
        else
            barChords[barIdx].set(beatInBar, sym);
    }

    // Build engraved measure objects with per-bar accidentals, rests, harmony, and beat-grouped beams.
    const rawMeasures = [];
    let lastChordSym = '';
    for (let barIdx = 0; barIdx < totalBars; barIdx++) {
        const barNumber = barIdx + 1;
        const barStartBeat = originBeat + barIdx * barBeats;
        const startTime = beatToTime(barStartBeat);
        const endTime = beatToTime(barStartBeat + barBeats);
        const pieces = barBuckets[barIdx];
        const barAccidental = new Map();
        const items = [];
        const polyMeasure = pieces.some(p => p.voice === 2) && pieces.some(p => p.voice === 1);
        const primaryPieces = polyMeasure ? pieces.filter(p => p.voice === 1) : pieces;
        const secondaryPieces = polyMeasure ? pieces.filter(p => p.voice === 2) : [];

        const emitPieces = (list, {emitRests, forcedStemDir}) => {
            let cursor = 0;
            for (const p of list) {
                if (emitRests && p.beatInBar - cursor >= 0.24)
                    items.push(...packRestSpan(cursor, p.beatInBar - cursor, barBeats));
                const rawMidi = Math.round(p.pitch);
                const midi = snapPitchToScale(p.pitch, p.durBeats, effectiveKey, scaleSnap);
                const snapDelta = midi - rawMidi;
                const snapCents = Math.round((midi - p.pitch) * 100);
                const spelled = spellMidi(midi, keySig, octaveShift);
                const rawSpelled = snapDelta !== 0 ? spellMidi(rawMidi, keySig, octaveShift) : spelled;
                const accKey = `${spelled.octave}:${spelled.letter}`;
                const curAlter = barAccidental.has(accKey) ? barAccidental.get(accKey) : keySig.defaultAlter[spelled.letter];
                let accidental = null;
                if (!p.tieFromPrev && spelled.alter !== curAlter) {
                    accidental = spelled.alter === 1 ? 'sharp' : spelled.alter === -1 ? 'flat' : 'natural';
                    barAccidental.set(accKey, spelled.alter);
                }

                const harmonies = [];
                if (p.voice === 1 && (harmony === 'above' || harmony === 'both')) {
                    const hMidi = computeHarmonyMidi(midi, effectiveKey, +1);
                    if (hMidi !== null)
                        harmonies.push({direction: 'above', ...spellMidi(hMidi, keySig, octaveShift)});
                }
                if (p.voice === 1 && (harmony === 'below' || harmony === 'both')) {
                    const hMidi = computeHarmonyMidi(midi, effectiveKey, -1);
                    if (hMidi !== null)
                        harmonies.push({direction: 'below', ...spellMidi(hMidi, keySig, octaveShift)});
                }

                const figs = splitNoteDurationForBar(p.beatInBar, p.durBeats, barBeats);
                let subBeat = p.beatInBar;
                const totalFigBeats = figs.reduce((s, f) => s + f.beats, 0) || p.durBeats;
                let elapsed = 0;
                for (let fi = 0; fi < figs.length; fi++) {
                    const fig = figs[fi];
                    const frac0 = elapsed / totalFigBeats;
                    const frac1 = (elapsed + fig.beats) / totalFigBeats;
                    elapsed += fig.beats;
                    const itemStart = p.start + frac0 * (p.end - p.start);
                    const itemEnd = p.start + frac1 * (p.end - p.start);
                    items.push({
                        kind: 'note',
                        id: `${p.noteId}:${p.pieceIdx}:${fi}`,
                        noteId: p.noteId,
                        voice: p.voice,
                        barNumber,
                        beatInBar: subBeat,
                        beats: fig.beats,
                        start: itemStart,
                        end: itemEnd,
                        rawStart: p.rawStart,
                        rawEnd: p.rawEnd,
                        midi,
                        rawPitch: p.pitch,
                        rawMidi,
                        rawWrittenStep: rawSpelled.writtenStep,
                        rawNoteName: rawSpelled.noteName,
                        snapDelta,
                        snapCents,
                        writtenStep: spelled.writtenStep,
                        noteName: spelled.noteName,
                        degree: scaleDegreeLabel(midi, effectiveKey),
                        accidental: fi === 0 ? accidental : null,
                        figure: fig.figure,
                        dots: fig.dots,
                        flags: fig.flags,
                        hollow: fig.hollow,
                        stem: fig.stem,
                        stemDir: forcedStemDir ?? (spelled.writtenStep >= MIDDLE_STAFF_STEP ? -1 : 1),
                        headShiftX: 0,
                        beamGroup: null,
                        tieFromPrev: (fi === 0 && p.tieFromPrev) || fi > 0,
                        tieToNext: (fi + 1 < figs.length) || p.tieToNext,
                        lyric: fi === 0 ? p.lyric : '',
                        harmonies,
                        edited: p.edited,
                        added: p.added,
                    });
                    subBeat = quantizeGrid(subBeat + fig.beats);
                }
                cursor = quantizeGrid(p.beatInBar + p.durBeats);
            }
            if (emitRests && barBeats - cursor >= 0.24)
                items.push(...packRestSpan(cursor, barBeats - cursor, barBeats));
        };

        emitPieces(primaryPieces, {emitRests: true, forcedStemDir: polyMeasure ? 1 : null});
        if (secondaryPieces.length)
            emitPieces(secondaryPieces, {emitRests: false, forcedStemDir: -1});

        // Apply classical horizontal second-interval collision offset between simultaneous Voice 1 & Voice 2.
        if (polyMeasure) {
            const v1Notes = items.filter(it => it.kind === 'note' && it.voice === 1);
            const v2Notes = items.filter(it => it.kind === 'note' && it.voice === 2);
            for (const n2 of v2Notes) {
                const clash = v1Notes.find(n1 =>
                    Math.abs(n1.beatInBar - n2.beatInBar) < 0.05 && Math.abs(n1.writtenStep - n2.writtenStep) <= 1);
                if (clash)
                    n2.headShiftX = 1;
            }
        }

        // Group consecutive flagged notes strictly within beat groups and within the same voice.
        const beatGroupSize = meter[1] === 8 ? 1.5 : (barBeats === 4 ? 2 : 1);
        let nextBeamId = 1;
        const beamVoice = (voiceFilter, forcedDir) => {
            let run = [];
            let runGroupIdx = -1;
            const flushBeam = () => {
                if (run.length >= 2) {
                    const avgStep = run.reduce((s, it) => s + it.writtenStep, 0) / run.length;
                    const dir = forcedDir ?? (avgStep >= MIDDLE_STAFF_STEP ? -1 : 1);
                    const gid = nextBeamId++;
                    for (const it of run) {
                        it.beamGroup = gid;
                        it.stemDir = dir;
                    }
                }
                run = [];
                runGroupIdx = -1;
            };
            for (const it of items) {
                if (it.kind === 'note' && (voiceFilter === null || it.voice === voiceFilter)) {
                    if (it.flags >= 1) {
                        const gIdx = Math.floor((it.beatInBar + 0.001) / beatGroupSize);
                        if (run.length && (gIdx !== runGroupIdx || run.length >= 4))
                            flushBeam();
                        runGroupIdx = gIdx;
                        run.push(it);
                    } else {
                        flushBeam();
                    }
                } else if (it.kind === 'rest' && (voiceFilter === null || voiceFilter === 1)) {
                    flushBeam();
                }
            }
            flushBeam();
        };
        if (polyMeasure) {
            beamVoice(1, 1);
            beamVoice(2, -1);
        } else {
            beamVoice(null, null);
        }

        // Collect chords for this bar (deduplicating back-to-back repeats unless explicitly overridden).
        const chordEntries = [...barChords[barIdx].entries()].sort((a, b) => a[0] - b[0]);
        const chords = [];
        for (const [beatInBar, symbol] of chordEntries) {
            const overrideKey = `${barNumber}:${beatInBar}`;
            const isForced = overrideKey in (score.chordOverrides ?? {}) || (beatInBar === 0 && String(barNumber) in (score.chordOverrides ?? {}));
            if (symbol !== lastChordSym || isForced) {
                chords.push({beatInBar, symbol, barNumber, key: overrideKey});
                lastChordSym = symbol;
            }
        }

        const hasNotes = pieces.length > 0;
        let visualWeight = hasNotes ? 1.0 : 0.85;
        let minStep = STAFF_BOTTOM_STEP;
        let maxStep = STAFF_TOP_STEP;
        for (const it of items) {
            if (it.kind === 'note') {
                visualWeight += 0.28 + (it.accidental ? 0.14 : 0) + ((it.lyric?.length ?? 0) > 6 ? 0.12 : 0);
                minStep = Math.min(minStep, it.writtenStep);
                maxStep = Math.max(maxStep, it.writtenStep);
                for (const h of (it.harmonies ?? [])) {
                    minStep = Math.min(minStep, h.writtenStep);
                    maxStep = Math.max(maxStep, h.writtenStep);
                }
            } else if (it.kind === 'rest' && !it.wholeBar) {
                visualWeight += 0.14;
            }
        }
        visualWeight = Math.max(0.85, Math.min(3.2, visualWeight));
        rawMeasures.push({
            barNumber,
            barEnd: barNumber,
            multiRest: 0,
            startTime,
            endTime,
            barBeats,
            hasNotes,
            visualWeight,
            minStep,
            maxStep,
            chords,
            items,
        });
    }

    // Compress 4+ consecutive completely empty bars into a multi-bar rest.
    // Only break a rest run on chord changes when chord symbols are actually shown.
    const isEmptyForRest = m => !m.hasNotes && (!showChords || m.chords.length === 0);
    const measures = [];
    for (let i = 0; i < rawMeasures.length;) {
        if (isEmptyForRest(rawMeasures[i])) {
            let j = i;
            while (j < rawMeasures.length && isEmptyForRest(rawMeasures[j]))
                j++;
            const runLen = j - i;
            if (runLen >= 4) {
                measures.push({
                    barNumber: rawMeasures[i].barNumber,
                    barEnd: rawMeasures[j - 1].barNumber,
                    multiRest: runLen,
                    startTime: rawMeasures[i].startTime,
                    endTime: rawMeasures[j - 1].endTime,
                    barBeats,
                    hasNotes: false,
                    visualWeight: 1.0,
                    minStep: STAFF_BOTTOM_STEP,
                    maxStep: STAFF_TOP_STEP,
                    chords: [],
                    items: [{kind: 'multirest', count: runLen, beatInBar: 0, beats: barBeats}],
                });
                i = j;
                continue;
            }
        }
        measures.push(rawMeasures[i]);
        i++;
    }

    // Group into systems (`barsPerSystem` measures per staff line, 1..12).
    const perSystem = Math.max(1, Math.min(12, Math.round(Number(barsPerSystem) || 6)));
    const systems = [];
    for (let i = 0; i < measures.length; i += perSystem) {
        const slice = measures.slice(i, i + perSystem);
        let minStep = STAFF_BOTTOM_STEP;
        let maxStep = STAFF_TOP_STEP;
        for (const m of slice) {
            minStep = Math.min(minStep, m.minStep ?? STAFF_BOTTOM_STEP);
            maxStep = Math.max(maxStep, m.maxStep ?? STAFF_TOP_STEP);
        }
        systems.push({
            index: systems.length,
            firstBar: slice[0].barNumber,
            lastBar: slice[slice.length - 1].barEnd,
            startTime: slice[0].startTime,
            endTime: slice[slice.length - 1].endTime,
            minStep,
            maxStep,
            measures: slice,
        });
    }

    return {
        clef,
        octaveShift,
        key: effectiveKey,
        keyLabel: effectiveKey ? keyName(effectiveKey) : '',
        keySig,
        bpm: Math.round(score.bpm),
        meter,
        barBeats,
        totalBars,
        duration,
        noteCount: qNotes.length,
        chordCount: measures.reduce((s, m) => s + m.chords.length, 0),
        voiceCount: sourceHasMultipleVoices ? 2 : 1,
        hasMultipleVoices,
        voiceMode: normVoiceMode,
        edited: score.edited,
        measures,
        systems,
    };
}

/**
 * Finds the active system, measure, note ID, and measure progress at `mediaTime`.
 */
export function findActiveLeadSheetPosition(leadSheet, mediaTime) {
    if (!leadSheet || !leadSheet.systems?.length || !Number.isFinite(mediaTime))
        return {systemIndex: 0, measureIndex: -1, barNumber: null, activeNoteId: null, activeItemId: null, measureProgress: 0};
    const t = mediaTime + 0.04;
    let sysIdx = 0;
    for (let i = 0; i < leadSheet.systems.length; i++) {
        const sys = leadSheet.systems[i];
        if (t >= sys.startTime)
            sysIdx = i;
        if (t < sys.endTime)
            break;
    }
    const sys = leadSheet.systems[sysIdx];
    let measureIndex = -1;
    let barNumber = null;
    let activeNoteId = null;
    let activeItemId = null;
    let measureProgress = 0;
    for (let mi = 0; mi < sys.measures.length; mi++) {
        const m = sys.measures[mi];
        if (t >= m.startTime && t <= m.endTime) {
            measureIndex = mi;
            barNumber = m.barNumber;
            const span = Math.max(0.05, m.endTime - m.startTime);
            measureProgress = Math.max(0, Math.min(1, (mediaTime - m.startTime) / span));
            for (const it of m.items) {
                if (it.kind === 'note' && t >= it.start && t <= it.end) {
                    activeNoteId = it.noteId;
                    activeItemId = it.id;
                    break;
                }
            }
            break;
        }
    }
    return {systemIndex: sysIdx, measureIndex, barNumber, activeNoteId, activeItemId, measureProgress};
}

/**
 * Sample 8-measure (2-system) G-major piano lead sheet for Settings & idle preview.
 */
export function sampleLeadSheetForPreview({scaleSnap = 'soft', harmony = 'off', barsPerSystem = 4} = {}) {
    const raw = {
        bpm: 84,
        meter: [3, 4],
        key: {root: 7, type: 'major', margin: 0.3},
        medianMidi: 67,
        duration: 18.0,
        beats: Array.from({length: 28}, (_, i) => i * (60 / 84)),
        downbeats: Array.from({length: 9}, (_, i) => i * 3 * (60 / 84)),
        notes: [
            {id: 1, start: 0.0, end: 0.71, pitch: 62, durBeats: 1.0},
            {id: 2, start: 0.71, end: 2.14, pitch: 67, durBeats: 2.0},
            {id: 3, start: 2.14, end: 2.50, pitch: 71, durBeats: 0.5},
            {id: 4, start: 2.50, end: 2.86, pitch: 67, durBeats: 0.5},
            {id: 5, start: 2.86, end: 4.29, pitch: 71, durBeats: 2.0},
            {id: 6, start: 4.29, end: 5.00, pitch: 69, durBeats: 1.0},
            {id: 7, start: 5.00, end: 6.43, pitch: 67, durBeats: 2.0},
            {id: 8, start: 6.43, end: 7.14, pitch: 64, durBeats: 1.0},
            {id: 9, start: 7.14, end: 8.57, pitch: 62, durBeats: 2.0},
            {id: 10, start: 8.57, end: 9.29, pitch: 62, durBeats: 1.0},
            {id: 11, start: 9.29, end: 10.71, pitch: 67, durBeats: 2.0},
            {id: 12, start: 10.71, end: 11.07, pitch: 71, durBeats: 0.5},
            {id: 13, start: 11.07, end: 11.43, pitch: 67, durBeats: 0.5},
            {id: 14, start: 11.43, end: 12.86, pitch: 71, durBeats: 2.0},
            {id: 15, start: 12.86, end: 13.57, pitch: 69, durBeats: 1.0},
            {id: 16, start: 13.57, end: 15.71, pitch: 74, durBeats: 3.0},
        ],
        chords: [
            {bar: 1, beatInBar: 0, start: 0.71, end: 5.0, symbol: 'G'},
            {bar: 3, beatInBar: 0, start: 5.0, end: 7.14, symbol: 'C'},
            {bar: 4, beatInBar: 0, start: 7.14, end: 9.29, symbol: 'G'},
            {bar: 5, beatInBar: 0, start: 9.29, end: 11.43, symbol: 'G'},
            {bar: 6, beatInBar: 0, start: 11.43, end: 13.57, symbol: 'Em'},
            {bar: 7, beatInBar: 0, start: 13.57, end: 16.0, symbol: 'D7'},
        ],
    };
    const lyricLines = [
        {time: 0.0, text: 'A- ma- zing grace how sweet the sound'},
        {time: 8.5, text: 'that saved a wretch like me'},
    ];
    return buildLeadSheet(raw, {lyricLines, scaleSnap, harmony, barsPerSystem});
}

/**
 * Places every lyric word across a staff system with ZERO truncation and ZERO
 * horizontal overlap — even on narrow windows or tight eighth-note rhythms:
 *   1. Tries Tier 0 at `baseFontPx` centered under its note (clamped inside `[leftBound, rightBound]`).
 *   2. If colliding with the prior word on Tier 0, tries gently shrinking (down to `0.78×` `baseFontPx`).
 *   3. If still colliding, drops the word cleanly onto the next tier below (`tier 1`, `tier 2`)
 *      at full readable size so every single word remains readable in full.
 */
export function layoutSystemLyrics(entries, {
    leftBound = 0,
    rightBound = 1000,
    baseFontPx = 11,
    minScale = 0.78,
    maxTiers = 3,
    measureWidth = null,
} = {}) {
    if (!Array.isArray(entries) || !entries.length)
        return {placements: [], tierCount: 0};

    const measure = typeof measureWidth === 'function'
        ? measureWidth
        : (text, px) => {
            let units = 0;
            for (const ch of String(text ?? ''))
                units += CJK_CHAR.test(ch) ? 1.02 : (/[ilI1.,'!:;|]/u.test(ch) ? 0.34 : (/[mwMW@]/u.test(ch) ? 0.82 : 0.58));
            return units * px;
        };

    const minX = leftBound + 2;
    const maxX = Math.max(minX + 36, rightBound - 2);
    const span = maxX - minX;
    const gap = Math.max(4, baseFontPx * 0.36);
    const tierRights = Array.from({length: Math.max(1, maxTiers)}, () => -Infinity);
    const placements = [];
    let maxTierUsed = 0;

    const clampLeft = (centerX, w) => Math.max(minX, Math.min(Math.max(minX, maxX - w), centerX - w / 2));

    for (const entry of entries) {
        const text = String(entry.text ?? '').trim();
        if (!text)
            continue;
        const noteX = Number(entry.x) || minX;
        const bold = Boolean(entry.bold);

        // Fit single word inside the full window span if the window is extremely narrow.
        let fullPx = baseFontPx;
        let fullW = Math.max(4, measure(text, fullPx, bold));
        if (fullW > span) {
            fullPx = Math.max(7.5, fullPx * (span / fullW));
            fullW = Math.max(4, measure(text, fullPx, bold));
        }
        const fullLeft = clampLeft(noteX, fullW);

        // 1. Ideal: Tier 0 at full size.
        if (fullLeft >= tierRights[0] + gap) {
            tierRights[0] = fullLeft + fullW;
            placements.push({...entry, text, drawX: fullLeft + fullW / 2, tier: 0, fontPx: fullPx, width: fullW, needsGuide: false});
            continue;
        }

        // 2. Gentle shrink on Tier 0 (down to `minScale`) if that clears the prior word cleanly.
        const shrunkPx = Math.max(8, fullPx * minScale);
        const shrunkW = Math.max(4, measure(text, shrunkPx, bold));
        const shrunkLeft = clampLeft(noteX, shrunkW);
        if (shrunkLeft >= tierRights[0] + gap) {
            // Interpolate largest font size between shrunkPx and fullPx that fits cleanly.
            let chosenPx = shrunkPx;
            let chosenW = shrunkW;
            let chosenLeft = shrunkLeft;
            const availW = (noteX - (tierRights[0] + gap)) * 2;
            if (availW > shrunkW && fullW > shrunkW) {
                const t = Math.max(0, Math.min(1, (availW - shrunkW) / (fullW - shrunkW)));
                const candPx = shrunkPx + t * (fullPx - shrunkPx);
                const candW = Math.max(4, measure(text, candPx, bold));
                const candLeft = clampLeft(noteX, candW);
                if (candLeft >= tierRights[0] + gap) {
                    chosenPx = candPx;
                    chosenW = candW;
                    chosenLeft = candLeft;
                }
            }
            tierRights[0] = chosenLeft + chosenW;
            placements.push({...entry, text, drawX: chosenLeft + chosenW / 2, tier: 0, fontPx: chosenPx, width: chosenW, needsGuide: false});
            continue;
        }

        // 3. Drop onto the first open lower tier (1, 2, ...) at full readable size, or gently shrunk on that tier.
        let placed = false;
        for (let tier = 1; tier < tierRights.length; tier++) {
            if (fullLeft >= tierRights[tier] + gap) {
                tierRights[tier] = fullLeft + fullW;
                maxTierUsed = Math.max(maxTierUsed, tier);
                placements.push({...entry, text, drawX: fullLeft + fullW / 2, tier, fontPx: fullPx, width: fullW, needsGuide: true});
                placed = true;
                break;
            }
            if (shrunkLeft >= tierRights[tier] + gap) {
                tierRights[tier] = shrunkLeft + shrunkW;
                maxTierUsed = Math.max(maxTierUsed, tier);
                placements.push({...entry, text, drawX: shrunkLeft + shrunkW / 2, tier, fontPx: shrunkPx, width: shrunkW, needsGuide: true});
                placed = true;
                break;
            }
        }

        // 4. Extreme cramming fallback (narrow window + dense 16th-note patter): pick the tier
        //    with the earliest right edge and place right after it at shrunk size — NEVER drop/truncate!
        if (!placed) {
            let bestTier = 0;
            for (let t = 1; t < tierRights.length; t++) {
                if (tierRights[t] < tierRights[bestTier])
                    bestTier = t;
            }
            const nextLeft = Math.min(Math.max(minX, maxX - shrunkW), Math.max(minX, tierRights[bestTier] + gap * 0.6));
            tierRights[bestTier] = nextLeft + shrunkW;
            maxTierUsed = Math.max(maxTierUsed, bestTier);
            placements.push({...entry, text, drawX: nextLeft + shrunkW / 2, tier: bestTier, fontPx: shrunkPx, width: shrunkW, needsGuide: bestTier > 0});
        }
    }

    return {placements, tierCount: placements.length ? maxTierUsed + 1 : 0};
}

// ---------------------------------------------------------------------------
// Single-source-of-truth Piano Lead Sheet page layout planner
// ---------------------------------------------------------------------------

export const BASE_STAFF_SPACE = 8.4;
export const SCORE_SPACING_BAR_UNITS = Object.freeze({
    compact: 14.0,
    normal: 18.5,
    spacious: 24.0,
});
export const MIN_LEGIBLE_BAR_UNITS = 13.0;

function clampNum(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
}

function measureDensityMultiplier(leadSheet, showLyrics) {
    const measures = leadSheet?.measures;
    if (!Array.isArray(measures) || !measures.length)
        return 1.0;
    const active = measures.filter(m => m && m.hasNotes);
    if (!active.length)
        return 1.0;
    const weights = active.map(m => Number(m.visualWeight) || 1.6).sort((a, b) => a - b);
    const p75Weight = weights[Math.min(weights.length - 1, Math.floor(weights.length * 0.75))];
    const weightBump = Math.max(0, (p75Weight - 2.0) * 0.14);
    let lyricBump = 0;
    if (showLyrics) {
        const lyricLens = active.map(m => {
            let chars = 0;
            for (const it of (m.items ?? [])) {
                if (it.kind === 'note' && it.lyric)
                    chars += String(it.lyric).length + 1;
            }
            return chars;
        }).sort((a, b) => a - b);
        const p75Chars = lyricLens[Math.min(lyricLens.length - 1, Math.floor(lyricLens.length * 0.75))];
        lyricBump = Math.max(0, (p75Chars - 13) * 0.022);
    }
    return clampNum(1.0 + Math.max(weightBump, lyricBump), 1.0, 1.38);
}

function measureVerticalExcursion(leadSheet) {
    const list = leadSheet?.measures?.length ? leadSheet.measures : (leadSheet?.systems ?? []);
    if (!list.length)
        return {extraHighSteps: 1.5, extraLowSteps: 1.5};
    const highs = [];
    const lows = [];
    for (const item of list) {
        highs.push(Number.isFinite(item.maxStep) ? Math.max(0, Math.min(7, item.maxStep - STAFF_TOP_STEP)) : 0);
        lows.push(Number.isFinite(item.minStep) ? Math.max(0, Math.min(7, STAFF_BOTTOM_STEP - item.minStep)) : 0);
    }
    highs.sort((a, b) => a - b);
    lows.sort((a, b) => a - b);
    const p90 = arr => arr[Math.min(arr.length - 1, Math.floor(arr.length * 0.9))];
    return {
        extraHighSteps: Math.max(1.5, p90(highs)),
        extraLowSteps: Math.max(1.5, p90(lows)),
    };
}

/**
 * Pure, single-source-of-truth page layout planner shared across the desktop
 * Cairo renderer (`shared/score-painter.js`), `ScoreWindow`, and the Settings
 * page preview (`service/settings-page/preview.js`).
 *
 * Invariants guaranteed for EVERY window size, aspect ratio, and zoom:
 * - Vertical rows ALWAYS auto-fill the available window height (no arbitrary
 *   6-row cap, no floating middle-of-page ribbon with giant top/bottom voids).
 * - System 1 starts cleanly right below the header rule with a small top margin;
 *   modest leftover slack is distributed evenly as bounded inter-system gaps.
 * - `scale` (`0.6..3.5`) directly sets `sp = 8.4 * scale`. Only an extreme 1×1
 *   overflow clamps `effectiveScale`, and the caller gets the honest value.
 * - `spacing` (`compact`/`normal`/`spacious`) governs Auto `barsPerSystem`
 *   (alongside song lyric/note density) and NEVER shrinks `sp` when pinned.
 * - A pinned `barsPerSystem` is honored at full `scale` whenever it fits above
 *   the horizontal legibility floor (`11.5 sp/bar`), and reflows cleanly down
 *   to `maxLegibleCols` instead of crushing staves into microscopic print.
 */
export function planLeadSheetPage(leadSheet, {
    width = null,
    height = null,
    scale = 1.0,
    barsPerSystem = 0,
    spacing = 'normal',
    showHeader = true,
    showMeasureNumbers = true,
    showChords = true,
    showLyrics = true,
    noteNames = 'letters',
    showSnapMoves = false,
} = {}) {
    const reqScale = clampNum(Number(scale) || 1.0, 0.55, 3.5);
    const barUnits = SCORE_SPACING_BAR_UNITS[spacing] ?? SCORE_SPACING_BAR_UNITS.normal;
    const densityMul = measureDensityMultiplier(leadSheet, showLyrics);
    const keyAccCount = leadSheet?.keySig?.accidentals?.length ?? 2;
    const {extraHighSteps, extraLowSteps} = measureVerticalExcursion(leadSheet);
    const showLabels = noteNames === 'letters' || noteNames === 'degrees' || Boolean(showSnapMoves);
    const requestedBars = Number(barsPerSystem) > 0 ? clampNum(Math.round(Number(barsPerSystem)), 1, 12) : 0;
    const hasBoundW = Number.isFinite(width) && width > 140;
    const hasBoundH = Number.isFinite(height) && height > 80;

    const evalAt = effScale => {
        const sp = BASE_STAFF_SPACE * effScale;
        const padX = Math.round(clampNum(1.4 * sp, 10, 26));
        const padY = Math.round(clampNum(0.95 * sp, 7, 18));
        const headerScale = clampNum(effScale, 0.85, 1.45);
        const headerH = showHeader ? Math.round(28 * headerScale) : 0;
        const headerGap = showHeader ? Math.round(clampNum(0.9 * sp, 8, 18)) : 0;
        const bodyTop = padY + (showHeader ? headerH + headerGap : 0);
        const bottomPad = Math.round(clampNum(1.0 * sp, 8, 20));
        const preambleW = sp * (5.2 + keyAccCount * 0.92);

        let usableW;
        let maxAutoCols;
        let maxLegibleCols;
        let cols;
        let reflowed = false;
        let actualWidth;
        let minOneBarWidth;

        if (hasBoundW) {
            actualWidth = Math.round(width);
            usableW = Math.max(40, actualWidth - padX * 2 - preambleW - sp * 1.6);
            const autoBarW = barUnits * densityMul * sp;
            maxAutoCols = clampNum(Math.floor(usableW / autoBarW), 1, 12);
            maxLegibleCols = clampNum(Math.floor(usableW / (MIN_LEGIBLE_BAR_UNITS * sp)), 1, 12);
            if (requestedBars > 0) {
                reflowed = requestedBars > maxLegibleCols;
                cols = Math.min(requestedBars, maxLegibleCols);
            } else {
                cols = maxAutoCols;
            }
            minOneBarWidth = Math.ceil(padX * 2 + preambleW + MIN_LEGIBLE_BAR_UNITS * sp + sp * 1.6);
        } else {
            cols = requestedBars > 0 ? requestedBars : 6;
            maxAutoCols = cols;
            maxLegibleCols = cols;
            usableW = cols * barUnits * densityMul * sp;
            actualWidth = Math.round(padX * 2 + preambleW + usableW + sp * 1.6);
            minOneBarWidth = actualWidth;
        }

        // System vertical height counts ONLY enabled engraving bands.
        const chordH = showChords ? Math.max(15 * effScale, sp * 2.05) : 0;
        const barNumH = showMeasureNumbers
            ? (showChords ? sp * 0.55 : Math.max(10 * effScale, sp * 1.15))
            : 0;
        const aboveExcursion = Math.max(sp * 1.85, extraHighSteps * sp * 0.52 + sp * 1.45);
        const aboveStaffH = aboveExcursion + chordH + barNumH;
        const staffH = sp * 4;
        const clefTailExtra = leadSheet?.clef === 'treble-8vb' ? sp * 1.55 : sp * 0.95;
        const belowExcursion = Math.max(sp * 1.55 + clefTailExtra * 0.65, extraLowSteps * sp * 0.52 + sp * 1.15);
        const labelH = showLabels ? Math.max(12 * effScale, sp * 1.55) : 0;
        const singleLyricH = showLyrics ? Math.max(14 * effScale, sp * 1.80) : 0;
        const barW = usableW / Math.max(1, cols);
        const tightBars = showLyrics && barW < 15.5 * sp;
        const lyricH = showLyrics ? Math.round(singleLyricH * (tightBars ? 1.55 : 1.15)) : 0;
        const systemContentH = Math.round(aboveStaffH + staffH + belowExcursion + labelH + lyricH);

        const minGap = Math.round(clampNum(1.65 * sp, 12, 32));
        const maxGap = Math.round(Math.min(systemContentH * 0.58, Math.max(minGap + 8, 5.5 * sp)));

        let visRows;
        let topMargin;
        let systemGap;
        let bodyH;
        let actualHeight;
        let minOneRowHeight;

        if (hasBoundH) {
            actualHeight = Math.round(height);
            bodyH = Math.max(40, actualHeight - bodyTop - bottomPad);
            visRows = clampNum(
                Math.floor((bodyH + minGap) / Math.max(36, systemContentH + minGap)),
                1,
                24,
            );
            const slack = Math.max(0, bodyH - visRows * systemContentH);
            if (visRows >= 2) {
                topMargin = Math.round(clampNum(slack * 0.09, 0, Math.min(20, sp * 1.4)));
                const remSlack = Math.max(0, slack - topMargin);
                systemGap = clampNum(Math.floor(remSlack / (visRows - 0.65)), minGap, maxGap);
            } else {
                topMargin = Math.round(clampNum(slack * 0.20, 0, Math.min(26, sp * 1.8)));
                systemGap = minGap;
            }
            minOneRowHeight = bodyTop + systemContentH + bottomPad;
        } else {
            visRows = 2;
            topMargin = Math.round(clampNum(0.6 * sp, 6, 14));
            systemGap = minGap;
            bodyH = topMargin + visRows * systemContentH + (visRows - 1) * systemGap;
            actualHeight = Math.round(bodyTop + bodyH + bottomPad);
            minOneRowHeight = actualHeight;
        }

        return {
            width: actualWidth,
            height: actualHeight,
            sp,
            requestedScale: reqScale,
            effectiveScale: effScale,
            headerScale,
            clampedScale: effScale < reqScale - 0.015,
            padX,
            padY,
            headerH,
            headerGap,
            bodyTop,
            bottomPad,
            bodyH,
            topMargin,
            systemH: systemContentH,
            systemGap,
            rowStride: systemContentH + systemGap,
            rows: visRows,
            barsPerSystem: cols,
            requestedBarsPerSystem: requestedBars,
            maxAutoCols,
            maxLegibleCols,
            reflowed,
            aboveExcursion,
            belowExcursion,
            chordH,
            barNumH,
            labelH,
            lyricH,
            minOneBarWidth,
            minOneRowHeight,
        };
    };

    let plan = evalAt(reqScale);
    let fitRatio = 1;
    if (hasBoundW && plan.minOneBarWidth > width)
        fitRatio = Math.min(fitRatio, width / plan.minOneBarWidth);
    if (hasBoundH && plan.minOneRowHeight > height)
        fitRatio = Math.min(fitRatio, height / plan.minOneRowHeight);
    if (fitRatio < 0.999)
        plan = evalAt(Math.max(0.45, reqScale * fitRatio));

    return plan;
}

/**
 * Convenience helper returning how many measures fit naturally across `width`
 * at the requested `scale` and `spacing` (honoring lyric/note density).
 */
export function computeAutoBarsPerSystem(leadSheet, {
    width = 1100,
    scale = 1.0,
    spacing = 'normal',
    showLyrics = true,
} = {}) {
    return planLeadSheetPage(leadSheet, {
        width,
        scale,
        barsPerSystem: 0,
        spacing,
        showLyrics,
    }).barsPerSystem;
}
