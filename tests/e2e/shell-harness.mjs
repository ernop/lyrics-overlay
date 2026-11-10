// A hermetic headless GNOME Shell with the lyrics service and extension.
//
// Everything runs in an isolated session (tests/isolated-session.mjs): a
// temporary HOME and XDG dirs, a private session bus and a private stand-in
// system bus. Only dconf-service is activatable, and the harness refuses to
// continue unless dconf writes land in the temp dir.

import {execFile, spawn} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

import {isolatedEnv, startBus} from '../isolated-session.mjs';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const UUID = 'lyrics-overlay@ernop';
const HELPER_UUID = 'unsafe-for-tests@local';
const SCHEMA = 'org.gnome.shell.extensions.lyrics-overlay';
const REAL_DCONF = path.join(os.homedir(), '.config', 'dconf', 'user');

export const MONITOR = {width: 1600, height: 900};

async function waitFor(check, what, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        const value = await check();
        if (value)
            return value;
        if (Date.now() > deadline)
            throw new Error(`timed out waiting for ${what}`);
        await new Promise(resolve => setTimeout(resolve, 100));
    }
}

export const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function startStubLrclib(answers) {
    const requests = [];
    const server = http.createServer((request, response) => {
        const url = new URL(request.url, 'http://stub');
        const key = `${url.searchParams.get('artist_name')}|${url.searchParams.get('track_name')}`;
        requests.push(key);
        response.setHeader('Content-Type', 'application/json');
        response.end(JSON.stringify(answers[key] ?? []));
    });
    return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({server, requests, port: server.address().port})));
}

/**
 * @param {{answers: Record<string, object[]>}} options LRCLIB answers by "artist|title"
 */
export async function startHarness({answers}) {
    const realDconfBefore = fs.statSync(REAL_DCONF).mtimeMs;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lyrics-overlay-shell-'));
    const env = isolatedEnv(tmp);
    fs.mkdirSync(path.join(tmp, 'services'), {mode: 0o700});
    const artifacts = path.join(root, 'build', 'e2e-artifacts');
    fs.rmSync(artifacts, {recursive: true, force: true});
    fs.mkdirSync(artifacts, {recursive: true});
    fs.copyFileSync('/usr/share/dbus-1/services/ca.desrt.dconf.service', path.join(tmp, 'services', 'ca.desrt.dconf.service'));

    const processes = [];
    const heartbeats = new Set();
    const cleanup = () => {
        for (const timer of heartbeats)
            clearInterval(timer);
        for (const child of processes.reverse())
            child.kill('SIGTERM');
    };
    try {
        const sessionBus = await startBus(tmp, 'session', env, path.join(tmp, 'services'));
        processes.push(sessionBus.daemon);
        const systemBus = await startBus(tmp, 'system', env, null);
        processes.push(systemBus.daemon);
        env.DBUS_SESSION_BUS_ADDRESS = sessionBus.address;
        env.DBUS_SYSTEM_BUS_ADDRESS = systemBus.address;

        const gsettings = (...args) => run('gsettings', args, {env});
        await gsettings('set', 'org.gnome.shell', 'enabled-extensions', `['${UUID}', '${HELPER_UUID}']`);
        if (!fs.existsSync(path.join(tmp, 'config', 'dconf', 'user')))
            throw new Error('dconf did not write the temporary database; refusing to continue');
        if (fs.statSync(REAL_DCONF).mtimeMs !== realDconfBefore)
            throw new Error('the real dconf database changed; stop and restore it');
        await gsettings('set', 'org.gnome.shell', 'disable-user-extensions', 'false');
        await gsettings('set', 'org.gnome.shell', 'welcome-dialog-last-shown-version', "'999'");
        await gsettings('set', 'org.gnome.desktop.screensaver', 'lock-enabled', 'false');
        await gsettings('set', 'org.gnome.desktop.session', 'idle-delay', '0');

        await run(path.join(root, 'scripts', 'install-gnome-extension.sh'), ['--data-home', env.XDG_DATA_HOME, '--no-enable'], {env});
        const helperDir = path.join(env.XDG_DATA_HOME, 'gnome-shell', 'extensions', HELPER_UUID);
        fs.mkdirSync(helperDir, {recursive: true});
        fs.writeFileSync(path.join(helperDir, 'metadata.json'), JSON.stringify({
            'uuid': HELPER_UUID, 'name': 'Unsafe mode for tests', 'description': 'Allows Eval and Screenshot', 'shell-version': ['50'],
        }));
        fs.writeFileSync(path.join(helperDir, 'extension.js'), `import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
export default class UnsafeForTests extends Extension {
    enable() { global.context.unsafe_mode = true; }
    disable() { global.context.unsafe_mode = false; }
}
`);
        const schemaDir = path.join(env.XDG_DATA_HOME, 'gnome-shell', 'extensions', UUID, 'schemas');

        const stub = await startStubLrclib(answers);
        const port = 20000 + Math.floor(Math.random() * 20000);
        const settingsPath = path.join(tmp, 'service-settings.json');
        fs.writeFileSync(settingsPath, JSON.stringify({
            port, hostname: 'lyrics.localhost', lrclibBaseUrl: `http://127.0.0.1:${stub.port}`,
            ytarchiveUrl: null, stateDir: path.join(tmp, 'state', 'lyrics'),
        }));
        let serviceLog = '';
        let service = null;
        /** Starts the service and resolves once it accepts HTTP. */
        const startService = () => new Promise((resolve, reject) => {
            const started = spawn('gjs', ['-m', path.join(root, 'tests', 'service-under-gc.js'), '--settings', settingsPath],
                {env, stdio: ['ignore', 'pipe', 'pipe']});
            processes.push(started);
            service = started;
            let output = '';
            const onData = data => {
                serviceLog += data;
                output += data;
                if (output.includes('listening on'))
                    resolve();
            };
            started.stdout.on('data', onData);
            started.stderr.on('data', onData);
            started.once('exit', code => reject(new Error(`the service exited (${code}) before listening:\n${output}`)));
        });
        await startService();
        /** POSTs JSON to the service the way the browser extension does. */
        const extensionPost = (urlPath, payload) => new Promise((resolve, reject) => {
            const request = http.request({host: '127.0.0.1', port, method: 'POST', path: urlPath, agent: false,
                headers: {'Host': `127.0.0.1:${port}`, 'Content-Type': 'application/json', 'Origin': 'moz-extension://test'}}, response => {
                let body = '';
                response.on('data', chunk => { body += chunk; });
                response.on('end', () => resolve({status: response.statusCode, body}));
            });
            request.on('error', reject);
            request.end(JSON.stringify(payload));
        });
        const stopService = async () => {
            if (service.exitCode !== null || service.signalCode !== null)
                return;
            const exited = new Promise(resolve => service.once('exit', resolve));
            service.kill('SIGTERM');
            await exited;
        };

        let shellLog = '';
        const shell = spawn('gnome-shell', ['--headless', '--wayland', '--no-x11', '--virtual-monitor', `${MONITOR.width}x${MONITOR.height}`],
            {env, stdio: ['ignore', 'pipe', 'pipe']});
        shell.stdout.on('data', data => { shellLog += data; });
        shell.stderr.on('data', data => { shellLog += data; });
        processes.push(shell);

        const evalJs = async code => {
            const {stdout} = await run('gjs', ['-m', path.join(root, 'tests', 'e2e', 'shell-eval.js'), code], {env});
            const {ok, result} = JSON.parse(stdout);
            if (!ok)
                throw new Error(`Eval failed: ${result}\n--- code:\n${code}`);
            return result === '' || result === undefined ? undefined : JSON.parse(result);
        };
        await waitFor(async () => (await evalJs('1').catch(() => null)) === 1, 'the shell to accept Eval');
        // Constant collection in the shell too, so an extension object held
        // only by a dropped JavaScript reference dies within the test.
        await evalJs('imports.gi.GLib.timeout_add(imports.gi.GLib.PRIORITY_DEFAULT, 250, () => { imports.system.gc(); return true; }) > 0');

        return {
            tmp,
            env,
            stub,
            evalJs,
            waitFor,
            artifacts,
            get shellLog() {
                return shellLog;
            },
            get serviceLog() {
                return serviceLog;
            },
            gsettings: {
                get: async key => (await run('gsettings', ['--schemadir', schemaDir, 'get', SCHEMA, key], {env})).stdout.trim(),
                set: (key, value) => run('gsettings', ['--schemadir', schemaDir, 'set', SCHEMA, key, value], {env}),
                reset: key => run('gsettings', ['--schemadir', schemaDir, 'reset', SCHEMA, key], {env}),
                /** Sets a desktop (non-extension) key in the isolated session. */
                setDesktop: (schema, key, value) => run('gsettings', ['set', schema, key, value], {env}),
            },
            /** The whole screen, or only `area` ({x, y, width, height}, stage pixels). */
            async screenshot(name, area = null) {
                const file = path.join(artifacts, `${name}.png`);
                const call = area
                    ? ['org.gnome.Shell.Screenshot.ScreenshotArea', ...[area.x, area.y, area.width, area.height].map(n => String(Math.round(n)))]
                    : ['org.gnome.Shell.Screenshot.Screenshot', 'false'];
                await run('gdbus', ['call', '--session', '--dest', 'org.gnome.Shell.Screenshot', '--object-path', '/org/gnome/Shell/Screenshot',
                    '--method', ...call, 'false', file], {env});
                return file;
            },
            async report(payload) {
                return (await extensionPost('/api/report', payload)).status;
            },
            /**
             * Holds the browser-command request the extension keeps open,
             * then answers the command that comes with `answer(command)`.
             * @returns {Promise<object>} the command
             */
            async answerNextCommand(answer) {
                const held = await extensionPost('/api/commands', {});
                if (held.status !== 200)
                    throw new Error(`no command came (HTTP ${held.status})`);
                const command = JSON.parse(held.body);
                const answered = await extensionPost('/api/command-result', {id: command.id, ...answer(command)});
                if (answered.status !== 204)
                    throw new Error(`the answer was refused (HTTP ${answered.status}): ${answered.body}`);
                return command;
            },
            /** A plain GTK window titled `title` in the headless shell; it closes with the harness. */
            async openWindow(title) {
                const socket = fs.readdirSync(env.XDG_RUNTIME_DIR).find(name => /^wayland-\d+$/u.test(name));
                if (!socket)
                    throw new Error('the headless shell has no Wayland socket');
                processes.push(spawn('gjs', ['-m', path.join(root, 'tests', 'e2e', 'titled-window.js'), title],
                    {env: {...env, WAYLAND_DISPLAY: socket, GDK_BACKEND: 'wayland'}, stdio: 'ignore'}));
                await waitFor(() => evalJs(`global.display.list_all_windows().some(window => window.get_title() === ${JSON.stringify(title)})`),
                    `the window "${title}"`);
            },
            /**
             * Reports like a page whose video runs: now, then every
             * payload.heartbeatMs with the clock moved on, until stop().
             */
            async play(payload) {
                const startedAt = Date.now();
                const send = () => this.report({...payload, sampledAt: Date.now(),
                    media: {...payload.media, currentTime: payload.media.currentTime + (Date.now() - startedAt) / 1000}});
                const status = await send();
                const timer = setInterval(send, payload.heartbeatMs);
                heartbeats.add(timer);
                return {status, stop: () => {
                    clearInterval(timer);
                    heartbeats.delete(timer);
                }};
            },
            async restartService() {
                await stopService();
                await startService();
            },
            stopService,
            async close() {
                cleanup();
                stub.server.close();
                await sleep(300);
                const realEnabled = (await run('gsettings', ['get', 'org.gnome.shell', 'enabled-extensions'])).stdout;
                if (realEnabled.includes(HELPER_UUID))
                    throw new Error('the real enabled-extensions list holds the test helper; restore it');
                fs.rmSync(tmp, {recursive: true, force: true});
            },
        };
    } catch (error) {
        cleanup();
        throw error;
    }
}
