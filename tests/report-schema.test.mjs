import test from 'node:test';
import assert from 'node:assert/strict';

import {
    isReportError, parseCommandResult, parseGone, parseReport,
} from '../service/report-schema.js';

const NOW = 1_800_000_000_000;

const media = overrides => ({
    videoId: 'dQw4w9WgXcQ', currentTime: 12.5, duration: 213, paused: false, ended: false, stalled: false,
    playbackRate: 1, muted: false, volume: 1, adShowing: false, ...overrides,
});

const metadata = overrides => ({
    host: 'www.youtube.com', videoId: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up', author: 'Rick Astley - Topic',
    lengthSeconds: 213, category: 'Music', musicVideoType: 'MUSIC_VIDEO_TYPE_ATV', description: 'Provided to YouTube by X',
    musicCards: [], mediaSession: {title: 'Never Gonna Give You Up', artist: 'Rick Astley', album: ''}, ytmByline: '',
    ...overrides,
});

const report = overrides => ({tabId: 3, sampledAt: NOW, heartbeatMs: 5000, media: media(), ...overrides});

function refused(body, pattern) {
    assert.throws(() => parseReport(body, NOW), error => isReportError(error) && pattern.test(error.message));
}

test('a complete report passes through with its fields', () => {
    const next = {host: 'music.youtube.com', videoId: 'yPYZpwSpKmA', title: 'Together Forever', byline: 'Rick Astley', durationSeconds: 205};
    const parsed = parseReport(report({metadata: metadata(), next}), NOW);
    assert.equal(parsed.tabId, 3);
    assert.deepEqual(parsed.message.media, media());
    assert.equal(parsed.message.metadata.author, 'Rick Astley - Topic');
    assert.deepEqual(parsed.message.next, next);
});

test('metadata and next are optional; next and the media session may be null', () => {
    assert.deepEqual(Object.keys(parseReport(report(), NOW).message), ['sampledAt', 'heartbeatMs', 'media']);
    assert.equal(parseReport(report({heartbeatMs: null}), NOW).message.heartbeatMs, null, 'a paused video promises no heartbeat');
    assert.equal(parseReport(report({next: null}), NOW).message.next, null);
    assert.equal(parseReport(report({metadata: metadata({mediaSession: null})}), NOW).message.metadata.mediaSession, null);
    assert.equal(parseReport(report({media: media({videoId: null})}), NOW).message.media.videoId, null);
});

test('long text is cut and only the first five music cards are kept', () => {
    const cards = Array.from({length: 8}, (_, index) => ({title: `Song ${index}`, artist: 'A', album: 'B'}));
    const parsed = parseReport(report({metadata: metadata({title: 'x'.repeat(1000), description: 'y'.repeat(9000), musicCards: cards})}), NOW);
    assert.equal(parsed.message.metadata.title.length, 400);
    assert.equal(parsed.message.metadata.description.length, 5000);
    assert.deepEqual(parsed.message.metadata.musicCards.map(card => card.title), ['Song 0', 'Song 1', 'Song 2', 'Song 3', 'Song 4']);
});

test('malformed reports are refused with the field named', () => {
    refused(null, /report must be an object/u);
    refused(report({tabId: -1}), /tabId/u);
    refused(report({tabId: 1.5}), /tabId/u);
    refused(report({sampledAt: NOW - 11 * 60 * 1000}), /sampledAt is not a current time/u);
    refused(report({sampledAt: Number.NaN}), /sampledAt must be a finite number/u);
    refused(report({heartbeatMs: undefined}), /heartbeatMs must be null or a whole number/u);
    refused(report({heartbeatMs: 500}), /heartbeatMs/u);
    refused(report({heartbeatMs: 5000.5}), /heartbeatMs/u);
    refused(report({heartbeatMs: '5000'}), /heartbeatMs/u);
    refused(report({media: undefined}), /media is missing/u);
    refused(report({media: media({videoId: 'bad id!'})}), /media\.videoId/u);
    refused(report({media: media({paused: 'no'})}), /media\.paused must be true or false/u);
    refused(report({media: media({currentTime: Number.POSITIVE_INFINITY})}), /media\.currentTime/u);
    refused(report({metadata: metadata({host: 'example.com'})}), /metadata\.host is not a YouTube host/u);
    refused(report({metadata: metadata({musicCards: 'none'})}), /metadata\.musicCards must be a list/u);
    refused(report({metadata: metadata({musicCards: [{title: 'Song', artist: 3, album: ''}]})}), /musicCards\[0\]\.artist/u);
    refused(report({next: {host: 'www.youtube.com', videoId: 'yPYZpwSpKmA', title: 'T', byline: 'B', durationSeconds: '3:25'}}), /next\.durationSeconds/u);
});

test('gone messages carry only a tab id', () => {
    assert.equal(parseGone({tabId: 9}), 9);
    assert.throws(() => parseGone({tabId: 'nine'}), error => isReportError(error));
    assert.equal(isReportError(new Error('other')), false);
});

test('a command result names its window exactly, or why the tab could not be selected', () => {
    const title = '(2) Song - YouTube — Mozilla Firefox';
    assert.deepEqual(parseCommandResult({id: 4, ok: true, windowTitle: title}), {id: 4, result: {ok: true, windowTitle: title}});
    assert.deepEqual(parseCommandResult({id: 4, ok: false, error: 'Invalid tab ID: 12'}), {id: 4, result: {ok: false, error: 'Invalid tab ID: 12'}});
    const refusedResult = (body, pattern) => assert.throws(() => parseCommandResult(body),
        error => isReportError(error) && pattern.test(error.message));
    refusedResult(null, /must be an object/u);
    refusedResult({id: 0, ok: true, windowTitle: title}, /id must be a positive integer/u);
    refusedResult({id: 4, ok: 'yes', windowTitle: title}, /ok must be true or false/u);
    refusedResult({id: 4, ok: true, windowTitle: ''}, /windowTitle/u);
    // Cut short, a title would match no window.
    refusedResult({id: 4, ok: true, windowTitle: 'x'.repeat(4001)}, /windowTitle/u);
    refusedResult({id: 4, ok: false}, /error must be text/u);
});