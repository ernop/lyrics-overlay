// Runs the configured local lead-vocal score extractor subprocess
// (service/generate-score.py: 2-pass RoFormer lead vocal isolation ->
// beat_this beats/downbeats -> faster-whisper word timings -> GAME-large
// vocal note transcription -> scale/key + beat-grid quantization).
//
// Keeps strong JS references to the active Gio.Subprocess, streams, and
// cancellable until completion so GJS GC cannot collect them mid-run.
// Never logs lyric text.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

Gio._promisify(Gio.DataInputStream.prototype, 'read_line_async', 'read_line_finish_utf8');
Gio._promisify(Gio.Subprocess.prototype, 'wait_async', 'wait_finish');

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

/**
 * Validates the optional `scoreGenerator` block in settings.json.
 * @param {unknown} raw
 * @param {string} path
 */
export function validateScoreGeneratorConfig(raw, path) {
    if (raw === undefined || raw === null)
        return null;
    if (typeof raw !== 'object' || Array.isArray(raw))
        throw new Error(`${path}: "scoreGenerator" must be an object or null`);
    if (!Array.isArray(raw.command) || !raw.command.length || raw.command.some(part => typeof part !== 'string' || !part))
        throw new Error(`${path}: "scoreGenerator.command" must be a non-empty array of strings`);
    const device = raw.device ?? 'auto';
    const whisperModel = raw.whisperModel ?? 'large-v3';
    const maxDurationSeconds = raw.maxDurationSeconds ?? 900;
    if (!['auto', 'cuda', 'cpu'].includes(device))
        throw new Error(`${path}: "scoreGenerator.device" must be "auto", "cuda" or "cpu"`);
    if (typeof whisperModel !== 'string' || !whisperModel)
        throw new Error(`${path}: "scoreGenerator.whisperModel" must be a non-empty string`);
    if (typeof maxDurationSeconds !== 'number' || !Number.isFinite(maxDurationSeconds) || maxDurationSeconds <= 0)
        throw new Error(`${path}: "scoreGenerator.maxDurationSeconds" must be a positive number`);
    let cookiesFromBrowser = null;
    if (raw.cookiesFromBrowser !== undefined && raw.cookiesFromBrowser !== null) {
        if (typeof raw.cookiesFromBrowser !== 'string' || !/^[^\s-][^\s]*$/u.test(raw.cookiesFromBrowser))
            throw new Error(`${path}: "scoreGenerator.cookiesFromBrowser" must be a browser name (e.g. "firefox") or null`);
        cookiesFromBrowser = raw.cookiesFromBrowser;
    }
    let gpuGate = null;
    if (raw.gpuGate !== undefined && raw.gpuGate !== null) {
        if (typeof raw.gpuGate !== 'object' || Array.isArray(raw.gpuGate))
            throw new Error(`${path}: "scoreGenerator.gpuGate" must be an object or null`);
        if (typeof raw.gpuGate.command !== 'string' || !raw.gpuGate.command)
            throw new Error(`${path}: "scoreGenerator.gpuGate.command" must be a string`);
        gpuGate = {...raw.gpuGate};
    }
    return {
        command: [...raw.command],
        device,
        whisperModel,
        maxDurationSeconds,
        cookiesFromBrowser,
        gpuGate,
    };
}

const encoder = new TextEncoder();

/**
 * @param {{config: ReturnType<typeof validateScoreGeneratorConfig>, projectDir: string,
 *          runtimeDir?: string, ytarchiveUrl: string|null, log: (message: string) => void}} options
 */
export function createScoreGenerator({config, projectDir, runtimeDir = null, ytarchiveUrl, log}) {
    if (!config)
        return null;
    let runSeq = 0;
    const promptDir = runtimeDir || GLib.build_filenamev([GLib.get_user_runtime_dir(), 'lyrics-overlay']);

    return ({videoId, identity = null, plainLyrics = '', force = false, freshAudio = false, quality = 'standard', onStage}) => {
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
            `--video-id=${videoId}`,
            '--device', config.device,
            '--whisper-model', config.whisperModel,
            '--quality', quality === 'high' ? 'high' : 'standard',
            '--max-duration', String(force ? 0 : config.maxDurationSeconds),
        );
        if (freshAudio)
            argv.push('--fresh-audio');
        if (ytarchiveUrl && !freshAudio)
            argv.push('--ytarchive-url', ytarchiveUrl);
        if (config.cookiesFromBrowser)
            argv.push('--cookies-from-browser', config.cookiesFromBrowser);
        if (config.gpuGate) {
            const gate = quality === 'high'
                ? {...config.gpuGate, minutes: Math.max(8, Number(config.gpuGate.minutes) || 6)}
                : config.gpuGate;
            argv.push('--gpu-gate-json', JSON.stringify(gate));
        }

        const promptText = String(plainLyrics ?? '').trim()
            || [identity?.artist, identity?.title || identity?.videoTitle].filter(Boolean).join(' - ');
        if (promptText) {
            GLib.mkdir_with_parents(promptDir, 0o700);
            promptPath = GLib.build_filenamev([promptDir, `score-prompt-${videoId}-${++runSeq}.txt`]);
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
                const stdoutReader = new Gio.DataInputStream({base_stream: stdoutPipe});
                const stderrReader = new Gio.DataInputStream({base_stream: stderrPipe});
                const stderrErrors = [];
                let payload = null;
                let badStdout = false;

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
                        log(`score generator stderr error for ${videoId}: ${error.message}`);
                });

                const readStdout = (async () => {
                    for (;;) {
                        const [line] = await stdoutReader.read_line_async(GLib.PRIORITY_DEFAULT, cancellable);
                        if (line === null)
                            break;
                        const trimmed = line.trim();
                        if (!trimmed)
                            continue;
                        try {
                            payload = JSON.parse(trimmed);
                        } catch {
                            badStdout = true;
                        }
                    }
                })();

                await Promise.all([readStdout, readStderr]);
                await proc.wait_async(cancellable);

                if (cancelled)
                    return {ok: false, cancelled: true, error: 'cancelled'};

                const exitOk = proc.get_successful();
                if (!payload) {
                    if (badStdout)
                        return {ok: false, error: `invalid score output (exit ${exitOk ? 0 : proc.get_exit_status()})`};
                    const detail = stderrErrors.at(-1) || `exit status ${proc.get_exit_status()}`;
                    return {ok: false, error: `score extractor stopped: ${detail}`};
                }

                if (!payload.ok) {
                    return {
                        ok: false,
                        skip: Boolean(payload.skip),
                        busy: Boolean(payload.busy),
                        error: String(payload.error || 'melody extraction failed'),
                    };
                }
                return payload;
            } catch (error) {
                if (cancelled)
                    return {ok: false, cancelled: true, error: 'cancelled'};
                log(`score generator error for ${videoId}: ${error.message}`);
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
