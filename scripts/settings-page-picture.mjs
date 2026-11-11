// Draws the README's picture of the settings page: the real page in a
// signed-out, headless Firefox with a throwaway profile, driven over
// WebDriver BiDi with Node's own WebSocket. A private service on its own
// session bus and port serves it with the default settings, no song and
// made-up microphones (a stand-in pw-dump), so nothing of this computer's
// devices or listening shows. Every file but the picture is deleted at the
// end. Run by scripts/update-readme-pictures.sh, after the shell e2e (which
// clears build/e2e-artifacts):
//
//   node scripts/settings-page-picture.mjs [--firefox PATH]
import {execFileSync, spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

import {dconfServiceDir, isolatedEnv, startBus} from '../tests/isolated-session.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(root, 'build', 'e2e-artifacts', 'readme-settings.png');
const args = process.argv.slice(2);
// Found on this PATH: the browser runs with the private session's.
const firefox = args[0] === '--firefox' ? args[1] : execFileSync('sh', ['-c', 'command -v firefox'], {encoding: 'utf8'}).trim();
// The picture is the page's first screen: the window less Firefox's bars.
const WINDOW = {width: 1280, height: 900};
// A fresh profile has taken 16 s to load the families the font list draws.
const READY_WAIT_MS = 60_000;
const FONTS_CHECK_MS = 2_000;
const SEND_LIMIT_MS = 30_000;

// Shaped like `pw-dump` output (tests/microphones.test.mjs), with made-up devices.
const DESK_MIC = 'alsa_input.usb-Example_Audio_Desk_Mic_0001-00.analog-stereo';
const node = (id, mediaClass, name, description) => ({id, type: 'PipeWire:Interface:Node',
    info: {props: {'media.class': mediaClass, 'node.name': name, 'node.description': description}}});
const PW_DUMP = [
    {id: 41, type: 'PipeWire:Interface:Metadata', props: {'metadata.name': 'default'},
        metadata: [{subject: 0, key: 'default.audio.source', type: 'Spa:String:JSON', value: {name: DESK_MIC}}]},
    node(45, 'Audio/Source', DESK_MIC, 'Desk Mic Analog Stereo'),
    node(46, 'Audio/Source', 'alsa_input.pci-0000_00_1f.3.analog-stereo', 'Built-in Audio Analog Stereo'),
];

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** Resolves with the first match of `pattern` in what `child` prints. */
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

/** A WebDriver BiDi session: send(method, params) answers with the result. */
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

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lyrics-overlay-settings-picture-'));
const processes = [];
try {
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
    // No song is reported, so LRCLIB is never asked; the address is closed anyway.
    fs.writeFileSync(settingsPath, JSON.stringify({port, hostname: 'lyrics.localhost:8792', lrclibBaseUrl: 'http://127.0.0.1:9',
        ytarchiveUrl: null, stateDir: path.join(tmp, 'state', 'lyrics')}));
    const service = spawn('gjs', ['-m', path.join(root, 'service', 'main.js'), '--settings', settingsPath],
        {env, stdio: ['ignore', 'pipe', 'pipe']});
    processes.push(service);
    await printed(service, /listening on/u, 'the service');

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
    // The page fills in from the service: every section, the font list and
    // the microphones, each family drawn in its own font. List rows are drawn
    // (content-visibility) from the frame after they are found on screen.
    // Each check gives the fonts a bounded time, so the deadline below holds.
    const ready = `(async () => {
        const fontsLoaded = await Promise.race([document.fonts.ready.then(() => true),
            new Promise(resolve => setTimeout(() => resolve(false), ${FONTS_CHECK_MS}))]);
        const filled = fontsLoaded && document.querySelectorAll('#sections section').length === 5 &&
            document.querySelectorAll('.fonts button').length > 1 &&
            document.querySelectorAll('[aria-label="Microphones"] button').length === 3 &&
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
    const {data} = await session.send('browsingContext.captureScreenshot', {context, origin: 'viewport'});
    fs.mkdirSync(path.dirname(OUTPUT), {recursive: true});
    fs.writeFileSync(OUTPUT, Buffer.from(data, 'base64'));
    await session.send('session.end', {});
    session.close();
    console.log(`wrote ${path.relative(root, OUTPUT)}`);
} finally {
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
