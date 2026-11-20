// Letter colors for the overlay line, and the border rings that keep each
// color readable on any background. Used by the shell extension's text
// layout and the settings page (the install script copies this file into it).

const WHITE = Object.freeze([1, 1, 1]);
const BLACK = Object.freeze([0, 0, 0]);
const HEX_PATTERN = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu;

/** Letter colors by setting value, as red, green and blue from 0 to 1. */
export const TEXT_COLORS = Object.freeze({
    'white': WHITE,
    'yellow': Object.freeze([1, 0.92, 0]),
    'orange': Object.freeze([1, 0.58, 0]),
    'red': Object.freeze([1, 0.23, 0.19]),
    'pink': Object.freeze([1, 0.43, 0.71]),
    'magenta': Object.freeze([1, 0.17, 0.84]),
    'purple': Object.freeze([0.71, 0.42, 1]),
    'blue': Object.freeze([0.24, 0.55, 1]),
    'cyan': Object.freeze([0, 0.9, 1]),
    'green': Object.freeze([0.19, 0.82, 0.35]),
    'black': BLACK,
});

/** Parses "#rrggbb" into [r, g, b] in 0..1, or null when invalid. */
export function parseHexColor(hex) {
    if (typeof hex !== 'string')
        return null;
    const match = HEX_PATTERN.exec(hex);
    if (!match)
        return null;
    return match.slice(1).map(part => parseInt(part, 16) / 255);
}

/**
 * Resolves the active text RGB from the named choice and optional custom hex.
 * When `customHex` is a valid "#rrggbb", it overrides the named preset.
 */
export function resolveTextColor(name, customHex = '') {
    if (customHex) {
        const parsed = parseHexColor(customHex);
        if (!parsed)
            throw new Error(`lyrics-overlay: invalid custom color "${customHex}"`);
        return parsed;
    }
    const preset = TEXT_COLORS[name];
    if (!preset)
        throw new Error(`lyrics-overlay: unknown text color "${name}"`);
    return preset;
}

/** Named preset closest in RGB space to an [r, g, b] color (0..1). */
export function nearestNamedColor(rgb) {
    let best = 'white';
    let bestDistance = Infinity;
    for (const [name, candidate] of Object.entries(TEXT_COLORS)) {
        const dr = rgb[0] - candidate[0];
        const dg = rgb[1] - candidate[1];
        const db = rgb[2] - candidate[2];
        const distance = dr * dr + dg * dg + db * db;
        if (distance < bestDistance) {
            bestDistance = distance;
            best = name;
        }
    }
    return best;
}

/**
 * Border ring colors for a letter color: the inner ring is whichever of
 * black and white contrasts more with the letters (WCAG contrast ratio),
 * the outer ring the other, so the line reads on any background.
 * When `customBorderHex` is provided, it becomes the inner ring and the
 * higher-contrast of black/white against it becomes the outer ring.
 */
export function ringColors(fill, customBorderHex = '') {
    const contrastInk = rgb => {
        const linear = channel => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
        const luminance = 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
        // Contrast with black, (L + 0.05) / 0.05, beats contrast with white,
        // 1.05 / (L + 0.05), exactly when (L + 0.05)^2 > 0.0525.
        return (luminance + 0.05) ** 2 > 0.0525 ? BLACK : WHITE;
    };
    if (customBorderHex) {
        const inner = parseHexColor(customBorderHex);
        if (!inner)
            throw new Error(`lyrics-overlay: invalid border color "${customBorderHex}"`);
        return {inner, outer: contrastInk(inner)};
    }
    const inner = contrastInk(fill);
    return {inner, outer: inner === BLACK ? WHITE : BLACK};
}

/** "#rrggbb" for a color, for swatches. */
export function hexColor(rgb) {
    return `#${rgb.map(channel => Math.round(channel * 255).toString(16).padStart(2, '0')).join('')}`;
}
