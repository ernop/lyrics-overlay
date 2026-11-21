// Draws the README's pictures of the settings page: the real page in a
// signed-out, headless Firefox with a throwaway profile, driven over
// WebDriver BiDi with Node's own WebSocket. A private service on its own
// session bus, local mock LRCLIB server, and port serves it with a public-
// domain song and made-up microphones (a stand-in pw-dump), so nothing of
// this computer's devices or listening shows. Every temporary file is deleted
// at the end. Run by scripts/update-readme-pictures.sh:
//
//   node scripts/settings-page-picture.mjs [--firefox PATH]
import {execFileSync, spawn} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {dconfServiceDir, isolatedEnv, startBus} from '../tests/isolated-session.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ARTIFACTS = path.join(root, 'build', 'e2e-artifacts');
const OUT_LYRICS = path.join(ARTIFACTS, 'readme-settings.png');
const OUT_MAP = path.join(ARTIFACTS, 'readme-settings-map.png');
const OUT_SONG = path.join(ARTIFACTS, 'readme-settings-song.png');

const args = process.argv.slice(2);
const firefox = args[0] === '--firefox' ? args[1] : execFileSync('sh', ['-c', 'command -v firefox'], {encoding: 'utf8'}).trim();
const WINDOW = {width: 1280, height: 880};
const READY_WAIT_MS = 60_000;
const FONTS_CHECK_MS = 2_000;
const SEND_LIMIT_MS = 30_000;

const DESK_MIC = 'alsa_input.usb-Example_Audio_Desk_Mic_0001-00.analog-stereo';
const node = (id, mediaClass, name, description) => ({id, type: 'PipeWire:Interface:Node',
    info: {props: {'media.class': mediaClass, 'node.name': name, 'node.description': description}}});
const PW_DUMP = [
    {id: 41, type: 'PipeWire:Interface:Metadata', props: {'metadata.name': 'default'},
        metadata: [{subject: 0, key: 'default.audio.source', type: 'Spa:String:JSON', value: {name: DESK_MIC}}]},
    node(45, 'Audio/Source', DESK_MIC, 'Desk Mic Analog Stereo'),
    node(46, 'Audio/Source', 'alsa_input.pci-0000_00_1f.3.analog-stereo', 'Built-in Audio Analog Stereo'),
];

const VIDEO_ID = 'sakurasakura1';
const SAKURA_LRC = [
    '[00:05.00] 桜 弥生の空は 見渡す限り',
    '[00:18.00] 霞か雲か 朝日に匂う',
    '[00:31.00] 桜 桜 花ざかり',
    '[00:44.00] いざや いざや 見にゆかん',
].join('\n');
const SAKURA_PLAIN = [
    '桜 弥生の空は 見渡す限り',
    '霞か雲か 朝日に匂う',
    '桜 桜 花ざかり',
    'いざや いざや 見にゆかん',
].join('\n');

const MOCK_LRCLIB = [
    {
        id: 101,
        trackName: 'Sakura Sakura',
        artistName: 'Traditional Ensemble',
        albumName: 'Spring Folk Songs',
        duration: 168,
        instrumental: false,
        plainLyrics: SAKURA_PLAIN,
        syncedLyrics: SAKURA_LRC,
    },
    {
        id: 102,
        trackName: 'Sakura Sakura (Acoustic)',
        artistName: 'Traditional Ensemble',
        albumName: 'Koto & Voice',
        duration: 170,
        instrumental: false,
        plainLyrics: SAKURA_PLAIN,
        syncedLyrics: SAKURA_LRC,
    },
    {
        id: 103,
        trackName: 'Sakura Sakura',
        artistName: 'Traditional Ensemble',
        albumName: 'Anthology',
        duration: 168,
        instrumental: false,
        plainLyrics: SAKURA_PLAIN,
        syncedLyrics: null,
    },
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function printed(child, pattern, what) {
    return new Promise((resolve, reject) => {
        let text = '';
        const onData = data => {
            text += data;
            const match = text.match(pattern);
            if (match)
                resolve(match);
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
        child.once('error', reject);
        child.once('exit', code => reject(new Error(`${what} exited (${code}):\n${text}`)));
    });
}

async function bidi(url) {
    const socket = new WebSocket(url);
    await new Promise((resolve, reject) => {
        socket.addEventListener('open', resolve, {once: true});
        socket.addEventListener('error', () => reject(new Error(`could not connect to ${url}`)), {once: true});
    });
    const pending = new Map();
    let nextId = 1;
    socket.addEventListener('message', ({data}) => {
        const message = JSON.parse(data);
        const waiting = pending.get(message.id);
        if (!waiting)
            return;
        pending.delete(message.id);
        if (message.type === 'success')
            waiting.resolve(message.result);
        else
            waiting.reject(new Error(`${waiting.method}: ${message.error} ${message.message}`));
    });
    return {
        send: (method, params) => new Promise((resolve, reject) => {
            const id = nextId++;
            const timer = setTimeout(() => {
                pending.delete(id);
                reject(new Error(`${method}: no answer in ${SEND_LIMIT_MS / 1000} s`));
            }, SEND_LIMIT_MS);
            const settle = callback => value => {
                clearTimeout(timer);
                callback(value);
            };
            pending.set(id, {method, resolve: settle(resolve), reject: settle(reject)});
            socket.send(JSON.stringify({id, method, params}));
        }),
        close: () => socket.close(),
    };
}

async function startMockLrclib() {
    const server = http.createServer((_req, res) => {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end(JSON.stringify(MOCK_LRCLIB));
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const {port} = server.address();
    return {server, url: `http://127.0.0.1:${port}`};
}

const manifest = JSON.parse(fs.readFileSync(path.join(root, 'firefox', 'manifest.json'), 'utf8'));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lyrics-overlay-settings-picture-'));
const processes = [];
let mockLrclib = null;
try {
    mockLrclib = await startMockLrclib();
    const env = isolatedEnv(tmp);
    const bus = await startBus(tmp, 'session', env, dconfServiceDir(tmp));
    processes.push(bus.daemon);
    env.DBUS_SESSION_BUS_ADDRESS = bus.address;

    const bin = path.join(tmp, 'bin');
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, 'pw-dump.json'), JSON.stringify(PW_DUMP));
    fs.writeFileSync(path.join(bin, 'pw-dump'), `#!/bin/sh\nexec cat '${path.join(bin, 'pw-dump.json')}'\n`, {mode: 0o755});
    env.PATH = `${bin}:${env.PATH}`;

    const port = 20000 + Math.floor(Math.random() * 20000);
    const settingsPath = path.join(tmp, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
        port,
        hostname: 'lyrics.localhost:8792',
        lrclibBaseUrl: mockLrclib.url,
        ytarchiveUrl: null,
        stateDir: path.join(tmp, 'state', 'lyrics'),
    }));
    const service = spawn('gjs', ['-m', path.join(root, 'service', 'main.js'), '--settings', settingsPath],
        {env, stdio: ['ignore', 'pipe', 'pipe']});
    processes.push(service);
    await printed(service, /listening on/u, 'the service');

    // Configure showcase settings and report a live public-domain Japanese song.
    const api = async (method, apiPath, body, headers = {}) => {
        const res = await fetch(`http://localhost:${port}${apiPath}`, {
            method,
            headers: {'Content-Type': 'application/json', ...headers},
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        if (!res.ok)
            throw new Error(`${method} ${apiPath} -> ${res.status}`);
        return res.status === 204 ? null : res.json();
    };
    await api('POST', '/api/settings', {
        changes: {
            'overlay-enabled': true,
            'pitch-enabled': true,
            'font-size': 56,
            'text-color': 'pink',
            'text-border': 'triple',
            'text-furigana': true,
            'text-backdrop': 'none',
        },
    }, {Origin: `http://localhost:${port}`});
    await api('POST', '/api/report', {
        tabId: 1,
        addonVersion: manifest.version,
        sampledAt: Date.now(),
        heartbeatMs: 60_000,
        media: {
            videoId: VIDEO_ID,
            currentTime: 7,
            duration: 168,
            playbackRate: 1,
            paused: false,
            ended: false,
            muted: false,
            volume: 1,
            stalled: false,
            adShowing: false,
        },
        metadata: {
            host: 'www.youtube.com',
            videoId: VIDEO_ID,
            title: 'Sakura Sakura',
            author: 'Traditional Ensemble - Topic',
            lengthSeconds: 168,
            category: 'Music',
            musicVideoType: '',
            musicCards: [],
            mediaSession: null,
            ytmByline: '',
            description: 'Provided to YouTube by Label\n\nSakura Sakura · Traditional Ensemble\n\nSpring Folk Songs\n\n℗ 2026 Label',
        },
        next: null,
    });

    // Wait until LRCLIB lookup + offline SudachiPy furigana have populated the active line.
    for (let i = 0; i < 40; i++) {
        const st = await api('GET', '/api/state');
        if (st.state.lyrics === 'timed' && Array.isArray(st.line?.ruby))
            break;
        await sleep(100);
    }

    const profile = path.join(tmp, 'profile');
    fs.mkdirSync(profile);
    fs.writeFileSync(path.join(profile, 'user.js'), [
        'user_pref("browser.shell.checkDefaultBrowser", false);',
        'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
        'user_pref("toolkit.telemetry.reportingpolicy.firstRun", false);',
    ].join('\n'));
    const browser = spawn(firefox, ['--headless', '--no-remote', '--profile', profile, '--remote-debugging-port', '0'],
        {env: {...env, MOZ_HEADLESS_WIDTH: String(WINDOW.width), MOZ_HEADLESS_HEIGHT: String(WINDOW.height)},
            stdio: ['ignore', 'pipe', 'pipe'], detached: true});
    processes.push(browser);
    const [, socketUrl] = await printed(browser, /WebDriver BiDi listening on (ws:\/\/\S+)/u, 'Firefox');

    const session = await bidi(`${socketUrl}/session`);
    await session.send('session.new', {capabilities: {}});
    const {contexts: [{context}]} = await session.send('browsingContext.getTree', {});
    await session.send('browsingContext.navigate', {context, url: `http://localhost:${port}/settings`, wait: 'complete'});

    const ready = `(async () => {
        const fontsLoaded = await Promise.race([document.fonts.ready.then(() => true),
            new Promise(resolve => setTimeout(() => resolve(false), ${FONTS_CHECK_MS}))]);
        const filled = fontsLoaded && Boolean(document.querySelector('#stage canvas')) &&
            document.querySelectorAll('#tabs button[role="tab"]').length === 3 &&
            document.querySelectorAll('.fonts button').length > 1 &&
            document.querySelectorAll('[aria-label="Microphones"] button').length === 3 &&
            document.querySelectorAll('.ring-chip').length === 3 &&
            document.getElementById('banner').textContent === '';
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return filled;
    })()`;
    const deadline = Date.now() + READY_WAIT_MS;
    for (;;) {
        const {result} = await session.send('script.evaluate', {expression: ready, target: {context}, awaitPromise: true});
        if (result.value === true)
            break;
        if (Date.now() > deadline)
            throw new Error('the settings page did not fill in');
        await sleep(250);
    }
    await sleep(300);

    const capture = async outPath => {
        const {data} = await session.send('browsingContext.captureScreenshot', {context, origin: 'viewport'});
        fs.mkdirSync(path.dirname(outPath), {recursive: true});
        fs.writeFileSync(outPath, Buffer.from(data, 'base64'));
        console.log(`wrote ${path.relative(root, outPath)}`);
    };

    // 1. Lyrics tab: Furigana preview + Triple ring chips + per-ring controls
    await capture(OUT_LYRICS);

    // 2. Pitch tab + Screen map on the sticky left stage
    await session.send('script.evaluate', {
        target: {context},
        awaitPromise: true,
        expression: `(async () => {
            document.querySelector('#tabs button[aria-controls="panel-pitch"]')?.click() ||
                [...document.querySelectorAll('#tabs button[role="tab"]')].find(b => b.textContent.includes('Pitch'))?.click();
            [...document.querySelectorAll('#stage .stage-bar button')].find(b => b.textContent.trim() === 'Screen map')?.click();
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            return true;
        })()`,
    });
    await sleep(250);
    await capture(OUT_MAP);

    // 3. Song tab + live preview: timing nudges, manual LRCLIB search, .lrc/.txt import, lyric sets
    await session.send('script.evaluate', {
        target: {context},
        awaitPromise: true,
        expression: `(async () => {
            [...document.querySelectorAll('#tabs button[role="tab"]')].find(b => b.textContent.includes('Song'))?.click();
            [...document.querySelectorAll('#stage .stage-bar button')].find(b => b.textContent.trim().includes('Preview'))?.click();
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            return true;
        })()`,
    });
    await sleep(250);
    await capture(OUT_SONG);

    await session.send('session.end', {});
    session.close();
} finally {
    mockLrclib?.server.close();
    for (const child of processes.reverse()) {
        try {
            process.kill(child.detached ? -child.pid : child.pid);
        } catch (error) {
            if (error.code !== 'ESRCH')
                throw error;
        }
    }
    await sleep(500);
    fs.rmSync(tmp, {recursive: true, force: true});
}
