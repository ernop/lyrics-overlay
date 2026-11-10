// Letter colors for the overlay line, and the border rings that keep each
// color readable on any background. Used by the shell extension's text
// layout and menu (the install script copies this file into it).

const WHITE = Object.freeze([1, 1, 1]);
const BLACK = Object.freeze([0, 0, 0]);

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

/**
 * Border ring colors for a letter color: the inner ring is whichever of
 * black and white contrasts more with the letters (WCAG contrast ratio),
 * the outer ring the other, so the line reads on any background.
 */
export function ringColors(fill) {
    const linear = channel => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
    const luminance = 0.2126 * linear(fill[0]) + 0.7152 * linear(fill[1]) + 0.0722 * linear(fill[2]);
    // Contrast with black, (L + 0.05) / 0.05, beats contrast with white,
    // 1.05 / (L + 0.05), exactly when (L + 0.05)^2 > 0.0525.
    const inner = (luminance + 0.05) ** 2 > 0.0525 ? BLACK : WHITE;
    return {inner, outer: inner === BLACK ? WHITE : BLACK};
}

/** "#rrggbb" for a color, for menu swatches. */
export function hexColor(rgb) {
    return `#${rgb.map(channel => Math.round(channel * 255).toString(16).padStart(2, '0')).join('')}`;
}
