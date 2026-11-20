// Overlay box geometry, proportional border specifications, and balanced
// wrapping, independent of the shell. Boxes are stage pixels
// {x, y, width, height}; saved geometry is the box center and size as
// fractions of its monitor's work area, so it survives resolution and scale
// changes. The pitch panel is a box too: separate, or docked against a side
// of the lyric box.

export const MIN_BOX_WIDTH = 160;
export const MIN_BOX_HEIGHT = 48;
export const DOCK_GAP = 4;

export const MIN_GEOMETRY_WIDTH = 0.05;
export const MIN_GEOMETRY_HEIGHT = 0.02;

export const FONT_SIZE_MIN = 16;
export const FONT_SIZE_MAX = 256;

/** Named placement presets for the lyric box, as monitor work-area fractions. */
export const PLACEMENT_PRESETS = Object.freeze([
    Object.freeze({id: 'bottom-center', label: 'Bottom', box: Object.freeze({cx: 0.5, cy: 0.75, width: 0.6, height: 0.14})}),
    Object.freeze({id: 'bottom-bar', label: 'Wide', box: Object.freeze({cx: 0.5, cy: 0.9, width: 0.88, height: 0.14})}),
    Object.freeze({id: 'bottom-left', label: 'Lower left', box: Object.freeze({cx: 0.24, cy: 0.88, width: 0.44, height: 0.14})}),
    Object.freeze({id: 'bottom-right', label: 'Lower right', box: Object.freeze({cx: 0.76, cy: 0.88, width: 0.44, height: 0.14})}),
    Object.freeze({id: 'center', label: 'Center', box: Object.freeze({cx: 0.5, cy: 0.5, width: 0.7, height: 0.18})}),
    Object.freeze({id: 'top-center', label: 'Top', box: Object.freeze({cx: 0.5, cy: 0.12, width: 0.64, height: 0.14})}),
]);

export function clampFontSize(size) {
    return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, size));
}

function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
}

/** Clamps fractional box geometry {cx, cy, width, height} cleanly inside [0, 1]. */
export function clampGeometry(geometry) {
    const width = clamp(geometry.width, MIN_GEOMETRY_WIDTH, 1);
    const height = clamp(geometry.height, MIN_GEOMETRY_HEIGHT, 1);
    return {
        cx: clamp(geometry.cx, width / 2, 1 - width / 2),
        cy: clamp(geometry.cy, height / 2, 1 - height / 2),
        width,
        height,
    };
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
 * Resize by dragging edges or corners: the named edges follow the pointer,
 * the opposite ones stay anchored, within the work area and down to the
 * minimum size.
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

/**
 * Automatic vertical anchor for wrapped lyrics: bottom-placed lyrics (or
 * lyrics with a pitch panel docked below) anchor at the bottom and expand
 * upward so the reading baseline stays steady and clear of the panel;
 * top-placed lyrics anchor at the top and expand downward; middle-placed
 * lyrics stay centered.
 * @param {number} cy fractional vertical center in [0, 1]
 * @param {string} [pitchDock]
 * @param {boolean} [pitchEnabled]
 * @returns {'top'|'center'|'bottom'}
 */
export function verticalAnchorFor(cy, pitchDock = 'below', pitchEnabled = false) {
    if (pitchEnabled && pitchDock === 'below')
        return 'bottom';
    if (pitchEnabled && pitchDock === 'above')
        return 'top';
    if (cy >= 0.58)
        return 'bottom';
    if (cy <= 0.42)
        return 'top';
    return 'center';
}

/**
 * Computes the actual surface rectangle for a lyric that wraps naturally at
 * a constant font size: matches `box` when the lyric fits inside it, and
 * expands vertically along `anchor` (clamped inside `area`) when multi-line
 * text needs more room.
 * @param {{x: number, y: number, width: number, height: number}} box
 * @param {number} requiredHeight
 * @param {'top'|'center'|'bottom'} anchor
 * @param {{x: number, y: number, width: number, height: number}} area
 */
export function expandedRenderBox(box, requiredHeight, anchor, area) {
    const height = clamp(Math.max(box.height, Math.ceil(requiredHeight)), MIN_BOX_HEIGHT, area.height);
    let y;
    if (anchor === 'bottom')
        y = box.y + box.height - height;
    else if (anchor === 'top')
        y = box.y;
    else
        y = box.y + (box.height - height) / 2;
    y = clamp(y, area.y, area.y + area.height - height);
    return {x: box.x, y, width: box.width, height};
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

/**
 * Hit-tests a point against a box's 8 edge/corner resize zones.
 * Returns {edges} when within `edgeZone` of any border, otherwise 'move'.
 * @param {{x: number, y: number}} point
 * @param {{x: number, y: number, width: number, height: number}} box
 * @param {number} edgeZone
 * @returns {'move'|{edges: Record<string, boolean>}}
 */
export function boxZoneAt(point, box, edgeZone) {
    const near = {
        left: point.x - box.x < edgeZone,
        right: box.x + box.width - point.x <= edgeZone,
        top: point.y - box.y < edgeZone,
        bottom: box.y + box.height - point.y <= edgeZone,
    };
    const edges = Object.fromEntries(Object.entries(near).filter(([, isNear]) => isNear));
    return Object.keys(edges).length ? {edges} : 'move';
}

/**
 * Gently snaps a moving box's center to the work area's horizontal/vertical
 * center, and its edges to the work area's edges, when within `threshold` px.
 * Returns the snapped box and guide coordinates in stage pixels.
 */
export function snapBox(box, area, threshold) {
    let {x, y} = box;
    const {width, height} = box;
    const guidesX = [];
    const guidesY = [];
    const centerX = area.x + area.width / 2;
    const centerY = area.y + area.height / 2;
    if (Math.abs((x + width / 2) - centerX) <= threshold) {
        x = centerX - width / 2;
        guidesX.push(centerX);
    } else if (Math.abs(x - area.x) <= threshold) {
        x = area.x;
        guidesX.push(area.x);
    } else if (Math.abs((x + width) - (area.x + area.width)) <= threshold) {
        x = area.x + area.width - width;
        guidesX.push(area.x + area.width);
    }
    if (Math.abs((y + height / 2) - centerY) <= threshold) {
        y = centerY - height / 2;
        guidesY.push(centerY);
    } else if (Math.abs(y - area.y) <= threshold) {
        y = area.y;
        guidesY.push(area.y);
    } else if (Math.abs((y + height) - (area.y + area.height)) <= threshold) {
        y = area.y + area.height - height;
        guidesY.push(area.y + area.height);
    }
    return {box: clampBox({x, y, width, height}, area), guides: {x: guidesX, y: guidesY}};
}

/**
 * Scales a font's space advance so wide/monospace spaces tighten down to
 * `targetSpaceEm` while narrower fonts stay untouched (never widened).
 * @param {number} naturalSpaceRatio measured space advance / fontSize
 * @param {number|null} targetSpaceEm desired maximum space width in ems
 */
export function normalizedSpaceScale(naturalSpaceRatio, targetSpaceEm) {
    if (!targetSpaceEm || !Number.isFinite(naturalSpaceRatio) || naturalSpaceRatio <= 0)
        return 1;
    return Math.min(1, targetSpaceEm / naturalSpaceRatio);
}

/**
 * Calibrated default ring profiles per border mode (em-proportional, modeled on
 * Japanese broadcast telop / anime multi-ring fuchidori proportions):
 * - `none`: bare letters.
 * - `single`: 1 bold WCAG contrast outline (0.10 em).
 * - `double`: fused inner body (0.145 em) + bold contrast rim (0.080 em).
 * - `triple`: inner body (0.125 em) + bright middle band (0.080 em) + outer
 *   contrast seal (0.060 em) that stays sharp over pure white or pure black
 *   video without needing a backdrop box or shadow cloud.
 * - `quad`: four progressive concentric bands (0.110 / 0.070 / 0.060 / 0.050 em).
 * - `glow`: fused inner body (0.145 em) + smooth feathered halo (0.105 em).
 */
export const BORDER_DEFAULTS = Object.freeze({
    none: Object.freeze([]),
    single: Object.freeze([
        Object.freeze({em: 0.10, min: 1.5, feathered: false}),
    ]),
    double: Object.freeze([
        Object.freeze({em: 0.145, min: 2, feathered: false}),
        Object.freeze({em: 0.080, min: 2, feathered: false}),
    ]),
    triple: Object.freeze([
        Object.freeze({em: 0.125, min: 2, feathered: false}),
        Object.freeze({em: 0.080, min: 2, feathered: false}),
        Object.freeze({em: 0.060, min: 1.5, feathered: false}),
    ]),
    quad: Object.freeze([
        Object.freeze({em: 0.125, min: 2, feathered: false}),
        Object.freeze({em: 0.070, min: 2, feathered: false}),
        Object.freeze({em: 0.060, min: 1.5, feathered: false}),
        Object.freeze({em: 0.050, min: 1.5, feathered: false}),
    ]),
    glow: Object.freeze([
        Object.freeze({em: 0.145, min: 2, feathered: false}),
        Object.freeze({em: 0.105, min: 2, feathered: true}),
    ]),
});

/**
 * Proportional border ring geometry, optical word-fusion bridge, and optional
 * smooth dark backing cloud parameters at a font size. Shared by desktop/shell
 * (Pango/Cairo) and the settings page preview.
 * @param {string} border
 * @param {number} fontSize
 * @param {{ringWidths?: ReadonlyArray<number>, cloud?: boolean}|null} [options]
 */
export function borderSpec(border, fontSize, options = null) {
    const defaults = BORDER_DEFAULTS[border];
    if (!defaults)
        throw new Error(`lyrics-overlay: unknown text border "${border}"`);
    const customWidths = options?.ringWidths ?? [];
    const rings = defaults.map((def, idx) => {
        const customEm = Number(customWidths[idx]) || 0;
        const em = customEm > 0 ? Math.min(0.35, Math.max(0.01, customEm)) : def.em;
        const width = Math.max(customEm > 0 ? 1 : def.min, fontSize * em);
        return {width, em, feathered: def.feathered};
    });
    const inner = rings[0]?.width ?? 0;
    const outer = rings[1]?.width ?? 0;
    const totalReach = rings.reduce((sum, entry) => sum + entry.width, 0);
    const featheredOuter = Boolean(rings.length && rings[rings.length - 1].feathered);
    const cloud = Boolean(options?.cloud) && rings.length > 0;
    const auraSpread = cloud ? Math.max(8, fontSize * (featheredOuter ? 0.42 : 0.48)) : 0;
    const auraAlpha = cloud ? (featheredOuter ? 0.65 : 0.88) : 0;
    const featherPad = featheredOuter ? rings[rings.length - 1].width * 0.6 : 0;
    return {
        rings,
        inner,
        outer,
        totalReach,
        targetSpaceEm: rings.length >= 2 ? 0.22 : 0.26,
        bridge: rings.length >= 2,
        auraSpread,
        auraAlpha,
        featheredOuter,
        extraPad: Math.ceil(Math.max(featherPad, auraSpread)),
    };
}

/** Automatic em-proportional backdrop padding and corner radius. */
export function backdropMetrics(fontSize) {
    return {
        padX: Math.max(10, Math.round(fontSize * 0.34)),
        padY: Math.max(6, Math.round(fontSize * 0.20)),
        radius: Math.max(6, Math.round(fontSize * 0.22)),
    };
}
