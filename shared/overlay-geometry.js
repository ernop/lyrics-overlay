// Overlay box geometry and text fitting, independent of the shell.
// Boxes are stage pixels {x, y, width, height}; saved geometry is the box
// center and size as fractions of its monitor's work area, so it survives
// resolution and scale changes. The pitch panel is a box too: separate,
// or docked against a side of the lyric box.

export const MIN_BOX_WIDTH = 160;
export const MIN_BOX_HEIGHT = 48;
export const DOCK_GAP = 4;

export const FONT_SIZE_MIN = 16;
export const FONT_SIZE_MAX = 256;

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
 * Resize by dragging edges: the named edges follow the pointer, the
 * opposite ones stay put, within the work area and down to the minimum.
 * @param {{left?: boolean, right?: boolean, top?: boolean, bottom?: boolean}} edges
 */
export function edgeResizedBox(start, edges, dx, dy, area) {
    let {x, y, width, height} = start;
    if (edges.left) {
        const right = x + width;
        x = clamp(x + dx, area.x, right - MIN_BOX_WIDTH);
        width = right - x;
    } else if (edges.right) {
        width = clamp(width + dx, MIN_BOX_WIDTH, area.x + area.width - x);
    }
    if (edges.top) {
        const bottom = y + height;
        y = clamp(y + dy, area.y, bottom - MIN_BOX_HEIGHT);
        height = bottom - y;
    } else if (edges.bottom) {
        height = clamp(height + dy, MIN_BOX_HEIGHT, area.y + area.height - y);
    }
    return {x, y, width, height};
}

/** The docked panel's edge away from the lyric: the one that resizes it. */
export const OUTER_EDGE = Object.freeze({below: 'bottom', above: 'top', left: 'left', right: 'right'});

/**
 * A panel docked against a side of the lyric box: as long as that side,
 * `thickness` pixels across it, but no thicker than the room left to the
 * work area's edge (down to the minimum, then it overlaps the box).
 * @param {'below'|'above'|'left'|'right'} dock
 */
export function dockedPanelBox(lyric, dock, thickness, area) {
    const fit = (wanted, room, minimum) => Math.max(minimum, Math.min(wanted, room));
    switch (dock) {
    case 'below': {
        const height = fit(thickness, area.y + area.height - (lyric.y + lyric.height + DOCK_GAP), MIN_BOX_HEIGHT);
        return clampBox({x: lyric.x, y: lyric.y + lyric.height + DOCK_GAP, width: lyric.width, height}, area);
    }
    case 'above': {
        const height = fit(thickness, lyric.y - DOCK_GAP - area.y, MIN_BOX_HEIGHT);
        return clampBox({x: lyric.x, y: lyric.y - DOCK_GAP - height, width: lyric.width, height}, area);
    }
    case 'left': {
        const width = fit(thickness, lyric.x - DOCK_GAP - area.x, MIN_BOX_WIDTH);
        return clampBox({x: lyric.x - DOCK_GAP - width, y: lyric.y, width, height: lyric.height}, area);
    }
    case 'right': {
        const width = fit(thickness, area.x + area.width - (lyric.x + lyric.width + DOCK_GAP), MIN_BOX_WIDTH);
        return clampBox({x: lyric.x + lyric.width + DOCK_GAP, y: lyric.y, width, height: lyric.height}, area);
    }
    }
    throw new Error(`lyrics-overlay: unknown dock "${dock}"`);
}

/**
 * The side of the lyric box a dragged panel is dropped against, or null:
 * its facing edge within `distance` of that side, and the two overlapping
 * along it. The nearest side wins.
 * @returns {'below'|'above'|'left'|'right'|null}
 */
export function snappedDock(panel, lyric, distance) {
    const overlaps = (start, length, otherStart, otherLength) =>
        Math.min(start + length, otherStart + otherLength) - Math.max(start, otherStart) > 0;
    const gaps = [];
    if (overlaps(panel.x, panel.width, lyric.x, lyric.width)) {
        gaps.push(['below', Math.abs(panel.y - (lyric.y + lyric.height + DOCK_GAP))]);
        gaps.push(['above', Math.abs(panel.y + panel.height + DOCK_GAP - lyric.y)]);
    }
    if (overlaps(panel.y, panel.height, lyric.y, lyric.height)) {
        gaps.push(['right', Math.abs(panel.x - (lyric.x + lyric.width + DOCK_GAP))]);
        gaps.push(['left', Math.abs(panel.x + panel.width + DOCK_GAP - lyric.x)]);
    }
    const near = gaps.filter(([, gap]) => gap <= distance).sort((a, b) => a[1] - b[1]);
    return near.length ? near[0][0] : null;
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
