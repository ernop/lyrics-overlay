// Microphone pitch for the overlay's trace. Runs only while the shell asks
// for it: a private PipeWire echo canceller (echo-cancel.conf) plus
// pw-record reading its cleaned voice, analyzed 25 times a second with
// voice-wei's detector. Audio never leaves memory.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {GlitchFilter, PitchDetector, voiceMidi} from '../shared/pitch-mpm.js';
import {defaultSourceName, nodeDescription} from './microphone-name.js';

const SAMPLE_RATE = 48000;
const WINDOW_SAMPLES = 2048;
const HOP_SAMPLES = 1920;
// A brief pause keeps the microphone open instead of toggling it.
const LINGER_MS = 10_000;
const VOICE_NODE = 'lyrics-overlay.voice';

export class PitchCapture {
    /**
     * @param {{configPath: string, onFrames: (frames: object) => void,
     *          onStatus: (status: {capturing: boolean, error: string, microphone: string}) => void,
     *          log: (message: string) => void}} options
     */
    constructor(options) {
        this._options = options;
        this._running = null;
        this._lingerId = 0;
    }

    want(wanted, immediate) {
        if (this._lingerId) {
            GLib.source_remove(this._lingerId);
            this._lingerId = 0;
        }
        if (wanted) {
            if (!this._running)
                this._start();
        } else if (this._running) {
            if (immediate) {
                this._stop('');
            } else {
                this._lingerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LINGER_MS, () => {
                    this._lingerId = 0;
                    this._stop('');
                    return GLib.SOURCE_REMOVE;
                });
            }
        }
    }

    shutdown() {
        this.want(false, true);
    }

    _start() {
        const run = {
            cancellable: new Gio.Cancellable(),
            window: new Float32Array(WINDOW_SAMPLES),
            sinceAnalysis: 0,
            leftover: new Uint8Array(0),
            detector: new PitchDetector(),
            filter: new GlitchFilter(),
            processes: [],
        };
        this._running = run;
        const echoCanceller = Gio.Subprocess.new(['pipewire', '-c', this._options.configPath], Gio.SubprocessFlags.NONE);
        const recorder = Gio.Subprocess.new([
            'pw-record', '--raw', '--target', VOICE_NODE, '--rate', String(SAMPLE_RATE), '--channels', '1',
            '--format', 'f32', '--latency', '20ms',
            '-P', '{ node.name = "lyrics-overlay.voice-reader" node.dont-fallback = true node.dont-reconnect = true }',
            '-',
        ], Gio.SubprocessFlags.STDOUT_PIPE);
        run.processes = [echoCanceller, recorder];
        for (const [process, name] of [[echoCanceller, 'echo canceller'], [recorder, 'pw-record']]) {
            process.wait_async(run.cancellable, (_process, result) => {
                try {
                    process.wait_finish(result);
                } catch (error) {
                    if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        return;
                    throw error;
                }
                if (this._running === run) {
                    const how = process.get_if_exited() ? `status ${process.get_exit_status()}` : `signal ${process.get_term_sig()}`;
                    this._stop(`${name} exited with ${how}`);
                }
            });
        }
        this._read(run, recorder.get_stdout_pipe());
        this._options.log('microphone on');
        this._options.onStatus({capturing: true, error: '', microphone: ''});
        this._nameMicrophone(run);
    }

    async _nameMicrophone(run) {
        let microphone;
        try {
            const source = defaultSourceName(JSON.parse(await this._output(['pw-dump', '-N', 'default'], run.cancellable)));
            microphone = source ? nodeDescription(JSON.parse(await this._output(['pw-dump', '-N', source], run.cancellable))) : '';
        } catch (error) {
            if (error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                return;
            this._options.log(`could not name the microphone: ${error.message}`);
            return;
        }
        if (this._running !== run)
            return;
        this._options.log(`microphone is ${microphone || 'unnamed'}`);
        this._options.onStatus({capturing: true, error: '', microphone});
    }

    _output(argv, cancellable) {
        const process = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE);
        return new Promise((resolve, reject) => {
            process.communicate_utf8_async(null, cancellable, (_process, result) => {
                try {
                    const [, stdout] = process.communicate_utf8_finish(result);
                    if (!process.get_successful())
                        throw new Error(`${argv.join(' ')} exited with status ${process.get_exit_status()}`);
                    resolve(stdout);
                } catch (error) {
                    reject(error);
                }
            });
        });
    }

    _stop(error) {
        const run = this._running;
        if (!run)
            return;
        this._running = null;
        run.cancellable.cancel();
        for (const process of run.processes)
            process.force_exit();
        this._options.log(error ? `microphone off: ${error}` : 'microphone off');
        this._options.onStatus({capturing: false, error, microphone: ''});
    }

    _read(run, stream) {
        stream.read_bytes_async(16384, GLib.PRIORITY_DEFAULT, run.cancellable, (_stream, result) => {
            let bytes;
            try {
                bytes = stream.read_bytes_finish(result);
            } catch (error) {
                if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    return;
                if (this._running === run)
                    this._stop(`reading the microphone failed: ${error.message}`);
                return;
            }
            if (this._running !== run)
                return;
            if (bytes.get_size() === 0) {
                this._stop('pw-record closed its output');
                return;
            }
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

        const window = run.window;
        if (count >= WINDOW_SAMPLES) {
            window.set(samples.subarray(count - WINDOW_SAMPLES));
        } else {
            window.copyWithin(0, count);
            window.set(samples, WINDOW_SAMPLES - count);
        }
        run.sinceAnalysis += count;
        if (run.sinceAnalysis < HOP_SAMPLES)
            return;
        // Analyze the newest window once; a backlog is dropped, not replayed.
        run.sinceAnalysis = run.sinceAnalysis - HOP_SAMPLES >= HOP_SAMPLES ? 0 : run.sinceAnalysis - HOP_SAMPLES;
        const at = Date.now();
        const midi = voiceMidi(run.detector, window, SAMPLE_RATE);
        let released = [];
        if (midi === null)
            run.filter.silence();
        else
            released = run.filter.push({time: at, midi});
        this._options.onFrames({at, voiced: midi !== null, samples: released.map(sample => ({t: sample.time, midi: Math.round(sample.midi * 100) / 100}))});
    }
}
