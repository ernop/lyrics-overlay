// The real extension in a real, signed-out, headless Firefox against a
// private service, run twice.
//
// A fresh install: the desktop's FocusSong call reaches the extension,
// which selects the song's tab and answers with its window's title, and
// OpenSettings opens the settings page once and later selects that same
// tab.
//
// An update from OLD_RELEASE, the last release without access to
// localhost, which Firefox does not grant with an update: OpenSettings
// shows the extension's page that asks for that access, and the settings
// page is never loaded.
//
// The service runs on a private session bus and port with a stand-in for
// LRCLIB, and each Firefox profile proxies the add-on's
// lyrics.localhost:8792 to it through a relay here that counts page loads,
// so the installed service, the desktop and the network beyond YouTube are
// untouched. The profiles and every other file are deleted at the end.
//
//   node scripts/probe-firefox-commands.mjs [--firefox PATH] [--show-log] [URL]
import {execFile, spawn} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

import {dconfServiceDir, isolatedEnv, startBus} from '../tests/isolated-session.mjs';

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
const UPDATE_WAIT_MS = 30_000;
const FIREFOX_SETTLE_MS = 20_000;
const OLD_RELEASE = 'v1.1.0';
const SETTINGS_TITLE = 'Lyrics overlay settings — Mozilla Firefox';
const GRANT_TITLE = 'Lyrics overlay: allow the settings page — Mozilla Firefox';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

/** LRCLIB finds nothing. */
function startStubs() {
    const server = http.createServer((request, response) => {
        response.setHeader('Content-Type', 'application/json');
        response.end('[]');
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/**
 * Firefox's plain-HTTP proxy: passes each request to the service and counts
 * settings page loads. The page's address, localhost:8792, becomes the
 * private service's own localhost name; the add-on's lyrics.localhost:8792
 * is the extra name the service is started with.
 */
function startRelay(servicePort, loads) {
    const server = http.createServer((request, response) => {
        if (request.method === 'GET' && new URL(request.url).pathname === '/settings')
            loads.settings++;
        const headers = {...request.headers};
        if (headers.host === 'localhost:8792')
            headers.host = `localhost:${servicePort}`;
        const forwarded = http.request({host: '127.0.0.1', port: servicePort, method: request.method, path: request.url,
            headers}, answer => {
            response.writeHead(answer.statusCode, answer.headers);
            answer.pipe(response);
        });
        forwarded.on('error', error => response.destroy(error));
        request.pipe(forwarded);
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

/** Ends a child and everything it started (it leads its process group), once. */
function groupStopper(child) {
    const exited = new Promise(resolve => child.once('exit', resolve));
    let stopping = null;
    return () => {
        stopping ??= (async () => {
            try {
                process.kill(-child.pid, 'SIGTERM');
            } catch (error) {
                if (error.code !== 'ESRCH')
                    throw error;
            }
            await exited;
        })();
        return stopping;
    };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lyrics-overlay-commands-'));
const stops = [];
let logPath = null;
let stubs = null;
let relay = null;
let firefoxStartedAt = 0;
const loads = {settings: 0};

function extensionLogLines() {
    return fs.readFileSync(logPath, 'utf8').split('\n')
        .filter(line => /lyrics service|another browser|moz-extension:|temporary add-on|extension reloading/u.test(line));
}

/** @param {(line: string) => boolean} expected error lines this run produces on purpose */
function checkExtensionLog(expected = () => false) {
    const errors = extensionLogLines().filter(line => /error|refused|unreachable/iu.test(line) && !expected(line));
    if (errors.length)
        throw new Error(`the extension logged errors:\n${errors.join('\n')}`);
    if (showLog)
        console.log(`--- Firefox log, extension lines:\n${extensionLogLines().join('\n')}`);
}

try {
    const env = isolatedEnv(tmp);
    const bus = await startBus(tmp, 'session', env, dconfServiceDir(tmp));
    stops.push(() => bus.daemon.kill('SIGTERM'));
    env.DBUS_SESSION_BUS_ADDRESS = bus.address;
    stubs = await startStubs();
    const stubUrl = `http://127.0.0.1:${stubs.address().port}`;
    const port = 20000 + Math.floor(Math.random() * 20000);
    relay = await startRelay(port, loads);

    /** A private service with a state of its own, so each run starts with no song. */
    const startService = async name => {
        const settingsPath = path.join(tmp, `${name}-settings.json`);
        // Proxied requests keep the Host the add-on addressed.
        fs.writeFileSync(settingsPath, JSON.stringify({port, hostname: 'lyrics.localhost:8792', lrclibBaseUrl: stubUrl,
            ytarchiveUrl: null, stateDir: path.join(tmp, name, 'state')}));
        let serviceLog = '';
        const service = spawn('gjs', ['-m', path.join(root, 'service', 'main.js'), '--settings', settingsPath],
            {env, stdio: ['ignore', 'pipe', 'pipe'], detached: true});
        const stop = groupStopper(service);
        stops.push(stop);
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
        return stop;
    };

    /** Firefox playing url with the add-on in sourceDir, reloaded when watchFile changes (when given). */
    const startFirefox = (name, sourceDir, watchFile) => {
        firefoxStartedAt = Date.now();
        logPath = path.join(tmp, `${name}-web-ext.log`);
        const log = fs.openSync(logPath, 'w');
        const prefs = {
            'media.autoplay.default': 0,
            'media.volume_scale': '0.0',
            // Only plain-HTTP requests use this proxy: the add-on's service
            // address goes to the private service, and YouTube (HTTPS) goes direct.
            'network.proxy.type': 1,
            'network.proxy.http': '127.0.0.1',
            'network.proxy.http_port': relay.address().port,
            'network.proxy.allow_hijacking_localhost': true,
            // The extension's own console lines (all start "lyrics service" or
            // "another browser") reach the log only through the content console.
            'devtools.console.stdout.chrome': true,
            'devtools.console.stdout.content': true,
        };
        const firefoxProcess = spawn('npx', ['web-ext', 'run', '--source-dir', sourceDir, '--firefox', firefox,
            '--firefox-profile', path.join(tmp, name, 'profile'), '--profile-create-if-missing', '--keep-profile-changes',
            '--start-url', url, ...Object.entries(prefs).flatMap(([pref, value]) => ['--pref', `${pref}=${value}`]),
            // Without --verbose web-ext drops Firefox's own output, the add-on's console with it.
            '--arg=--headless', ...(watchFile ? ['--watch-file', watchFile] : ['--no-reload']), '--no-input', '--verbose'],
        {cwd: root, stdio: ['ignore', log, log], detached: true});
        const stop = groupStopper(firefoxProcess);
        stops.push(stop);
        return stop;
    };

    // gdbus prints the one string argument GVariant-quoted: backslashes and
    // apostrophes escaped, which a JSON string literal reads once \' is '.
    const gdbus = async method => {
        const {stdout} = await run('gdbus', ['call', '--session', '--dest', 'net.fuseki.LyricsOverlay',
            '--object-path', '/net/fuseki/LyricsOverlay', '--method', `net.fuseki.LyricsOverlay1.${method}`], {env});
        const quoted = stdout.trim().replace(/^\('|',\)$/gu, '').replaceAll("\\'", "'");
        return JSON.parse(JSON.parse(`"${quoted.replaceAll('"', '\\"')}"`));
    };

    // Commands wait until the page has sent its song details and the lookup
    // is over and Firefox has run FIREFOX_SETTLE_MS, and come a second
    // apart: in its first seconds a fresh headless Firefox can hold a
    // response it has already received for 3 s, past the service's answer
    // budget (seen up to 12 s in, never after 20 s), and a busy one can take
    // longer than the 1.5 s the service waits for the add-on to ask for the
    // next command, sooner than anyone presses.
    /** The add-on version the private service last heard of (service/addon-version.js). */
    const addonStatus = () => new Promise((resolve, reject) => {
        http.get({host: '127.0.0.1', port, path: '/api/state', headers: {Host: `127.0.0.1:${port}`}}, response => {
            let body = '';
            response.on('data', chunk => { body += chunk; });
            response.on('end', () => resolve(JSON.parse(body).addon));
        }).on('error', reject);
    });
    const current = JSON.parse(fs.readFileSync(path.join(root, 'firefox', 'manifest.json'), 'utf8')).version;
    const expectAddon = async (expected, when) => {
        const addon = await addonStatus();
        if (JSON.stringify(addon) !== JSON.stringify(expected))
            throw new Error(`${when}, the service knew the add-on as ${JSON.stringify(addon)}, not ${JSON.stringify(expected)}`);
        console.log(`${when}, the add-on: ${JSON.stringify(addon)}`);
    };

    const LOOKUP_OVER = new Set(['not-music', 'timed', 'plain', 'none', 'error']);
    const command = async method => {
        await sleep(Math.max(1000, firefoxStartedAt + FIREFOX_SETTLE_MS - Date.now()));
        const askedAt = Date.now();
        const answer = await gdbus(method);
        console.log(`${method} answered in ${Date.now() - askedAt} ms: ${JSON.stringify(answer)}`);
        return answer;
    };
    const waitForSong = async () => {
        const deadline = Date.now() + STATE_WAIT_MS;
        while (Date.now() < deadline) {
            const state = await gdbus('GetState');
            if (state.active && state.sounding && LOOKUP_OVER.has(state.lyrics))
                return state;
            await sleep(1000);
        }
        throw new Error(`no YouTube song settled in the private service within ${STATE_WAIT_MS / 1000} s`);
    };

    // ----- A fresh install.
    let stopService = await startService('fresh');
    let stopFirefox = startFirefox('fresh', path.join(root, 'firefox'), null);
    const state = await waitForSong();
    console.log(`fresh install, playing: ${state.videoId}, lyrics ${state.lyrics}`);
    await expectAddon({status: 'current', version: current, current}, 'fresh install');

    const focused = await command('FocusSong');
    if (!focused.ok || !/ — Mozilla Firefox$/u.test(focused.windowTitle))
        throw new Error('the extension did not select the tab and name its window');

    // The first OpenSettings loads the page in a new tab; after the song's
    // tab is selected again, the second selects that tab without a load.
    for (const round of [1, 2]) {
        if (round === 2 && !(await command('FocusSong')).ok)
            throw new Error('the extension did not go back to the song');
        const opened = await command('OpenSettings');
        console.log(`settings page loads so far: ${loads.settings}`);
        if (!opened.ok || opened.windowTitle !== SETTINGS_TITLE)
            throw new Error(`the extension did not show the settings tab and name its window (round ${round})`);
    }
    if (loads.settings !== 1)
        throw new Error(`the settings page loaded ${loads.settings} times; the second OpenSettings must select the open tab`);
    checkExtensionLog();
    await stopFirefox();
    await stopService();

    // ----- An update from OLD_RELEASE. Changing the manifest, copied last,
    // makes web-ext reinstall the add-on, which Firefox starts as an update.
    const addon = path.join(tmp, 'update', 'addon');
    fs.mkdirSync(addon, {recursive: true});
    await run('sh', ['-c', 'git archive "$1" firefox | tar -x --strip-components=1 -C "$2"', 'sh', OLD_RELEASE, addon],
        {cwd: root});
    stopService = await startService('update');
    stopFirefox = startFirefox('update', addon, path.join(addon, 'manifest.json'));
    await waitForSong();
    console.log(`${OLD_RELEASE} installed`);
    await expectAddon({status: 'unnamed', current}, OLD_RELEASE);
    const old = await command('OpenSettings');
    if (old.ok)
        throw new Error(`${OLD_RELEASE} is not running: it cannot show the settings`);
    const files = fs.readdirSync(path.join(root, 'firefox')).filter(name => name !== 'manifest.json');
    for (const file of [...files, 'manifest.json'])
        fs.copyFileSync(path.join(root, 'firefox', file), path.join(addon, file));

    // The updated add-on listens again once the video reports to it.
    const deadline = Date.now() + UPDATE_WAIT_MS;
    let shown = null;
    while (Date.now() < deadline) {
        shown = await gdbus('OpenSettings');
        if (shown.ok)
            break;
        await sleep(1000);
    }
    console.log(`after the update, OpenSettings answered: ${JSON.stringify(shown)}; settings page loads: ${loads.settings}`);
    if (!shown.ok || shown.windowTitle !== GRANT_TITLE)
        throw new Error('the updated extension did not show its page asking for access to localhost');
    if (loads.settings !== 1)
        throw new Error('the updated extension loaded the settings page without access to localhost');
    await expectAddon({status: 'current', version: current, current}, 'after the update');
    // OLD_RELEASE throws on the command it does not know.
    checkExtensionLog(line => /unknown command: openSettings/u.test(line));
    console.log('ok: a fresh install shows one settings tab; an update asks for access to localhost first');
} catch (error) {
    if (logPath && fs.existsSync(logPath))
        console.error(`--- Firefox log, extension lines:\n${extensionLogLines().slice(-40).join('\n')}`);
    throw error;
} finally {
    for (const stop of stops.reverse())
        await stop();
    stubs?.close();
    relay?.closeAllConnections();
    relay?.close();
    await sleep(500);
    fs.rmSync(tmp, {recursive: true, force: true});
}
