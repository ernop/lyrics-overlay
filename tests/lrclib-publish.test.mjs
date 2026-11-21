import assert from 'node:assert/strict';
import {execFile, spawn} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

import {ProviderRateLimit} from '../shared/budget.js';
import {formatLrcTime, plainLyricsFromSynced, shiftSyncedLyrics} from '../shared/lrc.js';
import {LyricsCore} from '../service/core.js';
import {dconfServiceDir, isolatedEnv, startBus} from './isolated-session.mjs';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function memoryStore() {
    const videos = new Map();
    const searches = new Map();
    let budget = null;
    return {
        loadVideo: id => (videos.has(id) ? structuredClone(videos.get(id)) : null),
        saveVideo: rec => videos.set(rec.videoId, structuredClone(rec)),
        loadSearch: key => (searches.has(key) ? structuredClone(searches.get(key)) : null),
        saveSearch: (key, entry) => searches.set(key, structuredClone(entry)),
        loadBudget: () => (budget ? structuredClone(budget) : null),
        saveBudget: state => { budget = structuredClone(state); },
    };
}

function makeCore({publish, search} = {}) {
    let now = 10_000;
    const logs = [];
    const store = memoryStore();
    const core = new LyricsCore({
        store,
        search: search ?? (async () => []),
        publish,
        clock: {now: () => now},
        timers: {set: () => 1, clear: () => {}},
        emit: {state: () => {}, line: () => {}},
        log: msg => logs.push(msg),
    });
    return {core, logs, advance: ms => { now += ms; }};
}

test('shiftSyncedLyrics bakes displayAt offset sign convention and clamps at 00:00.00', () => {
    const raw = '[00:01.00] First line\n[00:10.50] Second line\n[00:59.996] Minute boundary';
    assert.equal(formatLrcTime(59.996), '[01:00.00]');
    // offset = +1.5 ("Too slow" -> lines appear 1.5 s earlier -> t - 1.5)
    assert.equal(
        shiftSyncedLyrics(raw, 1.5),
        '[00:00.00] First line\n[00:09.00] Second line\n[00:58.50] Minute boundary',
    );
    // offset = -2.0 ("Too fast" -> lines appear 2.0 s later -> t + 2.0)
    assert.equal(
        shiftSyncedLyrics(raw, -2.0),
        '[00:03.00] First line\n[00:12.50] Second line\n[01:02.00] Minute boundary',
    );
    assert.equal(plainLyricsFromSynced(raw), 'First line\nSecond line\nMinute boundary');
});

test('lrclib-pow.py solves a SHA-256 proof-of-work challenge matching LRCLIB byte order', async () => {
    const prefix = 'TestPrefix123456';
    const targetHex = `000FFF${'0'.repeat(58)}`;
    const {stdout} = await execFileAsync('python3', [
        path.join(root, 'service', 'lrclib-pow.py'),
        prefix,
        targetHex,
    ]);
    const nonce = stdout.trim();
    assert.match(nonce, /^\d+$/u);
    const digest = crypto.createHash('sha256').update(`${prefix}${nonce}`, 'utf8').digest();
    const target = Buffer.from(targetHex, 'hex');
    assert.ok(Buffer.compare(digest, target) <= 0, 'digest must be <= target');
});

test('activeLyrics, saveEditedLyrics, and publishToLrclib validate metadata, share budget, and never log lyrics', async () => {
    const published = [];
    let forceRateLimit = false;
    const {core, logs} = makeCore({
        publish: async req => {
            if (forceRateLimit)
                throw new ProviderRateLimit(25_000);
            published.push(req);
            return {ok: true, status: 201};
        },
        search: async () => [{
            id: 42,
            trackName: 'Shenandoah',
            artistName: 'Harbor Folk',
            albumName: 'Auto-transcribed from audio',
            duration: 210,
            instrumental: false,
            plainLyrics: 'Oh Shenandoah\nI long to see you',
            syncedLyrics: '[00:05.00] Oh Shenandoah\n[00:12.00] I long to see you',
        }],
    });

    core.report(1, {
        sampledAt: 10_000,
        heartbeatMs: 5000,
        media: {videoId: 'vid001', currentTime: 6, duration: 210, paused: false, ended: false, stalled: false, playbackRate: 1, muted: false, volume: 1, adShowing: false},
        metadata: {host: 'www.youtube.com', videoId: 'vid001', title: 'Shenandoah', author: 'Harbor Folk - Topic', lengthSeconds: 210, category: 'Music', musicVideoType: '', musicCards: [], mediaSession: null, ytmByline: '', description: 'Provided to YouTube by Label\n\nShenandoah \u00b7 Harbor Folk\n\nSea Shanties\n\n\u2117 2020 Label'},
        next: null,
    });
    await new Promise(resolve => setTimeout(resolve, 20));

    core.command({op: 'tooSlow'}); // offset = +0.5 -> effective times shift earlier by 0.5 s
    const full = core.activeLyrics();
    assert.equal(full.active, true);
    assert.equal(full.offsetSeconds, 0.5);
    assert.equal(full.candidate.realAlbumName, 'Sea Shanties');
    assert.equal(full.candidate.lines.length, 2);
    assert.equal(full.candidate.lines[0].effectiveTime, 4.5);
    assert.equal(full.candidate.bakedSyncedLyrics, '[00:04.50] Oh Shenandoah\n[00:11.50] I long to see you');

    // Placeholder album is rejected before touching the network.
    const badAlbum = await core.publishToLrclib({
        artistName: 'Harbor Folk',
        trackName: 'Shenandoah',
        albumName: 'Auto-transcribed from audio',
        duration: 210,
        text: full.candidate.bakedSyncedLyrics,
    });
    assert.equal(badAlbum.ok, false);
    assert.equal(badAlbum.status, 400);
    assert.equal(published.length, 0);

    // Save edited lyrics resets offset to 0 and updates active candidate.
    const saved = core.command({
        op: 'saveEditedLyrics',
        artistName: 'Harbor Folk',
        trackName: 'Shenandoah',
        albumName: 'Sea Shanties',
        duration: 210,
        text: '[00:04.50] Oh Shenandoah\n[00:11.50] I long to hear you',
    });
    assert.equal(saved.ok, true);
    assert.equal(saved.lineCount, 2);
    assert.equal(core.state().offsetSeconds, 0);

    // Rate-limit refusal returns 429 cleanly.
    forceRateLimit = true;
    const limited = await core.publishToLrclib({
        artistName: 'Harbor Folk',
        trackName: 'Shenandoah',
        albumName: 'Sea Shanties',
        duration: 210,
        text: '[00:04.50] Oh Shenandoah\n[00:11.50] I long to hear you',
    });
    assert.equal(limited.ok, false);
    assert.equal(limited.status, 429);

    // After pause clears, publishing succeeds and never logs lyric words.
    forceRateLimit = false;
    const {core: core2, logs: logs2} = makeCore({
        publish: async req => {
            published.push(req);
            return {ok: true, status: 201};
        },
    });
    const ok = await core2.publishToLrclib({
        artistName: 'Harbor Folk',
        trackName: 'Shenandoah',
        albumName: 'Sea Shanties',
        duration: 210,
        text: '[00:04.50] Oh Shenandoah\n[00:11.50] I long to hear you',
    });
    assert.equal(ok.ok, true);
    assert.equal(ok.lineCount, 2);
    assert.equal(published.length, 1);
    assert.equal(published[0].plainLyrics, 'Oh Shenandoah\nI long to hear you');
    assert.equal(published[0].syncedLyrics, '[00:04.50] Oh Shenandoah\n[00:11.50] I long to hear you');
    assert.ok(!logs2.join('\n').includes('Shenandoah'), 'logs must never contain lyric text');
    assert.ok(!logs.join('\n').includes('Shenandoah'), 'logs must never contain lyric text');
});

test('real gjs service serves /api/lyrics and completes anonymous LRCLIB challenge + publish end-to-end', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lyrics-publish-gjs-'));
    const procs = [];
    let mockServer = null;
    try {
        const challengePrefix = 'MockChallengePrefix';
        const challengeTarget = `00FFF${'0'.repeat(59)}`;
        let receivedPublish = null;

        mockServer = http.createServer((req, res) => {
            let body = '';
            req.on('data', chunk => { body += chunk; });
            req.on('end', () => {
                if (req.url.startsWith('/api/search')) {
                    res.writeHead(200, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify([{
                        id: 7,
                        trackName: 'Amazing Grace',
                        artistName: 'Chapel Choir',
                        albumName: 'Hymns Live',
                        duration: 180,
                        instrumental: false,
                        plainLyrics: 'Amazing grace, how sweet the sound',
                        syncedLyrics: '[00:05.00] Amazing grace, how sweet the sound',
                    }]));
                    return;
                }
                if (req.method === 'POST' && req.url === '/api/request-challenge') {
                    res.writeHead(200, {'Content-Type': 'application/json'});
                    res.end(JSON.stringify({prefix: challengePrefix, target: challengeTarget}));
                    return;
                }
                if (req.method === 'POST' && req.url === '/api/publish') {
                    const token = req.headers['x-publish-token'] || '';
                    const [prefix, nonce] = String(token).split(':');
                    const digest = crypto.createHash('sha256').update(`${prefix}${nonce}`, 'utf8').digest();
                    if (prefix !== challengePrefix || Buffer.compare(digest, Buffer.from(challengeTarget, 'hex')) > 0) {
                        res.writeHead(400, {'Content-Type': 'application/json'});
                        res.end(JSON.stringify({message: 'The provided publish token is incorrect'}));
                        return;
                    }
                    receivedPublish = {headers: req.headers, body: JSON.parse(body)};
                    res.writeHead(201, {'Content-Type': 'application/json'});
                    res.end('{}');
                    return;
                }
                res.writeHead(404);
                res.end();
            });
        });
        await new Promise(resolve => mockServer.listen(0, '127.0.0.1', resolve));
        const mockPort = mockServer.address().port;

        const env = isolatedEnv(tmp);
        const bus = await startBus(tmp, 'session', env, dconfServiceDir(tmp));
        procs.push(bus.daemon);
        env.DBUS_SESSION_BUS_ADDRESS = bus.address;

        const port = 25000 + Math.floor(Math.random() * 15000);
        const settingsPath = path.join(tmp, 'settings.json');
        fs.writeFileSync(settingsPath, JSON.stringify({
            port,
            hostname: `localhost:${port}`,
            lrclibBaseUrl: `http://127.0.0.1:${mockPort}`,
            ytarchiveUrl: null,
            stateDir: path.join(tmp, 'state'),
        }));

        const service = spawn('gjs', ['-m', path.join(root, 'service', 'main.js'), '--settings', settingsPath],
            {env, stdio: ['ignore', 'pipe', 'pipe']});
        procs.push(service);
        await new Promise((resolve, reject) => {
            let logText = '';
            const check = data => {
                logText += data;
                if (/listening on/u.test(logText))
                    resolve();
            };
            service.stdout.on('data', check);
            service.stderr.on('data', check);
            service.once('exit', code => reject(new Error(`service exited ${code}:\n${logText}`)));
        });

        const base = `http://localhost:${port}`;
        const reportRes = await fetch(`${base}/api/report`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify({
                tabId: 1,
                addonVersion: '1.3.1',
                sampledAt: Date.now(),
                heartbeatMs: 30_000,
                media: {videoId: 'grace01', currentTime: 6, duration: 180, paused: false, ended: false, stalled: false, playbackRate: 1, muted: false, volume: 1, adShowing: false},
                metadata: {host: 'www.youtube.com', videoId: 'grace01', title: 'Amazing Grace', author: 'Chapel Choir - Topic', lengthSeconds: 180, category: 'Music', musicVideoType: '', musicCards: [], mediaSession: null, ytmByline: '', description: ''},
                next: null,
            }),
        });
        assert.equal(reportRes.status, 204);

        let full = null;
        for (let i = 0; i < 30; i++) {
            full = await (await fetch(`${base}/api/lyrics`)).json();
            if (full.candidate?.timed)
                break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.equal(full.candidate.lines.length, 1);
        assert.equal(full.candidate.lines[0].text, 'Amazing grace, how sweet the sound');

        const pubRes = await fetch(`${base}/api/publish-lrclib`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json', Origin: base},
            body: JSON.stringify({
                artistName: 'Chapel Choir',
                trackName: 'Amazing Grace',
                albumName: 'Hymns Live',
                duration: 180,
                text: '[00:05.00] Amazing grace, how sweet the sound\n[00:12.00] That saved a wretch like me',
            }),
        });
        assert.equal(pubRes.status, 201);
        const pubJson = await pubRes.json();
        assert.equal(pubJson.ok, true);
        assert.equal(pubJson.lineCount, 2);
        assert.ok(receivedPublish, 'mock LRCLIB must have received the verified publish');
        assert.equal(receivedPublish.headers['user-agent'], 'Mozilla/5.0');
        assert.equal(receivedPublish.body.albumName, 'Hymns Live');
        assert.equal(receivedPublish.body.syncedLyrics, '[00:05.00] Amazing grace, how sweet the sound\n[00:12.00] That saved a wretch like me');
        assert.equal(receivedPublish.body.plainLyrics, 'Amazing grace, how sweet the sound\nThat saved a wretch like me');
    } finally {
        mockServer?.close();
        for (const child of procs.reverse())
            child.kill('SIGTERM');
        await new Promise(resolve => setTimeout(resolve, 250));
        fs.rmSync(tmp, {recursive: true, force: true});
    }
});
