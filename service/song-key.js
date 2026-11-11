// The key of the song that is playing, heard from the computer's own sound
// (the default output's monitor) while the pitch panel shows a detected
// scale. Audio never leaves memory; per video only the chroma gathered so
// far is stored, so a replay starts from it.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {ChromaAnalyzer, detectKey, KEY_SAMPLE_RATE, KEY_WINDOW} from '../shared/key-detect.js';

const HOP = Math.round(KEY_SAMPLE_RATE / 3);
// About 8 s of sound before the first guess.
const MIN_WINDOWS = 24;
// Below this lead over the best key with other notes, the guess is withheld.
const MIN_MARGIN = 0.02;
const SAVE_EVERY_WINDOWS = 30;

function isCancelled(error) {
    return error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

export class SongKey {
    /**
     * @param {{store: import('./store.js').JsonStore,
     *          onKey: (key: {videoId: string, root: number, type: 'major'|'minor'}|null) => void,
     *          log: (message: string) => void}} options
     */
    constructor(options) {
        for (const name of ['store', 'onKey', 'log']) {
            if (!options[name])
                throw new Error(`SongKey needs ${name}`);
        }
        this._options = options;
        this._analyzer = new ChromaAnalyzer();
        this._song = null;
        this._run = null;
    }

    /** Listens for this video's key, or stops listening (null). */
    listen(videoId) {
        if (videoId === (this._song?.videoId ?? null))
            return;
        this._saveSong();
        this._song = null;
        if (videoId === null) {
            this._stopCapture();
            this._options.onKey(null);
            return;
        }
        const stored = this._options.store.loadSongKey(videoId);
        this._song = {
            videoId,
            chroma: Float64Array.from(stored?.chroma ?? new Array(12).fill(0)),
            windows: stored?.windows ?? 0,
            unsaved: 0,
            key: null,
        };
        this._report();
        if (!this._run)
            this._startCapture();
    }

    shutdown() {
        this.listen(null);
    }

    _startCapture() {
        const run = {cancellable: new Gio.Cancellable(), ring: new Float32Array(KEY_WINDOW), ringAt: 0,
            window: new Float32Array(KEY_WINDOW), sinceAnalysis: 0, leftover: new Uint8Array(0), process: null};
        run.process = Gio.Subprocess.new([
            'pw-record', '--raw', '--rate', String(KEY_SAMPLE_RATE), '--channels', '1', '--format', 'f32', '--latency', '100ms',
            '-P', '{ stream.capture.sink = true node.name = "lyrics-overlay.song-listener" node.dont-reconnect = true }',
            '-',
        ], Gio.SubprocessFlags.STDOUT_PIPE);
        this._run = run;
        run.process.wait_async(run.cancellable, (_process, result) => {
            try {
                run.process.wait_finish(result);
            } catch (error) {
                if (isCancelled(error))
                    return;
                throw error;
            }
            if (this._run === run) {
                this._options.log('the song listener stopped; the key will not be detected');
                this._run = null;
            }
        });
        this._read(run, run.process.get_stdout_pipe());
    }

    _stopCapture() {
        const run = this._run;
        if (!run)
            return;
        this._run = null;
        run.cancellable.cancel();
        run.process.force_exit();
    }

    _read(run, stream) {
        stream.read_bytes_async(32768, GLib.PRIORITY_DEFAULT, run.cancellable, (_stream, result) => {
            let bytes;
            try {
                bytes = stream.read_bytes_finish(result);
            } catch (error) {
                if (isCancelled(error))
                    return;
                if (this._run === run)
                    this._options.log(`reading the song's sound failed: ${error.message}`);
                return;
            }
            if (this._run !== run || bytes.get_size() === 0)
                return;
            this._consume(run, bytes.toArray());
            this._read(run, stream);
        });
    }

    _consume(run, data) {
        const joined = new Uint8Array(run.leftover.length + data.length);
        joined.set(run.leftover);
        joined.set(data, run.leftover.length);
        const count = Math.floor(joined.length / 4);
        run.leftover = joined.slice(count * 4);
        const samples = new Float32Array(joined.buffer, 0, count);
        for (let i = 0; i < samples.length; i++) {
            run.ring[run.ringAt] = samples[i];
            run.ringAt = (run.ringAt + 1) % KEY_WINDOW;
            if (++run.sinceAnalysis < HOP)
                continue;
            run.sinceAnalysis = 0;
            run.window.set(run.ring.subarray(run.ringAt));
            run.window.set(run.ring.subarray(0, run.ringAt), KEY_WINDOW - run.ringAt);
            this._add(this._analyzer.chroma(run.window));
        }
    }

    _add(chroma) {
        const song = this._song;
        if (!song || !chroma)
            return;
        for (let i = 0; i < 12; i++)
            song.chroma[i] += chroma[i];
        song.windows++;
        if (++song.unsaved >= SAVE_EVERY_WINDOWS)
            this._saveSong();
        this._report();
    }

    _report() {
        const song = this._song;
        if (song.windows < MIN_WINDOWS)
            return;
        const found = detectKey(song.chroma);
        if (found.margin < MIN_MARGIN)
            return;
        if (song.key?.root === found.root && song.key.type === found.mode)
            return;
        song.key = {videoId: song.videoId, root: found.root, type: found.mode};
        this._options.log(`key of ${song.videoId}: ${found.root} ${found.mode} (margin ${found.margin.toFixed(3)})`);
        this._options.onKey(song.key);
    }

    _saveSong() {
        const song = this._song;
        if (!song?.unsaved)
            return;
        song.unsaved = 0;
        this._options.store.saveSongKey({videoId: song.videoId, chroma: Array.from(song.chroma, value => Math.round(value * 1000) / 1000), windows: song.windows});
    }
}
