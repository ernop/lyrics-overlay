// Runs the real gjs service in an isolated session (temporary HOME, a
// private bus that activates nothing) against a stub LRCLIB.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn, execFile} from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

import {dconfServiceDir, isolatedEnv, startBus} from './isolated-session.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const run = promisify(execFile);
const REAL_DCONF = path.join(os.homedir(), '.config', 'dconf', 'user');

const LRC = '[00:01.00] One\n[00:03.00] Two\n[00:30.00] Three';
const TOPIC = 'Provided to YouTube by Label\n\nStub Song · Stub Band\n\nStub Album\n\n℗ 2003 Label';

/** Stub LRCLIB (GET /api/search) and stub ytarchive (POST /api/get, /api/lyrics) on one port. */
function startStubLrclib() {
    const requests = [];
    const archived = [];
    const server = http.createServer((request, response) => {
        const url = new URL(request.url, 'http://stub');
        if (request.method === 'POST' && ['/api/get', '/api/lyrics'].includes(url.pathname)) {
            let body = '';
            request.on('data', chunk => { body += chunk; });
            request.on('end', () => {
                archived.push({path: url.pathname, body: JSON.parse(body), origin: request.headers.origin,
                    host: request.headers.host, type: request.headers['content-type']});
                response.writeHead(url.pathname === '/api/get' ? 202 : 200, {'Content-Type': 'application/json'});
                response.end(JSON.stringify(url.pathname === '/api/get' ? {status: 'queued'} : {lyrics: 'pending'}));
            });
            return;
        }
        requests.push({path: url.pathname, track: url.searchParams.get('track_name'), artist: url.searchParams.get('artist_name'), agent: request.headers['user-agent']});
        if (url.searchParams.get('track_name') === 'Busy Song') {
            response.writeHead(429, {'Retry-After': '120'});
            response.end();
            return;
        }
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(url.searchParams.get('track_name') === 'Stub Song' ? [{
            id: 77, trackName: 'Stub Song', artistName: 'Stub Band', albumName: 'Stub Album', duration: 180,
            instrumental: false, plainLyrics: 'One\nTwo\nThree', syncedLyrics: LRC,
        }] : []));
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({server, requests, archived, port: server.address().port})));
}

let serviceLog = '';

async function waitFor(check, what) {
    const deadline = Date.now() + 10000;
    for (;;) {
        const value = await check();
        if (value)
            return value;
        if (Date.now() > deadline)
            throw new Error(`timed out waiting for ${what}; service log:\n${serviceLog}`);
        await new Promise(resolve => setTimeout(resolve, 50));
    }
}

function request(port, {method = 'GET', urlPath = '/api/state', headers = {}, body} = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({host: '127.0.0.1', port, method, path: urlPath, agent: false, headers: {Host: `127.0.0.1:${port}`, ...headers}}, response => {
            let data = '';
            response.on('data', chunk => { data += chunk; });
            response.on('end', () => resolve({status: response.statusCode, body: data, headers: response.headers}));
        });
        req.on('error', reject);
        if (body !== undefined)
            req.write(body);
        req.end();
    });
}

const EXTENSION_HEADERS = {'Content-Type': 'application/json', Origin: 'moz-extension://abc'};

const report = (port, payload, headers = {}) => request(port, {
    method: 'POST', urlPath: '/api/report', body: JSON.stringify(payload), headers: {...EXTENSION_HEADERS, ...headers},
});

/** The real service on a private bus; stopped and removed when the test ends. */
async function startService(t) {
    const stub = await startStubLrclib();
    const realDconfBefore = fs.statSync(REAL_DCONF).mtimeMs;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyrics-overlay-test-'));
    const env = isolatedEnv(dir);
    const bus = await startBus(dir, 'session', env, dconfServiceDir(dir));
    env.DBUS_SESSION_BUS_ADDRESS = bus.address;
    const port = 20000 + Math.floor(Math.random() * 20000);
    const settingsPath = path.join(dir, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
        port, hostname: 'lyrics.localhost', lrclibBaseUrl: `http://127.0.0.1:${stub.port}`,
        ytarchiveUrl: `http://127.0.0.1:${stub.port}`, stateDir: path.join(dir, 'service-state'),
    }));
    serviceLog = '';
    const service = spawn('gjs', ['-m', path.join(root, 'tests/service-under-gc.js'), '--settings', settingsPath], {env, stdio: ['ignore', 'inherit', 'pipe']});
    service.stderr.on('data', data => { serviceLog += data; });
    t.after(() => {
        service.kill('SIGTERM');
        bus.daemon.kill();
        stub.server.close();
        fs.rmSync(dir, {recursive: true, force: true});
        assert.equal(fs.statSync(REAL_DCONF).mtimeMs, realDconfBefore, 'the real dconf database changed; restore it');
    });

    await waitFor(async () => (await request(port).catch(() => null))?.status === 200, 'the service to listen');
    const gdbus = async (method, ...args) => {
        const {stdout} = await run('gdbus', ['call', '--session', '--dest', 'net.fuseki.LyricsOverlay', '--object-path', '/net/fuseki/LyricsOverlay',
            '--method', `net.fuseki.LyricsOverlay1.${method}`, ...args], {env});
        return JSON.parse(JSON.parse(`"${stdout.trim().replace(/^\('|',\)$/gu, '').replaceAll('"', '\\"')}"`));
    };
    // What the shell reads: the setting as stored in the session's dconf.
    const stored = async key => (await run('gsettings', ['get', 'org.gnome.shell.extensions.lyrics-overlay', key],
        {env: {...env, GSETTINGS_SCHEMA_DIR: path.join(env.XDG_RUNTIME_DIR, 'lyrics-overlay', 'schemas')}})).stdout.trim();
    return {stub, dir, port, gdbus, stored};
}

const pagePost = (port, urlPath, body, headers = {}) => request(port, {method: 'POST', urlPath, body: JSON.stringify(body),
    headers: {'Content-Type': 'application/json', Origin: `http://127.0.0.1:${port}`, ...headers}});

test('the gjs service looks up lyrics, serves state and accepts shell commands', async t => {
    const {stub, dir, port, gdbus} = await startService(t);

    // Guards: Host, Origin, content type, shape.
    assert.equal((await request(port, {headers: {Host: 'evil.example'}})).status, 403);
    assert.equal((await request(port, {headers: {Host: `lyrics.localhost:${port}`}})).status, 200, 'the browser add-on’s address');
    const media = {videoId: 'abcdefghijk', currentTime: 0.5, duration: 180, paused: false, ended: false, stalled: false, playbackRate: 1, muted: false, volume: 1, adShowing: false};
    const metadata = {host: 'www.youtube.com', videoId: 'abcdefghijk', title: 'Stub Song', author: 'Stub Band - Topic', lengthSeconds: 180,
        category: 'Music', musicVideoType: '', description: TOPIC, musicCards: [], mediaSession: null, ytmByline: ''};
    assert.equal((await report(port, {tabId: 3, sampledAt: Date.now(), heartbeatMs: 5000, media}, {Origin: 'https://evil.example'})).status, 403);
    assert.equal((await report(port, {tabId: 3, sampledAt: Date.now(), heartbeatMs: 5000, media}, {Origin: 'null'})).status, 403);
    const withoutOrigin = siteHeader => request(port, {method: 'POST', urlPath: '/api/report',
        body: JSON.stringify({tabId: 4, sampledAt: Date.now(), heartbeatMs: 5000, media}), headers: {'Content-Type': 'application/json', ...siteHeader}});
    assert.equal((await withoutOrigin({'Sec-Fetch-Site': 'cross-site'})).status, 403);
    assert.equal((await withoutOrigin({})).status, 204, 'a local client sends no Origin');
    assert.equal((await request(port, {method: 'POST', urlPath: '/api/gone', body: JSON.stringify({tabId: 4}), headers: {'Content-Type': 'application/json'}})).status, 204);
    assert.equal((await request(port, {method: 'POST', urlPath: '/api/report', body: '{}', headers: {'Content-Type': 'text/plain'}})).status, 415);
    assert.equal((await report(port, {tabId: 3, sampledAt: Date.now(), heartbeatMs: 5000, media: {...media, videoId: '../../etc'}})).status, 400);
    assert.equal((await report(port, {tabId: 3, sampledAt: 0, heartbeatMs: 5000, media})).status, 400);
    assert.equal((await request(port)).headers['access-control-allow-origin'], undefined);

    assert.equal((await report(port, {tabId: 3, sampledAt: Date.now(), heartbeatMs: 5000, media, metadata, next: null})).status, 204);
    const state = await waitFor(async () => {
        const answer = JSON.parse((await request(port)).body);
        return answer.state.lyrics === 'timed' ? answer : null;
    }, 'timed lyrics');
    assert.equal(state.state.identityText, 'Stub Band - Stub Song - 2003 - Stub Album');
    assert.equal(stub.requests.length, 1);
    assert.deepEqual(stub.requests[0], {path: '/api/search', track: 'Stub Song', artist: 'Stub Band', agent: 'Mozilla/5.0'});
    assert.equal(state.line.text, 'One', 'no identity intro: the first line, led by 0.75 s');

    await waitFor(async () => JSON.parse((await request(port)).body).line.text === 'Two', 'the second line on time');

    assert.deepEqual(await gdbus('Command', JSON.stringify({op: 'tooFast'})), {ok: true});
    assert.equal((await gdbus('GetState')).offsetSeconds, -0.5);
    assert.deepEqual(await gdbus('Command', JSON.stringify({op: 'reject'})), {ok: true});
    assert.equal((await gdbus('GetState')).lyrics, 'none');
    assert.deepEqual(await gdbus('Command', JSON.stringify({op: 'choose', id: 77})), {ok: true});
    assert.equal((await gdbus('GetState')).chosen.id, 77);

    const saved = JSON.parse(fs.readFileSync(path.join(dir, 'service-state', 'videos', 'abcdefghijk.json'), 'utf8'));
    assert.deepEqual([saved.offsetSeconds, saved.chosenId, saved.rejectedIds], [-0.5, 77, []]);
    assert.equal(fs.statSync(path.join(dir, 'service-state', 'videos', 'abcdefghijk.json')).mode & 0o077, 0);

    const home = await request(port, {urlPath: '/'});
    assert.equal(home.status, 303);
    assert.equal(home.headers.location, `http://127.0.0.1:${port}/settings`, 'the settings page, on the address asked for');
    const page = await request(port, {urlPath: '/settings'});
    assert.equal(page.status, 200);
    assert.match(page.body, /<title>Lyrics overlay settings<\/title>/u, 'the shell raises the window by this title');
    for (const script of ['/settings.js', '/shared/scales.js', '/shared/text-ink.js', '/shared/lyrics-status.js'])
        assert.match((await request(port, {urlPath: script})).headers['content-type'], /^text\/javascript/u, script);
    const icon = await request(port, {urlPath: '/favicon.svg'});
    assert.equal(icon.headers['content-type'], 'image/svg+xml');
    assert.equal(icon.body, fs.readFileSync(new URL('../firefox/icon.svg', import.meta.url), 'utf8'));

    // The shell's FocusSong reaches the extension through its open request,
    // and the extension's answer returns to the shell.
    const commandRequest = headers => request(port, {method: 'POST', urlPath: '/api/commands', body: '{}', headers});
    assert.equal((await commandRequest({...EXTENSION_HEADERS, Origin: 'https://evil.example'})).status, 403);
    assert.equal((await commandRequest({...EXTENSION_HEADERS, 'Content-Type': 'text/plain'})).status, 415);
    // A newer request takes a held one's place, and the held one is told so
    // rather than answered empty: asking again at once would only take the
    // place back, and two listening browsers would trade it without pause.
    const displaced = commandRequest(EXTENSION_HEADERS);
    await new Promise(resolve => setTimeout(resolve, 200));
    const waiting = commandRequest(EXTENSION_HEADERS);
    const displacedAnswer = await displaced;
    assert.equal(displacedAnswer.status, 409);
    assert.match(JSON.parse(displacedAnswer.body).error, /newer request/u);
    const focused = gdbus('FocusSong');
    const delivered = await waiting;
    assert.equal(delivered.status, 200);
    const command = JSON.parse(delivered.body);
    assert.deepEqual(command, {op: 'focusTab', tabId: 3, id: 1});
    const title = 'Stub Song - YouTube — Mozilla Firefox';
    const answer = result => request(port, {method: 'POST', urlPath: '/api/command-result', body: JSON.stringify(result), headers: EXTENSION_HEADERS});
    assert.equal((await answer({id: command.id, ok: true})).status, 400, 'a success names its window');
    assert.equal((await answer({id: command.id, ok: true, windowTitle: title})).status, 204);
    assert.deepEqual(await focused, {ok: true, windowTitle: title});
    assert.equal((await answer({id: command.id, ok: true, windowTitle: title})).status, 409, 'answered once');
    assert.deepEqual(await gdbus('FocusSong'), {ok: false, error: 'the browser extension is not listening'});

    // A right-click on the lyric or the indicator asks for the one settings tab.
    const opening = gdbus('OpenSettings');
    const settingsCommand = JSON.parse((await commandRequest(EXTENSION_HEADERS)).body);
    assert.deepEqual(settingsCommand, {op: 'openSettings', id: 3});
    const settingsTitle = 'Lyrics overlay settings — Mozilla Firefox';
    assert.equal((await answer({id: settingsCommand.id, ok: true, windowTitle: settingsTitle})).status, 204);
    assert.deepEqual(await opening, {ok: true, windowTitle: settingsTitle});

    assert.equal((await request(port, {method: 'POST', urlPath: '/api/gone', body: JSON.stringify({tabId: 3}), headers: {'Content-Type': 'application/json'}})).status, 204);
    assert.deepEqual(await gdbus('FocusSong'), {ok: false, error: 'no song is playing'});
    assert.equal(JSON.parse((await request(port)).body).state.active, false);
    assert.doesNotMatch(serviceLog, /CRITICAL|WARNING|Error/u, serviceLog);
});

test('a connection the service will close is announced, and every other one is kept', async t => {
    const {port, gdbus} = await startService(t);
    // Browsers send the next request on a connection they kept; one the
    // service closes unannounced resets that request.
    const agent = new http.Agent({keepAlive: true, maxSockets: 1});
    t.after(() => agent.destroy());
    let announcedClose = true;
    const send = async ({method = 'GET', urlPath = '/api/state', headers = {}, body} = {}) => {
        const answer = await new Promise((resolve, reject) => {
            const req = http.request({host: '127.0.0.1', port, method, path: urlPath, agent, headers: {Host: `127.0.0.1:${port}`, ...headers}}, response => {
                let data = '';
                response.on('data', chunk => { data += chunk; });
                response.on('end', () => resolve({status: response.statusCode, body: data, reused: req.reusedSocket,
                    closes: response.headers.connection === 'close'}));
            });
            req.on('error', reject);
            req.end(body);
        });
        assert.equal(answer.reused, !announcedClose, `${method} ${urlPath}: sent on the kept connection, or a new one after an announced close`);
        announcedClose = answer.closes;
        return answer;
    };
    const extensionPost = (urlPath, value) => send({method: 'POST', urlPath, body: JSON.stringify(value), headers: EXTENSION_HEADERS});

    assert.equal((await send()).status, 200);
    assert.equal((await send({urlPath: '/'})).status, 303);
    assert.equal((await send({urlPath: '/settings'})).status, 200);
    assert.equal((await send({urlPath: '/nothing-here'})).status, 404);
    assert.equal((await extensionPost('/api/gone', {tabId: 4})).status, 204);
    assert.equal((await extensionPost('/api/command-result', {id: 9, ok: false, error: 'late'})).status, 409);
    const opening = gdbus('OpenSettings');
    const command = JSON.parse((await extensionPost('/api/commands', {})).body);
    const windowTitle = 'Lyrics overlay settings — Mozilla Firefox';
    assert.equal((await extensionPost('/api/command-result', {id: command.id, ok: true, windowTitle})).status, 204);
    assert.deepEqual(await opening, {ok: true, windowTitle});
    assert.equal((await send()).status, 200);
});

test('the settings page reads and writes the settings the shell reads, and only the page may write them', async t => {
    const {port, stored} = await startService(t);
    const {schema, values} = JSON.parse((await request(port, {urlPath: '/api/settings'})).body);
    assert.deepEqual(schema['font-size'], {type: 'd', writable: true, default: 48, min: 16, max: 256});
    assert.deepEqual(schema['text-border'].choices, ['none', 'single', 'double']);
    assert.equal(schema.box.writable, false, 'the box is set by dragging');
    assert.equal(values['font-size'], 48);

    const written = await pagePost(port, '/api/settings', {changes: {'font-size': 72, 'pitch-line-color': '#ff8800', 'pitch-dock': 'left'}});
    assert.equal(written.status, 200);
    assert.equal(JSON.parse(written.body).values['font-size'], 72);
    // dconf-service writes its database a moment after the service's call.
    await waitFor(async () => await stored('font-size') === '72.0', 'the size in dconf');
    assert.equal(await stored('pitch-dock'), "'left'");

    const refusals = [
        [{'font-size': 999}, /font-size must be from 16 to 256/u],
        [{'text-color': 'teal'}, /text-color must be one of/u],
        [{'pitch-line-color': 'orange'}, /#rrggbb/u],
        [{'box': {cx: 0.5, cy: 0.5, width: 0.5, height: 0.5}}, /dragging/u],
        [{'pitch-range-top': 50}, /at least 6 semitones/u],
        [{'no-such-key': true}, /no setting named/u],
    ];
    for (const [changes, why] of refusals) {
        const refused = await pagePost(port, '/api/settings', {changes});
        assert.equal(refused.status, 400, JSON.stringify(changes));
        assert.match(JSON.parse(refused.body).error, why);
    }
    assert.equal((await pagePost(port, '/api/settings', {changes: {'font-size': 20}}, {Origin: 'https://evil.example'})).status, 403);
    assert.equal((await pagePost(port, '/api/settings', {changes: {'font-size': 20}}, {Origin: `http://127.0.0.1:${port + 1}`})).status, 403);
    assert.equal((await pagePost(port, '/api/settings', {changes: {'font-size': 20}}, {'Content-Type': 'text/plain'})).status, 415);
    assert.equal((await request(port, {method: 'POST', urlPath: '/api/settings', body: '{"changes":{"font-size":20}}',
        headers: {'Content-Type': 'application/json'}})).status, 403, 'no Origin: not the page');
    assert.equal(await stored('font-size'), '72.0', 'nothing refused was written');

    const reset = await pagePost(port, '/api/settings/reset', {keys: ['font-size', 'pitch-dock']});
    assert.equal(reset.status, 200);
    await waitFor(async () => await stored('font-size') === '48.0', 'the reset size in dconf');

    assert.deepEqual(JSON.parse((await pagePost(port, '/api/command', {op: 'tooSlow'})).body), {ok: false}, 'no song playing');
    assert.equal((await pagePost(port, '/api/command', {op: 'pitch', wanted: true})).status, 400, 'the microphone is the shell’s');
    assert.equal((await pagePost(port, '/api/pitch/fit', {})).status, 409, 'nothing sung yet');

    const fonts = JSON.parse((await request(port, {urlPath: '/api/fonts'})).body).families;
    assert.ok(fonts.length > 0 && fonts.every(family => typeof family === 'string' && family), 'installed families by name');
    assert.deepEqual(fonts, [...fonts].sort((a, b) => a.localeCompare(b)));
});

test('an LRCLIB rate-limit refusal pauses lookups for the time it names instead of failing them', async t => {
    const {stub, dir, port} = await startService(t);
    const media = {videoId: 'busybusybus', currentTime: 0.5, duration: 180, paused: false, ended: false, stalled: false, playbackRate: 1, muted: false, volume: 1, adShowing: false};
    const metadata = {host: 'www.youtube.com', videoId: 'busybusybus', title: 'Busy Song', author: 'Stub Band - Topic', lengthSeconds: 180,
        category: 'Music', musicVideoType: '', description: 'Provided to YouTube by Label\n\nBusy Song · Stub Band\n\nStub Album\n\n℗ 2003 Label',
        musicCards: [], mediaSession: null, ytmByline: ''};
    const sentAt = Date.now();
    assert.equal((await report(port, {tabId: 5, sampledAt: sentAt, heartbeatMs: 5000, media, metadata, next: null})).status, 204);
    await waitFor(() => serviceLog.includes('LRCLIB refused for its rate limit (HTTP 429); resuming lookups at '), 'the pause');
    assert.equal(JSON.parse((await request(port)).body).state.lyrics, 'waiting');
    assert.equal(stub.requests.length, 1);
    const budget = JSON.parse(fs.readFileSync(path.join(dir, 'service-state', 'budget.json'), 'utf8'));
    assert.ok(budget.pausedUntil >= sentAt + 120_000 && budget.pausedUntil <= Date.now() + 120_000, JSON.stringify(budget));
    assert.doesNotMatch(serviceLog, /not a valid value|CRITICAL|WARNING|Error/u, serviceLog);
});

test('a video that starts sounding is handed to ytarchive once, then the lyrics found for it', async t => {
    const {stub, dir, port} = await startService(t);
    const media = {videoId: 'handoffvid1', currentTime: 0.5, duration: 180, paused: true, ended: false, stalled: false, playbackRate: 1, muted: false, volume: 1, adShowing: false};
    const metadata = {host: 'www.youtube.com', videoId: 'handoffvid1', title: 'Stub Song', author: 'Stub Band - Topic', lengthSeconds: 180,
        category: 'Music', musicVideoType: '', description: TOPIC, musicCards: [], mediaSession: null, ytmByline: ''};
    assert.equal((await report(port, {tabId: 6, sampledAt: Date.now(), heartbeatMs: 5000, media, metadata, next: null})).status, 204);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.deepEqual(stub.archived, [], 'a paused video was not heard');

    assert.equal((await report(port, {tabId: 6, sampledAt: Date.now(), heartbeatMs: 5000, media: {...media, paused: false}, metadata, next: null})).status, 204);
    await waitFor(() => stub.archived.length === 2, 'the add and the lyrics');
    // ytarchive trusts these because they are local and carry no Origin.
    assert.deepEqual(stub.archived[0], {path: '/api/get', body: {url: 'https://www.youtube.com/watch?v=handoffvid1', via: 'played'},
        origin: undefined, host: `127.0.0.1:${stub.port}`, type: 'application/json'});
    assert.deepEqual(stub.archived[1].body, {video_id: 'handoffvid1',
        lrc: `[ar:Stub Band]\n[ti:Stub Song]\n[al:Stub Album]\n[length:03:00]\n${LRC}\n`});

    assert.equal((await report(port, {tabId: 6, sampledAt: Date.now(), heartbeatMs: 5000, media: {...media, paused: false, currentTime: 2}, metadata, next: null})).status, 204);
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(stub.archived.length, 2, 'once per video, not per report');
    const record = JSON.parse(fs.readFileSync(path.join(dir, 'service-state', 'archive', 'handoffvid1.json'), 'utf8'));
    assert.deepEqual(record, {version: 1, videoId: 'handoffvid1', added: true, lyricsKey: '1:77'});
    assert.equal((await request(port, {method: 'POST', urlPath: '/api/archive', body: '{}', headers: EXTENSION_HEADERS})).status, 404);
    assert.match(serviceLog, /ytarchive: added handoffvid1/u);
    assert.doesNotMatch(serviceLog, /CRITICAL|WARNING|failed|unreachable/u, serviceLog);
});
