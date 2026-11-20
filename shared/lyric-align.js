// Turns timed Whisper segments/words into singable LRC lyrics:
// - Mode A ("aligned"): aligns known plain lyrics (e.g. from LRCLIB) onto
//   the audio's timed word stream using semi-global monotone sequence
//   alignment (zero penalty for spoken intros/outros, robust to misheard
//   sung words, interpolates unmatched lines, handles CJK and all scripts).
// - Mode B ("transcribed"): cleans Whisper music/caption hallucinations and
//   splits segments along vocal pauses and punctuation into singable lines.
//
// Pure ES module (no GNOME or Node dependencies) so both service/ (gjs)
// and tests/ (node) run the exact same code.

// Minimum fraction of reference lyric words that must align for plain-lyric
// alignment to be trusted; below this we fall back to transcribed lyrics.
export const MIN_ALIGN_COVERAGE = 0.18;
// Pause between lines long enough to insert a blank LRC marker, clearing
// the screen during instrumental breaks and triggering lyric-display.js's
// seconds countdown before the next vocal entry.
export const INSTRUMENTAL_GAP_SECONDS = 4.5;
const BLANK_AFTER_END_SECONDS = 1.0;
const MAX_LINE_CHARS = 56;
const MAX_LINE_WORDS = 11;
const PHRASE_PAUSE_SECONDS = 0.55;

const SECTION_HEADER = /^(?:\[[^\]]{1,40}\]|\((?:verse|chorus|pre-?chorus|post-?chorus|bridge|intro|outro|hook|refrain|instrumental|solo|interlude|break|spoken|guitar solo|piano solo)(?:\s+\d+)?\)|(?:verse|chorus|pre-?chorus|post-?chorus|bridge|intro|outro|hook|refrain|instrumental)(?:\s+\d+)?\s*:?)$/iu;

const NON_SPEECH_BRACKET = /[\[(]\s*(?:music|singing|applause|laughter|laughing|cheering|instrumental|silence|inaudible|crosstalk|noise|sighs?|groans?|clapping|♪+)\s*[\])]/giu;

const HALLUCINATION_EXACT = new Set([
    'thank you', 'thanks', 'thank you for watching', 'thanks for watching',
    'thank you for listening', 'thanks for listening',
    'please subscribe', 'subscribe', 'like and subscribe', 'subscribe to my channel',
    'like share and subscribe', 'dont forget to subscribe',
    'see you in the next video', 'see you next time', 'bye', 'goodbye',
    'music', 'instrumental', 'applause', 'laughter', 'singing',
    'amara org', 'subtitles by the amara org community',
    'captioned by', 'transcribed by', 'subtitled by',
    'mbc', 'sbs', 'kbs',
]);

const HALLUCINATION_PREFIX = /^(?:subtitles? by|captions? by|transcribed by|translated by|synced by|corrected by|www\.|https?:)/iu;

// CJK ideographs, Hiragana, Katakana, Hangul syllables: split individually
// because ASR and published lyrics often place spaces differently.
const CJK_CHAR = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function formatLrcTimestamp(seconds) {
    const clamped = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
    const centiseconds = Math.round(clamped * 100);
    const totalSeconds = Math.floor(centiseconds / 100);
    const cs = centiseconds % 100;
    const minutes = Math.floor(totalSeconds / 60);
    const secs = totalSeconds % 60;
    return `[${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}.${String(cs).padStart(2, '0')}]`;
}

/** Splits text into normalized comparable tokens (supports Latin, accented, Cyrillic, CJK, etc.). */
export function tokenizeWords(text) {
    const tokens = [];
    let current = '';
    const flush = () => {
        if (current) {
            const norm = current
                .normalize('NFKD')
                .replace(/\p{M}+/gu, '')
                .toLowerCase();
            if (norm)
                tokens.push(norm);
            current = '';
        }
    };
    for (const ch of String(text ?? '').normalize('NFC')) {
        if (CJK_CHAR.test(ch)) {
            flush();
            tokens.push(ch);
        } else if (ch === "'" || ch === '\u2019' || ch === '`') {
            // Join contractions ("don't" -> "dont") without breaking the token.
        } else if (/[\p{L}\p{N}]/u.test(ch)) {
            current += ch;
        } else {
            flush();
        }
    }
    flush();
    return tokens;
}

function normalizedPhrase(text) {
    return tokenizeWords(text).join(' ');
}

function cleanDisplayText(text) {
    return String(text ?? '')
        .replace(NON_SPEECH_BRACKET, ' ')
        .replace(/[♪♫♬]+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

function isHallucinationSegment(segment, cleanText) {
    if (!cleanText)
        return true;
    const norm = normalizedPhrase(cleanText);
    if (!norm)
        return true;
    if (HALLUCINATION_EXACT.has(norm) || HALLUCINATION_PREFIX.test(cleanText))
        return true;
    const noSpeech = Number(segment.no_speech_prob ?? 0);
    const words = Array.isArray(segment.words) ? segment.words : [];
    const avgProb = words.length
        ? words.reduce((sum, w) => sum + Number(w.probability ?? 0.5), 0) / words.length
        : 0.5;
    if (noSpeech >= 0.85 && avgProb < 0.4)
        return true;
    // Whisper frequently hallucinates bare "you" on quiet instrumentals.
    if (norm === 'you' && (noSpeech >= 0.45 || avgProb < 0.55))
        return true;
    return false;
}

/** Detects degenerate Whisper repetition loops inside one segment (e.g. "la la la ..." 15 times). */
function hasDegenerateWordLoop(tokens) {
    if (tokens.length < 12)
        return false;
    let streak = 1;
    for (let i = 1; i < tokens.length; i++) {
        if (tokens[i] === tokens[i - 1]) {
            streak++;
            if (streak >= 10)
                return true;
        } else {
            streak = 1;
        }
    }
    return false;
}

/**
 * Extracts filtered, monotonically timed words and cleaned segments from
 * Whisper's JSON output.
 * @param {Array<{start: number, end: number, text: string, no_speech_prob?: number,
 *                words?: Array<{start: number, end: number, word: string, probability?: number}>}>} segments
 */
export function extractTimedWords(segments) {
    const cleanSegments = [];
    const allWords = [];
    let repeatText = '';
    let repeatCount = 0;

    for (const seg of Array.isArray(segments) ? segments : []) {
        const start = Math.max(0, Number(seg.start) || 0);
        const end = Math.max(start, Number(seg.end) || start);
        const text = cleanDisplayText(seg.text);
        if (isHallucinationSegment(seg, text))
            continue;
        const segTokens = tokenizeWords(text);
        if (!segTokens.length || hasDegenerateWordLoop(segTokens))
            continue;

        const norm = segTokens.join(' ');
        if (norm === repeatText) {
            repeatCount++;
            // Allow genuine repeated choruses, drop runaway Whisper loops.
            const noSpeech = Number(seg.no_speech_prob ?? 0);
            if ((noSpeech >= 0.55 && repeatCount >= 3) || repeatCount >= 8)
                continue;
        } else {
            repeatText = norm;
            repeatCount = 1;
        }

        const segWords = [];
        const rawWords = Array.isArray(seg.words) && seg.words.length ? seg.words : null;
        if (rawWords) {
            for (const rw of rawWords) {
                const rawText = cleanDisplayText(rw.word);
                if (!rawText)
                    continue;
                const tokens = tokenizeWords(rawText);
                if (!tokens.length)
                    continue;
                const wStart = Math.max(0, Number.isFinite(Number(rw.start)) ? Number(rw.start) : start);
                const wEnd = Math.max(wStart, Number.isFinite(Number(rw.end)) ? Number(rw.end) : wStart);
                const prob = Number.isFinite(Number(rw.probability)) ? Number(rw.probability) : 0.6;
                const step = tokens.length > 1 ? (wEnd - wStart) / tokens.length : 0;
                for (let k = 0; k < tokens.length; k++) {
                    const entry = {
                        token: tokens[k],
                        raw: k === 0 ? rawText : '',
                        start: wStart + k * step,
                        end: k === tokens.length - 1 ? wEnd : wStart + (k + 1) * step,
                        prob,
                    };
                    segWords.push(entry);
                    allWords.push(entry);
                }
            }
        } else {
            const rawParts = text.split(/\s+/u).filter(Boolean);
            const dur = Math.max(0.1, end - start);
            const step = dur / Math.max(1, rawParts.length);
            rawParts.forEach((part, idx) => {
                const tokens = tokenizeWords(part);
                const pStart = start + idx * step;
                const pEnd = pStart + step;
                tokens.forEach((token, k) => {
                    const entry = {
                        token,
                        raw: k === 0 ? part : '',
                        start: pStart,
                        end: pEnd,
                        prob: 0.6,
                    };
                    segWords.push(entry);
                    allWords.push(entry);
                });
            });
        }
        if (segWords.length)
            cleanSegments.push({start, end, text, words: segWords});
    }

    // Enforce monotonic timestamps across all extracted words.
    let prevStart = 0;
    for (const w of allWords) {
        if (w.start < prevStart)
            w.start = prevStart;
        if (w.end < w.start)
            w.end = w.start;
        prevStart = w.start;
    }

    return {segments: cleanSegments, words: allWords};
}

function boundedEditDistance(a, b, maxDist) {
    if (Math.abs(a.length - b.length) > maxDist)
        return maxDist + 1;
    const m = a.length;
    const n = b.length;
    let prev = new Int32Array(n + 1);
    let curr = new Int32Array(n + 1);
    for (let j = 0; j <= n; j++)
        prev[j] = j;
    for (let i = 1; i <= m; i++) {
        curr[0] = i;
        let rowMin = i;
        for (let j = 1; j <= n; j++) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            const v = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
            curr[j] = v;
            if (v < rowMin)
                rowMin = v;
        }
        if (rowMin > maxDist)
            return maxDist + 1;
        const swap = prev;
        prev = curr;
        curr = swap;
    }
    return prev[n];
}

function wordSimilarityScore(ref, hyp) {
    if (ref === hyp)
        return 3.0;
    const minLen = Math.min(ref.length, hyp.length);
    const maxLen = Math.max(ref.length, hyp.length);
    if (minLen >= 3 && (ref.startsWith(hyp) || hyp.startsWith(ref)) && maxLen - minLen <= 3)
        return 2.0;
    if (minLen >= 4) {
        const limit = minLen >= 7 ? 2 : 1;
        const dist = boundedEditDistance(ref, hyp, limit);
        if (dist <= limit)
            return dist === 1 ? 1.8 : 1.2;
    }
    return -1.2;
}

/**
 * Semi-global monotone sequence alignment:
 * - Zero penalty for leading/trailing ASR words (spoken intros & outros).
 * - Uses banded DP only for very long tracks (> 1.2M cells) to stay fast.
 * @returns {Int32Array} for each ref index i (0..M-1), matched hyp index j or -1
 */
function alignSequences(refTokens, hypTokens) {
    const M = refTokens.length;
    const N = hypTokens.length;
    const mapping = new Int32Array(M).fill(-1);
    if (!M || !N)
        return mapping;

    const SKIP_REF = -0.9;
    const SKIP_HYP = -0.6;
    const NEG_INF = -1e9;

    const useBand = M * N > 1_200_000;
    const band = useBand ? Math.max(260, Math.abs(M - N) + 260) : N + 1;
    const stride = useBand ? 2 * band + 1 : N + 1;

    // Row offset for banded storage: col j is stored at j - (center - band).
    const rowStart = i => (useBand ? Math.max(0, Math.round((i * N) / M) - band) : 0);
    const rowEnd = i => (useBand ? Math.min(N, Math.round((i * N) / M) + band) : N);

    // Traceback codes: 1 = diag (match/mismatch), 2 = up (skip ref), 3 = left (skip hyp)
    const trace = new Uint8Array((M + 1) * stride);
    let prev = new Float32Array(N + 1).fill(0); // semi-global: free leading hyp skips
    let curr = new Float32Array(N + 1);

    for (let i = 1; i <= M; i++) {
        const s = rowStart(i);
        const e = rowEnd(i);
        const ps = rowStart(i - 1);
        const pe = rowEnd(i - 1);
        curr.fill(NEG_INF);
        const refTok = refTokens[i - 1];
        const rowBase = i * stride;

        for (let j = s; j <= e; j++) {
            const idx = rowBase + (j - s);
            let best = NEG_INF;
            let op = 2;

            // Up: skip reference word (i-1, j)
            if (j >= ps && j <= pe) {
                const up = prev[j] + SKIP_REF;
                if (up > best) {
                    best = up;
                    op = 2;
                }
            }
            // Diag: align ref[i-1] with hyp[j-1]
            if (j > 0 && j - 1 >= ps && j - 1 <= pe) {
                const diag = prev[j - 1] + wordSimilarityScore(refTok, hypTokens[j - 1]);
                if (diag >= best) {
                    best = diag;
                    op = 1;
                }
            }
            // Left: skip hyp word (i, j-1)
            if (j > s) {
                const left = curr[j - 1] + SKIP_HYP;
                if (left > best) {
                    best = left;
                    op = 3;
                }
            }
            curr[j] = best;
            trace[idx] = op;
        }
        const swap = prev;
        prev = curr;
        curr = swap;
    }

    // Semi-global ending: free trailing hyp skips, so pick best j on final row.
    const lastS = rowStart(M);
    const lastE = rowEnd(M);
    let bestJ = lastS;
    let bestScore = prev[lastS];
    for (let j = lastS + 1; j <= lastE; j++) {
        if (prev[j] > bestScore) {
            bestScore = prev[j];
            bestJ = j;
        }
    }

    let i = M;
    let j = bestJ;
    while (i > 0) {
        const s = rowStart(i);
        const op = trace[i * stride + (j - s)];
        if (op === 1 && j > 0) {
            if (wordSimilarityScore(refTokens[i - 1], hypTokens[j - 1]) > 0)
                mapping[i - 1] = j - 1;
            i--;
            j--;
        } else if (op === 3 && j > 0) {
            j--;
        } else {
            i--;
        }
    }
    return mapping;
}

/** Parses plain lyrics into singable lines, dropping structural section tags like "[Chorus]". */
export function parsePlainLines(plainLyrics) {
    const lines = [];
    for (const raw of String(plainLyrics ?? '').split(/\r?\n/u)) {
        const text = raw.replace(/\s+/gu, ' ').trim();
        if (!text || SECTION_HEADER.test(text))
            continue;
        const tokens = tokenizeWords(text);
        if (!tokens.length)
            continue;
        lines.push({text, tokens});
    }
    return lines;
}

/** Formats timed `{start, end, text}` lines into LRC with blank markers for instrumental gaps. */
export function formatTimedLrc(timedLines, durationSeconds = 0) {
    const out = [];
    for (let i = 0; i < timedLines.length; i++) {
        const line = timedLines[i];
        out.push(`${formatLrcTimestamp(line.start)} ${line.text}`);
        const next = timedLines[i + 1];
        if (next) {
            const gap = next.start - line.end;
            if (gap >= INSTRUMENTAL_GAP_SECONDS) {
                const blankAt = Math.min(next.start - 3.2, line.end + BLANK_AFTER_END_SECONDS);
                if (blankAt > line.start + 0.5)
                    out.push(formatLrcTimestamp(blankAt));
            }
        } else if (durationSeconds > 0 && durationSeconds - line.end >= 8) {
            out.push(formatLrcTimestamp(line.end + 4.0));
        }
    }
    return `${out.join('\n')}\n`;
}

/**
 * Mode A: Aligns known plain lyrics onto Whisper's timed word stream.
 * @returns {{ok: true, mode: 'aligned', lrc: string, plainText: string, coverage: number, lineCoverage: number, lineCount: number}
 *          |{ok: false, reason: string, coverage?: number}}
 */
export function alignPlainLyrics(plainLyrics, segments, durationSeconds = 0) {
    const lines = parsePlainLines(plainLyrics);
    if (!lines.length)
        return {ok: false, reason: 'no-plain-lines'};

    const {words: hypWords} = extractTimedWords(segments);
    if (!hypWords.length)
        return {ok: false, reason: 'no-vocals'};

    const refTokens = [];
    const lineRanges = [];
    for (const line of lines) {
        const from = refTokens.length;
        for (const tok of line.tokens)
            refTokens.push(tok);
        lineRanges.push({from, to: refTokens.length});
    }

    const hypTokens = hypWords.map(w => w.token);
    const mapping = alignSequences(refTokens, hypTokens);

    let matchedRef = 0;
    for (let i = 0; i < mapping.length; i++) {
        if (mapping[i] >= 0)
            matchedRef++;
    }
    const coverage = matchedRef / refTokens.length;
    if (coverage < MIN_ALIGN_COVERAGE)
        return {ok: false, reason: 'low-coverage', coverage};

    const audioEnd = Math.max(
        Number(durationSeconds) || 0,
        hypWords[hypWords.length - 1].end + 1,
    );

    // Compute per-line anchors from matched words.
    const anchors = lines.map((line, lineIdx) => {
        const {from, to} = lineRanges[lineIdx];
        const hits = [];
        for (let i = from; i < to; i++) {
            const j = mapping[i];
            if (j >= 0)
                hits.push({pos: i - from, word: hypWords[j]});
        }
        if (!hits.length)
            return null;

        // If a multi-word line matched multiple times and its very first hit
        // jumps far earlier than the rest of the line, drop that outlier hit.
        if (hits.length >= 2 && hits[1].word.start - hits[0].word.end > 12)
            hits.shift();
        if (hits.length >= 2 && hits[hits.length - 1].word.start - hits[hits.length - 2].word.end > 12)
            hits.pop();

        const first = hits[0];
        const last = hits[hits.length - 1];
        const leadingMissed = first.pos;
        const trailingMissed = (to - from - 1) - last.pos;
        const start = Math.max(0, first.word.start - leadingMissed * 0.28);
        const end = Math.min(audioEnd, Math.max(start + 0.5, last.word.end + trailingMissed * 0.25));
        return {start, end, hitCount: hits.length};
    });

    // Reject isolated weak single-word anchors that create a huge implausible jump
    // relative to both neighboring anchors.
    for (let i = 0; i < anchors.length; i++) {
        const a = anchors[i];
        if (!a || a.hitCount > 1 || lines[i].tokens.length < 4)
            continue;
        let prevIdx = i - 1;
        while (prevIdx >= 0 && !anchors[prevIdx])
            prevIdx--;
        let nextIdx = i + 1;
        while (nextIdx < anchors.length && !anchors[nextIdx])
            nextIdx++;
        if (prevIdx >= 0 && nextIdx < anchors.length) {
            const span = anchors[nextIdx].start - anchors[prevIdx].end;
            if (span > 0 && (a.start - anchors[prevIdx].end > 25 && anchors[nextIdx].start - a.end < 1.5))
                anchors[i] = null;
        }
    }

    const anchoredIndices = [];
    for (let i = 0; i < anchors.length; i++) {
        if (anchors[i])
            anchoredIndices.push(i);
    }
    if (!anchoredIndices.length)
        return {ok: false, reason: 'no-anchors', coverage};

    // Interpolate unmatched lines smoothly between anchored neighbors.
    const resolved = anchors.map(a => (a ? {...a} : null));
    const weightOf = idx => Math.max(3, lines[idx].text.length);

    // Leading unmatched lines before the first anchor.
    const firstAnchor = anchoredIndices[0];
    if (firstAnchor > 0) {
        let totalWords = 0;
        for (let i = 0; i < firstAnchor; i++)
            totalWords += lines[i].tokens.length;
        const estDuration = Math.min(resolved[firstAnchor].start, totalWords * 0.35);
        const startAt = Math.max(0, resolved[firstAnchor].start - estDuration);
        const span = Math.max(0.2 * firstAnchor, resolved[firstAnchor].start - startAt);
        let weightSum = 0;
        for (let i = 0; i < firstAnchor; i++)
            weightSum += weightOf(i);
        let acc = 0;
        for (let i = 0; i < firstAnchor; i++) {
            const w = weightOf(i);
            const s = startAt + (acc / weightSum) * span;
            acc += w;
            const e = startAt + (acc / weightSum) * span;
            resolved[i] = {start: s, end: Math.max(s + 0.3, e - 0.1)};
        }
    }

    // Interior gaps between consecutive anchors.
    for (let k = 0; k < anchoredIndices.length - 1; k++) {
        const left = anchoredIndices[k];
        const right = anchoredIndices[k + 1];
        if (right - left <= 1)
            continue;
        const startAt = Math.min(resolved[right].start, resolved[left].end + 0.15);
        const span = Math.max(0.2 * (right - left - 1), resolved[right].start - startAt);
        let weightSum = 0;
        for (let i = left + 1; i < right; i++)
            weightSum += weightOf(i);
        let acc = 0;
        for (let i = left + 1; i < right; i++) {
            const w = weightOf(i);
            const s = startAt + (acc / weightSum) * span;
            acc += w;
            const e = startAt + (acc / weightSum) * span;
            resolved[i] = {start: s, end: Math.max(s + 0.3, e - 0.1)};
        }
    }

    // Trailing unmatched lines after the last anchor.
    const lastAnchor = anchoredIndices[anchoredIndices.length - 1];
    if (lastAnchor < lines.length - 1) {
        const startAt = resolved[lastAnchor].end + 0.25;
        let totalWords = 0;
        for (let i = lastAnchor + 1; i < lines.length; i++)
            totalWords += lines[i].tokens.length;
        const estSpan = Math.min(Math.max(1, audioEnd - startAt), totalWords * 0.38);
        let weightSum = 0;
        for (let i = lastAnchor + 1; i < lines.length; i++)
            weightSum += weightOf(i);
        let acc = 0;
        for (let i = lastAnchor + 1; i < lines.length; i++) {
            const w = weightOf(i);
            const s = startAt + (acc / weightSum) * estSpan;
            acc += w;
            const e = startAt + (acc / weightSum) * estSpan;
            resolved[i] = {start: s, end: Math.max(s + 0.3, e - 0.1)};
        }
    }

    // Enforce strictly non-decreasing timestamps and valid line durations.
    const timedLines = [];
    for (let i = 0; i < lines.length; i++) {
        let start = Math.max(0, resolved[i].start);
        if (i > 0 && start < timedLines[i - 1].start + 0.15)
            start = timedLines[i - 1].start + 0.15;
        const end = Math.max(start + 0.3, resolved[i].end);
        timedLines.push({start, end, text: lines[i].text});
    }

    return {
        ok: true,
        mode: 'aligned',
        lrc: formatTimedLrc(timedLines, durationSeconds),
        plainText: lines.map(l => l.text).join('\n'),
        coverage: Math.round(coverage * 1000) / 1000,
        lineCoverage: Math.round((anchoredIndices.length / lines.length) * 1000) / 1000,
        lineCount: timedLines.length,
    };
}

function joinRawWords(wordGroup) {
    const pieces = [];
    for (const w of wordGroup) {
        if (!w.raw)
            continue;
        if (!pieces.length) {
            pieces.push(w.raw);
        } else if (CJK_CHAR.test(w.raw[0]) && CJK_CHAR.test(pieces[pieces.length - 1].slice(-1))) {
            pieces[pieces.length - 1] += w.raw;
        } else if (/^[,.;:!?)]/u.test(w.raw)) {
            pieces[pieces.length - 1] += w.raw;
        } else {
            pieces.push(w.raw);
        }
    }
    return pieces.join(' ').replace(/\s+/gu, ' ').trim();
}

function splitChunkIntoLines(wordGroup) {
    const visible = wordGroup.filter(w => w.raw);
    if (!visible.length)
        return [];
    const text = joinRawWords(visible);
    if (text.length <= MAX_LINE_CHARS && visible.length <= MAX_LINE_WORDS)
        return [{start: visible[0].start, end: visible[visible.length - 1].end, text}];

    // Split near the middle, preferring the largest inter-word pause or punctuation.
    let bestSplit = Math.floor(visible.length / 2);
    let bestWeight = -Infinity;
    const mid = visible.length / 2;
    for (let i = 1; i < visible.length; i++) {
        const balance = 1 - Math.abs(i - mid) / mid;
        const gap = Math.max(0, visible[i].start - visible[i - 1].end);
        const punct = /[,.;:!?—-]$/u.test(visible[i - 1].raw) ? 0.6 : 0;
        const weight = balance * 0.7 + Math.min(gap, 1.5) * 1.4 + punct;
        if (weight > bestWeight) {
            bestWeight = weight;
            bestSplit = i;
        }
    }
    return [
        ...splitChunkIntoLines(visible.slice(0, bestSplit)),
        ...splitChunkIntoLines(visible.slice(bestSplit)),
    ];
}

/**
 * Mode B: Formats cleaned Whisper segments into singable timed LRC lines
 * when no plain lyrics exist on LRCLIB (or plain lyrics didn't match).
 * @returns {{ok: true, mode: 'transcribed', lrc: string, plainText: string, lineCount: number}
 *          |{ok: false, reason: string}}
 */
export function buildTranscribedLyrics(segments, durationSeconds = 0) {
    const {segments: cleanSegments} = extractTimedWords(segments);
    if (!cleanSegments.length)
        return {ok: false, reason: 'no-vocals'};

    const rawLines = [];
    for (const seg of cleanSegments) {
        const visible = seg.words.filter(w => w.raw);
        if (!visible.length)
            continue;
        let current = [visible[0]];
        for (let i = 1; i < visible.length; i++) {
            const prev = visible[i - 1];
            const curr = visible[i];
            const pause = curr.start - prev.end;
            const punctBreak = /[.!?]$/u.test(prev.raw) && current.length >= 3;
            const softPunctBreak = /[,;—]$/u.test(prev.raw) && current.length >= 5;
            if (pause >= PHRASE_PAUSE_SECONDS || punctBreak || softPunctBreak) {
                rawLines.push(...splitChunkIntoLines(current));
                current = [curr];
            } else {
                current.push(curr);
            }
        }
        rawLines.push(...splitChunkIntoLines(current));
    }

    // Merge tiny trailing 1-word fragments back when tightly adjacent.
    const merged = [];
    for (const line of rawLines) {
        const prev = merged[merged.length - 1];
        if (prev && line.text.length <= 8 && !/\s/u.test(line.text) &&
            line.start - prev.end < 0.22 && prev.text.length + line.text.length + 1 <= MAX_LINE_CHARS) {
            prev.text = `${prev.text} ${line.text}`;
            prev.end = Math.max(prev.end, line.end);
        } else {
            merged.push({...line});
        }
    }

    // Enforce strictly non-decreasing timestamps.
    for (let i = 1; i < merged.length; i++) {
        if (merged[i].start < merged[i - 1].start + 0.15)
            merged[i].start = merged[i - 1].start + 0.15;
        if (merged[i].end < merged[i].start + 0.25)
            merged[i].end = merged[i].start + 0.25;
    }

    if (merged.length < 2)
        return {ok: false, reason: 'no-vocals'};

    return {
        ok: true,
        mode: 'transcribed',
        lrc: formatTimedLrc(merged, durationSeconds),
        plainText: merged.map(l => l.text).join('\n'),
        lineCount: merged.length,
    };
}

/**
 * Top-level entry point: aligns plain lyrics when available and well-matched,
 * otherwise builds singable timed lines directly from Whisper's transcript.
 */
export function generateLrcFromTranscript({segments, duration = 0, plainLyrics = ''}) {
    const trimmedPlain = String(plainLyrics ?? '').trim();
    if (trimmedPlain) {
        const aligned = alignPlainLyrics(trimmedPlain, segments, duration);
        if (aligned.ok)
            return aligned;
    }
    return buildTranscribedLyrics(segments, duration);
}
