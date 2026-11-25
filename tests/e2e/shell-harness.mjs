// A hermetic headless GNOME Shell with the lyrics service and extension.
//
// Everything runs in an isolated session (tests/isolated-session.mjs): a
// temporary HOME and XDG dirs, a private session bus and a private stand-in
// system bus. Only dconf-service is activatable, and the harness refuses to
// continue unless dconf writes land in the temp dir.

import {execFile} from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

import {dconfServiceDir, isolatedEnv, realDconf, spawnTied, startBus} from '../isolated-session.mjs';

const run = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const UUID = 'lyrics-overlay@ernop';
const RAISER_UUID = 'lyrics-overlay-raiser@ernop';
const HELPER_UUID = 'unsafe-for-tests@local';
const SCHEMA = 'org.gnome.shell.extensions.lyrics-overlay';
// The session's first write; the screen lock and idle keys come after the
// real value of this one is seen unchanged.
const FIRST_WRITTEN = '/org/gnome/shell/enabled-extensions';

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
 * @param {{answers: Record<string, object[]>, extraSettings?: object,
 *          xwayland?: boolean, enableExtension?: boolean, enableRaiser?: boolean}} options LRCLIB answers by "artist|title"
 */
export async function startHarness({answers, extraSettings = {}, xwayland = false, enableExtension = true, enableRaiser = false}) {
    const realDconfBefore = await realDconf(FIRST_WRITTEN);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lyrics-overlay-shell-'));
    const env = isolatedEnv(tmp);
    const services = dconfServiceDir(tmp);
    const artifacts = path.join(root, 'build', 'e2e-artifacts');
    fs.rmSync(artifacts, {recursive: true, force: true});
    fs.mkdirSync(artifacts, {recursive: true});

    const processes = [];
    const heartbeats = new Set();
    // Stops the children, newest first, and waits until each has exited, so
    // none is left running on a runtime dir that close() then deletes.
    const cleanup = async () => {
        for (const timer of heartbeats)
            clearInterval(timer);
        for (const child of processes.reverse()) {
            if (child.exitCode !== null || child.signalCode !== null)
                continue;
            const exited = new Promise(resolve => child.once('exit', resolve));
            child.kill('SIGTERM');
            const killer = setTimeout(() => child.kill('SIGKILL'), 5000);
            await exited;
            clearTimeout(killer);
        }
    };
    try {
        const sessionBus = await startBus(tmp, 'session', env, services);
        processes.push(sessionBus.daemon);
        const systemBus = await startBus(tmp, 'system', env, null);
        processes.push(systemBus.daemon);
        env.DBUS_SESSION_BUS_ADDRESS = sessionBus.address;
        env.DBUS_SYSTEM_BUS_ADDRESS = systemBus.address;

        const gsettings = (...args) => run('gsettings', args, {env});
        const enabledUuids = [
            ...(enableExtension ? [UUID] : []),
            ...(enableRaiser ? [RAISER_UUID] : []),
            HELPER_UUID,
        ];
        const enabledList = `[${enabledUuids.map(id => `'${id}'`).join(', ')}]`;
        await gsettings('set', 'org.gnome.shell', 'enabled-extensions', enabledList);
        if (!fs.existsSync(path.join(tmp, 'config', 'dconf', 'user')))
            throw new Error('dconf did not write the temporary database; refusing to continue');
        if (await realDconf(FIRST_WRITTEN) !== realDconfBefore)
            throw new Error('the real session’s enabled extensions changed; stop and restore them');
        await gsettings('set', 'org.gnome.shell', 'disable-user-extensions', 'false');
        await gsettings('set', 'org.gnome.shell', 'welcome-dialog-last-shown-version', "'999'");
        await gsettings('set', 'org.gnome.desktop.screensaver', 'lock-enabled', 'false');
        await gsettings('set', 'org.gnome.desktop.session', 'idle-delay', '0');

        let schemaDir;
        if (enableExtension) {
            await run(path.join(root, 'scripts', 'install-gnome-extension.sh'), ['--data-home', env.XDG_DATA_HOME, '--no-enable'], {env});
            schemaDir = path.join(env.XDG_DATA_HOME, 'gnome-shell', 'extensions', UUID, 'schemas');
        } else {
            schemaDir = path.join(tmp, 'compiled-schemas');
            fs.mkdirSync(schemaDir, {recursive: true});
            await run('glib-compile-schemas', ['--strict', `--targetdir=${schemaDir}`,
                path.join(root, 'gnome-extension', UUID, 'schemas')], {env});
        }
        if (enableRaiser) {
            await run(path.join(root, 'scripts', 'install-window-raiser.sh'),
                ['--data-home', env.XDG_DATA_HOME, '--no-enable'], {env});
        }
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

        const stub = await startStubLrclib(answers);
        const port = 20000 + Math.floor(Math.random() * 20000);
        const settingsPath = path.join(tmp, 'service-settings.json');
        fs.writeFileSync(settingsPath, JSON.stringify({
            port, hostname: 'lyrics.localhost', lrclibBaseUrl: `http://127.0.0.1:${stub.port}`,
            ytarchiveUrl: null, stateDir: path.join(tmp, 'state', 'lyrics'),
            ...extraSettings,
        }));
        let serviceLog = '';
        let service = null;
        /** Starts the service and resolves once it accepts HTTP. */
        const startService = () => new Promise((resolve, reject) => {
            const started = spawnTied('gjs', ['-m', path.join(root, 'tests', 'service-under-gc.js'), '--settings', settingsPath],
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
        const shellArgs = ['--headless', '--wayland', ...(xwayland ? [] : ['--no-x11']), '--virtual-monitor', `${MONITOR.width}x${MONITOR.height}`];
        const shell = spawnTied('gnome-shell', shellArgs,
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

        let desktopLog = '';
        let desktop = null;
        const startDesktop = async () => {
            const x11 = await waitFor(async () => {
                const vars = await evalJs('({DISPLAY: imports.gi.GLib.getenv("DISPLAY"), XAUTHORITY: imports.gi.GLib.getenv("XAUTHORITY")})');
                return vars?.DISPLAY ? vars : null;
            }, 'XWayland DISPLAY from gnome-shell');
            const desktopEnv = {...env, DISPLAY: x11.DISPLAY};
            if (x11.XAUTHORITY)
                desktopEnv.XAUTHORITY = x11.XAUTHORITY;
            const socket = fs.readdirSync(env.XDG_RUNTIME_DIR).find(name => /^wayland-\d+$/u.test(name));
            if (socket)
                desktopEnv.WAYLAND_DISPLAY = socket;
            await new Promise((resolve, reject) => {
                const started = spawnTied('gjs', ['-m', path.join(root, 'tests', 'desktop-under-gc.js')],
                    {env: desktopEnv, stdio: ['ignore', 'pipe', 'pipe']});
                processes.push(started);
                desktop = started;
                let output = '';
                const onData = data => {
                    desktopLog += data;
                    output += data;
                    if (output.includes('ready on '))
                        resolve();
                };
                started.stdout.on('data', onData);
                started.stderr.on('data', onData);
                started.once('exit', code => reject(new Error(`desktop exited (${code}) before ready:\n${output}`)));
            });
        };
        const stopDesktop = async () => {
            if (!desktop || desktop.exitCode !== null || desktop.signalCode !== null)
                return;
            const exited = new Promise(resolve => desktop.once('exit', resolve));
            desktop.kill('SIGTERM');
            await exited;
        };
        const desktopStatus = async () => {
            const {stdout: json} = await run('gjs', ['-c', `
                const Gio = imports.gi.Gio;
                const res = Gio.DBus.session.call_sync(
                    'net.fuseki.LyricsOverlayDesktop', '/net/fuseki/LyricsOverlayDesktop',
                    'net.fuseki.LyricsOverlayDesktop1', 'GetStatus', null, null, 0, 2000, null);
                print(res.deepUnpack()[0]);
            `], {env});
            return JSON.parse(json.trim());
        };

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
            get desktopLog() {
                return desktopLog;
            },
            startDesktop,
            stopDesktop,
            desktopStatus,
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
            /**
             * A GTK window titled `title` in the headless shell, drawn by
             * `program` (a plain window unless given), once the shell has
             * placed and shown it; it closes with the harness.
             */
            async openWindow(title, program = path.join(root, 'tests', 'e2e', 'titled-window.js')) {
                const socket = fs.readdirSync(env.XDG_RUNTIME_DIR).find(name => /^wayland-\d+$/u.test(name));
                if (!socket)
                    throw new Error('the headless shell has no Wayland socket');
                const countExpr = `global.display.list_all_windows().filter(window =>
                    window.get_title() === ${JSON.stringify(title)} && window.get_compositor_private()?.visible === true).length`;
                const before = await evalJs(countExpr);
                processes.push(spawnTied('gjs', ['-m', program, title],
                    {env: {...env, WAYLAND_DISPLAY: socket, GDK_BACKEND: 'wayland'}, stdio: 'ignore'}));
                await waitFor(async () => (await evalJs(countExpr)) > before, `the window "${title}"`);
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
                await cleanup();
                stub.server.close();
                const realEnabled = (await run('gsettings', ['get', 'org.gnome.shell', 'enabled-extensions'])).stdout;
                if (realEnabled.includes(HELPER_UUID))
                    throw new Error('the real enabled-extensions list holds the test helper; restore it');
                fs.rmSync(tmp, {recursive: true, force: true});
            },
        };
    } catch (error) {
        await cleanup();
        throw error;
    }
}
