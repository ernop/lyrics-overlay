// Overlay box geometry and text fitting, independent of the shell.
// Boxes are stage pixels {x, y, width, height}; saved geometry is the box
// center and size as fractions of its monitor's work area, so it survives
// resolution and scale changes.

export const MIN_BOX_WIDTH = 160;
export const MIN_BOX_HEIGHT = 48;

export const FONT_SIZE_MIN = 16;
export const FONT_SIZE_MAX = 256;
export const FONT_SIZE_LABELS = Object.freeze([16, 32, 64, 128, 256]);
export const FONT_SIZE_NOTCHES = Object.freeze([16, 23, 32, 45, 64, 91, 128, 181, 256]);

/** Slider position 0..1 to font size (logarithmic: equal travel, equal ratio). */
export function fontSizeAt(position) {
    const p = Math.min(1, Math.max(0, position));
    return FONT_SIZE_MIN * (FONT_SIZE_MAX / FONT_SIZE_MIN) ** p;
}

export function positionOfFontSize(size) {
    const clamped = Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, size));
    return Math.log(clamped / FONT_SIZE_MIN) / Math.log(FONT_SIZE_MAX / FONT_SIZE_MIN);
}

export function clampFontSize(size) {
    return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, size));
}

function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
}

export function clampBox(box, area) {
    const width = clamp(box.width, Math.min(MIN_BOX_WIDTH, area.width), area.width);
    const height = clamp(box.height, Math.min(MIN_BOX_HEIGHT, area.height), area.height);
    const centerX = box.x + box.width / 2;
    const centerY = box.y + box.height / 2;
    return {
        x: clamp(centerX - width / 2, area.x, area.x + area.width - width),
        y: clamp(centerY - height / 2, area.y, area.y + area.height - height),
        width,
        height,
    };
}

export function boxFromGeometry(geometry, area) {
    const width = geometry.width * area.width;
    const height = geometry.height * area.height;
    return clampBox({
        x: area.x + geometry.cx * area.width - width / 2,
        y: area.y + geometry.cy * area.height - height / 2,
        width,
        height,
    }, area);
}

export function geometryFromBox(box, area) {
    return {
        cx: (box.x + box.width / 2 - area.x) / area.width,
        cy: (box.y + box.height / 2 - area.y) / area.height,
        width: box.width / area.width,
        height: box.height / area.height,
    };
}

export function movedBox(start, dx, dy, area) {
    return clampBox({...start, x: start.x + dx, y: start.y + dy}, area);
}

/**
 * Free resize about the box center: pulling away from the center on
 * either axis grows that axis, pulling toward it shrinks it. Width and
 * height change independently; there is no aspect lock.
 */
export function resizedBox(start, press, pointer, area) {
    const centerX = start.x + start.width / 2;
    const centerY = start.y + start.height / 2;
    const signX = press.x >= centerX ? 1 : -1;
    const signY = press.y >= centerY ? 1 : -1;
    const width = start.width + 2 * signX * (pointer.x - press.x);
    const height = start.height + 2 * signY * (pointer.y - press.y);
    return clampBox({x: centerX - width / 2, y: centerY - height / 2, width, height}, area);
}

/**
 * Largest size in [minimum, wanted] for which fits(size) holds, to within
 * half a pixel; minimum when nothing fits.
 */
export function fitFontSize(wanted, minimum, fits) {
    if (fits(wanted))
        return wanted;
    let low = minimum;
    let high = wanted;
    while (high - low > 0.5) {
        const mid = (low + high) / 2;
        if (fits(mid))
            low = mid;
        else
            high = mid;
    }
    return low;
}

/**
 * Narrowest wrap width that keeps the line count of the widest wrap, so a
 * two-line lyric splits evenly instead of leaving one word on line two.
 */
export function balancedWrapWidth(maxWidth, lineCountAt) {
    const lines = lineCountAt(maxWidth);
    if (lines <= 1)
        return maxWidth;
    let low = 1;
    let high = maxWidth;
    while (high - low > 2) {
        const mid = (low + high) / 2;
        if (lineCountAt(mid) <= lines)
            high = mid;
        else
            low = mid;
    }
    return high;
}
