// LRCLIB search and anonymous publish client. Requests carry only track
// metadata/lyrics and a generic browser User-Agent (no project, person, or
// machine names).

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import {ProviderRateLimit, retryAtFromHeader} from '../shared/budget.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');
Gio._promisify(Gio.Subprocess.prototype, 'communicate_utf8_async', 'communicate_utf8_finish');

const TIMEOUT_SECONDS = 15;
const HTTP_OK = 200;
const HTTP_TOO_MANY_REQUESTS = 429;
const USER_AGENT = 'Mozilla/5.0';
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function jsonErrorDetail(status, bodyText) {
    try {
        const parsed = JSON.parse(bodyText);
        if (typeof parsed?.message === 'string' && parsed.message.trim())
            return `HTTP ${status}: ${parsed.message.trim()}`;
    } catch {
        // Non-JSON error body; fall back to HTTP status below.
    }
    return `HTTP ${status}`;
}

async function solvePowChallenge({projectDir, pythonPath, prefix, target}) {
    const script = GLib.build_filenamev([projectDir, 'service', 'lrclib-pow.py']);
    const proc = Gio.Subprocess.new(
        [pythonPath || 'python3', script, String(prefix), String(target)],
        Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
    );
    const [stdout, stderr] = await proc.communicate_utf8_async(null, null);
    if (!proc.get_successful()) {
        const detail = String(stderr || '').trim() || `exit ${proc.get_exit_status()}`;
        throw new Error(`proof-of-work solver failed: ${detail}`);
    }
    const nonce = String(stdout || '').trim();
    if (!/^\d+$/u.test(nonce))
        throw new Error('proof-of-work solver returned an invalid nonce');
    return nonce;
}

/**
 * Throws ProviderRateLimit when LRCLIB refuses for its rate limit.
 * @returns {(candidate: {artist: string, title: string}) => Promise<object[]>}
 */
export function createLrclibSearch(baseUrl) {
    const session = new Soup.Session({timeout: TIMEOUT_SECONDS, user_agent: USER_AGENT});
    return async ({artist, title}) => {
        const query = {track_name: title};
        if (artist)
            query.artist_name = artist;
        const encoded = Object.entries(query)
            .map(([name, value]) => `${name}=${GLib.Uri.escape_string(value, null, false)}`)
            .join('&');
        const message = Soup.Message.new('GET', `${baseUrl}/api/search?${encoded}`);
        message.get_request_headers().append('Accept', 'application/json');
        const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);
        // The plain number: Soup.Status has no member for 429, and
        // get_status() throws on codes its enumeration lacks.
        const status = message.status_code;
        if (status === HTTP_TOO_MANY_REQUESTS)
            throw new ProviderRateLimit(retryAtFromHeader(message.get_response_headers().get_one('Retry-After'), Date.now()));
        if (status !== HTTP_OK)
            throw new Error(`HTTP ${status}`);
        const answer = JSON.parse(decoder.decode(bytes.toArray()));
        if (!Array.isArray(answer))
            throw new Error('answer is not a list');
        return answer;
    };
}

/**
 * Anonymous LRCLIB publisher: requests a one-time proof-of-work challenge
 * (`POST /api/request-challenge`), solves it out-of-process so the GJS loop
 * never stalls, and submits to `POST /api/publish`.
 *
 * @param {string} baseUrl
 * @param {{projectDir: string, pythonPath?: string}} options
 */
export function createLrclibPublisher(baseUrl, {projectDir, pythonPath} = {}) {
    const session = new Soup.Session({timeout: TIMEOUT_SECONDS, user_agent: USER_AGENT});
    const root = baseUrl.replace(/\/+$/u, '');

    return async ({trackName, artistName, albumName, duration, plainLyrics, syncedLyrics}) => {
        const challengeMsg = Soup.Message.new('POST', `${root}/api/request-challenge`);
        challengeMsg.get_request_headers().append('Accept', 'application/json');
        challengeMsg.set_request_body_from_bytes('application/json', new GLib.Bytes(new Uint8Array()));
        const challengeBytes = await session.send_and_read_async(challengeMsg, GLib.PRIORITY_DEFAULT, null);
        const challengeStatus = challengeMsg.status_code;
        const challengeText = decoder.decode(challengeBytes.toArray());
        if (challengeStatus === HTTP_TOO_MANY_REQUESTS)
            throw new ProviderRateLimit(retryAtFromHeader(challengeMsg.get_response_headers().get_one('Retry-After'), Date.now()));
        if (challengeStatus < 200 || challengeStatus >= 300)
            throw new Error(`LRCLIB challenge failed (${jsonErrorDetail(challengeStatus, challengeText)})`);
        let challenge;
        try {
            challenge = JSON.parse(challengeText);
        } catch {
            throw new Error('LRCLIB challenge returned invalid JSON');
        }
        if (typeof challenge?.prefix !== 'string' || typeof challenge?.target !== 'string')
            throw new Error('LRCLIB challenge lacked prefix or target');

        const nonce = await solvePowChallenge({
            projectDir,
            pythonPath,
            prefix: challenge.prefix,
            target: challenge.target,
        });

        const payload = JSON.stringify({
            trackName,
            artistName,
            albumName,
            duration,
            plainLyrics,
            syncedLyrics,
        });
        const publishMsg = Soup.Message.new('POST', `${root}/api/publish`);
        publishMsg.get_request_headers().append('Accept', 'application/json');
        publishMsg.get_request_headers().append('X-Publish-Token', `${challenge.prefix}:${nonce}`);
        publishMsg.set_request_body_from_bytes('application/json', new GLib.Bytes(encoder.encode(payload)));
        const publishBytes = await session.send_and_read_async(publishMsg, GLib.PRIORITY_DEFAULT, null);
        const publishStatus = publishMsg.status_code;
        const publishText = decoder.decode(publishBytes.toArray());
        if (publishStatus === HTTP_TOO_MANY_REQUESTS)
            throw new ProviderRateLimit(retryAtFromHeader(publishMsg.get_response_headers().get_one('Retry-After'), Date.now()));
        if (publishStatus < 200 || publishStatus >= 300)
            throw new Error(`LRCLIB publish failed (${jsonErrorDetail(publishStatus, publishText)})`);
        return {ok: true, status: publishStatus};
    };
}
