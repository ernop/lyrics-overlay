// Scales the pitch panel can stand out, and how notes are spelled in them:
// with flats in flat keys (B♭, not A♯, in F major), otherwise sharps. Free
// of GNOME code so the service, the settings page and the shell share it.

/** Scale types by their pitch-scale-type setting value, as semitones above the root. */
export const SCALES = Object.freeze({
    'major': {name: 'major', steps: [0, 2, 4, 5, 7, 9, 11], parentMajor: 0},
    'minor': {name: 'minor', steps: [0, 2, 3, 5, 7, 8, 10], parentMajor: 3},
    'harmonic-minor': {name: 'harmonic minor', steps: [0, 2, 3, 5, 7, 8, 11], parentMajor: 3},
    'melodic-minor': {name: 'melodic minor', steps: [0, 2, 3, 5, 7, 9, 11], parentMajor: 3},
    'dorian': {name: 'dorian', steps: [0, 2, 3, 5, 7, 9, 10], parentMajor: 10},
    'phrygian': {name: 'phrygian', steps: [0, 1, 3, 5, 7, 8, 10], parentMajor: 8},
    'lydian': {name: 'lydian', steps: [0, 2, 4, 6, 7, 9, 11], parentMajor: 7},
    'mixolydian': {name: 'mixolydian', steps: [0, 2, 4, 5, 7, 9, 10], parentMajor: 5},
    'major-pentatonic': {name: 'major pentatonic', steps: [0, 2, 4, 7, 9], parentMajor: 0},
    'minor-pentatonic': {name: 'minor pentatonic', steps: [0, 3, 5, 7, 10], parentMajor: 3},
    'blues': {name: 'blues', steps: [0, 3, 5, 6, 7, 10], parentMajor: 3},
});

const SHARP_NAMES = ['C', 'C♯', 'D', 'D♯', 'E', 'F', 'F♯', 'G', 'G♯', 'A', 'A♯', 'B'];
const FLAT_NAMES = ['C', 'D♭', 'D', 'E♭', 'E', 'F', 'G♭', 'G', 'A♭', 'A', 'B♭', 'B'];
// Major keys written with flats: F, B♭, E♭, A♭, D♭, G♭.
const FLAT_MAJOR_ROOTS = new Set([5, 10, 3, 8, 1, 6]);

function scaleType(type) {
    const scale = SCALES[type];
    if (!scale)
        throw new Error(`no scale type ${JSON.stringify(type)}`);
    return scale;
}

/**
 * Names for the twelve pitch classes as spelled in a key; sharps when there is no key.
 * @param {{root: number, type: string}|null} key
 */
export function pitchClassNames(key) {
    if (!key)
        return SHARP_NAMES;
    const parent = (key.root + scaleType(key.type).parentMajor) % 12;
    return FLAT_MAJOR_ROOTS.has(parent) ? FLAT_NAMES : SHARP_NAMES;
}

/** "G4" for MIDI 67: the pitch class as spelled in the key, and the octave. */
export function noteLabel(midi, names) {
    return `${names[((midi % 12) + 12) % 12]}${Math.floor(midi / 12) - 1}`;
}

/** "B♭ major" */
export function keyName(key) {
    return `${pitchClassNames(key)[key.root]} ${scaleType(key.type).name}`;
}

/** @returns {Set<number>} the key's pitch classes */
export function scalePitchClasses(key) {
    return new Set(scaleType(key.type).steps.map(step => (key.root + step) % 12));
}
