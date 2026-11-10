// Loopback HTTP API for the browser extension and the status page.
//
// Requests must name an expected Host (DNS-rebinding guard). Extension
// requests (reports, command requests and results) must be
// application/json from an extension origin or no origin: a web
// page cannot send that content type cross-origin without a CORS
// preflight, which this server never approves. No response carries CORS
// headers.

import Soup from 'gi://Soup?version=3.0';

import {isReportError, parseCommandResult, parseGone, parseReport} from './report-schema.js';
import {renderStatusBody, renderStatusPage} from './status-page.js';

const MAX_BODY_BYTES = 64 * 1024;
const EXTENSION_PATHS = new Set(['/api/report', '/api/gone', '/api/commands', '/api/command-result']);
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

/**
 * The caller must keep the returned server until shutdown: only this
 * JavaScript reference holds it, and once collected it stops listening.
 * @param {{port: number, hostname: string, favicon: Uint8Array,
 *          core: import('./core.js').LyricsCore,
 *          browser: import('./browser-commands.js').BrowserCommands,
 *          log: (message: string) => void}} options
 * @returns {Soup.Server}
 */
export function startHttp({port, hostname, favicon, core, browser, log}) {
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
                message.set_status(204, null);
            message.unpause();
        });
    };

    const handleExtension = (message, headers, path) => {
        const origin = headers.get_one('Origin');
        const crossSite = origin === null && headers.get_one('Sec-Fetch-Site') === 'cross-site';
        if (crossSite || (origin !== null && !origin.startsWith('moz-extension://'))) {
            respondJson(message, 403, {error: 'only the browser extension may call this'});
            return;
        }
        const [contentType] = headers.get_content_type();
        if (contentType !== 'application/json') {
            respondJson(message, 415, {error: 'extension requests are application/json'});
            return;
        }
        const body = message.get_request_body().flatten();
        if (body.get_size() > MAX_BODY_BYTES) {
            respondJson(message, 413, {error: 'request too large'});
            return;
        }
        try {
            const json = JSON.parse(decoder.decode(body.get_data() ?? new Uint8Array()));
            switch (path) {
            case '/api/report': {
                const {tabId, message: report} = parseReport(json, Date.now());
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
                if (!browser.answer(id, result)) {
                    respondJson(message, 409, {error: 'that command is no longer waiting'});
                    return;
                }
                break;
            }
            }
        } catch (error) {
            if (!(error instanceof SyntaxError) && !isReportError(error))
                throw error;
            log(`refused ${path}: ${error.message}`);
            respondJson(message, 400, {error: error.message});
            return;
        }
        message.set_status(204, null);
    };

    server.add_handler(null, (_server, message, path) => {
        const headers = message.get_request_headers();
        if (!allowedHosts.has(headers.get_one('Host') ?? '')) {
            respondJson(message, 403, {error: 'unexpected Host'});
            return;
        }
        const method = message.get_method();
        if (method === 'GET' && path === '/') {
            respond(message, 200, 'text/html; charset=utf-8', renderStatusPage(core.state(), core.line()));
            return;
        }
        if (method === 'GET' && path === '/status-body') {
            respond(message, 200, 'text/html; charset=utf-8', renderStatusBody(core.state(), core.line()));
            return;
        }
        if (method === 'GET' && path === '/favicon.svg') {
            respond(message, 200, 'image/svg+xml', favicon);
            return;
        }
        if (method === 'GET' && path === '/api/state') {
            respondJson(message, 200, {state: core.state(), line: core.line()});
            return;
        }
        if (method === 'POST' && EXTENSION_PATHS.has(path)) {
            handleExtension(message, headers, path);
            return;
        }
        respondJson(message, 404, {error: 'not found'});
    });

    server.listen_local(port, Soup.ServerListenOptions.IPV4_ONLY);
    log(`listening on 127.0.0.1:${port} (${hostname})`);
    return server;
}
