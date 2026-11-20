// Fits one lyric into a region and paints it. Fitting runs on a shared
// measuring context; painting rebuilds the same layout on the cairo
// context, so measured and painted text agree to within hinting.
//
// Both run on GNOME Shell's main thread on every resize step, so both keep
// caches: the balanced wrap width of a text at a font size, and the two
// border rings of each wrapped line as alpha masks. While a resize keeps
// the font size, a step costs a few Pango layouts and three mask copies
// per line instead of a full stroke of the outline.

import Cairo from 'cairo';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

import {balancedWrapWidth, fitFontSize} from './shared/overlay-geometry.js';
import {TEXT_COLORS, ringColors} from './shared/text-ink.js';

const SMALLEST_FITTED_SIZE = 12;
const EDGE_PIXELS = 4;
// Cairo's stroker leaves a hole in a stroke whose half-width exceeds the
// radius of a closed contour: a wide border around the dot of an i, j or
// ï, a period or a colon drew as a ring with the background showing
// inside it. A stroke of half-width h is drawn correctly from h down to
// about h minus the contour's diameter, so strokes stepped down by less
// than the smallest contour's diameter cover every distance. A period or
// the dot of an i is about 0.12 of the font size across in common fonts.
// Only the widest stroke's outer edge shows, so the narrower strokes are
// drawn without antialiasing: two half-covered edges stacked inside the
// ring would leave a pale speck where the next color shows through.
const RING_STEP_OF_FONT_SIZE = 0.06;
// The lines of two layers of up to three lines, and a few that a resize
// rewraps into. A line's two masks at the largest sizes take about 1 MB.
const RING_CACHE_SIZE = 12;
const WRAP_CACHE_SIZE = 64;

const ALIGNMENTS = Object.freeze({
    'center': Pango.Alignment.CENTER,
    'left': Pango.Alignment.LEFT,
});

/**
 * Border ring widths in pixels for a border setting at a font size, times
 * the thickness setting (text-border-scale).
 */
export function ringWidths(border, fontSize, scale) {
    switch (border) {
    case 'none':
        return {inner: 0, outer: 0};
    case 'single':
        return {inner: Math.max(1.5, fontSize * 0.07) * scale, outer: 0};
    case 'double':
        return {inner: Math.max(1.5, fontSize * 0.055) * scale, outer: Math.max(1.5, fontSize * 0.045) * scale};
    }
    throw new Error(`lyrics-overlay: unknown text border "${border}"`);
}

function edgeFor(params, fontSize) {
    const ring = ringWidths(params.border, fontSize, params.borderScale);
    return Math.ceil(ring.inner + ring.outer) + EDGE_PIXELS;
}

function fontDescription(family, bold, fontSize) {
    const description = new Pango.FontDescription();
    description.set_family(family);
    description.set_weight(bold ? Pango.Weight.BOLD : Pango.Weight.NORMAL);
    description.set_absolute_size(fontSize * Pango.SCALE);
    return description;
}

function applySpec(layout, spec) {
    layout.set_alignment(ALIGNMENTS[spec.align]);
    layout.set_wrap(Pango.WrapMode.WORD_CHAR);
    layout.set_font_description(fontDescription(spec.family, spec.bold, spec.fontSize));
    layout.set_width(Math.round(spec.wrapWidth * Pango.SCALE));
    layout.set_text(spec.text, -1);
}

/**
 * @param {Pango.Context} context measuring context
 * @param {string} text
 * @param {{fontSize: number, family: string, bold: boolean, color: string, border: string,
 *          borderScale: number, align: string, width: number, height: number}} params region size and wanted look
 * @returns {{spec: object, origin: {x: number, y: number}, ring: {inner: number, outer: number},
 *            fill: number[], inkBox: {x: number, y: number, width: number, height: number}}}
 */
export function fitLyric(context, text, params) {
    const fill = TEXT_COLORS[params.color];
    if (!fill)
        throw new Error(`lyrics-overlay: unknown text color "${params.color}"`);
    if (!(params.align in ALIGNMENTS))
        throw new Error(`lyrics-overlay: unknown text alignment "${params.align}"`);
    const layout = Pango.Layout.new(context);
    const spec = {text, family: params.family, bold: params.bold, align: params.align, fontSize: params.fontSize, wrapWidth: 1};
    const measure = (fontSize, wrapWidth) => {
        applySpec(layout, {...spec, fontSize, wrapWidth});
        return layout;
    };
    const room = fontSize => {
        const edge = edgeFor(params, fontSize);
        return {width: Math.max(1, params.width - 2 * edge), height: Math.max(1, params.height - 2 * edge)};
    };
    const fits = fontSize => {
        const {width, height} = room(fontSize);
        const [, logical] = measure(fontSize, width).get_pixel_extents();
        return logical.height <= height && logical.width <= width;
    };
    spec.fontSize = fitFontSize(params.fontSize, Math.min(params.fontSize, SMALLEST_FITTED_SIZE), fits);
    const maxWidth = room(spec.fontSize).width;
    const lineCountAt = wrapWidth => measure(spec.fontSize, wrapWidth).get_line_count();
    const lines = lineCountAt(maxWidth);
    // The narrowest width that keeps `lines` lines depends only on the text
    // and the font, so a resize that keeps both finds it here.
    const wrapKey = `${spec.fontSize}|${spec.family}|${spec.bold}|${lines}|${text}`;
    let balanced = cacheGet(wrapCache, wrapKey);
    if (balanced === undefined) {
        balanced = balancedWrapWidth(maxWidth, lineCountAt);
        cacheSet(wrapCache, wrapKey, balanced, WRAP_CACHE_SIZE);
    }
    spec.wrapWidth = Math.min(balanced, maxWidth);

    const [ink, logical] = measure(spec.fontSize, spec.wrapWidth).get_pixel_extents();
    const left = params.align === 'left' ? edgeFor(params, spec.fontSize) : (params.width - spec.wrapWidth) / 2;
    const origin = {x: left, y: (params.height - logical.height) / 2};
    const ring = ringWidths(params.border, spec.fontSize, params.borderScale);
    const reach = ring.inner + ring.outer;
    return {
        spec,
        origin,
        ring,
        fill,
        inkBox: {
            x: origin.x + ink.x - reach,
            y: origin.y + ink.y - reach,
            width: ink.width + 2 * reach,
            height: ink.height + 2 * reach,
        },
    };
}

/**
 * Strokes the current path so that everything within `reach` pixels of it
 * down to `floor` pixels is covered: stepped strokes, see
 * RING_STEP_OF_FONT_SIZE. Keeps the path.
 */
function strokeBand(cr, reach, floor, step) {
    const antialias = cr.getAntialias();
    for (let halfWidth = reach; ; halfWidth -= step) {
        cr.setLineWidth(2 * halfWidth);
        cr.strokePreserve();
        cr.setAntialias(Cairo.Antialias.NONE);
        if (halfWidth - step <= floor)
            break;
    }
    cr.setAntialias(antialias);
}

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

/** Least recently used caches: Maps in use order, oldest first. */
const wrapCache = new Map();
const ringCache = new Map();

function cacheGet(cache, key) {
    const value = cache.get(key);
    if (value !== undefined) {
        cache.delete(key);
        cache.set(key, value);
    }
    return value;
}

function cacheSet(cache, key, value, size, drop = () => {}) {
    cache.set(key, value);
    while (cache.size > size) {
        const [oldest, dropped] = cache.entries().next().value;
        cache.delete(oldest);
        drop(dropped);
    }
}

function dropRings(entry) {
    entry.outer?.finish();
    entry.inner.finish();
}

/**
 * The border rings of one laid-out line as alpha masks, with their
 * top-left relative to the line's baseline start.
 */
function lineRings(line, lineText, spec, ring) {
    const {inner, outer} = ring;
    const key = `${spec.fontSize}|${spec.family}|${spec.bold}|${inner}|${outer}|${lineText}`;
    const cached = cacheGet(ringCache, key);
    if (cached)
        return cached;
    const [ink] = line.get_pixel_extents();
    const pad = Math.ceil(inner + outer) + 2;
    const dx = ink.x - pad, dy = ink.y - pad;
    const width = ink.width + 2 * pad, height = ink.height + 2 * pad;
    const step = Math.max(1, spec.fontSize * RING_STEP_OF_FONT_SIZE);
    const mask = (reach, floor) => {
        const surface = new Cairo.ImageSurface(Cairo.Format.A8, width, height);
        const cr = new Cairo.Context(surface);
        cr.moveTo(-dx, -dy);
        PangoCairo.layout_line_path(cr, line);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        cr.setLineCap(Cairo.LineCap.ROUND);
        strokeBand(cr, reach, floor, step);
        cr.$dispose();
        return surface;
    };
    // The inner ring covers everything within `inner`, so the outer ring
    // needs its band only down to there.
    const entry = {dx, dy, outer: outer > 0 ? mask(inner + outer, inner) : null, inner: mask(inner, 0)};
    cacheSet(ringCache, key, entry, RING_CACHE_SIZE, dropRings);
    return entry;
}

/** Paints a fitted lyric with its region's top-left at the cairo origin. */
export function paintLyric(cr, fitted) {
    const layout = PangoCairo.create_layout(cr);
    applySpec(layout, fitted.spec);
    const {inner} = fitted.ring;
    if (inner === 0) {
        cr.moveTo(fitted.origin.x, fitted.origin.y);
        cr.setSourceRGBA(...fitted.fill, 1);
        PangoCairo.show_layout(cr, layout);
        return;
    }
    // Each line starts on a whole pixel, so its cached masks land exactly
    // on the letters filled there.
    const bytes = utf8.encode(fitted.spec.text);
    const lines = [];
    const iter = layout.get_iter();
    do {
        const line = iter.get_line_readonly();
        const [, logical] = iter.get_line_extents();
        const start = line.get_start_index();
        lines.push({
            line,
            text: fromUtf8.decode(bytes.subarray(start, start + line.get_length())),
            x: Math.round(fitted.origin.x + logical.x / Pango.SCALE),
            y: Math.round(fitted.origin.y + iter.get_baseline() / Pango.SCALE),
        });
    } while (iter.next_line());
    for (const entry of lines)
        entry.rings = lineRings(entry.line, entry.text, fitted.spec, fitted.ring);

    const colors = ringColors(fitted.fill);
    for (const layer of ['outer', 'inner']) {
        cr.setSourceRGBA(...colors[layer], 1);
        for (const {x, y, rings} of lines) {
            if (rings[layer])
                cr.maskSurface(rings[layer], x + rings.dx, y + rings.dy);
        }
    }
    cr.newPath();
    for (const {line, x, y} of lines) {
        cr.moveTo(x, y);
        PangoCairo.layout_line_path(cr, line);
    }
    cr.setSourceRGBA(...fitted.fill, 1);
    cr.fill();
}
