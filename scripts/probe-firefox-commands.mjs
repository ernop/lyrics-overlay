// The real extension in a real, signed-out, headless Firefox against a
// private service: checks that the desktop's FocusSong call reaches the
// extension, which selects the song's tab and answers with its window's
// title. The service runs on a private session bus and port with a
// stand-in for LRCLIB, and the Firefox profile proxies the add-on's
// lyrics.localhost:8792 to it, so the installed service, the desktop and
// the network beyond YouTube are untouched. The profile and every other
// file are deleted at the end.
//
//   node scripts/probe-firefox-commands.mjs [--firefox PATH] [--show-log] [URL]
import {execFile, spawn} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

import {isolatedEnv, startBus} from '../tests/isolated-session.mjs';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
let firefox = 'firefox';
if (args[0] === '--firefox') {
    firefox = args[1];
    args.splice(0, 2);
}
const showLog = args[0] === '--show-log';
if (showLog)
    args.shift();
const url = args[0] ?? 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const STATE_WAIT_MS = 60_000;

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function extensionLogLines() {
    return fs.readFileSync(logPath, 'utf8').split('\n')
        .filter(line => /lyrics service|another browser|moz-extension:|temporary add-on|extension reloading/u.test(line));
}

/** LRCLIB finds nothing. */
function startStubs() {
    const server = http.createServer((request, response) => {
        response.setHeader('Content-Type', 'application/json');
        response.end('[]');
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lyrics-overlay-commands-'));
const logPath = path.join(tmp, 'web-ext.log');
const processes = [];
let stubs = null;
try {
    const env = isolatedEnv(tmp);
    const bus = await startBus(tmp, 'session', env, null);
    processes.push(bus.daemon);
    env.DBUS_SESSION_BUS_ADDRESS = bus.address;
    stubs = await startStubs();
    const stubUrl = `http://127.0.0.1:${stubs.address().port}`;
    const port = 20000 + Math.floor(Math.random() * 20000);
    const settingsPath = path.join(tmp, 'settings.json');
    // Proxied requests keep the Host the add-on addressed.
    fs.writeFileSync(settingsPath, JSON.stringify({port, hostname: 'lyrics.localhost:8792', lrclibBaseUrl: stubUrl,
        ytarchiveUrl: null, stateDir: path.join(tmp, 'state', 'lyrics')}));

    let serviceLog = '';
    const service = spawn('gjs', ['-m', path.join(root, 'service', 'main.js'), '--settings', settingsPath],
        {env, stdio: ['ignore', 'pipe', 'pipe']});
    processes.push(service);
    await new Promise((resolve, reject) => {
        const onData = data => {
            serviceLog += data;
            if (serviceLog.includes('listening on'))
                resolve();
        };
        service.stdout.on('data', onData);
        service.stderr.on('data', onData);
        service.once('exit', code => reject(new Error(`the service exited (${code}):\n${serviceLog}`)));
    });

    // gdbus prints the one string argument GVariant-quoted: backslashes and
    // apostrophes escaped, which a JSON string literal reads once \' is '.
    const gdbus = async method => {
        const {stdout} = await run('gdbus', ['call', '--session', '--dest', 'net.fuseki.LyricsOverlay',
            '--object-path', '/net/fuseki/LyricsOverlay', '--method', `net.fuseki.LyricsOverlay1.${method}`], {env});
        const quoted = stdout.trim().replace(/^\('|',\)$/gu, '').replaceAll("\\'", "'");
        return JSON.parse(JSON.parse(`"${quoted.replaceAll('"', '\\"')}"`));
    };

    const log = fs.openSync(logPath, 'w');
    const prefs = {
        'media.autoplay.default': 0,
        'media.volume_scale': '0.0',
        // Only plain-HTTP requests use this proxy: the add-on's service
        // address goes to the private service, and YouTube (HTTPS) goes direct.
        'network.proxy.type': 1,
        'network.proxy.http': '127.0.0.1',
        'network.proxy.http_port': port,
        'network.proxy.allow_hijacking_localhost': true,
        // The extension's own console lines (all start "lyrics service" or
        // "another browser") reach the log only through the content console.
        'devtools.console.stdout.chrome': true,
        'devtools.console.stdout.content': true,
    };
    const firefoxProcess = spawn('npx', ['web-ext', 'run', '--source-dir', 'firefox', '--firefox', firefox,
        '--firefox-profile', path.join(tmp, 'profile'), '--profile-create-if-missing', '--keep-profile-changes',
        '--start-url', url, ...Object.entries(prefs).flatMap(([name, value]) => ['--pref', `${name}=${value}`]),
        '--arg=--headless', '--no-reload', '--no-input'], {cwd: root, stdio: ['ignore', log, log], detached: true});
    processes.push({kill: () => process.kill(-firefoxProcess.pid, 'SIGTERM')});

    const deadline = Date.now() + STATE_WAIT_MS;
    let state = null;
    while (Date.now() < deadline) {
        state = await gdbus('GetState');
        if (state.active && state.sounding)
            break;
        await sleep(1000);
    }
    if (!state?.active)
        throw new Error(`no YouTube report reached the private service within ${STATE_WAIT_MS / 1000} s`);
    console.log(`playing: ${state.videoId}, lyrics ${state.lyrics}`);

    const startedAt = Date.now();
    const focused = await gdbus('FocusSong');
    console.log(`FocusSong answered in ${Date.now() - startedAt} ms: ${JSON.stringify(focused)}`);
    if (!focused.ok || !/ — Mozilla Firefox$/u.test(focused.windowTitle))
        throw new Error('the extension did not select the tab and name its window');

    const extensionErrors = extensionLogLines().filter(line => /error|refused|unreachable/iu.test(line));
    if (extensionErrors.length)
        throw new Error(`the extension logged errors:\n${extensionErrors.join('\n')}`);
    console.log('ok: the extension answered the command and logged no errors');
    if (showLog)
        console.log(`--- Firefox log, extension lines:\n${extensionLogLines().join('\n')}`);
} catch (error) {
    if (fs.existsSync(logPath))
        console.error(`--- Firefox log, extension lines:\n${extensionLogLines().slice(-40).join('\n')}`);
    throw error;
} finally {
    for (const child of processes.reverse())
        child.kill('SIGTERM');
    stubs?.close();
    await sleep(500);
    fs.rmSync(tmp, {recursive: true, force: true});
}
