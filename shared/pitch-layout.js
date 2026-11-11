// What the pitch panel shows, independent of the shell: the trace's clock,
// which note lines carry their names, and the note the readout holds.
// Free of GNOME code so node tests cover it.

// With pitch-time-in-silence off, the trace stops this far into a pause.
export const PAUSE_SCROLL_MS = 400;
// The readout keeps the last note through gaps up to this long (consonants,
// breaths), so it does not blink while a phrase is sung.
export const READOUT_HOLD_MS = 1500;
// The readout moves to another note only once the voice is this far past
// the boundary between notes, so a voice on a boundary does not flicker.
const READOUT_HYSTERESIS = 0.15;

/**
 * Trace time. Real time while silences scroll; otherwise a clock that
 * stops PAUSE_SCROLL_MS into a pause and resumes with the voice, so the
 * trace keeps only sung time.
 */
export class TraceClock {
    constructor(scrollsInSilence) {
        this._scrolls = scrollsInSilence;
        this._lastAt = null;
        this._lastVoicedAt = null;
        this.now = 0;
        // Real time minus trace time.
        this._behind = 0;
    }

    /** Moves the clock to a frame batch's time; returns the trace time. */
    advance(at, voiced) {
        if (this._lastAt === null) {
            this._lastAt = at;
            this.now = at;
        }
        const elapsed = Math.max(0, at - this._lastAt);
        this._lastAt = at;
        if (voiced)
            this._lastVoicedAt = at;
        if (this._scrolls || (this._lastVoicedAt !== null && at - this._lastVoicedAt <= PAUSE_SCROLL_MS))
            this.now += elapsed;
        this._behind = at - this.now;
        return this.now;
    }

    /** A sample's real time on the trace's clock. */
    traceTime(realTime) {
        return realTime - this._behind;
    }
}

/**
 * The note lines across [low, high], marked as in the scale and as its root.
 * @param {Set<number>|null} scale pitch classes, or null for no scale
 * @param {number|null} root
 */
export function noteLines(low, high, scale, root) {
    const lines = [];
    for (let midi = Math.ceil(low); midi <= Math.floor(high); midi++) {
        const pitchClass = ((midi % 12) + 12) % 12;
        lines.push({midi, inScale: scale ? scale.has(pitchClass) : false, root: root === pitchClass, c: pitchClass === 0});
    }
    return lines;
}

/**
 * The lines that carry their names. The pitch-labels setting picks the
 * candidates; they are placed most important first (the root, or C without
 * a scale; then scale notes; then the rest), and a name that would overlap
 * one already placed is left off.
 * @param {Array<{midi: number, y: number, inScale: boolean, root: boolean, c: boolean}>} lines
 * @param {'all'|'scale'|'c'|'none'} mode
 * @param {number} labelHeight
 * @param {boolean} hasScale
 * @returns {Set<number>} the MIDI notes to name
 */
export function labeledLines(lines, mode, labelHeight, hasScale) {
    const anchor = line => hasScale ? line.root : line.c;
    const wanted = {
        all: () => true,
        scale: line => hasScale ? line.inScale : line.c,
        c: line => line.c,
        none: () => false,
    }[mode];
    if (!wanted)
        throw new Error(`unknown note label setting "${mode}"`);
    const rank = line => anchor(line) ? 0 : line.inScale ? 1 : 2;
    const ordered = lines.filter(wanted).sort((a, b) => rank(a) - rank(b) || a.midi - b.midi);
    const placed = [];
    const named = new Set();
    for (const line of ordered) {
        if (placed.some(y => Math.abs(y - line.y) < labelHeight))
            continue;
        placed.push(line.y);
        named.add(line.midi);
    }
    return named;
}

/** The note the readout shows: held through short gaps, moved only past a boundary. */
export class ReadoutNote {
    constructor() {
        this._midi = null;
        this._heardAt = -Infinity;
        this.cents = 0;
    }

    /** @param {{t: number, midi: number}} sample a voiced sample */
    hear(sample) {
        if (this._midi === null || Math.abs(sample.midi - this._midi) > 0.5 + READOUT_HYSTERESIS)
            this._midi = Math.round(sample.midi);
        this._heardAt = sample.t;
        this.cents = Math.round((sample.midi - this._midi) * 100);
    }

    /** @returns {number|null} the held note at time now, or null once the voice has been gone long enough */
    at(now) {
        return this._midi !== null && now - this._heardAt <= READOUT_HOLD_MS ? this._midi : null;
    }

    clear() {
        this._midi = null;
        this._heardAt = -Infinity;
    }
}
