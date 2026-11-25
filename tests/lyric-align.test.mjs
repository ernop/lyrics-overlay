import assert from 'node:assert/strict';
import test from 'node:test';

import {parseSyncedLyrics} from '../shared/lrc.js';
import {
    alignPlainLyrics, buildTranscribedLyrics, formatLrcTimestamp,
    generateLrcFromTranscript, parsePlainLines, tokenizeWords,
} from '../shared/lyric-align.js';

function makeSegment(start, words, opts = {}) {
    let t = start;
    const timed = words.map(entry => {
        const [word, dur = 0.35, gap = 0.05, prob = 0.9] = Array.isArray(entry) ? entry : [entry];
        const s = t;
        const e = s + dur;
        t = e + gap;
        return {start: s, end: e, word, probability: prob};
    });
    return {
        start: timed[0]?.start ?? start,
        end: timed[timed.length - 1]?.end ?? start,
        text: timed.map(w => w.word).join(' '),
        no_speech_prob: opts.no_speech_prob ?? 0.02,
        words: timed,
    };
}

test('formatLrcTimestamp rounds cleanly without 60-second rollover bugs', () => {
    assert.equal(formatLrcTimestamp(-2), '[00:00.00]');
    assert.equal(formatLrcTimestamp(0), '[00:00.00]');
    assert.equal(formatLrcTimestamp(12.346), '[00:12.35]');
    assert.equal(formatLrcTimestamp(59.996), '[01:00.00]');
    assert.equal(formatLrcTimestamp(125.05), '[02:05.05]');
});

test('tokenizeWords normalizes accents, apostrophes, punctuation and CJK characters', () => {
    assert.deepEqual(tokenizeWords("Don't stop, Café!"), ['dont', 'stop', 'cafe']);
    assert.deepEqual(tokenizeWords('さくらが咲く'), ['さ', 'く', 'ら', 'が', '咲', 'く']);
});

test('parsePlainLines skips structural section headings while preserving lyric lines', () => {
    const lines = parsePlainLines('[Verse 1]\nHello world\n\n(Chorus)\nSing along now\nBridge:\nFade out');
    assert.deepEqual(lines.map(l => l.text), ['Hello world', 'Sing along now', 'Fade out']);
});

test('alignPlainLyrics aligns plain lyrics onto Whisper words despite spoken intro, misheard words, repeated choruses and instrumental breaks', () => {
    const plain = [
        '[Verse 1]',
        'Standing by the river in the rain',
        'Calling out your gentle name',
        '',
        '[Chorus]',
        'Carry me home tonight',
        'Carry me home tonight',
        '',
        '[Verse 2]',
        'Shadows fade into the morning light',
        '',
        '[Chorus]',
        'Carry me home tonight',
    ].join('\n');

    const segments = [
        // Spoken intro banter before the music starts
        makeSegment(1.0, ['Hey', 'everybody', 'thanks', 'for', 'coming', 'out', 'tonight']),
        // Verse 1 with a misheard word ("rivers" / "jentle")
        makeSegment(12.0, ['Standing', 'by', 'the', 'rivers', 'in', 'the', 'rain']),
        makeSegment(16.0, ['Calling', 'out', 'your', 'jentle', 'name']),
        // First chorus
        makeSegment(20.0, ['Carry', 'me', 'home', 'tonight']),
        makeSegment(24.0, ['Carry', 'me', 'home', 'tonight']),
        // Long instrumental break (~15 s), then Verse 2 where Whisper missed a couple words
        makeSegment(42.0, ['Shadows', 'fade', 'the', 'morning', 'light']),
        // Second chorus
        makeSegment(48.0, ['Carry', 'me', 'home', 'tonight']),
        // Trailing spoken outro
        makeSegment(55.0, ['Thank', 'you', 'so', 'much', 'everybody']),
    ];

    const result = alignPlainLyrics(plain, segments, 65);
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'aligned');
    assert.ok(result.coverage >= 0.85, `expected high coverage, got ${result.coverage}`);
    assert.equal(result.lineCount, 6);

    const parsed = parseSyncedLyrics(result.lrc);
    const nonEmpty = parsed.filter(l => l.text);
    assert.deepEqual(nonEmpty.map(l => l.text), [
        'Standing by the river in the rain',
        'Calling out your gentle name',
        'Carry me home tonight',
        'Carry me home tonight',
        'Shadows fade into the morning light',
        'Carry me home tonight',
    ]);
    // Verse 1 starts right around 12 s (NOT pulled to the 1 s spoken intro!)
    assert.ok(Math.abs(nonEmpty[0].time - 12.0) < 0.25, `got ${nonEmpty[0].time}`);
    // First chorus lines at ~20 s and ~24 s; second chorus at ~48 s
    assert.ok(Math.abs(nonEmpty[2].time - 20.0) < 0.25, `got ${nonEmpty[2].time}`);
    assert.ok(Math.abs(nonEmpty[3].time - 24.0) < 0.25, `got ${nonEmpty[3].time}`);
    assert.ok(Math.abs(nonEmpty[4].time - 42.0) < 0.25, `got ${nonEmpty[4].time}`);
    assert.ok(Math.abs(nonEmpty[5].time - 48.0) < 0.25, `got ${nonEmpty[5].time}`);
    // Instrumental break between 25.5 s and 42 s gets a blank line marker so countdown triggers
    const blanks = parsed.filter(l => !l.text);
    assert.ok(blanks.some(b => b.time > 25 && b.time < 40), JSON.stringify(parsed));
});

test('alignPlainLyrics interpolates an entirely missed line monotonically between matched neighbors', () => {
    const plain = [
        'First line is loud and clear',
        'Second line gets buried in guitars',
        'Third line comes back strong',
    ].join('\n');
    const segments = [
        makeSegment(10.0, ['First', 'line', 'is', 'loud', 'and', 'clear']),
        // Second line missing from ASR completely
        makeSegment(20.0, ['Third', 'line', 'comes', 'back', 'strong']),
    ];
    const result = alignPlainLyrics(plain, segments, 30);
    assert.equal(result.ok, true);
    const nonEmpty = parseSyncedLyrics(result.lrc).filter(l => l.text);
    assert.equal(nonEmpty.length, 3);
    assert.ok(nonEmpty[0].time < nonEmpty[1].time && nonEmpty[1].time < nonEmpty[2].time, JSON.stringify(nonEmpty));
    assert.ok(nonEmpty[1].time > 12 && nonEmpty[1].time < 19, JSON.stringify(nonEmpty));
});

test('alignPlainLyrics supports CJK lyrics without spaces', () => {
    const plain = 'さくらが咲く\n風が吹く';
    const segments = [
        makeSegment(5.0, ['さくら', 'が', '咲く']),
        makeSegment(10.0, ['風', 'が', '吹く']),
    ];
    const result = alignPlainLyrics(plain, segments, 20);
    assert.equal(result.ok, true);
    const nonEmpty = parseSyncedLyrics(result.lrc).filter(l => l.text);
    assert.deepEqual(nonEmpty.map(l => l.text), ['さくらが咲く', '風が吹く']);
    assert.ok(Math.abs(nonEmpty[0].time - 5.0) < 0.25);
    assert.ok(Math.abs(nonEmpty[1].time - 10.0) < 0.25);
});

test('generateLrcFromTranscript falls back to transcribed lines when plainLyrics is the wrong song', () => {
    const wrongPlain = 'Completely unrelated opera words\nNothing in common whatsoever\nNever sung in this audio';
    const segments = [
        makeSegment(8.0, ['Driving', 'down', 'the', 'coast', 'at', 'midnight']),
        makeSegment(13.0, ['Radio', 'playing', 'our', 'old', 'song']),
    ];
    const result = generateLrcFromTranscript({segments, duration: 30, plainLyrics: wrongPlain});
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'transcribed');
    const nonEmpty = parseSyncedLyrics(result.lrc).filter(l => l.text);
    assert.deepEqual(nonEmpty.map(l => l.text), [
        'Driving down the coast at midnight',
        'Radio playing our old song',
    ]);
});

test('buildTranscribedLyrics filters hallucinations, splits long segments on pauses and adds instrumental blanks', () => {
    const segments = [
        makeSegment(0.5, ['[Music]'], {no_speech_prob: 0.9}),
        makeSegment(2.0, ['Thank', 'you', 'for', 'watching'], {no_speech_prob: 0.6}),
        makeSegment(10.0, [
            ['Walking', 0.3, 0.05], ['through', 0.3, 0.05], ['the', 0.2, 0.05], ['quiet', 0.3, 0.05], ['street', 0.3, 0.9],
            ['Underneath', 0.3, 0.05], ['the', 0.2, 0.05], ['silver', 0.3, 0.05], ['moon', 0.4, 0.05],
        ]),
        makeSegment(25.0, ['Waiting', 'for', 'the', 'sun', 'to', 'rise']),
        makeSegment(32.0, ['Subtitles', 'by', 'Amara.org']),
    ];
    const result = buildTranscribedLyrics(segments, 40);
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'transcribed');
    const parsed = parseSyncedLyrics(result.lrc);
    const nonEmpty = parsed.filter(l => l.text);
    assert.deepEqual(nonEmpty.map(l => l.text), [
        'Walking through the quiet street',
        'Underneath the silver moon',
        'Waiting for the sun to rise',
    ]);
    assert.ok(parsed.some(l => !l.text && l.time > 13 && l.time < 22), 'blank marker during instrumental gap');
});

test('buildTranscribedLyrics reports no-vocals for purely instrumental or hallucinated audio', () => {
    const segments = [
        makeSegment(1.0, ['Thank', 'you', 'for', 'watching'], {no_speech_prob: 0.7}),
        makeSegment(20.0, ['you'], {no_speech_prob: 0.65, words: [{start: 20, end: 20.4, word: 'you', probability: 0.2}]}),
    ];
    const result = buildTranscribedLyrics(segments, 120);
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no-vocals');
});

test('alignPlainLyrics fuses isolated-vocal timestamps with referenceSyncedLyrics preserving unmatched relative spacing', () => {
    const referenceLrc = [
        '[00:10.00] First line loud and clear',
        '[00:13.00] Buried backing phrase here',
        '[00:19.00] Final chorus comes back strong',
    ].join('\n');
    // Video has a +2.0 s intro offset compared to the studio reference; middle line missed by ASR.
    const segments = [
        makeSegment(12.0, ['First', 'line', 'loud', 'and', 'clear']),
        makeSegment(21.0, ['Final', 'chorus', 'comes', 'back', 'strong']),
    ];
    const result = generateLrcFromTranscript({
        segments,
        duration: 30,
        referenceSyncedLyrics: referenceLrc,
    });
    assert.equal(result.ok, true);
    assert.equal(result.mode, 'aligned');
    const nonEmpty = parseSyncedLyrics(result.lrc).filter(l => l.text);
    assert.deepEqual(nonEmpty.map(l => l.text), [
        'First line loud and clear',
        'Buried backing phrase here',
        'Final chorus comes back strong',
    ]);
    assert.ok(Math.abs(nonEmpty[0].time - 12.0) < 0.25, `first matched line at ~12 s, got ${nonEmpty[0].time}`);
    assert.ok(Math.abs(nonEmpty[2].time - 21.0) < 0.25, `third matched line at ~21 s, got ${nonEmpty[2].time}`);
    // Reference had line 2 at 1/3 of the way between 10 s and 19 s -> 12 + (3/9)*9 = 15.0 s!
    assert.ok(Math.abs(nonEmpty[1].time - 15.0) < 0.4, `unmatched middle line preserves 1/3 reference ratio (~15 s), got ${nonEmpty[1].time}`);
});
