import test from 'node:test';
import assert from 'node:assert/strict';

import {
    ArchiveRefused, ArchiveSync, LRC_FORMAT, MAX_OUTBOX, STOP_PAUSE_MS, lrcText,
} from '../service/archive-sync.js';

const SYNCED = '[00:01.00] One\n[00:03.00] Two';
const timed = {id: 77, trackName: 'Stub Song', artistName: 'Stub Band', albumName: 'Stub Album', duration: 185,
    instrumental: false, plainLyrics: 'One\nTwo', syncedLyrics: SYNCED, timed: true};
const plain = {...timed, id: 78, syncedLyrics: null, timed: false};

function memoryStore() {
    const records = new Map();
    let outbox = null;
    return {
        records,
        get outbox() { return outbox; },
        loadArchiveRecord: id => (records.has(id) ? structuredClone(records.get(id)) : null),
        saveArchiveRecord: record => records.set(record.videoId, structuredClone(record)),
        loadArchiveOutbox: () => (outbox ? [...outbox] : null),
        saveArchiveOutbox: ids => { outbox = [...ids]; },
    };
}

function fakeTimers() {
    let now = 0;
    let nextId = 1;
    const pending = new Map();
    return {
        get pending() { return pending.size; },
        set(callback, delayMs) {
            const id = nextId++;
            pending.set(id, {at: now + delayMs, callback});
            return id;
        },
        clear(id) {
            pending.delete(id);
        },
        async advance(ms) {
            now += ms;
            for (;;) {
                const due = [...pending.entries()]
                    .filter(([, entry]) => entry.at <= now)
                    .sort((a, b) => a[1].at - b[1].at);
                if (!due.length)
                    break;
                const [id, entry] = due[0];
                pending.delete(id);
                entry.callback();
                await Promise.resolve();
            }
        },
    };
}

/** A ytarchive stand-in: `mode` 'up', 'down' (unreachable) or 'refusing' (HTTP 4xx). */
function fakeClient() {
    const client = {
        mode: 'up',
        calls: [],
        async add(videoId) {
            client.calls.push(['add', videoId]);
            client._answer();
        },
        async lyrics(videoId, lrc) {
            client.calls.push(['lyrics', videoId, lrc]);
            client._answer();
        },
        async stop(videoId) {
            client.calls.push(['stop', videoId]);
            client._answer();
        },
        _answer() {
            if (client.mode === 'down')
                throw new Error('connection refused');
            if (client.mode === 'refusing')
                throw new ArchiveRefused('HTTP 400: video_id must be a YouTube video id');
        },
    };
    return client;
}

function setup({store = memoryStore(), client = fakeClient(), lyrics = new Map(), timers = fakeTimers(), stopPauseMs} = {}) {
    const logs = [];
    const sync = new ArchiveSync({
        store,
        client,
        lyricsFor: id => lyrics.get(id) ?? null,
        timers,
        stopPauseMs,
        log: line => logs.push(line),
    });
    return {sync, store, client, lyrics, timers, logs};
}

const state = (videoId, {sounding = true, chosen = null} = {}) =>
    ({active: true, sounding, videoId, chosen: chosen ? {id: chosen.id, timed: Boolean(chosen.timed)} : null});
const inactive = () => ({active: false, sounding: false, videoId: null, chosen: null});

test('lrcText writes LRC tags and the timed lines, plain lines without times, and nothing without words', () => {
    assert.equal(lrcText(timed), '[ar:Stub Band]\n[ti:Stub Song]\n[al:Stub Album]\n[length:03:05]\n[00:01.00] One\n[00:03.00] Two\n');
    assert.equal(lrcText(plain), '[ar:Stub Band]\n[ti:Stub Song]\n[al:Stub Album]\n[length:03:05]\nOne\nTwo\n');
    assert.equal(lrcText({...timed, albumName: '', duration: 0, trackName: 'A ]\nB'}), '[ar:Stub Band]\n[ti:A B]\n[00:01.00] One\n[00:03.00] Two\n');
    assert.equal(lrcText({...plain, instrumental: true, plainLyrics: ''}), '');
    assert.equal(lrcText(null), '');
});

test('a video is added once ever, when it is first heard', async () => {
    const {sync, store, client} = setup();
    await sync.observe(state('quietvideo1', {sounding: false}));
    assert.deepEqual(client.calls, [], 'a paused or muted video was not heard');
    await sync.observe(state('heardvideo1'));
    await sync.observe(state('heardvideo1', {sounding: false}));
    await sync.observe(state('heardvideo1'));
    assert.deepEqual(client.calls, [['add', 'heardvideo1']]);
    assert.deepEqual(store.records.get('heardvideo1'), {version: 1, videoId: 'heardvideo1', added: true, lyricsKey: ''});

    const restarted = setup({store});
    await restarted.sync.start();
    await restarted.sync.observe(state('heardvideo1'));
    assert.deepEqual(restarted.client.calls, [], 'a restart does not add it again');
});

test('lyrics follow the chosen candidate: sent when found, again when changed, removed when rejected', async () => {
    const {sync, client, lyrics, store} = setup();
    await sync.observe(state('songvideo01'));
    lyrics.set('songvideo01', timed);
    await sync.observe(state('songvideo01', {chosen: timed}));
    await sync.observe(state('songvideo01', {chosen: timed, sounding: false}));
    lyrics.set('songvideo01', plain);
    await sync.observe(state('songvideo01', {chosen: plain, sounding: false}));
    lyrics.delete('songvideo01');
    await sync.observe(state('songvideo01'));
    assert.deepEqual(client.calls, [
        ['add', 'songvideo01'],
        ['lyrics', 'songvideo01', lrcText(timed)],
        ['lyrics', 'songvideo01', lrcText(plain)],
        ['lyrics', 'songvideo01', null],
    ]);
    assert.equal(store.records.get('songvideo01').lyricsKey, '');
});

test('lyrics found before a video plays wait until it is heard, then follow its add', async () => {
    const lyrics = new Map([['nextvideo01', timed]]);
    const {sync, client, store} = setup({lyrics});
    await sync.observe(state('nextvideo01', {sounding: false, chosen: timed}));
    assert.deepEqual(client.calls, []);
    await sync.observe(state('nextvideo01', {chosen: timed}));
    assert.deepEqual(client.calls, [['add', 'nextvideo01'], ['lyrics', 'nextvideo01', lrcText(timed)]]);
    assert.equal(store.records.get('nextvideo01').lyricsKey, `${LRC_FORMAT}:77`);
});

test('while ytarchive is unreachable videos wait in the outbox, sent at the next change or the next start', async () => {
    const {sync, client, store, logs} = setup();
    client.mode = 'down';
    await sync.observe(state('firstvideo1'));
    await sync.observe(state('secondvideo'));
    assert.deepEqual(store.outbox, ['firstvideo1', 'secondvideo']);
    assert.equal(logs.filter(line => line.startsWith('ytarchive unreachable')).length, 1, 'said once, not per attempt');
    assert.equal(client.calls.length, 2, 'one attempt per change, no retry loop');

    client.mode = 'up';
    const restarted = setup({store, client});
    await restarted.sync.start();
    assert.deepEqual(client.calls.slice(2), [['add', 'firstvideo1'], ['add', 'secondvideo']]);
    assert.deepEqual(store.outbox, []);
});

test('a refusal drops the video from the outbox instead of asking again', async () => {
    const {sync, client, store, logs} = setup();
    client.mode = 'refusing';
    await sync.observe(state('refusedvid1'));
    assert.deepEqual(store.outbox, []);
    assert.equal(store.records.get('refusedvid1'), undefined, 'not added: heard again, it is asked for again');
    assert.match(logs.join('\n'), /ytarchive refused refusedvid1: HTTP 400/u);
});

test(`the outbox keeps the newest ${MAX_OUTBOX} videos`, async () => {
    const store = memoryStore();
    store.saveArchiveOutbox(Array.from({length: MAX_OUTBOX}, (_, n) => `waiting${String(n).padStart(4, '0')}`));
    const {sync, client, logs} = setup({store});
    client.mode = 'down';
    await sync.observe(state('newestvideo'));
    assert.equal(store.outbox.length, MAX_OUTBOX);
    assert.equal(store.outbox.at(-1), 'newestvideo');
    assert.equal(store.outbox[0], 'waiting0001');
    assert.match(logs.join('\n'), /dropped 1 oldest videos \(waiting0000\)/u);
});

test('the store failing is logged and never reaches the caller', async () => {
    const store = memoryStore();
    store.loadArchiveRecord = () => { throw new Error('disk full'); };
    const {sync, logs} = setup({store});
    await sync.observe(state('anyvideo001'));
    assert.deepEqual(logs, ['ytarchive hand-off failed: disk full']);
});

test('closing or switching away from a heard video sends stop immediately; never heard sends nothing', async () => {
    const {sync, client, timers} = setup();
    await sync.observe(state('neverheard1', {sounding: false}));
    await sync.observe(inactive());
    assert.deepEqual(client.calls, [], 'closing a tab that never sounded sends no stop');

    await sync.observe(state('livestream1'));
    await sync.observe(inactive());
    assert.deepEqual(client.calls, [['add', 'livestream1'], ['stop', 'livestream1']]);
    assert.equal(timers.pending, 0);

    await sync.observe(state('livestream2'));
    await sync.observe(state('nextvideo02'));
    assert.deepEqual(client.calls.slice(2), [
        ['add', 'livestream2'],
        ['add', 'nextvideo02'],
        ['stop', 'livestream2'],
    ]);
});

test('pausing waits STOP_PAUSE_MS before sending stop, resumes cancel it, and closing during pause stops immediately', async () => {
    const {sync, client, timers} = setup();
    assert.equal(STOP_PAUSE_MS, 60_000);
    await sync.observe(state('pausevid001'));
    await sync.observe(state('pausevid001', {sounding: false}));
    await timers.advance(STOP_PAUSE_MS - 1);
    await sync._chain;
    assert.deepEqual(client.calls, [['add', 'pausevid001']], 'brief pause does not stop the recording');

    // Resuming cancels the timer.
    await sync.observe(state('pausevid001'));
    assert.equal(timers.pending, 0);
    await timers.advance(STOP_PAUSE_MS * 2);
    await sync._chain;
    assert.deepEqual(client.calls, [['add', 'pausevid001']]);

    // Pausing for the full STOP_PAUSE_MS sends stop once; closing later does not send a second stop.
    await sync.observe(state('pausevid001', {sounding: false}));
    await timers.advance(STOP_PAUSE_MS);
    await sync._chain;
    assert.deepEqual(client.calls, [['add', 'pausevid001'], ['stop', 'pausevid001']]);
    await sync.observe(inactive());
    assert.deepEqual(client.calls, [['add', 'pausevid001'], ['stop', 'pausevid001']]);

    // Closing while paused cancels the timer and stops immediately.
    await sync.observe(state('pausevid002'));
    await sync.observe(state('pausevid002', {sounding: false}));
    assert.equal(timers.pending, 1);
    await sync.observe(inactive());
    assert.equal(timers.pending, 0);
    assert.deepEqual(client.calls.slice(2), [['add', 'pausevid002'], ['stop', 'pausevid002']]);
});

test('observePresence tracks background tabs alongside an active music tab', async () => {
    const {sync, client, timers} = setup();
    // Music tab is active while a background webcam also sounds.
    await sync.observe(state('musicvid001'));
    await sync.observePresence({sounding: ['musicvid001', 'webcamvid01'], open: ['musicvid001', 'webcamvid01']});
    assert.deepEqual(client.calls, [['add', 'musicvid001'], ['add', 'webcamvid01']]);

    // Closing the background webcam stops it immediately even though musicvid001 stays active.
    await sync.observePresence({sounding: ['musicvid001'], open: ['musicvid001']});
    assert.deepEqual(client.calls, [['add', 'musicvid001'], ['add', 'webcamvid01'], ['stop', 'webcamvid01']]);

    // Pausing the remaining tab starts the pause timer, cleared on shutdown.
    await sync.observePresence({sounding: [], open: ['musicvid001']});
    assert.equal(timers.pending, 1);
    sync.shutdown();
    assert.equal(timers.pending, 0);
});

test('stop failures are logged and never added to the persistent outbox', async () => {
    const {sync, client, store, logs} = setup();
    await sync.observe(state('stopfail001'));
    client.mode = 'down';
    await sync.observe(inactive());
    assert.deepEqual(store.outbox, []);
    assert.match(logs.join('\n'), /ytarchive stop for stopfail001 failed: connection refused/u);

    client.mode = 'up';
    await sync.observe(state('stoprefuse1'));
    client.mode = 'refusing';
    await sync.observe(inactive());
    assert.deepEqual(store.outbox, []);
    assert.match(logs.join('\n'), /ytarchive refused stop for stoprefuse1: HTTP 400/u);
});

test('observeVideoLyrics forwards newly generated lyrics for a previously heard background video', async () => {
    const {sync, client, lyrics} = setup();
    await sync.observe(state('bgconcert01'));
    await sync.observe(state('othervideo1'));
    assert.deepEqual(client.calls, [['add', 'bgconcert01'], ['add', 'othervideo1'], ['stop', 'bgconcert01']]);

    // While another video is active, bgconcert01 finishes generating timed lyrics.
    lyrics.set('bgconcert01', {...timed, id: 'gen:transcribed:1', syncedLyrics: '[00:05.00] Comfort ye'});
    await sync.observeVideoLyrics('bgconcert01');
    assert.equal(client.calls.at(-1)[0], 'lyrics');
    assert.equal(client.calls.at(-1)[1], 'bgconcert01');
    assert.match(client.calls.at(-1)[2], /\[00:05\.00\] Comfort ye/u);
});

test('demoting the same candidate id from timed to plain resends plain lyrics to ytarchive', async () => {
    const {sync, client, lyrics, store} = setup();
    lyrics.set('demotedvid1', timed);
    await sync.observe(state('demotedvid1', {chosen: timed}));
    assert.equal(store.records.get('demotedvid1').lyricsKey, `${LRC_FORMAT}:77`);

    const demoted = {...timed, timed: false, syncedLyrics: null};
    lyrics.set('demotedvid1', demoted);
    await sync.observe(state('demotedvid1', {chosen: demoted}));
    assert.equal(client.calls.at(-1)[0], 'lyrics');
    assert.equal(client.calls.at(-1)[2], lrcText(demoted));
    assert.equal(store.records.get('demotedvid1').lyricsKey, `${LRC_FORMAT}:77:plain`);
});
