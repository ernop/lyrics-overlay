// Client for a local ytarchive service, used by ArchiveSync. ytarchive
// trusts a POST whose Host is local and which carries no Origin, which is
// what these loopback requests are; they go nowhere else.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Soup from 'gi://Soup?version=3.0';

import {ArchiveRefused} from './archive-sync.js';

Gio._promisify(Soup.Session.prototype, 'send_and_read_async', 'send_and_read_finish');

const TIMEOUT_SECONDS = 10;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

/** @returns {{add(videoId: string): Promise<void>, lyrics(videoId: string, lrc: string|null): Promise<void>}} */
export function createYtarchiveClient(baseUrl) {
    const session = new Soup.Session({timeout: TIMEOUT_SECONDS});
    const post = async (path, body) => {
        const message = Soup.Message.new('POST', `${baseUrl}${path}`);
        message.set_request_body_from_bytes('application/json', new GLib.Bytes(encoder.encode(JSON.stringify(body))));
        const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null);
        const status = message.status_code;
        if (status >= 200 && status < 300)
            return;
        const detail = `HTTP ${status}: ${decoder.decode(bytes.toArray()).slice(0, 300)}`;
        throw status >= 400 && status < 500 ? new ArchiveRefused(detail) : new Error(detail);
    };
    return {
        // "played" fills ytarchive's Added by column.
        add: videoId => post('/api/get', {url: `https://www.youtube.com/watch?v=${videoId}`, via: 'played'}),
        lyrics: (videoId, lrc) => post('/api/lyrics', {video_id: videoId, lrc}),
    };
}
