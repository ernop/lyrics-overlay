// JSON files under the state directory, written atomically:
//   videos/<videoId>.json   per-video lookup, candidates, choice, rejections, offset
//   searches/<sha1>.json    LRCLIB search answers, pruned after SEARCH_CACHE_MS
//   budget.json             request budget windows, so restarts cannot reset them
//   archive/<videoId>.json  what ytarchive has taken for a video (archive-sync.js)
//   archive-outbox.json     videos with something ytarchive has not taken yet
//   keys/<videoId>.json     chroma heard so far for the song's key (song-key.js)

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {SEARCH_CACHE_MS} from './core.js';

const decoder = new TextDecoder();
const encoder = new TextEncoder();

export function expandHome(path) {
    return path.startsWith('~/') ? GLib.build_filenamev([GLib.get_home_dir(), path.slice(2)]) : path;
}

export class JsonStore {
    constructor(stateDir) {
        this._root = expandHome(stateDir);
        for (const dir of [this._root, this._path('videos'), this._path('searches'), this._path('archive'), this._path('keys')]) {
            if (GLib.mkdir_with_parents(dir, 0o700) !== 0)
                throw new Error(`cannot create ${dir}`);
        }
    }

    _path(...parts) {
        return GLib.build_filenamev([this._root, ...parts]);
    }

    _read(path) {
        if (!GLib.file_test(path, GLib.FileTest.EXISTS))
            return null;
        const [, contents] = GLib.file_get_contents(path);
        return JSON.parse(decoder.decode(contents));
    }

    _write(path, value) {
        GLib.file_set_contents_full(path, encoder.encode(`${JSON.stringify(value)}\n`),
            GLib.FileSetContentsFlags.CONSISTENT, 0o600);
    }

    _searchPath(key) {
        return this._path('searches', `${GLib.compute_checksum_for_string(GLib.ChecksumType.SHA1, key, -1)}.json`);
    }

    loadVideo(videoId) {
        return this._read(this._path('videos', `${videoId}.json`));
    }

    saveVideo(record) {
        this._write(this._path('videos', `${record.videoId}.json`), record);
    }

    loadSearch(key) {
        const entry = this._read(this._searchPath(key));
        return entry && entry.key === key ? {at: entry.at, records: entry.records} : null;
    }

    saveSearch(key, entry) {
        this._write(this._searchPath(key), {key, at: entry.at, records: entry.records});
    }

    loadBudget() {
        return this._read(this._path('budget.json'));
    }

    saveBudget(state) {
        this._write(this._path('budget.json'), state);
    }

    loadArchiveRecord(videoId) {
        return this._read(this._path('archive', `${videoId}.json`));
    }

    saveArchiveRecord(record) {
        this._write(this._path('archive', `${record.videoId}.json`), record);
    }

    loadSongKey(videoId) {
        return this._read(this._path('keys', `${videoId}.json`));
    }

    saveSongKey(record) {
        this._write(this._path('keys', `${record.videoId}.json`), record);
    }

    loadArchiveOutbox() {
        return this._read(this._path('archive-outbox.json'));
    }

    saveArchiveOutbox(videoIds) {
        this._write(this._path('archive-outbox.json'), videoIds);
    }

    /** Deletes search answers older than the cache period; returns how many. */
    pruneSearches(nowMs) {
        const dir = Gio.File.new_for_path(this._path('searches'));
        const children = dir.enumerate_children('standard::name,time::modified', Gio.FileQueryInfoFlags.NONE, null);
        let removed = 0;
        for (let info = children.next_file(null); info; info = children.next_file(null)) {
            const modifiedMs = info.get_modification_date_time().to_unix() * 1000;
            if (nowMs - modifiedMs > SEARCH_CACHE_MS) {
                dir.get_child(info.get_name()).delete(null);
                removed++;
            }
        }
        children.close(null);
        return removed;
    }
}
