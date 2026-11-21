// Persistent offline Japanese furigana worker (wraps service/furigana.py).
// Lazy-started on first kanji-bearing line, caches annotated lines in an LRU
// map, and batches whole songs in a single IPC round-trip (~5 ms per song).
// Zero network access; never logs lyric text.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async', 'read_line_finish_utf8');
Gio._promisify(Gio.OutputStream.prototype, 'write_bytes_async', 'write_bytes_finish');

const KANJI_RE = /[\u4e00-\u9fff\u3400-\u4dbf\u3005]/u;
const MAX_CACHE = 2048;
const RETRY_AFTER_MS = 60_000;
const encoder = new TextEncoder();

export function hasKanji(text) {
    return typeof text === 'string' && KANJI_RE.test(text);
}

function hasAnyReading(segments) {
    return Array.isArray(segments) && segments.some(seg => Array.isArray(seg) && seg[1]);
}

function findPython(projectDir, override) {
    if (override)
        return override;
    const venvPython = GLib.build_filenamev([projectDir, '.venv', 'bin', 'python']);
    if (GLib.file_test(venvPython, GLib.FileTest.IS_EXECUTABLE))
        return venvPython;
    return 'python3';
}

export class FuriganaWorker {
    /**
     * @param {{projectDir: string, log: (message: string) => void, pythonPath?: string}} options
     */
    constructor({projectDir, log, pythonPath}) {
        this._projectDir = projectDir;
        this._log = log;
        this._python = findPython(projectDir, pythonPath);
        this._script = GLib.build_filenamev([projectDir, 'service', 'furigana.py']);
        this._cache = new Map();
        this._inFlight = new Map();
        this._pending = new Map();
        this._nextId = 1;
        this._proc = null;
        this._stdin = null;
        this._stdout = null;
        this._cancellable = null;
        this._starting = null;
        this._writeChain = Promise.resolve();
        this._stopped = false;
        this._failedAt = 0;
        this._status = {available: true, dict: '', error: ''};
    }

    status() {
        return {...this._status};
    }

    /**
     * Synchronous cache lookup: returns annotated segments when cached and at
     * least one kanji received a reading, otherwise null.
     * @param {string} text
     * @returns {Array<[string, string]>|null}
     */
    cached(text) {
        if (!hasKanji(text))
            return null;
        if (!this._cache.has(text))
            return null;
        const segments = this._cache.get(text);
        // Refresh LRU order.
        this._cache.delete(text);
        this._cache.set(text, segments);
        return hasAnyReading(segments) ? segments : null;
    }

    _remember(text, segments) {
        if (this._cache.has(text))
            this._cache.delete(text);
        this._cache.set(text, segments);
        while (this._cache.size > MAX_CACHE) {
            const oldest = this._cache.keys().next().value;
            this._cache.delete(oldest);
        }
    }

    /**
     * Annotates one lyric line; returns null if the line has no kanji or if the
     * offline dictionary is unavailable.
     * @param {string} text
     * @returns {Promise<Array<[string, string]>|null>}
     */
    async annotate(text) {
        if (!hasKanji(text))
            return null;
        if (this._cache.has(text))
            return this.cached(text);
        if (this._inFlight.has(text))
            return this._inFlight.get(text);
        const promise = (async () => {
            try {
                const ready = await this._ensureStarted();
                if (!ready)
                    return null;
                const resp = await this._send({text});
                if (!resp || !Array.isArray(resp.segments))
                    return null;
                this._remember(text, resp.segments);
                return hasAnyReading(resp.segments) ? resp.segments : null;
            } catch (error) {
                this._log(`furigana annotate error: ${error.message}`);
                return null;
            } finally {
                this._inFlight.delete(text);
            }
        })();
        this._inFlight.set(text, promise);
        return promise;
    }

    /**
     * Pre-annotates a batch of lines in one IPC call so live playback hits the
     * in-memory cache with zero latency.
     * @param {string[]} lines
     * @returns {Promise<boolean>} true if any new kanji lines were cached
     */
    async warm(lines) {
        const missing = [];
        const seen = new Set();
        for (const text of lines) {
            if (!hasKanji(text) || seen.has(text) || this._cache.has(text))
                continue;
            seen.add(text);
            missing.push(text);
        }
        if (!missing.length)
            return false;
        try {
            const ready = await this._ensureStarted();
            if (!ready)
                return false;
            const resp = await this._send({texts: missing});
            if (!resp || !Array.isArray(resp.results) || resp.results.length !== missing.length)
                return false;
            for (let i = 0; i < missing.length; i++) {
                if (Array.isArray(resp.results[i]))
                    this._remember(missing[i], resp.results[i]);
            }
            return true;
        } catch (error) {
            this._log(`furigana warm error: ${error.message}`);
            return false;
        }
    }

    _ensureStarted() {
        if (this._stopped)
            return Promise.resolve(false);
        if (this._proc)
            return Promise.resolve(true);
        if (this._starting)
            return this._starting;
        if (this._failedAt && Date.now() - this._failedAt < RETRY_AFTER_MS)
            return Promise.resolve(false);

        this._starting = (async () => {
            const cancellable = new Gio.Cancellable();
            try {
                const launcher = new Gio.SubprocessLauncher({
                    flags: Gio.SubprocessFlags.STDIN_PIPE
                        | Gio.SubprocessFlags.STDOUT_PIPE
                        | Gio.SubprocessFlags.STDERR_SILENCE,
                });
                launcher.set_cwd(this._projectDir);
                const proc = launcher.spawnv([this._python, '-u', this._script]);
                const stdin = proc.get_stdin_pipe();
                const stdout = new Gio.DataInputStream({base_stream: proc.get_stdout_pipe()});
                const [firstLine] = await stdout.read_line_async(GLib.PRIORITY_DEFAULT, cancellable);
                if (firstLine === null)
                    throw new Error('furigana worker closed before ready');
                const hello = JSON.parse(firstLine);
                if (!hello.ready)
                    throw new Error(hello.error || 'furigana dictionary unavailable');

                this._proc = proc;
                this._stdin = stdin;
                this._stdout = stdout;
                this._cancellable = cancellable;
                this._failedAt = 0;
                this._status = {available: true, dict: String(hello.dict || ''), error: ''};
                this._log(`furigana worker ready (Sudachi ${this._status.dict})`);
                this._readLoop(proc, stdout, cancellable);
                return true;
            } catch (error) {
                this._failedAt = Date.now();
                this._status = {available: false, dict: '', error: error.message};
                this._log(`furigana unavailable: ${error.message}`);
                cancellable.cancel();
                return false;
            } finally {
                this._starting = null;
            }
        })();
        return this._starting;
    }

    _readLoop(proc, stdout, cancellable) {
        (async () => {
            try {
                for (;;) {
                    const [line] = await stdout.read_line_async(GLib.PRIORITY_DEFAULT, cancellable);
                    if (line === null)
                        break;
                    if (!line.trim())
                        continue;
                    let msg;
                    try {
                        msg = JSON.parse(line);
                    } catch {
                        continue;
                    }
                    const entry = this._pending.get(msg.id);
                    if (!entry)
                        continue;
                    this._pending.delete(msg.id);
                    if (msg.error)
                        entry.reject(new Error(String(msg.error)));
                    else
                        entry.resolve(msg);
                }
            } catch (error) {
                if (!this._stopped && this._proc === proc)
                    this._log(`furigana worker stopped: ${error.message}`);
            } finally {
                if (this._proc === proc) {
                    this._proc = null;
                    this._stdin = null;
                    this._stdout = null;
                    this._cancellable = null;
                }
                for (const [id, entry] of this._pending) {
                    this._pending.delete(id);
                    entry.reject(new Error('furigana worker exited'));
                }
            }
        })();
    }

    _send(payload) {
        const id = this._nextId++;
        const bytes = new GLib.Bytes(encoder.encode(`${JSON.stringify({id, ...payload})}\n`));
        return new Promise((resolve, reject) => {
            if (!this._stdin) {
                reject(new Error('furigana worker is not running'));
                return;
            }
            this._pending.set(id, {resolve, reject});
            const stdin = this._stdin;
            const cancellable = this._cancellable;
            this._writeChain = this._writeChain.then(async () => {
                if (this._stdin !== stdin)
                    throw new Error('furigana worker closed');
                await stdin.write_bytes_async(bytes, GLib.PRIORITY_DEFAULT, cancellable);
            }).catch(error => {
                const entry = this._pending.get(id);
                if (entry) {
                    this._pending.delete(id);
                    entry.reject(error);
                }
            });
        });
    }

    shutdown() {
        this._stopped = true;
        this._cancellable?.cancel();
        try {
            this._stdin?.close(null);
        } catch {
            // Stream already closed.
        }
        try {
            this._proc?.send_signal(15);
        } catch {
            // Process already exited.
        }
        this._proc = null;
        this._stdin = null;
        this._stdout = null;
        this._cancellable = null;
    }
}
