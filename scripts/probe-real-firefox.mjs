// The real extension in a real, signed-out Firefox against the installed
// service: prints each change in the service's state while a YouTube video
// plays, then kills Firefox and times how long the service takes to drop
// the tab. Headless and muted; the profile is created here and always
// deleted. Prints line keys, never lyric text.
//
//   node scripts/probe-real-firefox.mjs [--firefox PATH] [URL] [SECONDS]
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let firefox = 'firefox';
if (args[0] === '--firefox') {
    firefox = args[1];
    args.splice(0, 2);
}
const url = args[0] ?? 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const seconds = Number(args[1] ?? 40);
const DROP_LIMIT_MS = 40_000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function serviceState() {
    return new Promise((resolve, reject) => {
        http.get({host: '127.0.0.1', port: 8792, path: '/api/state'}, response => {
            let body = '';
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => (response.statusCode === 200
                ? resolve(JSON.parse(body)) : reject(new Error(`the service answered ${response.statusCode}`))));
        }).on('error', reject);
    });
}

function summary({state, line}) {
    return JSON.stringify({active: state.active, sounding: state.sounding, videoId: state.videoId,
        identity: state.identityText, lyrics: state.lyrics, candidates: state.candidates.length,
        line: line.key, lineChars: line.text.length});
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lyrics-overlay-firefox-'));
const logPath = path.join(tmp, 'web-ext.log');
const log = fs.openSync(logPath, 'w');
const runner = spawn('npx', ['web-ext', 'run', '--source-dir', 'firefox', '--firefox', firefox,
    '--firefox-profile', path.join(tmp, 'profile'), '--profile-create-if-missing', '--keep-profile-changes',
    '--start-url', url, '--pref', 'media.autoplay.default=0', '--pref', 'media.volume_scale=0.0',
    '--arg=--headless', '--no-reload', '--no-input'], {cwd: root, stdio: ['ignore', log, log], detached: true});
let running = true;
const runnerExited = new Promise(resolve => runner.once('exit', () => {
    running = false;
    resolve();
}));

async function stopFirefox() {
    if (running) {
        process.kill(-runner.pid, 'SIGTERM');
        await runnerExited;
    }
}

let failed = false;
try {
    const started = Date.now();
    let last = '';
    while (Date.now() - started < seconds * 1000) {
        await sleep(2000);
        if (!running)
            throw new Error('web-ext exited early');
        const now = summary(await serviceState());
        if (now !== last) {
            last = now;
            console.log(`${((Date.now() - started) / 1000).toFixed(0).padStart(3)} s ${now}`);
        }
    }
    await stopFirefox();
    const stoppedAt = Date.now();
    for (;;) {
        await sleep(1000);
        const {state, line} = await serviceState();
        const waited = ((Date.now() - stoppedAt) / 1000).toFixed(0);
        if (!state.active) {
            console.log(`Firefox killed: the service dropped the tab within ${waited} s (line ${line.key})`);
            break;
        }
        if (Date.now() - stoppedAt > DROP_LIMIT_MS) {
            failed = true;
            console.log(`Firefox killed: the tab is still active after ${waited} s (line ${line.key})`);
            break;
        }
    }
} catch (error) {
    failed = true;
    console.log(`probe failed: ${error.message}\n--- web-ext log (last lines):`);
    console.log(fs.readFileSync(logPath, 'utf8').split('\n').slice(-20).join('\n'));
} finally {
    await stopFirefox();
    fs.rmSync(tmp, {recursive: true, force: true});
}
process.exitCode = failed ? 1 : 0;
