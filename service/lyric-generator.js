// Runs the configured local lyric generator subprocess (e.g. faster-whisper
// via service/generate-lyrics.py) and converts its word-timed JSON output
// into timed LRC lyrics through shared/lyric-align.js.
//
// Keeps strong JS references to the active Gio.Subprocess, streams and
// cancellable until completion so GJS GC cannot collect them mid-run.
// Never logs lyric text.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {generateLrcFromTranscript} from '../shared/lyric-align.js';

Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async', 'read_line_finish_utf8');
Gio._promisify(Gio.InputStream.prototype, 'read_bytes_async', 'read_bytes_finish');
Gio._promisify(Gio.Subprocess.prototype, 'wait_async', 'wait_finish');

const READ_CHUNK_BYTES = 65536;
const decoder = new TextDecoder();
const encoder = new TextEncoder();

function resolvePath(projectDir, value) {
    if (GLib.path_is_absolute(value))
        return value;
    if (value.includes('/'))
        return GLib.build_filenamev([projectDir, value]);
    return value;
}

const SYSTEM_BIN_DIRS = new Set(['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin']);

function augmentedPath() {
    const localBin = GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin']);
    const current = GLib.getenv('PATH') ?? '/usr/local/bin:/usr/bin:/bin';
    const parts = current.split(':').filter(part => part && part !== localBin);
    const insertAt = parts.findIndex(part => SYSTEM_BIN_DIRS.has(part));
    parts.splice(insertAt === -1 ? parts.length : insertAt, 0, localBin);
    return parts.join(':');
}

async function readAllBytes(stream, cancellable) {
    const chunks = [];
    let total = 0;
    for (;;) {
        const bytes = await stream.read_bytes_async(READ_CHUNK_BYTES, GLib.PRIORITY_DEFAULT, cancellable);
        const arr = bytes.toArray();
        if (!arr.length)
            break;
        chunks.push(arr);
        total += arr.length;
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        merged.set(chunk, offset);
        offset += chunk.length;
    }
    return decoder.decode(merged);
}

/**
 * Validates the optional `lyricsGenerator` block in settings.json.
 * @param {unknown} raw
 * @param {string} path settings file path for clear error messages
 */
export function validateGeneratorConfig(raw, path) {
    if (raw === undefined || raw === null)
        return null;
    if (typeof raw !== 'object' || Array.isArray(raw))
        throw new Error(`${path}: "lyricsGenerator" must be an object or null`);
    if (!Array.isArray(raw.command) || !raw.command.length || raw.command.some(part => typeof part !== 'string' || !part))
        throw new Error(`${path}: "lyricsGenerator.command" must be a non-empty array of strings`);
    const model = raw.model ?? 'large-v3';
    const device = raw.device ?? 'auto';
    const computeType = raw.computeType ?? 'auto';
    const maxDurationSeconds = raw.maxDurationSeconds ?? 900;
    if (typeof model !== 'string' || !model)
        throw new Error(`${path}: "lyricsGenerator.model" must be a non-empty string`);
    if (!['auto', 'cuda', 'cpu'].includes(device))
        throw new Error(`${path}: "lyricsGenerator.device" must be "auto", "cuda" or "cpu"`);
    if (typeof computeType !== 'string' || !computeType)
        throw new Error(`${path}: "lyricsGenerator.computeType" must be a non-empty string`);
    if (typeof maxDurationSeconds !== 'number' || !Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0)
        throw new Error(`${path}: "lyricsGenerator.maxDurationSeconds" must be a positive number`);
    let cookiesFromBrowser = null;
    if (raw.cookiesFromBrowser !== undefined && raw.cookiesFromBrowser !== null) {
        if (typeof raw.cookiesFromBrowser !== 'string' || !/^[^\s-][^\s]*$/u.test(raw.cookiesFromBrowser))
            throw new Error(`${path}: "lyricsGenerator.cookiesFromBrowser" must be a browser name (e.g. "firefox") or null`);
        cookiesFromBrowser = raw.cookiesFromBrowser;
    }
    let gpuGate = null;
    if (raw.gpuGate !== undefined && raw.gpuGate !== null) {
        if (typeof raw.gpuGate !== 'object' || Array.isArray(raw.gpuGate))
            throw new Error(`${path}: "lyricsGenerator.gpuGate" must be an object or null`);
        if (typeof raw.gpuGate.command !== 'string' || !raw.gpuGate.command)
            throw new Error(`${path}: "lyricsGenerator.gpuGate.command" must be a string`);
        gpuGate = {...raw.gpuGate};
    }
    return {
        command: [...raw.command],
        model,
        device,
        computeType,
        maxDurationSeconds,
        cookiesFromBrowser,
        gpuGate,
    };
}

/**
 * @param {{config: ReturnType<typeof validateGeneratorConfig>, projectDir: string,
 *          runtimeDir: string, ytarchiveUrl: string|null, log: (message: string) => void}} options
 */
export function createLyricGenerator({config, projectDir, runtimeDir, ytarchiveUrl, log}) {
    if (!config)
        return null;
    let runSeq = 0;

    return ({videoId, identity, plainLyrics, force = false, onStage}) => {
        const cancellable = new Gio.Cancellable();
        let cancelled = false;
        let promptPath = '';
        let proc = null;

        const cleanupPrompt = () => {
            if (!promptPath)
                return;
            try {
                Gio.File.new_for_path(promptPath).delete(null);
            } catch {
                // Already removed or never created.
            }
            promptPath = '';
        };

        const argv = config.command.map((part, idx) => (idx <= 1 ? resolvePath(projectDir, part) : part));
        argv.push(
            '--video-id', videoId,
            '--model', config.model,
            '--device', config.device,
            '--compute-type', config.computeType,
            '--max-duration', String(force ? 0 : config.maxDurationSeconds),
        );
        if (ytarchiveUrl)
            argv.push('--ytarchive-url', ytarchiveUrl);
        if (config.cookiesFromBrowser)
            argv.push('--cookies-from-browser', config.cookiesFromBrowser);
        if (config.gpuGate)
            argv.push('--gpu-gate-json', JSON.stringify(config.gpuGate));

        const promptText = String(plainLyrics ?? '').trim() ||
            [identity?.artist, identity?.title || identity?.videoTitle].filter(Boolean).join(' - ');
        if (promptText) {
            promptPath = GLib.build_filenamev([runtimeDir, `prompt-${videoId}-${++runSeq}.txt`]);
            GLib.file_set_contents_full(
                promptPath,
                encoder.encode(promptText.slice(0, 1200)),
                GLib.FileSetContentsFlags.CONSISTENT,
                0o600,
            );
            argv.push('--prompt-file', promptPath);
        }

        const launcher = new Gio.SubprocessLauncher({
            flags: Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE,
        });
        launcher.setenv('PATH', augmentedPath(), true);
        launcher.set_cwd(projectDir);

        const promise = (async () => {
            try {
                proc = launcher.spawnv(argv);
                const stdoutPipe = proc.get_stdout_pipe();
                const stderrPipe = proc.get_stderr_pipe();
                const stderrReader = new Gio.DataInputStream({base_stream: stderrPipe});
                const stderrErrors = [];

                const readStderr = (async () => {
                    for (;;) {
                        const [line] = await stderrReader.read_line_async(GLib.PRIORITY_DEFAULT, cancellable);
                        if (line === null)
                            break;
                        const trimmed = line.trim();
                        if (trimmed.startsWith('stage:')) {
                            const stage = trimmed.slice('stage:'.length).trim();
                            if (!cancelled)
                                onStage?.(stage);
                        } else if (trimmed) {
                            stderrErrors.push(trimmed);
                            if (stderrErrors.length > 6)
                                stderrErrors.shift();
                        }
                    }
                })().catch(error => {
                    if (!cancelled)
                        log(`lyric generator stderr error for ${videoId}: ${error.message}`);
                });

                const stdoutText = await readAllBytes(stdoutPipe, cancellable);
                await readStderr;
                await proc.wait_async(cancellable);

                if (cancelled)
                    return {ok: false, cancelled: true, error: 'cancelled'};

                const exitOk = proc.get_successful();
                if (!stdoutText.trim()) {
                    const detail = stderrErrors.at(-1) || `exit status ${proc.get_exit_status()}`;
                    return {ok: false, error: `lyric generator stopped: ${detail}`};
                }

                let payload;
                try {
                    payload = JSON.parse(stdoutText);
                } catch {
                    return {ok: false, error: `invalid generator output (exit ${exitOk ? 0 : proc.get_exit_status()})`};
                }

                if (!payload.ok) {
                    return {
                        ok: false,
                        skip: Boolean(payload.skip),
                        busy: Boolean(payload.busy),
                        error: String(payload.error || 'lyric generation failed'),
                    };
                }

                const built = generateLrcFromTranscript({
                    segments: payload.segments,
                    duration: Number(payload.duration) || identity?.durationSeconds || 0,
                    plainLyrics: plainLyrics ?? '',
                });
                if (!built.ok) {
                    return {
                        ok: false,
                        skip: built.reason === 'no-vocals',
                        error: built.reason === 'no-vocals' ? 'No sung vocals found in audio' : built.reason,
                    };
                }
                return {
                    ...built,
                    duration: Number(payload.duration) || identity?.durationSeconds || 0,
                };
            } catch (error) {
                if (cancelled)
                    return {ok: false, cancelled: true, error: 'cancelled'};
                log(`lyric generator error for ${videoId}: ${error.message}`);
                return {ok: false, error: error.message};
            } finally {
                cleanupPrompt();
                proc = null;
            }
        })();

        return {
            promise,
            cancel() {
                if (cancelled)
                    return;
                cancelled = true;
                try {
                    proc?.send_signal(15);
                } catch {
                    // Process already exited.
                }
                cancellable.cancel();
                cleanupPrompt();
            },
        };
    };
}
