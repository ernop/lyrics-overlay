// Microphone pitch for the pitch panel. Runs only while the shell asks for
// it: pw-record reading the chosen microphone, through a private PipeWire
// echo canceller (echo-cancel.js) while that setting is on, analyzed
// pitch-rate times a second with voice-wei's detector. Audio never leaves
// memory.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {GlitchFilter, PitchDetector, voiceMidi} from '../shared/pitch-mpm.js';
import {echoCancelConfig, VOICE_NODE} from './echo-cancel.js';
import {listMicrophones} from './microphones.js';

const SAMPLE_RATE = 48000;
const WINDOW_SAMPLES = 2048;
// A stall delivers a backlog; only its newest window is analyzed.
const BACKLOG_SAMPLES = SAMPLE_RATE / 5;
// A brief pause keeps the microphone open instead of toggling it.
const LINGER_MS = 10_000;
// "Fit to my singing" spans what was sung this far back, without the
// highest and lowest RECENT_TRIM of it (stray detections).
const RECENT_MS = 30_000;
const RECENT_TRIM = 0.03;
const RESTART_SETTINGS = new Set(['pitch-microphone', 'pitch-echo-cancel']);

function isCancelled(error) {
    return error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

function output(argv, cancellable) {
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

export class PitchCapture {
    /**
     * @param {{settings: import('./settings-store.js').SettingsStore, runtimeDir: string,
     *          onFrames: (frames: object) => void,
     *          onStatus: (status: {capturing: boolean, error: string, microphone: string}) => void,
     *          log: (message: string) => void}} options
     */
    constructor(options) {
        for (const name of ['settings', 'runtimeDir', 'onFrames', 'onStatus', 'log']) {
            if (!options[name])
                throw new Error(`PitchCapture needs ${name}`);
        }
        this._options = options;
        this._running = null;
        this._lingerId = 0;
        this._hop = this._hopSamples();
        /** @type {Array<{t: number, midi: number}>} */
        this._recent = [];
        options.settings.onChanged(name => {
            if (name === 'pitch-rate')
                this._hop = this._hopSamples();
            else if (RESTART_SETTINGS.has(name) && this._running)
                this._restart();
        });
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

    /** The audio inputs PipeWire offers, for the settings page. */
    async microphones() {
        return listMicrophones(JSON.parse(await output(['pw-dump'], null)));
    }

    /** @returns {{low: number, high: number}|null} the range of the last RECENT_MS of singing */
    recentRange() {
        const since = Date.now() - RECENT_MS;
        const notes = this._recent.filter(sample => sample.t >= since).map(sample => sample.midi).sort((a, b) => a - b);
        if (!notes.length)
            return null;
        const trim = Math.floor(notes.length * RECENT_TRIM);
        return {low: notes[trim], high: notes[notes.length - 1 - trim]};
    }

    _hopSamples() {
        return Math.round(SAMPLE_RATE / this._options.settings.get('pitch-rate'));
    }

    _restart() {
        this._stop('');
        this._start();
    }

    _start() {
        const settings = this._options.settings;
        const microphone = settings.get('pitch-microphone');
        const echoCancel = settings.get('pitch-echo-cancel');
        const run = {
            cancellable: new Gio.Cancellable(),
            ring: new Float32Array(WINDOW_SAMPLES),
            ringAt: 0,
            window: new Float32Array(WINDOW_SAMPLES),
            sinceAnalysis: 0,
            voiced: false,
            leftover: new Uint8Array(0),
            detector: new PitchDetector(),
            filter: new GlitchFilter(),
            processes: [],
        };
        this._running = run;
        if (echoCancel) {
            const configPath = GLib.build_filenamev([this._options.runtimeDir, 'echo-cancel.conf']);
            GLib.file_set_contents(configPath, echoCancelConfig({microphone}));
            run.processes.push({process: Gio.Subprocess.new(['pipewire', '-c', configPath], Gio.SubprocessFlags.NONE), name: 'echo canceller'});
        }
        const target = echoCancel ? VOICE_NODE : microphone;
        const recorder = Gio.Subprocess.new([
            'pw-record', '--raw', ...target ? ['--target', target] : [], '--rate', String(SAMPLE_RATE), '--channels', '1',
            '--format', 'f32', '--latency', '10ms',
            '-P', `{ node.name = "lyrics-overlay.voice-reader" node.dont-reconnect = true${target ? ' node.dont-fallback = true' : ''} }`,
            '-',
        ], Gio.SubprocessFlags.STDOUT_PIPE);
        run.processes.push({process: recorder, name: 'pw-record'});
        for (const {process, name} of run.processes) {
            process.wait_async(run.cancellable, (_process, result) => {
                try {
                    process.wait_finish(result);
                } catch (error) {
                    if (isCancelled(error))
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
        this._options.log(`microphone on (${microphone || 'default input'}, echo cancelling ${echoCancel ? 'on' : 'off'})`);
        this._options.onStatus({capturing: true, error: '', microphone: ''});
        this._nameMicrophone(run, microphone);
    }

    async _nameMicrophone(run, chosen) {
        let found;
        try {
            const {microphones, defaultName} = listMicrophones(JSON.parse(await output(['pw-dump'], run.cancellable)));
            found = microphones.find(microphone => microphone.name === (chosen || defaultName));
        } catch (error) {
            if (isCancelled(error))
                return;
            this._options.log(`could not name the microphone: ${error.message}`);
            return;
        }
        if (this._running !== run)
            return;
        if (!found) {
            this._stop(chosen ? 'the chosen microphone is not connected' : 'there is no microphone');
            return;
        }
        this._options.log(`microphone is ${found.description}`);
        this._options.onStatus({capturing: true, error: '', microphone: found.description});
    }

    _stop(error) {
        const run = this._running;
        if (!run)
            return;
        this._running = null;
        run.cancellable.cancel();
        for (const {process} of run.processes)
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
                if (isCancelled(error))
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
        let samples = new Float32Array(joined.buffer, 0, count);
        const arrival = Date.now();
        if (samples.length > BACKLOG_SAMPLES) {
            samples = samples.subarray(samples.length - WINDOW_SAMPLES);
            run.sinceAnalysis = this._hop - WINDOW_SAMPLES;
        }

        const released = [];
        let analyzed = false;
        for (let i = 0; i < samples.length; i++) {
            run.ring[run.ringAt] = samples[i];
            run.ringAt = (run.ringAt + 1) % WINDOW_SAMPLES;
            if (++run.sinceAnalysis < this._hop)
                continue;
            run.sinceAnalysis = 0;
            analyzed = true;
            run.window.set(run.ring.subarray(run.ringAt));
            run.window.set(run.ring.subarray(0, run.ringAt), WINDOW_SAMPLES - run.ringAt);
            const midi = voiceMidi(run.detector, run.window, SAMPLE_RATE);
            run.voiced = midi !== null;
            if (midi === null)
                run.filter.silence();
            else
                released.push(...run.filter.push({time: arrival - (samples.length - 1 - i) * 1000 / SAMPLE_RATE, midi}));
        }
        if (!analyzed)
            return;
        const frames = released.map(sample => ({t: Math.round(sample.time), midi: Math.round(sample.midi * 100) / 100}));
        this._remember(frames, arrival);
        this._options.onFrames({at: arrival, voiced: run.voiced, samples: frames});
    }

    _remember(frames, now) {
        this._recent.push(...frames);
        const oldest = now - RECENT_MS;
        const firstKept = this._recent.findIndex(sample => sample.t >= oldest);
        this._recent.splice(0, firstKept < 0 ? this._recent.length : firstKept);
    }
}
