import test from 'node:test';
import assert from 'node:assert/strict';

import {ArchiveRefused, ArchiveSync, LRC_FORMAT, MAX_OUTBOX, lrcText} from '../service/archive-sync.js';

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
        _answer() {
            if (client.mode === 'down')
                throw new Error('connection refused');
            if (client.mode === 'refusing')
                throw new ArchiveRefused('HTTP 400: video_id must be a YouTube video id');
        },
    };
    return client;
}

function setup({store = memoryStore(), client = fakeClient(), lyrics = new Map()} = {}) {
    const logs = [];
    const sync = new ArchiveSync({store, client, lyricsFor: id => lyrics.get(id) ?? null, log: line => logs.push(line)});
    return {sync, store, client, lyrics, logs};
}

const state = (videoId, {sounding = true, chosen = null} = {}) =>
    ({active: true, sounding, videoId, chosen: chosen ? {id: chosen.id} : null});

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
