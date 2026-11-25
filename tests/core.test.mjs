import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {ERROR_RECHECK_MS, LyricsCore, MISSED_HEARTBEATS, SOUNDING_GRACE_MS} from '../service/core.js';
import {ProviderRateLimit} from '../shared/budget.js';

// The content script's heartbeat while its video runs (firefox/content.js).
const HEARTBEAT_MS = 5000;

test('the content script keeps the timing this core relies on', () => {
    const source = fs.readFileSync(new URL('../firefox/content.js', import.meta.url), 'utf8');
    const constant = name => Number(source.match(new RegExp(`const ${name} = ([\\d_]+);`, 'u'))[1].replaceAll('_', ''));
    assert.equal(constant('HEARTBEAT_MS'), HEARTBEAT_MS);
    assert.equal(constant('STOPPED_SHOWN_MS'), SOUNDING_GRACE_MS,
        'the background page must stay up while a stopped song is on screen');
});

const TOPIC = `Provided to YouTube by Label

Song One · Band

Album One

℗ 1999 Label`;

const LRC = ['[00:10.00] First line', '[00:12.00] Second line', '[00:14.00]', '[00:20.00] After the break'].join('\n');

function record(id, overrides = {}) {
    return {id, trackName: 'Song One', artistName: 'Band', albumName: 'Album One', duration: 200,
        instrumental: false, plainLyrics: 'First line', syncedLyrics: LRC, ...overrides};
}

/**
 * @param {{answers?: Record<string, object[]|Error|(() => Promise<object[]>|object[])>,
 *          budgetWindows?: ReadonlyArray<{seconds: number, limit: number}>}} options
 *        LRCLIB answers by "artist|title"; a function answers each search itself
 */
function harness({answers = {}, budgetWindows, generate, maxGenerateDurationSeconds} = {}) {
    let now = 1_700_000_000_000;
    const pending = [];
    const searches = [];
    const states = [];
    const presences = [];
    const updatedVideos = [];
    const lines = [];
    const logs = [];
    const saved = {videos: new Map(), searches: new Map(), budget: null, videoWrites: 0};
    const store = {
        loadVideo: id => (saved.videos.has(id) ? structuredClone(saved.videos.get(id)) : null),
        saveVideo: rec => {
            saved.videoWrites++;
            saved.videos.set(rec.videoId, structuredClone(rec));
        },
        loadSearch: key => saved.searches.get(key) ?? null,
        saveSearch: (key, entry) => saved.searches.set(key, entry),
        loadBudget: () => saved.budget,
        saveBudget: state => { saved.budget = state; },
    };
    let nextHandle = 1;
    const timers = {
        set(callback, delayMs) {
            const handle = nextHandle++;
            pending.push({handle, at: now + delayMs, callback});
            return handle;
        },
        clear(handle) {
            const index = pending.findIndex(timer => timer.handle === handle);
            if (index >= 0)
                pending.splice(index, 1);
        },
    };
    const core = new LyricsCore({
        store,
        search: async candidate => {
            searches.push(`${candidate.artist}|${candidate.title}`);
            const given = answers[`${candidate.artist}|${candidate.title}`] ?? [];
            const answer = typeof given === 'function' ? await given() : given;
            if (answer instanceof Error)
                throw answer;
            return structuredClone(answer);
        },
        clock: {now: () => now},
        timers,
        emit: {
            state: state => states.push(state),
            presence: presence => presences.push(presence),
            videoUpdated: videoId => updatedVideos.push(videoId),
            line: line => lines.push(line),
        },
        log: message => logs.push(message),
        budgetWindows,
        generate,
        maxGenerateDurationSeconds,
    });
    const flush = () => new Promise(resolve => setImmediate(resolve));
    return {
        core, searches, states, presences, updatedVideos, lines, logs, saved, flush,
        /** Reports as the content script does: a running video promises a heartbeat. */
        report(tabId, message) {
            const running = !message.media.paused && !message.media.ended;
            core.report(tabId, {heartbeatMs: running ? HEARTBEAT_MS : null, ...message});
        },
        /** Lets a running video play on for ms, sending the heartbeats it promised. */
        async play(tabId, mediaState, ms) {
            const end = now + ms;
            while (now + HEARTBEAT_MS <= end) {
                await this.advance(HEARTBEAT_MS);
                const playedSeconds = (now - mediaState.sampledAt) / 1000;
                this.report(tabId, {sampledAt: now, media: {...mediaState.media, currentTime: mediaState.media.currentTime + playedSeconds}});
            }
            await this.advance(end - now);
        },
        get now() { return now; },
        async advance(ms) {
            const target = now + ms;
            for (;;) {
                pending.sort((a, b) => a.at - b.at);
                const due = pending[0];
                if (!due || due.at > target)
                    break;
                pending.shift();
                now = due.at;
                due.callback();
                await flush();
            }
            now = target;
            await flush();
        },
        lastState: () => states[states.length - 1],
        lastLine: () => lines[lines.length - 1],
    };
}

function metadata(videoId, overrides = {}) {
    return {host: 'www.youtube.com', videoId, title: 'Song One', author: 'Band - Topic', lengthSeconds: 200,
        category: 'Music', musicVideoType: '', description: TOPIC, musicCards: [], mediaSession: null, ytmByline: '', ...overrides};
}

function media(videoId, overrides = {}) {
    return {videoId, currentTime: 0, duration: 200, paused: false, ended: false, stalled: false,
        playbackRate: 1, muted: false, volume: 1, adShowing: false, ...overrides};
}

test('a Topic song is looked up once and its lines follow playback', async () => {
    const h = harness({answers: {'Band|Song One': [record(1)]}});
    h.report(7, {sampledAt: h.now, media: media('v1'), metadata: metadata('v1')});
    assert.equal(h.lastState().lyrics, 'searching');
    await h.flush();
    assert.deepEqual(h.searches, ['Band|Song One']);
    assert.deepEqual(h.logs, ['lookup v1: timed; 1 searched, 0 cached, 0 ms after 0 ms queued']);
    assert.equal(h.lastState().lyrics, 'timed');
    assert.equal(h.lastState().identityText, 'Band - Song One - 1999 - Album One');
    assert.deepEqual(h.lastLine(), {text: '10 First line', key: 'v1:line:0'});

    await h.advance(2100);
    assert.deepEqual(h.lastLine(), {text: '8 First line', key: 'v1:line:0'});
    await h.advance(7300);
    assert.equal(h.lastLine().text, 'First line');
    await h.advance(2000);
    assert.equal(h.lastLine().text, 'Second line');
    await h.advance(2300);
    assert.equal(h.lastLine().text, '7 After the break');
});

test('repeated metadata writes the video record only when the identity changes', async () => {
    const h = harness({answers: {'Band|Song One': [record(1)]}});
    h.report(7, {sampledAt: h.now, media: media('v1'), metadata: metadata('v1')});
    await h.flush();
    const writes = h.saved.videoWrites;
    await h.advance(15_000);
    h.report(7, {sampledAt: h.now, media: media('v1', {currentTime: 15}), metadata: metadata('v1')});
    await h.advance(15_000);
    h.report(7, {sampledAt: h.now, media: media('v1', {currentTime: 30}), metadata: metadata('v1')});
    await h.flush();
    assert.equal(h.saved.videoWrites, writes);
    h.report(7, {sampledAt: h.now, media: media('v1', {currentTime: 30}), metadata: metadata('v1', {lengthSeconds: 201})});
    assert.equal(h.saved.videoWrites, writes + 1);
    assert.equal(h.saved.videos.get('v1').identity.durationSeconds, 201);
});

test('a paused video freezes its line and keeps the indicator for the grace period', async () => {
    const h = harness({answers: {'Band|Song One': [record(1)]}});
    h.report(7, {sampledAt: h.now, media: media('v1'), metadata: metadata('v1')});
    await h.flush();
    await h.advance(11_000);
    h.report(7, {sampledAt: h.now, media: media('v1', {currentTime: 11, paused: true})});
    const frozen = h.lastLine();
    await h.advance(60_000);
    assert.deepEqual(h.lastLine(), frozen);
    assert.equal(h.lastState().active, true);
    assert.equal(h.lastState().sounding, false);
    assert.equal(h.core.activeTabId(), 7);
    await h.advance(SOUNDING_GRACE_MS);
    assert.equal(h.lastState().active, false);
    assert.equal(h.lastLine().text, '');
    assert.equal(h.core.activeTabId(), null);
});

test('an ended video shows no line, even while its indicator lingers', async () => {
    const h = harness({answers: {'Band|Song One': [record(1)]}});
    h.report(7, {sampledAt: h.now, media: media('v1'), metadata: metadata('v1')});
    await h.flush();
    await h.advance(11_000);
    assert.equal(h.lastLine().text, 'First line');
    h.report(7, {sampledAt: h.now, media: media('v1', {currentTime: 11, ended: true})});
    assert.deepEqual(h.lastLine(), {text: '', key: 'v1:none'});
    assert.equal(h.lastState().active, true);
});

test('a playing tab that breaks its heartbeat promise is dropped, and its lines stop with it', async () => {
    const h = harness({answers: {'Band|Song One': [record(1)]}});
    h.report(7, {sampledAt: h.now, media: media('v1'), metadata: metadata('v1')});
    await h.flush();
    await h.advance(MISSED_HEARTBEATS * HEARTBEAT_MS);
    assert.equal(h.lastState().active, true, 'the promise still holds');
    assert.match(h.lastLine().text, /After the break$/u, 'counting down to the next line');
    await h.advance(2);
    assert.equal(h.lastState().active, false);
    assert.equal(h.lastLine().text, '');
    await h.advance(SOUNDING_GRACE_MS);
    assert.equal(h.lastLine().text, '', 'the clock never runs on unreported');
});

test('heartbeats keep a playing tab, and a buffering stall still promises them', async () => {
    const h = harness({answers: {'Band|Song One': [record(1)]}});
    h.report(7, {sampledAt: h.now, media: media('v1'), metadata: metadata('v1')});
    await h.flush();
    for (let second = 4; second <= 60; second += 4) {
        await h.advance(4000);
        h.report(7, {sampledAt: h.now, media: media('v1', {currentTime: second, stalled: second > 30})});
    }
    assert.equal(h.lastState().active, true);
    assert.equal(h.lastState().sounding, true);
});

test('a tab that comes back after being dropped resumes from the stored lyrics', async () => {
    const h = harness({answers: {'Band|Song One': [record(1)]}});
    h.report(7, {sampledAt: h.now, media: media('v1'), metadata: metadata('v1')});
    await h.flush();
    await h.advance(MISSED_HEARTBEATS * HEARTBEAT_MS + 10);
    assert.equal(h.lastState().active, false);
    h.report(7, {sampledAt: h.now, media: media('v1', {currentTime: 12.5}), metadata: metadata('v1')});
    await h.flush();
    assert.equal(h.lastState().lyrics, 'timed');
    assert.equal(h.lastLine().text, 'Second line');
    assert.deepEqual(h.searches, ['Band|Song One'], 'no second search');
});

test('non-music videos are not looked up unless asked', async () => {
    const h = harness({answers: {'Speaker|Talk': [record(5, {trackName: 'Talk', artistName: 'Speaker'})]}});
    h.report(7, {sampledAt: h.now, media: media('v2'), metadata: metadata('v2', {title: 'Speaker - Talk', author: 'Speaker', category: 'Education', description: ''})});
    await h.flush();
    assert.deepEqual(h.searches, []);
    assert.equal(h.lastState().lyrics, 'not-music');
    assert.deepEqual(h.core.command({op: 'lookUp'}), {ok: true});
    await h.flush();
    assert.equal(h.searches.length > 0, true);
    assert.equal(h.lastState().lyrics, 'timed');
});

test('cached searches are reused across videos of the same song', async () => {
    const h = harness({answers: {'Band|Song One': [record(1)]}});
    h.report(7, {sampledAt: h.now, media: media('v1'), metadata: metadata('v1')});
    await h.flush();
    h.report(7, {sampledAt: h.now, media: media('v3'), metadata: metadata('v3')});
    await h.flush();
    assert.deepEqual(h.searches, ['Band|Song One']);
    assert.equal(h.lastState().lyrics, 'timed');
});

test('timing nudges, rejections and choices persist per video', async () => {
    const h = harness({answers: {'Band|Song One': [record(1), record(2, {albumName: 'Live', duration: 260})]}});
    h.report(7, {sampledAt: h.now, media: media('v1'), metadata: metadata('v1')});
    await h.flush();
    assert.equal(h.lastState().chosen.id, 1);

    h.core.command({op: 'tooFast'});
    h.core.command({op: 'tooFast'});
    h.core.command({op: 'tooSlow'});
    h.core.command({op: 'tooFast'});
    assert.equal(h.lastState().offsetSeconds, -1);
    assert.equal(h.saved.videos.get('v1').offsetSeconds, -1);

    h.core.command({op: 'reject'});
    assert.equal(h.lastState().chosen.id, 2);
    assert.deepEqual(h.saved.videos.get('v1').rejectedIds, [1]);

    h.core.command({op: 'choose', id: 1});
    assert.equal(h.lastState().chosen.id, 1);
    assert.equal(h.lastState().userChose, true);
    assert.deepEqual(h.saved.videos.get('v1').rejectedIds, []);

    h.core.command({op: 'searchAgain'});
    await h.flush();
    assert.equal(h.searches.length, 2);
    assert.equal(h.lastState().chosen.id, 1);
    assert.equal(h.lastState().offsetSeconds, -1);
});

test('the next video is preloaded after the current one', async () => {
    const h = harness({answers: {
        'Band|Song One': [record(1)],
        'Other Band|Song Two': [record(9, {trackName: 'Song Two', artistName: 'Other Band'})],
    }});
    const next = {videoId: 'v9', title: 'Song Two', byline: 'Other Band - Topic', durationSeconds: 200, host: 'www.youtube.com'};
    h.report(7, {sampledAt: h.now, media: media('v1'), metadata: metadata('v1'), next});
    await h.flush();
    await h.flush();
    assert.deepEqual(h.searches, ['Band|Song One', 'Other Band|Song Two']);
    h.report(7, {sampledAt: h.now, media: media('v9'), metadata: metadata('v9', {title: 'Song Two', author: 'Other Band - Topic',
        description: 'Provided to YouTube by Label\n\nSong Two · Other Band\n\nAlbum\n\n℗ 2001 Label'})});
    await h.flush();
    assert.equal(h.searches.length, 2);
    assert.equal(h.lastState().lyrics, 'timed');
});

test('an upcoming video listed by a bare title is not preloaded', async () => {
    const h = harness({answers: {'Band|Song One': [record(1)]}});
    const next = {videoId: 'v8', title: 'A Day In The Life Of A Beekeeper', byline: '', durationSeconds: 870, host: 'www.youtube.com'};
    h.report(7, {sampledAt: h.now, media: media('v1'), metadata: metadata('v1'), next});
    await h.flush();
    await h.flush();
    assert.deepEqual(h.searches, ['Band|Song One']);
});

test('a spent budget defers lookups until its window reopens', async () => {
    const h = harness({
        answers: {'Band|Song One': [record(1)], 'Band|Song Two': [record(2, {trackName: 'Song Two'})]},
        budgetWindows: [{seconds: 60, limit: 1}],
    });
    h.report(7, {sampledAt: h.now, media: media('v1'), metadata: metadata('v1')});
    await h.flush();
    const songTwoStarted = h.now;
    h.report(7, {sampledAt: h.now, media: media('v2'), metadata: metadata('v2', {title: 'Song Two',
        description: 'Provided to YouTube by Label\n\nSong Two · Band\n\nAlbum\n\n℗ 2001 Label'})});
    await h.flush();
    assert.equal(h.searches.length, 1);
    assert.equal(h.lastState().lyrics, 'waiting');
    await h.play(7, {sampledAt: songTwoStarted, media: media('v2')}, 61_000);
    assert.equal(h.searches.length, 2);
    assert.equal(h.lastState().lyrics, 'timed');
});

test('failed searches are errors, not misses, and are rechecked later', async () => {
    const h = harness({answers: {'Band|Song One': new Error('HTTP 502'), 'Band|Song One ': []}});
    h.report(7, {sampledAt: h.now, media: media('v1'), metadata: metadata('v1')});
    await h.flush();
    assert.equal(h.lastState().lyrics, 'error');
    assert.equal(h.saved.searches.size, 0);
    h.report(7, {sampledAt: h.now, media: media('v1', {currentTime: 1})});
    await h.flush();
    assert.equal(h.searches.length, 1);
    await h.advance(ERROR_RECHECK_MS + 1000);
    h.report(7, {sampledAt: h.now, media: media('v1', {currentTime: 2}), metadata: metadata('v1')});
    await h.flush();
    assert.equal(h.searches.length, 2);
});

const SONG_TWO = metadata('v2', {title: 'Song Two', description: 'Provided to YouTube by Label\n\nSong Two · Band\n\nAlbum\n\n℗ 2001 Label'});
const SONG_THREE = metadata('v3', {title: 'Song Three', description: 'Provided to YouTube by Label\n\nSong Three · Band\n\nAlbum\n\n℗ 2002 Label'});

test('the pitch status names the microphone the trace hears', () => {
    const h = harness();
    assert.deepEqual(h.core.state().pitch, {capturing: false, error: '', microphone: ''});
    h.core.setPitchStatus({capturing: true, error: '', microphone: 'Desk Mic Analog Stereo'});
    assert.deepEqual(h.lastState().pitch, {capturing: true, error: '', microphone: 'Desk Mic Analog Stereo'});
});

test('only a sounding tab asks for lookups', async () => {
    const h = harness({answers: {'Band|Song One': [record(1)], 'Band|Song Two': [record(2, {trackName: 'Song Two'})]}});
    h.report(8, {sampledAt: h.now, media: media('v2', {paused: true}), metadata: SONG_TWO});
    h.report(9, {sampledAt: h.now, media: media('v2', {muted: true}), metadata: SONG_TWO});
    h.report(10, {sampledAt: h.now, media: media('v2', {volume: 0}), metadata: SONG_TWO});
    await h.flush();
    assert.deepEqual(h.searches, []);
    assert.equal(h.lastState().active, false);

    h.report(7, {sampledAt: h.now, media: media('v1'), metadata: metadata('v1')});
    await h.flush();
    assert.deepEqual(h.searches, ['Band|Song One']);
    h.report(8, {sampledAt: h.now, media: media('v2', {currentTime: 3}), metadata: SONG_TWO});
    await h.flush();
    assert.deepEqual(h.searches, ['Band|Song One', 'Band|Song Two']);
});

test('a queued lookup for a song that is no longer playing is dropped', async () => {
    const h = harness({
        answers: {'Band|Song One': [record(1)], 'Band|Song Three': [record(3, {trackName: 'Song Three'})]},
        budgetWindows: [{seconds: 60, limit: 1}],
    });
    h.report(7, {sampledAt: h.now, media: media('v1'), metadata: metadata('v1')});
    await h.flush();
    h.report(7, {sampledAt: h.now, media: media('v2'), metadata: SONG_TWO});
    await h.flush();
    assert.equal(h.lastState().lyrics, 'waiting');

    const skippedAt = h.now;
    h.report(7, {sampledAt: h.now, media: media('v3'), metadata: SONG_THREE});
    await h.flush();
    assert.ok(h.logs.includes('dropped 1 queued lookups for videos no longer playing'), h.logs.join('\n'));
    await h.play(7, {sampledAt: skippedAt, media: media('v3')}, 61_000);
    assert.deepEqual(h.searches, ['Band|Song One', 'Band|Song Three']);
    assert.equal(h.lastState().lyrics, 'timed');
});

test('a lookup stops between searches when its song stops playing, and resumes on the next play', async () => {
    let answerFirst;
    const h = harness({answers: {
        'Band|Song One': () => new Promise(resolve => { answerFirst = resolve; }),
        'Song One|Band': [],
    }});
    const official = metadata('v4', {title: 'Band - Song One (Official Video)', author: 'BandVEVO', description: ''});
    h.report(7, {sampledAt: h.now, media: media('v4'), metadata: official});
    await h.flush();
    assert.deepEqual(h.searches, ['Band|Song One']);
    h.core.tabGone(7);
    answerFirst([]);
    await h.flush();
    assert.deepEqual(h.searches, ['Band|Song One'], 'the second query is not sent');
    assert.ok(h.logs.some(line => line.startsWith('lookup v4: stopped, no longer playing; 1 searched')), h.logs.join('\n'));
    assert.equal(h.saved.videos.get('v4').lookup, null);

    h.report(7, {sampledAt: h.now, media: media('v4', {currentTime: 5}), metadata: official});
    await h.flush();
    assert.deepEqual(h.searches, ['Band|Song One', 'Song One|Band'], 'the first answer comes from the cache');
    assert.equal(h.saved.videos.get('v4').lookup.status, 'none');
});

test('an LRCLIB rate-limit refusal pauses lookups until the time it names, and is not a failure', async () => {
    let refusals = 0;
    const h = harness({answers: {
        'Band|Song One': () => (refusals++ === 0 ? new ProviderRateLimit(h.now + 30_000) : [record(1)]),
    }});
    const started = h.now;
    h.report(7, {sampledAt: h.now, media: media('v1'), metadata: metadata('v1')});
    await h.flush();
    assert.equal(h.lastState().lyrics, 'waiting');
    assert.equal(h.saved.videos.get('v1').lookup, null);
    assert.equal(h.saved.budget.pausedUntil, started + 30_000);
    assert.ok(h.logs.some(line => line.startsWith('LRCLIB refused for its rate limit (HTTP 429); resuming lookups at ')), h.logs.join('\n'));

    await h.play(7, {sampledAt: started, media: media('v1')}, 29_000);
    assert.equal(h.searches.length, 1);
    await h.play(7, {sampledAt: started, media: media('v1')}, 2_000);
    assert.equal(h.searches.length, 2);
    assert.equal(h.lastState().lyrics, 'timed');
});

test('ads hide the line', async () => {
    const h = harness({answers: {'Band|Song One': [record(1)]}});
    h.report(7, {sampledAt: h.now, media: media('v1', {currentTime: 11}), metadata: metadata('v1')});
    await h.flush();
    assert.equal(h.lastLine().text, 'First line');
    h.report(7, {sampledAt: h.now, media: media('v1', {currentTime: 3, adShowing: true})});
    assert.equal(h.lastLine().text, '');
    assert.equal(h.lastState().active, true);
});

test('auto-generates timed lyrics when LRCLIB returns only plain text, updates stages, and persists', async () => {
    const calls = [];
    let finish;
    const h = harness({
        answers: {'Band|Song One': [record(10, {syncedLyrics: null, plainLyrics: 'First line\nSecond line'})]},
        generate: req => {
            calls.push(req);
            let cancelled = false;
            return {
                promise: new Promise(resolve => { finish = resolve; }),
                cancel: () => { cancelled = true; req.cancelled = cancelled; },
            };
        },
    });
    h.report(7, {sampledAt: h.now, media: media('v1', {currentTime: 10.5}), metadata: metadata('v1')});
    await h.flush();

    assert.equal(calls.length, 1);
    assert.equal(calls[0].plainLyrics, 'First line\nSecond line');
    assert.equal(h.lastState().lyrics, 'generating');
    assert.equal(h.lastState().generation.available, true);
    assert.equal(h.lastState().generation.status, 'running');
    assert.equal(h.lastState().generation.mode, 'aligned');
    assert.equal(h.lastState().generation.message, 'Aligning lyrics \u00b7 loading audio');

    calls[0].onStage('gpu-wait');
    assert.equal(h.lastState().generation.message, 'Aligning lyrics \u00b7 waiting for GPU');
    calls[0].onStage('transcribe');
    assert.equal(h.lastState().generation.message, 'Aligning lyrics\u2026');

    finish({
        ok: true,
        mode: 'aligned',
        lrc: '[00:10.00] First line\n[00:15.00] Second line\n',
        plainText: 'First line\nSecond line',
        duration: 200,
        coverage: 0.92,
        lineCount: 2,
    });
    await h.flush();

    assert.equal(h.lastState().lyrics, 'timed');
    assert.equal(h.lastState().generation.status, 'ready');
    assert.equal(h.lastState().generation.mode, 'aligned');
    assert.equal(h.lastLine().text, 'First line');
    assert.ok(h.lastState().candidates.some(c => c.generated === 'aligned' && c.current && c.timed));
    // Rejecting the generated set does not trigger an automatic regeneration loop.
    assert.deepEqual(h.core.command({op: 'reject'}), {ok: true});
    await h.flush();
    assert.equal(calls.length, 1);
    // Manual regenerate forces a fresh run and selects the new candidate.
    assert.deepEqual(h.core.command({op: 'generate'}), {ok: true});
    assert.equal(calls.length, 2);
    assert.equal(h.lastState().lyrics, 'generating');

    finish({
        ok: true,
        mode: 'aligned',
        lrc: '[00:10.00] First line\n[00:15.00] Second line\n',
        plainText: 'First line\nSecond line',
        duration: 200,
        coverage: 0.92,
        lineCount: 2,
    });
    await h.flush();

    // "Generate from scratch" deliberately ignores even the selected plain
    // lyrics, hides the stale timed candidate while transcribing, previews
    // early transcribed lines, and can preempt an in-flight Mode A alignment.
    assert.deepEqual(h.core.command({op: 'generate'}), {ok: true});
    assert.equal(calls.length, 3);
    assert.equal(h.lastState().generation.mode, 'aligned');

    assert.deepEqual(h.core.command({op: 'generateFromScratch'}), {ok: true});
    assert.equal(calls[2].cancelled, true, 'preempts in-flight alignment on the same song');
    assert.equal(calls.length, 4);
    assert.equal(calls[3].plainLyrics, '');
    assert.equal(calls[3].force, true);
    assert.equal(h.lastState().lyrics, 'generating');
    assert.equal(h.lastState().generation.mode, 'transcribed');
    assert.equal(h.lastLine().text, '', 'old timed lines clear while transcribing from scratch');

    calls[3].onPartial?.({
        lrc: '[00:10.00] Fresh transcribed opening\n',
        coveredRanges: [[0, 30]],
        lineCount: 1,
    });
    assert.equal(h.lastState().generation.previewing, true);
    assert.equal(h.lastLine().text, 'Fresh transcribed opening');
});

test('auto-generation cancels when switching songs, skips instrumentals and long videos, and ignores next preloads', async () => {
    const calls = [];
    const h = harness({
        answers: {
            'Band|Song One': [],
            'Band|Song Two': [record(2, {trackName: 'Song Two', instrumental: true, syncedLyrics: null, plainLyrics: ''})],
            'Band|Song Three': [],
        },
        maxGenerateDurationSeconds: 600,
        generate: req => {
            const entry = {videoId: req.videoId, force: req.force, cancelled: false, resolve: null};
            calls.push(entry);
            return {
                promise: new Promise(resolve => { entry.resolve = resolve; }),
                cancel: () => {
                    entry.cancelled = true;
                    entry.resolve?.({ok: false, cancelled: true});
                },
            };
        },
    });

    // Song One has no lyrics on LRCLIB -> starts generating; next preload (Song Three) is NOT generated.
    h.report(7, {
        sampledAt: h.now,
        media: media('v1'),
        metadata: metadata('v1'),
        next: {videoId: 'v3', title: 'Band - Song Three', artist: 'Band', durationSeconds: 200},
    });
    await h.flush();
    assert.deepEqual(calls.map(c => c.videoId), ['v1']);
    assert.equal(h.lastState().lyrics, 'generating');
    assert.equal(h.lastState().generation.message, 'Timing lyrics \u00b7 loading audio');

    // Switching to Song Two cancels v1 immediately and does not generate for instrumental Song Two.
    h.report(7, {sampledAt: h.now, media: media('v2'), metadata: SONG_TWO});
    await h.flush();
    assert.equal(calls[0].cancelled, true);
    assert.deepEqual(calls.map(c => c.videoId), ['v1']);

    // A 30-minute video is skipped cleanly without calling the generator.
    const longSong = metadata('vlong', {
        title: 'Long Mix',
        lengthSeconds: 1800,
        description: 'Provided to YouTube by Label\n\nLong Mix \u00b7 Band\n\nAlbum\n\n\u2117 2003 Label',
    });
    h.report(7, {sampledAt: h.now, media: media('vlong', {duration: 1800}), metadata: longSong});
    await h.flush();
    assert.deepEqual(calls.map(c => c.videoId), ['v1']);
    assert.equal(h.lastState().generation.status, 'skipped');
    assert.match(h.lastState().generation.message, /10 minutes/u);

    // Clicking "Generate timed lyrics" manually bypasses the automatic duration cap and passes force: true.
    assert.deepEqual(h.core.command({op: 'generate'}), {ok: true});
    assert.equal(calls.length, 2);
    assert.deepEqual([calls[1].videoId, calls[1].force], ['vlong', true]);
    assert.equal(h.lastState().lyrics, 'generating');
});

test('raising maxGenerateDurationSeconds re-enables automatic generation for previously duration-skipped tracks', async () => {
    const calls = [];
    const h = harness({
        answers: {'Band|Epic Ballad': []},
        maxGenerateDurationSeconds: 1200,
        generate: req => {
            calls.push({videoId: req.videoId, force: req.force});
            return {promise: new Promise(() => {}), cancel: () => {}};
        },
    });
    h.saved.videos.set('vepic', {
        version: 1,
        videoId: 'vepic',
        identity: null,
        lookup: {status: 'done', at: 0, query: 'Band|Epic Ballad', error: null},
        generated: {
            version: 1,
            status: 'skipped',
            mode: null,
            at: 0,
            error: 'Video is longer than 15 minutes',
            candidateId: null,
        },
        candidates: [],
        chosenId: null,
        rejectedIds: [],
        offsetSeconds: 0,
        userRequested: false,
    });
    const epic = metadata('vepic', {
        title: 'Epic Ballad',
        lengthSeconds: 1000,
        description: 'Provided to YouTube by Label\n\nEpic Ballad \u00b7 Band\n\nAlbum\n\n\u2117 2003 Label',
    });
    h.report(7, {sampledAt: h.now, media: media('vepic', {duration: 1000}), metadata: epic});
    await h.flush();
    assert.deepEqual(calls, [{videoId: 'vepic', force: false}]);
    assert.equal(h.lastState().lyrics, 'generating');
});

test('a background non-music stream never flashes lyrics or cancels generation on heartbeats', async () => {
    const webcamMeta = metadata('vcam1', {
        title: 'Harbor Street Live Webcam',
        author: 'City Cam Channel',
        category: 'Travel & Events',
        description: '',
    });
    const longIntro = '[01:00.00] First line after intro\n[01:05.00] Second line';
    const h = harness({
        answers: {'Band|Song One': [record(1, {syncedLyrics: longIntro})]},
    });

    // Webcam opens first and keeps sending 5 s heartbeats.
    h.report(9, {sampledAt: h.now, media: media('vcam1', {currentTime: 100}), metadata: webcamMeta});
    await h.flush();
    assert.equal(h.lastState().lyrics, 'not-music');

    await h.advance(2000);
    h.report(7, {sampledAt: h.now, media: media('v1', {currentTime: 0}), metadata: metadata('v1')});
    await h.flush();
    assert.equal(h.lastState().lyrics, 'timed');
    assert.equal(h.core.activeTabId(), 7);

    const statesStart = h.states.length;
    const linesStart = h.lines.length;
    // Interleave heartbeats from both tabs for 25 seconds during the 60 s countdown.
    for (let step = 0; step < 5; step++) {
        await h.advance(2500);
        h.report(9, {sampledAt: h.now, media: media('vcam1', {currentTime: 102 + step * 5}), metadata: webcamMeta});
        await h.advance(2500);
        h.report(7, {sampledAt: h.now, media: media('v1', {currentTime: (step + 1) * 5}), metadata: metadata('v1')});
    }
    const emittedStates = h.states.slice(statesStart);
    const emittedLines = h.lines.slice(linesStart);
    assert.equal(h.core.activeTabId(), 7);
    assert.ok(emittedStates.every(s => s.videoId === 'v1' && s.lyrics === 'timed'), JSON.stringify(emittedStates));
    assert.ok(emittedLines.every(l => l.text.endsWith('First line after intro')), JSON.stringify(emittedLines));
    assert.equal(h.lastLine().text, '35 First line after intro');

    // Same stability while automatic lyric timing runs: webcam heartbeats never cancel it.
    let cancelled = false;
    const g = harness({
        answers: {'Band|Song Two': []},
        generate: () => ({
            promise: new Promise(() => {}),
            cancel: () => { cancelled = true; },
        }),
    });
    g.report(9, {sampledAt: g.now, media: media('vcam1'), metadata: webcamMeta});
    await g.advance(1000);
    g.report(7, {sampledAt: g.now, media: media('v2'), metadata: SONG_TWO});
    await g.flush();
    assert.equal(g.lastState().lyrics, 'generating');
    for (let step = 0; step < 3; step++) {
        await g.advance(2500);
        g.report(9, {sampledAt: g.now, media: media('vcam1', {currentTime: step * 5 + 3}), metadata: webcamMeta});
        await g.advance(2500);
        g.report(7, {sampledAt: g.now, media: media('v2', {currentTime: (step + 1) * 5}), metadata: SONG_TWO});
    }
    assert.equal(cancelled, false);
    assert.equal(g.lastState().lyrics, 'generating');
    assert.equal(g.core.activeTabId(), 7);
});

test('two simultaneously playing songs stay on the newer song across heartbeats', async () => {
    const h = harness({
        answers: {
            'Band|Song One': [record(1)],
            'Band|Song Two': [record(2, {trackName: 'Song Two'})],
        },
    });
    h.report(7, {sampledAt: h.now, media: media('v1'), metadata: metadata('v1')});
    await h.flush();
    await h.advance(2000);
    h.report(8, {sampledAt: h.now, media: media('v2'), metadata: SONG_TWO});
    await h.flush();
    assert.equal(h.core.activeTabId(), 8);

    // Tab 7 sends a newer heartbeat while Tab 8 is also playing: Tab 8 stays active.
    await h.advance(3000);
    h.report(7, {sampledAt: h.now, media: media('v1', {currentTime: 5}), metadata: metadata('v1')});
    assert.equal(h.core.activeTabId(), 8);
    await h.advance(2000);
    h.report(8, {sampledAt: h.now, media: media('v2', {currentTime: 5}), metadata: SONG_TWO});
    assert.equal(h.core.activeTabId(), 8);
});

test('pausing a song keeps it active over an older background stream, while a new video takes over', async () => {
    const webcamMeta = metadata('vcam1', {title: 'Harbor Street Live Webcam', author: 'City Cam Channel', category: 'Travel & Events', description: ''});
    const talkMeta = metadata('vtalk1', {title: 'Science Lecture', author: 'University Channel', category: 'Education', description: ''});
    const h = harness({answers: {'Band|Song One': [record(1)]}});

    h.report(9, {sampledAt: h.now, media: media('vcam1'), metadata: webcamMeta});
    await h.advance(3000);
    h.report(7, {sampledAt: h.now, media: media('v1', {currentTime: 10}), metadata: metadata('v1')});
    await h.flush();
    await h.advance(5000);
    h.report(7, {sampledAt: h.now, media: media('v1', {currentTime: 15, paused: true}), metadata: metadata('v1')});
    assert.equal(h.core.activeTabId(), 7);

    // Older background stream heartbeat does not steal from the just-paused song.
    await h.advance(2000);
    h.report(9, {sampledAt: h.now, media: media('vcam1', {currentTime: 10}), metadata: webcamMeta});
    assert.equal(h.core.activeTabId(), 7);

    // A non-music video started after the pause takes over cleanly.
    await h.advance(2000);
    h.report(10, {sampledAt: h.now, media: media('vtalk1'), metadata: talkMeta});
    assert.equal(h.core.activeTabId(), 10);
});

test('marking a non-music video as a music video flips state, searches title-only fallback and chains into timing', async () => {
    const genCalls = [];
    const h = harness({
        answers: {
            '|Hidden Folk Tune': [],
        },
        generate: req => {
            genCalls.push(req);
            return {
                promise: Promise.resolve({
                    ok: true,
                    mode: 'transcribed',
                    lrc: '[00:05.00] Heard from audio\n',
                    plainText: 'Heard from audio',
                    lineCount: 1,
                    duration: 180,
                }),
                cancel: () => {},
            };
        },
    });
    const fanUpload = metadata('vfan1', {
        title: 'Hidden Folk Tune',
        author: 'RandomUploader42',
        category: 'People & Blogs',
        description: '',
    });
    h.report(7, {sampledAt: h.now, media: media('vfan1', {currentTime: 5}), metadata: fanUpload});
    h.report(7, {sampledAt: h.now, media: media('vfan1', {currentTime: 5, paused: true}), metadata: fanUpload});
    await h.flush();
    assert.equal(h.lastState().musical, false);
    assert.equal(h.lastState().lyrics, 'not-music');

    assert.deepEqual(h.core.command({op: 'lookUp'}), {ok: true});
    assert.equal(h.lastState().musical, true);
    await h.flush();
    await h.flush();
    assert.deepEqual(h.searches, ['RandomUploader42|Hidden Folk Tune', '|Hidden Folk Tune']);
    assert.equal(genCalls.length, 1);
    assert.equal(h.lastState().lyrics, 'timed');
    assert.equal(h.lastLine().text, 'Heard from audio');
});

test('manual LRCLIB search and local .lrc/.txt import select lyrics immediately and cancel active generation', async () => {
    let cancelled = false;
    const h = harness({
        answers: {
            'Band|Song One': [],
            'Real Artist|Real Song': [
                record(42, {trackName: 'Real Song', artistName: 'Real Artist', albumName: 'Deluxe', duration: 201}),
            ],
        },
        generate: () => ({
            promise: new Promise(() => {}),
            cancel: () => { cancelled = true; },
        }),
    });
    h.report(7, {sampledAt: h.now, media: media('v1', {currentTime: 10}), metadata: metadata('v1')});
    await h.flush();
    assert.equal(h.lastState().lyrics, 'generating');

    // Manual LRCLIB query merges its results and cancels passive generation once timed lyrics arrive.
    assert.equal(h.core.command({op: 'searchQuery', artist: '', title: ''}).ok, false);
    assert.deepEqual(h.core.command({op: 'searchQuery', artist: 'Real Artist', title: 'Real Song'}), {ok: true});
    await h.flush();
    assert.equal(cancelled, true);
    assert.equal(h.lastState().lyrics, 'timed');
    assert.equal(h.lastState().chosen.id, 42);
    assert.ok(h.lastState().candidates.some(c => c.id === 42 && c.lineCount === 3));

    // Importing a local .lrc file selects it immediately and survives a later search.
    assert.equal(h.core.command({op: 'importLyrics', filename: 'empty.lrc', text: '   '}).ok, false);
    const imported = h.core.command({
        op: 'importLyrics',
        filename: 'custom-version.lrc',
        text: '[ar:Custom Artist]\n[ti:Custom Title]\n[00:08.00] Custom line one\n[00:14.00] Custom line two\n',
    });
    assert.equal(imported.ok, true);
    assert.equal(imported.timed, true);
    assert.equal(h.lastState().chosen.id, imported.id);
    assert.equal(h.lastLine().text, 'Custom line one');
    assert.ok(h.lastState().candidates.some(c => c.id === imported.id && c.custom && c.lineCount === 2));

    // Switching back to an earlier candidate still works.
    assert.deepEqual(h.core.command({op: 'choose', id: 42}), {ok: true});
    assert.equal(h.lastState().chosen.id, 42);
});

test('presence tracks all open and sounding tabs even when a music tab stays active', async () => {
    const h = harness({answers: {'Band|Song One': [record(1)]}});
    const songMeta = metadata('song0000001');
    const camMeta = metadata('webcam00001', {
        title: 'Harbor Live Cam',
        author: 'Harbor Watch',
        category: 'Travel & Events',
        description: '',
    });

    h.report(1, {sampledAt: h.now, media: media('song0000001'), metadata: songMeta});
    h.report(2, {sampledAt: h.now, media: media('webcam00001'), metadata: camMeta});
    assert.equal(h.lastState().videoId, 'song0000001', 'musical tab remains active');
    assert.deepEqual(h.presences.at(-1), {
        sounding: ['song0000001', 'webcam00001'],
        open: ['song0000001', 'webcam00001'],
    });

    // Closing the background webcam removes it from presence at once without changing active state.
    const stateCountBefore = h.states.length;
    h.core.tabGone(2);
    assert.equal(h.states.length, stateCountBefore, 'active music state is undisturbed');
    assert.deepEqual(h.presences.at(-1), {
        sounding: ['song0000001'],
        open: ['song0000001'],
    });

    // Pausing leaves the song open but no longer sounding; missing heartbeats on another tab drops it.
    h.report(3, {sampledAt: h.now, media: media('webcam00002'), metadata: metadata('webcam00002', {
        title: 'Plaza Live Cam',
        author: 'City Watch',
        category: 'Travel & Events',
        description: '',
    })});
    h.report(1, {sampledAt: h.now, media: media('song0000001', {paused: true}), metadata: songMeta});
    assert.deepEqual(h.presences.at(-1), {
        sounding: ['webcam00002'],
        open: ['song0000001', 'webcam00002'],
    });
    await h.advance(MISSED_HEARTBEATS * HEARTBEAT_MS + 10);
    assert.deepEqual(h.presences.at(-1), {
        sounding: [],
        open: ['song0000001'],
    });
});

test('manual forced generation formats live progress, survives tab switches and pauses, notifies archive, and supports explicit cancel', async () => {
    const calls = [];
    const h = harness({
        answers: {
            'Choir|Messiah': [],
            'Band|Song Two': [record(2, {trackName: 'Song Two', syncedLyrics: '[00:05.00] Short song line'})],
            'Band|Short Auto': [],
        },
        maxGenerateDurationSeconds: 1200,
        generate: req => {
            const entry = {
                videoId: req.videoId,
                force: req.force,
                onStage: req.onStage,
                cancelled: false,
                resolve: null,
            };
            calls.push(entry);
            return {
                promise: new Promise(resolve => { entry.resolve = resolve; }),
                cancel: () => {
                    entry.cancelled = true;
                    entry.resolve?.({ok: false, cancelled: true});
                },
            };
        },
    });

    const concert = metadata('concert0001', {
        title: 'Messiah',
        author: 'Choir',
        lengthSeconds: 8797,
        description: 'Provided to YouTube by Label\n\nMessiah \u00b7 Choir\n\nAlbum\n\n\u2117 2020 Label',
    });
    h.report(1, {sampledAt: h.now, media: media('concert0001', {duration: 8797}), metadata: concert});
    await h.flush();
    assert.equal(h.lastState().generation.status, 'skipped');
    assert.equal(calls.length, 0);

    // Manual forced generation starts and formats multi-hour live progress cleanly.
    assert.deepEqual(h.core.command({op: 'generate'}), {ok: true});
    assert.equal(calls.length, 1);
    assert.equal(calls[0].force, true);
    calls[0].onStage('transcribe:2530/8797');
    assert.equal(h.lastState().generation.message, 'Timing lyrics \u00b7 42:10 / 2:26:37 (29%)');

    // Switching to another song does NOT cancel the manual forced run; progress stays visible in generation.background.
    h.report(1, {sampledAt: h.now, media: media('v2', {currentTime: 6}), metadata: SONG_TWO});
    await h.flush();
    assert.equal(calls[0].cancelled, false, 'manual forced run survives switching videos');
    assert.equal(h.lastState().videoId, 'v2');
    assert.equal(h.lastState().lyrics, 'timed');
    assert.deepEqual(h.lastState().generation.background, {
        videoId: 'concert0001',
        label: 'Choir - Messiah - 2020 - Album',
        mode: 'transcribed',
        stage: 'transcribe:2530/8797',
        message: 'Timing lyrics \u00b7 42:10 / 2:26:37 (29%)',
    });

    // Closing the tab (no active video) also keeps the manual forced run alive and reports background progress.
    h.core.tabGone(1);
    assert.equal(calls[0].cancelled, false, 'manual forced run survives playback end');
    assert.equal(h.lastState().active, false);
    assert.equal(h.lastState().generation.background.videoId, 'concert0001');

    // Completing in the background saves the candidate, notifies archive sync, and clears background state.
    calls[0].resolve({
        ok: true,
        mode: 'transcribed',
        lrc: '[01:40.00] Comfort ye, my people\n[146:30.00] Amen\n',
        plainText: 'Comfort ye, my people\nAmen',
        duration: 8797,
        lineCount: 2,
    });
    await h.flush();
    assert.equal(h.lastState().generation.background, undefined);
    assert.deepEqual(h.updatedVideos, ['concert0001']);

    // Returning to the concert immediately shows the saved timed lyrics at 2h 26m 31s.
    h.report(2, {sampledAt: h.now, media: media('concert0001', {currentTime: 8791, duration: 8797}), metadata: concert});
    assert.equal(h.lastState().lyrics, 'timed');
    assert.equal(h.lastLine().text, 'Amen');

    // Explicit cancelGenerate cancels a running automatic job and prevents immediate auto-restart.
    const shortAuto = metadata('shortauto01', {
        title: 'Short Auto',
        author: 'Band',
        lengthSeconds: 180,
        description: 'Provided to YouTube by Label\n\nShort Auto \u00b7 Band\n\nAlbum\n\n\u2117 2020 Label',
    });
    h.report(2, {sampledAt: h.now, media: media('shortauto01', {duration: 180}), metadata: shortAuto});
    await h.flush();
    assert.equal(calls.length, 2);
    assert.equal(h.lastState().lyrics, 'generating');
    assert.deepEqual(h.core.command({op: 'cancelGenerate'}), {ok: true, cancelled: true});
    assert.equal(calls[1].cancelled, true);
    assert.equal(calls.length, 2, 'cancelling must not immediately restart automatic generation');
    assert.equal(h.lastState().lyrics, 'none');
    assert.equal(h.lastState().generation.status, 'skipped');

    // Explicit cancelGenerate also cancels a background forced job when no video is active.
    assert.deepEqual(h.core.command({op: 'generate'}), {ok: true});
    assert.equal(calls.length, 3);
    h.core.tabGone(2);
    assert.equal(calls[2].cancelled, false);
    assert.deepEqual(h.core.command({op: 'cancelGenerate'}), {ok: true, cancelled: true});
    assert.equal(calls[2].cancelled, true);
    assert.equal(h.lastState().generation.background, undefined);
});

test('download progress, GPU wait reason, and streaming early subtitles preview cleanly without persisting partial lyrics', async () => {
    const calls = [];
    const h = harness({
        answers: {
            'Choir|Oratorio': [record(10, {
                artistName: 'Choir',
                trackName: 'Oratorio',
                duration: 7200,
                syncedLyrics: null,
                plainLyrics: 'Comfort ye\nEvery valley',
            })],
        },
        maxGenerateDurationSeconds: 1200,
        generate: req => {
            const entry = {
                videoId: req.videoId,
                startAt: req.startAt,
                onStage: req.onStage,
                onPartial: req.onPartial,
                cancelled: false,
                resolve: null,
            };
            calls.push(entry);
            return {
                promise: new Promise(resolve => { entry.resolve = resolve; }),
                cancel: () => {
                    entry.cancelled = true;
                    entry.resolve?.({ok: false, cancelled: true});
                },
            };
        },
    });

    const concert = metadata('oratorio001', {
        title: 'Oratorio',
        author: 'Choir',
        lengthSeconds: 7200,
        description: 'Provided to YouTube by Label\n\nOratorio \u00b7 Choir\n\nAlbum\n\n\u2117 2020 Label',
    });
    h.report(1, {sampledAt: h.now, media: media('oratorio001', {currentTime: 1835.5, duration: 7200}), metadata: concert});
    await h.flush();

    assert.deepEqual(h.core.command({op: 'generate'}), {ok: true});
    assert.equal(calls.length, 1);
    assert.equal(Math.round(calls[0].startAt), 1836);

    // Subprocess download progress and GPU wait holder name format clearly.
    calls[0].onStage('audio:34000000/73000000');
    assert.equal(h.lastState().generation.message, 'Aligning lyrics \u00b7 loading audio 34 / 73 MB (47%)');
    calls[0].onStage('audio:420000/950000');
    assert.equal(h.lastState().generation.message, 'Aligning lyrics \u00b7 loading audio 420 / 950 kB (44%)');
    calls[0].onStage('audio:18200000/0');
    assert.equal(h.lastState().generation.message, 'Aligning lyrics \u00b7 loading audio 18.2 MB');
    calls[0].onStage('gpu-wait:another job holds 12 GB');
    assert.equal(h.lastState().generation.message, 'Aligning lyrics \u00b7 waiting for GPU (another job holds 12 GB)');

    // Before partial subtitles arrive: overlay has no timed line yet and previewing is absent.
    assert.equal(h.lastState().generation.previewing, undefined);
    assert.equal(h.lastLine().text, '');

    // Early partial covering playhead slice arrives -> displays immediately without writing to disk or archive.
    calls[0].onPartial({
        lrc: '[30:34.00] Early rough line\n[30:40.00] Next early line\n',
        lineCount: 2,
        duration: 7200,
        coveredRanges: [[1825, 2425]],
    });
    assert.equal(h.lastState().lyrics, 'generating');
    assert.equal(h.lastState().generation.previewing, true);
    assert.equal(h.lastLine().text, 'Early rough line');
    assert.equal(h.core.lyricsFor('oratorio001').timed, false, 'partial subtitles must never reach ytarchive as timed');
    assert.equal(h.saved.videos.get('oratorio001').candidates.some(c => c.generated), false, 'partial subtitles must not persist');

    // Seeking into an untranscribed region clears previewing so the quiet status pill can show again.
    h.report(1, {sampledAt: h.now, media: media('oratorio001', {currentTime: 100, duration: 7200}), metadata: concert});
    assert.equal(h.lastState().generation.previewing, undefined);
    assert.equal(h.lastLine().text, '');

    // Seeking back into covered region restores early subtitles; full Mode A completion swaps in aligned lyrics atomically.
    h.report(1, {sampledAt: h.now, media: media('oratorio001', {currentTime: 1835.5, duration: 7200}), metadata: concert});
    assert.equal(h.lastState().generation.previewing, true);
    assert.equal(h.lastLine().text, 'Early rough line');

    calls[0].resolve({
        ok: true,
        mode: 'aligned',
        lrc: '[01:40.00] Comfort ye\n[30:34.00] Every valley\n',
        plainText: 'Comfort ye\nEvery valley',
        duration: 7200,
        coverage: 0.95,
        lineCount: 2,
    });
    await h.flush();
    assert.equal(h.lastState().lyrics, 'timed');
    assert.equal(h.lastState().generation.status, 'ready');
    assert.equal(h.lastState().generation.previewing, undefined);
    assert.equal(h.lastLine().text, 'Every valley');
    assert.equal(h.core.lyricsFor('oratorio001').timed, true);
    assert.deepEqual(h.updatedVideos, ['oratorio001']);
});

test('length-mismatched timed LRCLIB entries demote to plain for alignment, and gross mismatches are rejected', async () => {
    const genCalls = [];
    const h = harness({
        answers: {
            'Band|Intro Cut': [
                // 25 s shorter than the 225 s music video, and missing plainLyrics (must extract from syncedLyrics).
                record(10, {trackName: 'Intro Cut', duration: 200, plainLyrics: '', syncedLyrics: '[00:05.00] Verse one\n[00:10.00] Verse two'}),
            ],
            'Band|Overrun Song': [
                // Declared 200 s, but sung lyrics run 35 s past the end of the track.
                record(11, {trackName: 'Overrun Song', duration: 200, plainLyrics: 'Late line', syncedLyrics: '[00:10.00] Early\n[03:55.00] Past end'}),
            ],
            'Band|Short Track': [
                // 150 s song attached via Music card to a 7200 s concert video.
                record(12, {trackName: 'Short Track', duration: 150, plainLyrics: 'Short song', syncedLyrics: '[00:05.00] Short song'}),
            ],
        },
        generate: req => {
            genCalls.push({videoId: req.videoId, plainLyrics: req.plainLyrics});
            return {promise: new Promise(() => {}), cancel: () => {}};
        },
    });

    // Moderate mismatch (25 s off on 225 s video): demoted to plain, triggers Whisper Mode A alignment with extracted text.
    const introMeta = metadata('vintro1', {
        title: 'Intro Cut',
        lengthSeconds: 225,
        description: 'Provided to YouTube by Label\n\nIntro Cut \u00b7 Band\n\nAlbum\n\n\u2117 2001 Label',
    });
    h.report(1, {sampledAt: h.now, media: media('vintro1', {currentTime: 6, duration: 225.1}), metadata: introMeta});
    await h.flush();
    assert.equal(h.lastState().lyrics, 'generating');
    assert.equal(h.lastLine().text, '', 'out-of-sync LRCLIB timestamps must not display');
    assert.equal(h.lastState().candidates[0].timed, false);
    assert.equal(h.lastState().candidates[0].matches, true);
    assert.deepEqual(genCalls, [{videoId: 'vintro1', plainLyrics: 'Verse one\nVerse two'}]);

    // Timestamp overrun (same 200 s duration, but sung lyric at 235 s): demoted to plain and aligned.
    const overrunMeta = metadata('vover1', {
        title: 'Overrun Song',
        lengthSeconds: 200,
        description: 'Provided to YouTube by Label\n\nOverrun Song \u00b7 Band\n\nAlbum\n\n\u2117 2001 Label',
    });
    h.report(1, {sampledAt: h.now, media: media('vover1', {currentTime: 10, duration: 200}), metadata: overrunMeta});
    await h.flush();
    assert.equal(h.lastState().lyrics, 'generating');
    assert.equal(h.lastState().candidates[0].timed, false);
    assert.deepEqual(genCalls[1], {videoId: 'vover1', plainLyrics: 'Late line'});

    // Gross mismatch (150 s LRCLIB on 7200 s concert video): rejected outright (matches: false, no lyrics).
    const concertMeta = metadata('vlongcard1', {
        title: 'Full Live Concert',
        author: 'Uploader',
        category: 'Music',
        lengthSeconds: 7200,
        description: '',
        musicCards: [{title: 'Short Track', artist: 'Band', album: 'Album'}],
    });
    h.report(1, {sampledAt: h.now, media: media('vlongcard1', {currentTime: 10, duration: 7200}), metadata: concertMeta});
    await h.flush();
    assert.equal(h.lastState().lyrics, 'none');
    assert.equal(h.lastState().chosen, null);
    assert.equal(h.lastState().candidates[0].matches, false);
    assert.equal(h.lastState().candidates[0].timed, false);
    assert.equal(h.lastLine().text, '');
});

test('preloaded next videos re-rank from cache once exact playback duration arrives, ignoring ad durations', async () => {
    const h = harness({answers: {
        'Band|Song One': [record(1)],
        'Other Band|Song Two': [
            record(20, {trackName: 'Song Two', artistName: 'Other Band', duration: 200}),
            record(21, {trackName: 'Song Two', artistName: 'Other Band', duration: 199}),
            record(22, {trackName: 'Song Two', artistName: 'Other Band', duration: 196.8}),
        ],
    }});
    // Preload uses YouTube's rounded "+1 s" lengthText (200 s for a 198.6 s song).
    const next = {videoId: 'v9', title: 'Song Two', byline: 'Other Band - Topic', durationSeconds: 200, host: 'www.youtube.com'};
    h.report(7, {sampledAt: h.now, media: media('v1'), metadata: metadata('v1'), next});
    await h.flush();
    await h.flush();
    assert.deepEqual(h.searches, ['Band|Song One', 'Other Band|Song Two']);
    assert.equal(h.saved.videos.get('v9').candidates[0].id, 20, 'preload ranked against 200 s');
    assert.equal(h.saved.videos.get('v9').candidates.find(c => c.id === 22).timed, false, '196.8 s > 2 s from 200 s');

    // During a 15 s ad before v9 starts, media.duration (15) is ignored and lengthSeconds (199) is used.
    const v9Meta = metadata('v9', {
        title: 'Song Two',
        author: 'Other Band - Topic',
        lengthSeconds: 199,
        description: 'Provided to YouTube by Label\n\nSong Two \u00b7 Other Band\n\nAlbum\n\n\u2117 2001 Label',
    });
    h.report(7, {sampledAt: h.now, media: media('v9', {duration: 15, adShowing: true}), metadata: v9Meta});
    await h.flush();
    assert.equal(h.searches.length, 2, 're-ranking reuses the cached search with zero extra LRCLIB requests');
    assert.equal(h.saved.videos.get('v9').lookup.duration, 199);
    assert.equal(h.lastState().chosen.id, 21, '199 s beats 200 s once real lengthSeconds arrives');
    assert.equal(h.saved.videos.get('v9').candidates.find(c => c.id === 22).timed, false, '196.8 s still > 2 s from rounded 199 s');

    // Once the ad ends and real float media.duration (198.6 s) arrives, 196.8 s is within ±2 s and 199 s still wins.
    h.report(7, {sampledAt: h.now, media: media('v9', {duration: 198.6, adShowing: false}), metadata: v9Meta});
    await h.flush();
    assert.equal(h.searches.length, 2);
    assert.equal(h.lastState().chosen.id, 21);
    assert.equal(h.saved.videos.get('v9').candidates.find(c => c.id === 22).timed, true, '196.8 s promoted back to timed at 198.6 s');
    assert.equal(h.saved.videos.get('v9').lookup.duration, 198.6);

    // Subsequent heartbeats at the same duration do not re-run lookup.
    const logsBefore = h.logs.length;
    h.report(7, {sampledAt: h.now + 5000, media: media('v9', {currentTime: 5, duration: 198.6}), metadata: v9Meta});
    await h.flush();
    assert.equal(h.logs.length, logsBefore);
});


