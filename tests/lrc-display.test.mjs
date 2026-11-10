import test from 'node:test';
import assert from 'node:assert/strict';

import {parseSyncedLyrics} from '../shared/lrc.js';
import {
    LAST_LINE_HOLD_SECONDS, displayAt, lineIndexAt, nudgedOffset, titleLineIndexAt,
} from '../shared/lyric-display.js';

test('LRC parsing handles fractions, repeated tags, word tags and metadata', () => {
    const lines = parseSyncedLyrics([
        '[ar:Someone]',
        '[00:05.5] Five and a half',
        '[00:01.05]<00:01.05>Word <00:01.50>timed',
        '[00:10.00][00:20.000]Chorus',
        '[01:02]',
        'no tag',
    ].join('\n'));
    assert.deepEqual(lines, [
        {time: 1.05, text: 'Word timed'},
        {time: 5.5, text: 'Five and a half'},
        {time: 10, text: 'Chorus'},
        {time: 20, text: 'Chorus'},
        {time: 62, text: ''},
    ]);
});

test('a credits block at the end parses as blank lines, keeping its times', () => {
    // The layout of a real LRCLIB file: last line, end marker, a bare
    // heading, the names under it, and a final end marker.
    const lines = parseSyncedLyrics([
        '[03:58.00]Last sung line',
        '[04:01.00]',
        '[04:03.00]SONGWRITERS',
        '[04:05.00]SOMEONE, A / OTHER, B',
        '[04:05.50]',
    ].join('\n'));
    assert.deepEqual(lines, [
        {time: 238, text: 'Last sung line'},
        {time: 241, text: ''},
        {time: 243, text: ''},
        {time: 245, text: ''},
        {time: 245.5, text: ''},
    ]);
});

test('labelled credit lines are blanked; words a lyric could sing alone are kept', () => {
    const texts = parseSyncedLyrics([
        '[00:00.00]作词 : 某人',
        '[00:01.00]作曲：某人',
        '[00:02.00]Written by: Someone',
        '[00:03.00]Music by Someone Else',
        '[00:04.00]Music',
        '[00:05.00]Lyrics: Someone',
        '[00:06.00]Producer: Someone',
        '[00:07.00]Songwriters are liars',
        '[00:08.00]Source',
    ].join('\n')).map(line => line.text);
    assert.deepEqual(texts, ['', '', '', 'Music by Someone Else', 'Music', '', '', 'Songwriters are liars', 'Source']);
});

test('a bare heading blanks the names under it only up to the next blank line', () => {
    const texts = parseSyncedLyrics([
        '[00:01.00]Composer',
        '[00:02.00]Somebody',
        '[00:03.00]',
        '[00:04.00]First sung line',
    ].join('\n')).map(line => line.text);
    assert.deepEqual(texts, ['', '', '', 'First sung line']);
});

test('line index uses the last line at or before a time', () => {
    const lines = [{time: 1, text: 'a'}, {time: 2, text: 'b'}, {time: 3, text: 'c'}];
    assert.equal(lineIndexAt(lines, 0.5), -1);
    assert.equal(lineIndexAt(lines, 2), 1);
    assert.equal(lineIndexAt(lines, 9), 2);
});

test('title line skips blanks forward and is -1 once nothing more is sung', () => {
    const lines = [{time: 1, text: 'a'}, {time: 2, text: ''}, {time: 3, text: 'c'}, {time: 4, text: ''}];
    assert.equal(titleLineIndexAt(lines, 1), 2);
    assert.equal(titleLineIndexAt(lines, 3), -1);
    assert.equal(titleLineIndexAt(lines, -1), 0);
});

test('offset nudges round to tenths', () => {
    assert.equal(nudgedOffset(0.1, 0.5), 0.6);
    assert.equal(nudgedOffset(0.6, -0.5), 0.1);
});

const song = [
    {time: 10, text: 'First line'},
    {time: 12, text: 'Second line'},
    {time: 14, text: ''},
    {time: 20, text: 'After the break'},
    {time: 23, text: ''},
];

const at = (mediaTime, offsetSeconds = 0) => displayAt({lines: song, offsetSeconds, mediaTime});

test('the intro counts down whole seconds to the first line from the start', () => {
    assert.deepEqual(at(0), {text: '10 First line', key: 'line:0', nextChangeAt: 1});
    assert.equal(at(8.5).text, '2 First line');
    assert.equal(at(9.1).text, '1 First line');
    assert.equal(at(9.1).nextChangeAt, 10 - 0.75);
});

test('lines are led by 0.75 seconds', () => {
    assert.equal(at(9.25).text, 'First line');
    assert.equal(at(11.24).text, 'First line');
    assert.equal(at(11.25).text, 'Second line');
    assert.equal(at(11.25).nextChangeAt, 13.25);
});

test('a long instrumental gap counts down to the next line', () => {
    assert.equal(at(13.5).text, '7 After the break');
    assert.equal(at(13.5).key, 'line:3');
    assert.equal(at(13.5).nextChangeAt, 14);
    assert.equal(at(19.3).text, 'After the break');
});

test('after the end marker of the last line nothing is shown', () => {
    assert.equal(at(22.24).text, 'After the break');
    assert.equal(at(22.24).nextChangeAt, 22.25);
    assert.deepEqual(at(22.25), {text: '', key: 'none', nextChangeAt: Infinity});
    assert.deepEqual(at(500), {text: '', key: 'none', nextChangeAt: Infinity});
});

test('a final line without an end marker holds for a bounded time, then clears', () => {
    const lines = [{time: 10, text: 'Only line'}];
    const shown = displayAt({lines, offsetSeconds: 0, mediaTime: 12});
    assert.deepEqual(shown, {text: 'Only line', key: 'line:0', nextChangeAt: 10 + LAST_LINE_HOLD_SECONDS});
    assert.deepEqual(displayAt({lines, offsetSeconds: 0, mediaTime: 10 + LAST_LINE_HOLD_SECONDS}),
        {text: '', key: 'none', nextChangeAt: Infinity});
});

test('a credits block never reaches the display', () => {
    const lines = parseSyncedLyrics('[03:58.00]Last sung line\n[04:01.00]\n[04:03.00]SONGWRITERS\n[04:05.00]A / B\n[04:05.00]');
    assert.equal(displayAt({lines, offsetSeconds: 0, mediaTime: 239}).text, 'Last sung line');
    for (const mediaTime of [240.25, 242.5, 244, 246])
        assert.equal(displayAt({lines, offsetSeconds: 0, mediaTime}).text, '');
});

test('a positive offset shows lines earlier', () => {
    assert.equal(at(10.75, 0.5).text, 'Second line');
    assert.equal(at(10.74, 0.5).text, 'First line');
});

test('no lines shows nothing', () => {
    assert.deepEqual(displayAt({lines: [], offsetSeconds: 0, mediaTime: 1}), {text: '', key: 'none', nextChangeAt: Infinity});
});
