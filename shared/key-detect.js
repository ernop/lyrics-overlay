// The key a song is in, from its sound: each analysis window's spectrum is
// folded into a chroma vector (energy per pitch class), the vectors are
// summed over the song, and the sum is matched against the Krumhansl-
// Kessler major and minor key profiles. Free of GNOME code so it runs under
// both gjs and node (tests).

export const KEY_SAMPLE_RATE = 11025;
// 0.74 s at KEY_SAMPLE_RATE: fine enough to tell semitones apart at C2.
export const KEY_WINDOW = 8192;
const MIN_HZ = 65;
const MAX_HZ = 2100;
// Windows quieter than this (RMS) are silence and count for nothing.
const MIN_RMS = 0.003;

const MAJOR_PROFILE = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR_PROFILE = [6.33, 2.68, 3.52, 5.38, 2.60, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/** In-place radix-2 FFT; re and im have the same power-of-two length. */
export function fft(re, im) {
    const n = re.length;
    for (let i = 1, j = 0; i < n; i++) {
        let bit = n >> 1;
        for (; j & bit; bit >>= 1)
            j ^= bit;
        j ^= bit;
        if (i < j) {
            [re[i], re[j]] = [re[j], re[i]];
            [im[i], im[j]] = [im[j], im[i]];
        }
    }
    for (let size = 2; size <= n; size <<= 1) {
        const step = -2 * Math.PI / size;
        for (let start = 0; start < n; start += size) {
            for (let k = 0; k < size / 2; k++) {
                const cos = Math.cos(step * k);
                const sin = Math.sin(step * k);
                const a = start + k;
                const b = a + size / 2;
                const tre = re[b] * cos - im[b] * sin;
                const tim = re[b] * sin + im[b] * cos;
                re[b] = re[a] - tre;
                im[b] = im[a] - tim;
                re[a] += tre;
                im[a] += tim;
            }
        }
    }
}

export class ChromaAnalyzer {
    constructor(sampleRate = KEY_SAMPLE_RATE, size = KEY_WINDOW) {
        this._size = size;
        this._hann = Float64Array.from({length: size}, (_, i) => 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (size - 1)));
        this._re = new Float64Array(size);
        this._im = new Float64Array(size);
        // Each bin in range feeds its nearest pitch class, less the farther
        // it lies from that semitone's center.
        this._bins = [];
        for (let bin = Math.ceil(MIN_HZ * size / sampleRate); bin <= Math.floor(MAX_HZ * size / sampleRate); bin++) {
            const midi = 69 + 12 * Math.log2(bin * sampleRate / size / 440);
            const nearest = Math.round(midi);
            this._bins.push({bin, pitchClass: ((nearest % 12) + 12) % 12, weight: Math.cos(Math.PI * (midi - nearest)) ** 2});
        }
    }

    /**
     * @param {Float32Array|Float64Array} samples one window of `size` samples
     * @returns {Float64Array|null} chroma summing to 1, or null for silence
     */
    chroma(samples) {
        if (samples.length !== this._size)
            throw new Error(`chroma needs ${this._size} samples, got ${samples.length}`);
        let power = 0;
        for (let i = 0; i < this._size; i++) {
            power += samples[i] * samples[i];
            this._re[i] = samples[i] * this._hann[i];
            this._im[i] = 0;
        }
        if (Math.sqrt(power / this._size) < MIN_RMS)
            return null;
        fft(this._re, this._im);
        const chroma = new Float64Array(12);
        for (const {bin, pitchClass, weight} of this._bins)
            chroma[pitchClass] += weight * Math.hypot(this._re[bin], this._im[bin]);
        const total = chroma.reduce((sum, value) => sum + value, 0);
        if (total <= 0)
            return null;
        return chroma.map(value => value / total);
    }
}

function correlation(chroma, profile, root) {
    let meanChroma = 0;
    let meanProfile = 0;
    for (let i = 0; i < 12; i++) {
        meanChroma += chroma[i] / 12;
        meanProfile += profile[i] / 12;
    }
    let product = 0;
    let chromaSquares = 0;
    let profileSquares = 0;
    for (let i = 0; i < 12; i++) {
        const c = chroma[(i + root) % 12] - meanChroma;
        const p = profile[i] - meanProfile;
        product += c * p;
        chromaSquares += c * c;
        profileSquares += p * p;
    }
    return chromaSquares > 0 ? product / Math.sqrt(chromaSquares * profileSquares) : 0;
}

/**
 * The best-matching key, and by how much it beats the best key with other
 * notes (a relative major or minor has the same notes, so it is no rival).
 * @param {ArrayLike<number>} chroma
 * @returns {{root: number, mode: 'major'|'minor', margin: number}}
 */
export function detectKey(chroma) {
    const keys = [];
    for (let root = 0; root < 12; root++) {
        keys.push({root, mode: 'major', score: correlation(chroma, MAJOR_PROFILE, root)});
        keys.push({root, mode: 'minor', score: correlation(chroma, MINOR_PROFILE, root)});
    }
    keys.sort((a, b) => b.score - a.score);
    const [best] = keys;
    const relativeRoot = best.mode === 'major' ? (best.root + 9) % 12 : (best.root + 3) % 12;
    const rival = keys.find(key => key !== best && !(key.root === relativeRoot && key.mode !== best.mode));
    return {root: best.root, mode: best.mode, margin: best.score - rival.score};
}
