// Draws the README's pictures of the settings page: the real page in a
// signed-out, headless Firefox with a throwaway profile, driven over
// WebDriver BiDi with Node's own WebSocket. A private service on its own
// session bus, local mock LRCLIB server, stand-in local lyric generator, and
// port serves it with a public-domain English folk song ("Shenandoah") and
// made-up microphones (a stand-in pw-dump), so nothing of this computer's
// devices or listening shows. Every temporary file is deleted at the end.
// Run by scripts/update-readme-pictures.sh:
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
const OUT_FULL = path.join(ARTIFACTS, 'readme-full-lyrics.png');

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

const VIDEO_ID = 'shenandoah1';
const SHENANDOAH_LINES = [
    [6.0, 'Oh Shenandoah, I long to hear you'],
    [13.5, 'Away, you rolling river'],
    [20.5, 'Oh Shenandoah, I long to hear you'],
    [28.0, "Away, we're bound away, 'cross the wide Missouri"],
    [39.0, 'Oh Shenandoah, I love your daughter'],
    [46.5, 'Away, you rolling river'],
    [53.5, 'I will take her across the rolling water'],
    [61.0, "Away, we're bound away, 'cross the wide Missouri"],
    [72.0, "'Tis seven long years since last I saw you"],
    [79.5, 'Away, you rolling river'],
    [86.5, "'Tis seven long years since last I saw you"],
    [94.0, "Away, we're bound away, 'cross the wide Missouri"],
];

function makeFakeTranscript() {
    return {
        ok: true,
        language: 'en',
        duration: 214,
        device: 'cuda',
        segments: SHENANDOAH_LINES.map(([start, text]) => {
            const parts = text.split(' ');
            const step = 4.2 / Math.max(1, parts.length);
            const words = parts.map((w, i) => ({
                start: +(start + i * step).toFixed(2),
                end: +(start + (i + 0.85) * step).toFixed(2),
                word: i === 0 ? w : ` ${w}`,
                probability: 0.96,
            }));
            return {
                start,
                end: +(start + 4.4).toFixed(2),
                text,
                no_speech_prob: 0.01,
                words,
            };
        }),
    };
}

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

// LRCLIB returns no lyrics for this folk recording so the local automatic
// lyric timer runs and produces a clean "Transcribed" set in seconds.
async function startMockLrclib() {
    const server = http.createServer((_req, res) => {
        res.writeHead(200, {'Content-Type': 'application/json'});
        res.end('[]');
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
    const fakeGen = path.join(bin, 'fake-gen.mjs');
    fs.writeFileSync(fakeGen, `#!/usr/bin/env node
process.stderr.write('stage:transcribe\\n');
process.stdout.write(${JSON.stringify(JSON.stringify(makeFakeTranscript()))} + '\\n');
`, {mode: 0o755});
    env.PATH = `${bin}:${env.PATH}`;

    const port = 20000 + Math.floor(Math.random() * 20000);
    const settingsPath = path.join(tmp, 'settings.json');
    fs.writeFileSync(settingsPath, JSON.stringify({
        port,
        hostname: 'lyrics.localhost:8792',
        lrclibBaseUrl: mockLrclib.url,
        ytarchiveUrl: null,
        stateDir: path.join(tmp, 'state', 'lyrics'),
        lyricsGenerator: {
            command: ['node', fakeGen],
            model: 'large-v3',
            device: 'cuda',
            computeType: 'float16',
            maxDurationSeconds: 1200,
            gpuGate: null,
        },
    }));
    const service = spawn('gjs', ['-m', path.join(root, 'service', 'main.js'), '--settings', settingsPath],
        {env, stdio: ['ignore', 'pipe', 'pipe']});
    processes.push(service);
    await printed(service, /listening on/u, 'the service');

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
            'text-color': 'yellow',
            'text-border': 'triple',
            'text-furigana': false,
            'text-backdrop': 'none',
        },
    }, {Origin: `http://localhost:${port}`});

    const reportTrack = () => api('POST', '/api/report', {
        tabId: 1,
        addonVersion: manifest.version,
        sampledAt: Date.now(),
        heartbeatMs: 60_000,
        media: {
            videoId: VIDEO_ID,
            currentTime: 29,
            duration: 214,
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
            title: 'Shenandoah',
            author: 'Riverside Folk - Topic',
            lengthSeconds: 214,
            category: 'Music',
            musicVideoType: '',
            musicCards: [],
            mediaSession: null,
            ytmByline: '',
            description: 'Provided to YouTube by Label\n\nShenandoah · Riverside Folk\n\nRiver Songs\n\n℗ 2026 Label',
        },
        next: null,
    });
    await reportTrack();

    // Wait until automatic local timing produces the timed candidate.
    for (let i = 0; i < 60; i++) {
        const st = await api('GET', '/api/state');
        if (st.state.lyrics === 'timed' && st.state.candidates.some(c => c.generated === 'transcribed'))
            break;
        await sleep(100);
    }
    // Freeze at line 4 ("Away, we're bound away, 'cross the wide Missouri") so the
    // Full Lyrics modal highlights a mid-song line cleanly.
    await api('POST', '/api/report', {
        tabId: 1,
        addonVersion: manifest.version,
        sampledAt: Date.now(),
        heartbeatMs: 60_000,
        media: {
            videoId: VIDEO_ID,
            currentTime: 29.5,
            duration: 214,
            playbackRate: 1,
            paused: true,
            ended: false,
            muted: false,
            volume: 1,
            stalled: false,
            adShowing: false,
        },
        metadata: {
            host: 'www.youtube.com',
            videoId: VIDEO_ID,
            title: 'Shenandoah',
            author: 'Riverside Folk - Topic',
            lengthSeconds: 214,
            category: 'Music',
            musicVideoType: '',
            musicCards: [],
            mediaSession: null,
            ytmByline: '',
            description: 'Provided to YouTube by Label\n\nShenandoah · Riverside Folk\n\nRiver Songs\n\n℗ 2026 Label',
        },
        next: null,
    });

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
            document.querySelectorAll('.settings-group').length === 3 &&
            Boolean(document.getElementById('song')) &&
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

    // 1. Combined page at its Lyrics section: live English preview + Triple ring controls
    await capture(OUT_LYRICS);

    // 2. Pitch section + Screen map on the sticky left stage
    await session.send('script.evaluate', {
        target: {context},
        awaitPromise: true,
        expression: `(async () => {
            [...document.querySelectorAll('#stage .stage-bar button')].find(b => b.textContent.trim() === 'Screen map')?.click();
            document.getElementById('pitch')?.scrollIntoView({block: 'start'});
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            return true;
        })()`,
    });
    await sleep(250);
    await capture(OUT_MAP);

    // 3. Pitch preview + lower Pitch & Microphone controls
    await session.send('script.evaluate', {
        target: {context},
        awaitPromise: true,
        expression: `(async () => {
            [...document.querySelectorAll('#stage .stage-bar button')].find(b => b.textContent.trim() === 'Pitch')?.click();
            window.scrollTo(0, document.body.scrollHeight);
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            return true;
        })()`,
    });
    await sleep(250);
    await capture(OUT_SONG);

    // 4. Full lyrics modal open in Read mode with active line highlighted
    await session.send('script.evaluate', {
        target: {context},
        awaitPromise: true,
        expression: `(async () => {
            [...document.querySelectorAll('#topbar button')].find(b => b.textContent.trim() === 'Full lyrics')?.click();
            for (let i = 0; i < 30; i++) {
                if (document.querySelector('.lyric-line-row.is-current'))
                    break;
                await new Promise(r => setTimeout(r, 80));
            }
            await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
            return true;
        })()`,
    });
    await sleep(350);
    await capture(OUT_FULL);

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
