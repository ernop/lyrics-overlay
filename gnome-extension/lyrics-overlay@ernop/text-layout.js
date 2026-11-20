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

import {FONT_SIZE_MAX, balancedWrapWidth, fitFontSize, ringWidths} from './shared/overlay-geometry.js';
import {parseHexColor, resolveTextColor, ringColors} from './shared/text-ink.js';

export {ringWidths};

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
    'right': Pango.Alignment.RIGHT,
});

const VALIGNMENTS = new Set(['top', 'center', 'bottom']);
const FIT_MODES = new Set(['shrink', 'fill']);
const BACKDROPS = new Set(['none', 'pill', 'box']);

function resolvedWeight(params) {
    if (typeof params.fontWeight === 'number' && params.fontWeight >= 100)
        return Math.min(900, Math.max(100, Math.round(params.fontWeight)));
    return params.bold ? Pango.Weight.BOLD : Pango.Weight.NORMAL;
}

function shadowOffset(shadow, fontSize) {
    if (!(shadow > 0))
        return {dx: 0, dy: 0};
    return {
        dx: Math.max(2, Math.round(fontSize * 0.04 * (0.6 + shadow * 0.6))),
        dy: Math.max(2, Math.round(fontSize * 0.06 * (0.6 + shadow * 0.6))),
    };
}

function edgeFor(params, fontSize) {
    const ring = ringWidths(params.border, fontSize, params.borderScale);
    const {dx, dy} = shadowOffset(params.shadow ?? 0, fontSize);
    const backdropPad = (params.backdrop ?? 'none') !== 'none' ? (params.backdropPadding ?? 14) : 0;
    return Math.ceil(ring.inner + ring.outer) + Math.max(dx, dy) + backdropPad + EDGE_PIXELS;
}

function fontDescription(spec) {
    const description = new Pango.FontDescription();
    description.set_family(spec.family);
    description.set_weight(spec.weight);
    description.set_style(spec.italic ? Pango.Style.ITALIC : Pango.Style.NORMAL);
    description.set_absolute_size(spec.fontSize * Pango.SCALE);
    return description;
}

function applySpec(layout, spec) {
    layout.set_alignment(ALIGNMENTS[spec.align]);
    layout.set_wrap(Pango.WrapMode.WORD_CHAR);
    layout.set_font_description(fontDescription(spec));
    layout.set_width(Math.round(spec.wrapWidth * Pango.SCALE));
    if (spec.letterSpacing) {
        const attributes = new Pango.AttrList();
        attributes.insert(Pango.attr_letter_spacing_new(Math.round(spec.letterSpacing * Pango.SCALE)));
        layout.set_attributes(attributes);
    } else {
        layout.set_attributes(null);
    }
    layout.set_text(spec.text, -1);
}

function roundedRectangle(cr, x, y, width, height, radius) {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    cr.newSubPath();
    cr.arc(x + width - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + width - r, y + height - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + height - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

/**
 * @param {Pango.Context} context measuring context
 * @param {string} text
 * @param {{fontSize: number, family: string, bold: boolean, color: string, border: string,
 *          borderScale: number, align: string, width: number, height: number,
 *          fontWeight?: number, italic?: boolean, uppercase?: boolean, letterSpacing?: number,
 *          fitMode?: string, maxLines?: number, valign?: string, customColor?: string,
 *          textOpacity?: number, borderColorMode?: string, borderColor?: string,
 *          shadow?: number, backdrop?: string, backdropColor?: string, backdropOpacity?: number,
 *          backdropRadius?: number, backdropPadding?: number}} params region size and wanted look
 */
export function fitLyric(context, text, params) {
    const fill = resolveTextColor(params.color, params.customColor ?? '');
    if (!(params.align in ALIGNMENTS))
        throw new Error(`lyrics-overlay: unknown text alignment "${params.align}"`);
    const valign = params.valign ?? 'center';
    if (!VALIGNMENTS.has(valign))
        throw new Error(`lyrics-overlay: unknown vertical alignment "${valign}"`);
    const fitMode = params.fitMode ?? 'shrink';
    if (!FIT_MODES.has(fitMode))
        throw new Error(`lyrics-overlay: unknown fit mode "${fitMode}"`);
    const backdropMode = params.backdrop ?? 'none';
    if (!BACKDROPS.has(backdropMode))
        throw new Error(`lyrics-overlay: unknown backdrop "${backdropMode}"`);

    const displayText = params.uppercase ? text.toLocaleUpperCase() : text;
    const maxLines = Math.max(0, Math.round(params.maxLines ?? 0));
    const layout = Pango.Layout.new(context);
    const spec = {
        text: displayText,
        family: params.family,
        weight: resolvedWeight(params),
        italic: Boolean(params.italic),
        letterSpacing: params.letterSpacing ?? 0,
        align: params.align,
        fontSize: params.fontSize,
        wrapWidth: 1,
    };
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
        const measured = measure(fontSize, width);
        if (maxLines > 0 && measured.get_line_count() > maxLines)
            return false;
        const [, logical] = measured.get_pixel_extents();
        return logical.height <= height && logical.width <= width;
    };
    const ceiling = fitMode === 'fill' ? FONT_SIZE_MAX : params.fontSize;
    spec.fontSize = fitFontSize(ceiling, Math.min(ceiling, SMALLEST_FITTED_SIZE), fits);
    const maxWidth = room(spec.fontSize).width;
    const lineCountAt = wrapWidth => measure(spec.fontSize, wrapWidth).get_line_count();
    const lines = lineCountAt(maxWidth);
    // The narrowest width that keeps `lines` lines depends only on the text
    // and the font, so a resize that keeps both finds it here.
    const wrapKey = `${spec.fontSize}|${spec.family}|${spec.weight}|${spec.italic}|${spec.letterSpacing}|${lines}|${displayText}`;
    let balanced = cacheGet(wrapCache, wrapKey);
    if (balanced === undefined) {
        balanced = balancedWrapWidth(maxWidth, lineCountAt);
        cacheSet(wrapCache, wrapKey, balanced, WRAP_CACHE_SIZE);
    }
    spec.wrapWidth = Math.min(balanced, maxWidth);

    const [ink, logical] = measure(spec.fontSize, spec.wrapWidth).get_pixel_extents();
    const edge = edgeFor(params, spec.fontSize);
    let left;
    if (params.align === 'left')
        left = edge;
    else if (params.align === 'right')
        left = params.width - edge - spec.wrapWidth;
    else
        left = (params.width - spec.wrapWidth) / 2;

    let top;
    if (valign === 'top')
        top = edge;
    else if (valign === 'bottom')
        top = params.height - edge - logical.height;
    else
        top = (params.height - logical.height) / 2;

    const origin = {x: left, y: top};
    const ring = ringWidths(params.border, spec.fontSize, params.borderScale);
    const reach = ring.inner + ring.outer;
    const borderCustomHex = (params.borderColorMode ?? 'auto') === 'custom' ? (params.borderColor ?? '#000000') : '';
    const colors = ringColors(fill, borderCustomHex);
    const textInkBox = {
        x: origin.x + ink.x - reach,
        y: origin.y + ink.y - reach,
        width: ink.width + 2 * reach,
        height: ink.height + 2 * reach,
    };

    let backdrop = null;
    let inkBox = textInkBox;
    if (backdropMode !== 'none') {
        const bgRgb = parseHexColor(params.backdropColor ?? '#000000') ?? [0, 0, 0];
        const bgOpacity = params.backdropOpacity ?? 0.65;
        const radius = params.backdropRadius ?? 12;
        if (backdropMode === 'box') {
            backdrop = {x: 0, y: 0, width: params.width, height: params.height, radius, rgb: bgRgb, opacity: bgOpacity};
        } else {
            const padX = params.backdropPadding ?? 14;
            const padY = Math.round(padX * 0.7);
            const bx = Math.max(0, textInkBox.x - padX);
            const by = Math.max(0, textInkBox.y - padY);
            const br = Math.min(params.width, textInkBox.x + textInkBox.width + padX);
            const bb = Math.min(params.height, textInkBox.y + textInkBox.height + padY);
            backdrop = {x: bx, y: by, width: Math.max(1, br - bx), height: Math.max(1, bb - by), radius, rgb: bgRgb, opacity: bgOpacity};
        }
        inkBox = {x: backdrop.x, y: backdrop.y, width: backdrop.width, height: backdrop.height};
    }

    return {
        spec,
        origin,
        ring,
        ringColors: colors,
        fill,
        textOpacity: params.textOpacity ?? 1,
        shadow: params.shadow ?? 0,
        backdrop,
        inkBox,
        lineCount: lines,
        targetFontSize: params.fontSize,
        clamped: fitMode === 'shrink' && spec.fontSize < params.fontSize - 0.5,
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
    const key = `${spec.fontSize}|${spec.family}|${spec.weight}|${spec.italic}|${spec.letterSpacing}|${inner}|${outer}|${lineText}`;
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
    if (fitted.backdrop && fitted.backdrop.opacity > 0) {
        const {x, y, width, height, radius, rgb, opacity} = fitted.backdrop;
        roundedRectangle(cr, x, y, width, height, radius);
        cr.setSourceRGBA(rgb[0], rgb[1], rgb[2], opacity);
        cr.fill();
    }

    const layout = PangoCairo.create_layout(cr);
    applySpec(layout, fitted.spec);
    const alpha = fitted.textOpacity ?? 1;
    const {inner} = fitted.ring;
    const {dx: shadowX, dy: shadowY} = shadowOffset(fitted.shadow ?? 0, fitted.spec.fontSize);

    if (inner === 0) {
        if (fitted.shadow > 0) {
            const shadowAlpha = Math.min(0.9, fitted.shadow * 0.85) * alpha;
            cr.setSourceRGBA(0, 0, 0, shadowAlpha * 0.45);
            for (const [ox, oy] of [[shadowX + 1, shadowY + 1], [shadowX - 1, shadowY + 1], [shadowX, shadowY + 2]]) {
                cr.moveTo(fitted.origin.x + ox, fitted.origin.y + oy);
                PangoCairo.show_layout(cr, layout);
            }
            cr.setSourceRGBA(0, 0, 0, shadowAlpha);
            cr.moveTo(fitted.origin.x + shadowX, fitted.origin.y + shadowY);
            PangoCairo.show_layout(cr, layout);
        }
        cr.moveTo(fitted.origin.x, fitted.origin.y);
        cr.setSourceRGBA(...fitted.fill, alpha);
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

    if (fitted.shadow > 0) {
        const shadowAlpha = Math.min(0.85, fitted.shadow * 0.78) * alpha;
        cr.setSourceRGBA(0, 0, 0, shadowAlpha);
        for (const {x, y, rings} of lines) {
            const mask = rings.outer ?? rings.inner;
            cr.maskSurface(mask, x + rings.dx + shadowX, y + rings.dy + shadowY);
        }
    }

    const colors = fitted.ringColors ?? ringColors(fitted.fill);
    for (const layer of ['outer', 'inner']) {
        cr.setSourceRGBA(...colors[layer], alpha);
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
    cr.setSourceRGBA(...fitted.fill, alpha);
    cr.fill();
}
