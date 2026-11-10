// LRCLIB search client. Requests carry only the song identity and a
// generic browser User-Agent (no project, person or machine names).

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import {ProviderRateLimit, retryAtFromHeader} from '../shared/budget.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');

const TIMEOUT_SECONDS = 12;
const HTTP_OK = 200;
const HTTP_TOO_MANY_REQUESTS = 429;
const decoder = new TextDecoder();

/**
 * Throws ProviderRateLimit when LRCLIB refuses for its rate limit.
 * @returns {(candidate: {artist: string, title: string}) => Promise<object[]>}
 */
export function createLrclibSearch(baseUrl) {
    const session = new Soup.Session({timeout: TIMEOUT_SECONDS, user_agent: 'Mozilla/5.0'});
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
