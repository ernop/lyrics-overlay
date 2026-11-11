// Loopback HTTP API for the browser extension and the settings page.
//
// Requests must name an expected Host (DNS-rebinding guard). Extension
// requests (reports, command requests and results) must be
// application/json from an extension origin or no origin: a web
// page cannot send that content type cross-origin without a CORS
// preflight, which this server never approves. Settings page writes must
// be application/json from the page's own origin. No response carries
// CORS headers.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import {isReportError, parseCommandResult, parseGone, parseReport} from './report-schema.js';
import {isSettingsError} from './settings-store.js';

const MAX_BODY_BYTES = 64 * 1024;
const EXTENSION_PATHS = new Set(['/api/report', '/api/gone', '/api/commands', '/api/command-result']);
const PAGE_PATHS = new Set(['/api/settings', '/api/settings/reset', '/api/command', '/api/pitch/fit']);
// The song controls the settings page offers (LyricsCore.command).
const PAGE_COMMANDS = new Set(['tooFast', 'tooSlow', 'resetOffset', 'choose', 'reject', 'searchAgain', 'lookUp']);
// "Fit to my singing" leaves this much room around what was sung.
const FIT_MARGIN = 1;
const FIT_MIN_SPAN = 12;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** @param {string|Uint8Array} body */
function respond(message, status, contentType, body) {
    message.set_status(status, null);
    message.get_response_headers().append('Cache-Control', 'no-store');
    message.set_response(contentType, Soup.MemoryUse.COPY, typeof body === 'string' ? encoder.encode(body) : body);
}

function respondJson(message, status, value) {
    respond(message, status, 'application/json', JSON.stringify(value));
}

// libsoup (3.6, and master as of 2026-11) closes the connection after
// every 204: writing one drops the length header it must not carry, and
// then takes the response for one that ends at EOF. Saying so keeps the
// add-on from sending its next request on a connection that is closing,
// which would reset that request.
function respondEmpty(message) {
    message.set_status(204, null);
    message.get_response_headers().replace('Connection', 'close');
}

class RequestError extends Error {
    constructor(status, text) {
        super(text);
        this.status = status;
    }
}

function readJson(message) {
    const body = message.get_request_body().flatten();
    if (body.get_size() > MAX_BODY_BYTES)
        throw new RequestError(413, 'request too large');
    try {
        return JSON.parse(decoder.decode(body.get_data() ?? new Uint8Array()));
    } catch (error) {
        if (error instanceof SyntaxError)
            throw new RequestError(400, error.message);
        throw error;
    }
}

// Ghostscript's symbol fonts, on nearly every Ubuntu desktop: fontconfig
// takes their symbol encoding for Latin-1, so they pass as English fonts,
// but they draw pictures where the letters go.
const PICTURE_FAMILIES = new Set(['D050000L', 'Standard Symbols PS']);

/** Every installed font family that can write English, by name. */
function fontFamilies() {
    const process = Gio.Subprocess.new(['fc-list', '--format', '%{family[0]}\n', ':lang=en'], Gio.SubprocessFlags.STDOUT_PIPE);
    return new Promise((resolve, reject) => {
        process.communicate_utf8_async(null, null, (_process, result) => {
            try {
                const [, stdout] = process.communicate_utf8_finish(result);
                if (!process.get_successful())
                    throw new Error(`fc-list exited with status ${process.get_exit_status()}`);
                resolve([...new Set(stdout.split('\n').filter(family => family && !PICTURE_FAMILIES.has(family)))]
                    .sort((a, b) => a.localeCompare(b)));
            } catch (error) {
                reject(error);
            }
        });
    });
}

/** The fixed pitch range around what was sung lately. */
function fittedRange(sung, limits) {
    let bottom = Math.floor(sung.low) - FIT_MARGIN;
    let top = Math.ceil(sung.high) + FIT_MARGIN;
    const missing = FIT_MIN_SPAN - (top - bottom);
    if (missing > 0) {
        bottom -= Math.floor(missing / 2);
        top += Math.ceil(missing / 2);
    }
    const shift = Math.max(0, limits.min - bottom) - Math.max(0, top - limits.max);
    return {bottom: bottom + shift, top: top + shift};
}

/**
 * The caller must keep the returned server until shutdown: only this
 * JavaScript reference holds it, and once collected it stops listening.
 * @param {{port: number, hostname: string, files: Map<string, {type: string, body: Uint8Array}>,
 *          core: import('./core.js').LyricsCore,
 *          browser: import('./browser-commands.js').BrowserCommands,
 *          addon: import('./addon-version.js').AddonVersion,
 *          settings: import('./settings-store.js').SettingsStore,
 *          pitch: import('./pitch-capture.js').PitchCapture,
 *          log: (message: string) => void}} options
 * @returns {Soup.Server}
 */
export function startHttp({port, hostname, files, core, browser, addon, settings, pitch, log}) {
    // lyrics.localhost:<port> is the browser add-on's address; `hostname` is an extra name, such as a proxy's.
    const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`, `lyrics.localhost:${port}`, hostname]);
    const server = new Soup.Server({});

    /** Holds the extension's request open until a command comes or the hold ends. */
    const awaitCommand = message => {
        message.pause();
        browser.listen(outcome => {
            if ('command' in outcome)
                respondJson(message, 200, outcome.command);
            else if (outcome.ended === 'replaced')
                respondJson(message, 409, {error: 'a newer request from a browser took this one’s place'});
            else
                respondEmpty(message);
            message.unpause();
        });
    };

    /** Answers once the promise settles; a rejection is a 500 the log explains. */
    const respondLater = (message, path, promise) => {
        message.pause();
        promise.then(value => respondJson(message, 200, value), error => {
            log(`${path} failed: ${error.message}`);
            respondJson(message, 500, {error: error.message});
        }).finally(() => message.unpause());
    };

    const handleExtension = (message, headers, path) => {
        const origin = headers.get_one('Origin');
        const crossSite = origin === null && headers.get_one('Sec-Fetch-Site') === 'cross-site';
        if (crossSite || (origin !== null && !origin.startsWith('moz-extension://')))
            throw new RequestError(403, 'only the browser extension may call this');
        const [contentType] = headers.get_content_type();
        if (contentType !== 'application/json')
            throw new RequestError(415, 'extension requests are application/json');
        const json = readJson(message);
        switch (path) {
        case '/api/report': {
            const {tabId, addonVersion, message: report} = parseReport(json, Date.now());
            addon.heard(addonVersion);
            core.report(tabId, report);
            break;
        }
        case '/api/gone':
            core.tabGone(parseGone(json));
            break;
        case '/api/commands':
            awaitCommand(message);
            return;
        case '/api/command-result': {
            const {id, result} = parseCommandResult(json);
            if (!browser.answer(id, result))
                throw new RequestError(409, 'that command is no longer waiting');
            break;
        }
        }
        respondEmpty(message);
    };

    const handlePage = (message, headers, path) => {
        if (headers.get_one('Origin') !== `http://${headers.get_one('Host')}`)
            throw new RequestError(403, 'only the settings page may call this');
        const [contentType] = headers.get_content_type();
        if (contentType !== 'application/json')
            throw new RequestError(415, 'settings page requests are application/json');
        const json = readJson(message);
        switch (path) {
        case '/api/settings':
            settings.set(json.changes);
            respondJson(message, 200, {values: settings.values()});
            return;
        case '/api/settings/reset':
            settings.reset(json.keys);
            respondJson(message, 200, {values: settings.values()});
            return;
        case '/api/command':
            if (!PAGE_COMMANDS.has(json.op))
                throw new RequestError(400, `the page cannot send ${JSON.stringify(json.op)}`);
            respondJson(message, 200, core.command(json.op === 'choose' ? {op: 'choose', id: json.id} : {op: json.op}));
            return;
        case '/api/pitch/fit': {
            const sung = pitch.recentRange();
            if (!sung)
                throw new RequestError(409, 'nothing was sung in the last 30 seconds');
            const range = fittedRange(sung, settings.describe()['pitch-range-bottom']);
            settings.set({'pitch-range': 'fixed', 'pitch-range-bottom': range.bottom, 'pitch-range-top': range.top});
            respondJson(message, 200, {values: settings.values()});
            return;
        }
        }
    };

    const handle = (message, path) => {
        const headers = message.get_request_headers();
        if (!allowedHosts.has(headers.get_one('Host') ?? ''))
            throw new RequestError(403, 'unexpected Host');
        const method = message.get_method();
        if (method === 'GET') {
            if (path === '/') {
                message.set_redirect(303, '/settings');
                // Without a length Soup would end the answer by closing the connection.
                message.get_response_headers().set_content_length(0);
                return;
            }
            const file = files.get(path);
            if (file) {
                respond(message, 200, file.type, file.body);
                return;
            }
            switch (path) {
            case '/api/state':
                respondJson(message, 200, {state: core.state(), line: core.line(), addon: addon.describe()});
                return;
            case '/api/settings':
                respondJson(message, 200, {schema: settings.describe(), values: settings.values()});
                return;
            case '/api/fonts':
                respondLater(message, path, fontFamilies().then(families => ({families})));
                return;
            case '/api/microphones':
                respondLater(message, path, pitch.microphones());
                return;
            }
        }
        if (method === 'POST' && EXTENSION_PATHS.has(path)) {
            handleExtension(message, headers, path);
            return;
        }
        if (method === 'POST' && PAGE_PATHS.has(path)) {
            handlePage(message, headers, path);
            return;
        }
        throw new RequestError(404, 'not found');
    };

    server.add_handler(null, (_server, message, path) => {
        try {
            handle(message, path);
        } catch (error) {
            if (error instanceof RequestError) {
                respondJson(message, error.status, {error: error.message});
            } else if (isReportError(error) || isSettingsError(error)) {
                log(`refused ${path}: ${error.message}`);
                respondJson(message, 400, {error: error.message});
            } else {
                throw error;
            }
        }
    });

    server.listen_local(port, Soup.ServerListenOptions.IPV4_ONLY);
    log(`listening on 127.0.0.1:${port} (${hostname})`);
    return server;
}

/**
 * The files the server sends as they are, by path.
 * @param {string} projectDir
 * @returns {Map<string, {type: string, body: Uint8Array}>}
 */
export function loadStaticFiles(projectDir) {
    const files = new Map();
    const add = (path, relative, type) => {
        const [, body] = GLib.file_get_contents(GLib.build_filenamev([projectDir, ...relative.split('/')]));
        files.set(path, {type, body});
    };
    add('/settings', 'service/settings-page/index.html', 'text/html; charset=utf-8');
    add('/settings.css', 'service/settings-page/settings.css', 'text/css; charset=utf-8');
    add('/settings.js', 'service/settings-page/settings.js', 'text/javascript; charset=utf-8');
    for (const name of ['lyrics-status.js', 'scales.js', 'text-ink.js'])
        add(`/shared/${name}`, `shared/${name}`, 'text/javascript; charset=utf-8');
    // The extension's icon is the product's one mark, so the favicon is that file.
    add('/favicon.svg', 'firefox/icon.svg', 'image/svg+xml');
    return files;
}
