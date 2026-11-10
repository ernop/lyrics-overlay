// Sung-pitch detection: voice-wei's band-limited McLeod pitch method
// (pitch-detect-core.js) and its glitch holdback, unchanged in thresholds.

export const VOICE_MIN_MIDI = 38; // D2
export const VOICE_MAX_MIDI = 74; // D5
export const GLITCH_JUMP_MIDI = 5.5;
export const GLITCH_WINDOW_MS = 220;
export const GLITCH_CONFIRM_MS = 260;
export const GLITCH_CONFIRM_MIDI = 1.2;
export const GLITCH_CONFIRM_SAMPLES = 3;
export const TRACE_BREAK_MS = 250;

const MIN_RMS = 0.01;
const MPM_CLARITY_MIN = 0.80;
const MPM_PEAK_RATIO = 0.90;
const MPM_SUBHARMONIC_MARGIN = 0.015;
const MPM_IN_BAND_SUBHARMONIC_MARGIN = 0.05;
const DETECT_DECIMATE = 2;

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

export function midiToFreq(midi) {
    return 440 * 2 ** ((midi - 69) / 12);
}

export function freqToMidi(freq) {
    return 69 + 12 * Math.log2(freq / 440);
}

/** "A3" for the nearest semitone. */
export function noteName(midi) {
    const rounded = Math.round(midi);
    return `${NOTE_NAMES[((rounded % 12) + 12) % 12]}${Math.floor(rounded / 12) - 1}`;
}

export function rms(samples) {
    let sum = 0;
    for (let i = 0; i < samples.length; i++)
        sum += samples[i] * samples[i];
    return samples.length ? Math.sqrt(sum / samples.length) : 0;
}

export class PitchDetector {
    constructor() {
        this._signal = new Float32Array(0);
        this._nsdf = new Float32Array(0);
    }

    /** @returns {number} frequency in Hz, or -1 when no sung pitch */
    detect(buffer, sampleRate) {
        if (rms(buffer) < MIN_RMS)
            return -1;
        const rate = sampleRate / DETECT_DECIMATE;
        const len = Math.floor(buffer.length / DETECT_DECIMATE);
        if (this._signal.length < len)
            this._signal = new Float32Array(len);
        const signal = this._signal;
        for (let i = 0; i < len; i++)
            signal[i] = (buffer[2 * i] + buffer[2 * i + 1]) * 0.5;

        const tauStart = 2;
        const tauMin = Math.max(tauStart + 1, Math.floor(rate / midiToFreq(VOICE_MAX_MIDI)) - 2);
        const tauMax = Math.min(Math.floor(len / 2) - 1, Math.ceil(rate / midiToFreq(VOICE_MIN_MIDI)) + 2);
        if (tauMax <= tauMin)
            return -1;
        const window = len - tauMax;
        if (this._nsdf.length < tauMax + 2)
            this._nsdf = new Float32Array(tauMax + 2);
        const nsdf = this._nsdf;
        for (let tau = tauStart; tau <= tauMax; tau++) {
            let r = 0;
            let m = 0;
            for (let i = 0; i < window; i++) {
                const a = signal[i];
                const b = signal[i + tau];
                r += a * b;
                m += a * a + b * b;
            }
            nsdf[tau] = m > 0 ? 2 * r / m : 0;
        }

        const peaks = [];
        let tau = tauStart;
        while (tau <= tauMax && nsdf[tau] > 0)
            tau++;
        while (tau <= tauMax) {
            while (tau <= tauMax && nsdf[tau] <= 0)
                tau++;
            let best = -1;
            while (tau <= tauMax && nsdf[tau] > 0) {
                if (best < 0 || nsdf[tau] > nsdf[best])
                    best = tau;
                tau++;
            }
            if (best > 0)
                peaks.push(best);
        }
        if (!peaks.length)
            return -1;

        const peakValue = peak => {
            if (peak <= tauStart || peak >= tauMax)
                return nsdf[peak];
            const left = nsdf[peak - 1];
            const mid = nsdf[peak];
            const right = nsdf[peak + 1];
            const denom = 2 * (2 * mid - left - right);
            if (denom === 0)
                return mid;
            const shift = (right - left) / denom;
            return mid + (right - left) * shift / 4;
        };

        let tallest = 0;
        for (const peak of peaks)
            tallest = Math.max(tallest, peakValue(peak));
        if (tallest < MPM_CLARITY_MIN)
            return -1;

        let chosen = peaks[0];
        for (const peak of peaks) {
            if (peakValue(peak) >= tallest * MPM_PEAK_RATIO) {
                chosen = peak;
                break;
            }
        }
        for (let pass = 0; pass < 3; pass++) {
            let improved = false;
            const margin = chosen < tauMin ? MPM_SUBHARMONIC_MARGIN : MPM_IN_BAND_SUBHARMONIC_MARGIN;
            for (const multiple of [2, 1.5, 3]) {
                const target = Math.round(chosen * multiple);
                if (target > tauMax)
                    continue;
                let candidate = -1;
                for (const peak of peaks) {
                    if (Math.abs(peak - target) <= 3 && (candidate < 0 || peakValue(peak) > peakValue(candidate)))
                        candidate = peak;
                }
                if (candidate > 0 && peakValue(candidate) > peakValue(chosen) + margin) {
                    chosen = candidate;
                    improved = true;
                    break;
                }
            }
            if (!improved)
                break;
        }
        if (chosen < tauMin)
            return -1;

        let period = chosen;
        if (chosen > tauStart && chosen < tauMax) {
            const left = nsdf[chosen - 1];
            const mid = nsdf[chosen];
            const right = nsdf[chosen + 1];
            const denom = 2 * (2 * mid - left - right);
            if (denom !== 0)
                period = chosen + (right - left) / denom;
        }
        return rate / period;
    }
}

/** Sung midi for a frame, or null for silence, no pitch or out of band. */
export function voiceMidi(detector, buffer, sampleRate) {
    const freq = detector.detect(buffer, sampleRate);
    if (freq <= 0)
        return null;
    const midi = freqToMidi(freq);
    return midi < VOICE_MIN_MIDI || midi > VOICE_MAX_MIDI ? null : midi;
}

/**
 * voice-wei's glitch holdback: a jump larger than GLITCH_JUMP_MIDI within
 * GLITCH_WINDOW_MS waits until GLITCH_CONFIRM_SAMPLES samples agree at the
 * new level, then all of them are released together.
 */
export class GlitchFilter {
    constructor() {
        this.reset();
    }

    reset() {
        this._last = null;
        this._pending = [];
    }

    /** Silence ends any pending jump. */
    silence() {
        this._pending = [];
    }

    /** @returns {Array<{time: number, midi: number}>} samples released now */
    push(sample) {
        if (!this._last) {
            this._last = sample;
            return [sample];
        }
        const elapsed = sample.time - this._last.time;
        const jump = Math.abs(sample.midi - this._last.midi);
        if (elapsed <= GLITCH_WINDOW_MS && jump > GLITCH_JUMP_MIDI) {
            const lastPending = this._pending[this._pending.length - 1];
            const continues = lastPending &&
                sample.time - this._pending[0].time <= GLITCH_CONFIRM_MS &&
                Math.abs(sample.midi - lastPending.midi) <= GLITCH_CONFIRM_MIDI;
            if (!continues) {
                this._pending = [sample];
                return [];
            }
            this._pending.push(sample);
            if (this._pending.length < GLITCH_CONFIRM_SAMPLES)
                return [];
            const released = this._pending;
            this._pending = [];
            this._last = sample;
            return released;
        }
        this._pending = [];
        this._last = sample;
        return [sample];
    }
}
