// Fits one lyric at a constant font size into a region and paints it.
// Long lines wrap evenly into balanced lines without ever shrinking the
// letters mid-song; the caller may expand the surface vertically to
// `requiredHeight` when a multi-line lyric exceeds the box height.
//
// Fitting runs on a shared measuring context; painting rebuilds the same
// layout on the cairo context, so measured and painted text agree to within
// hinting. Both run on GNOME Shell's main thread on resize steps, so wrap
// widths and pre-rendered border/shadow alpha masks are cached per line.

import Cairo from 'cairo';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

import {backdropMetrics, balancedWrapWidth, borderSpec} from './shared/overlay-geometry.js';
import {parseHexColor, resolveTextColor, ringColors} from './shared/text-ink.js';

export {borderSpec};

const EDGE_PIXELS = 4;
// Cairo's stroker leaves a hole in a stroke whose half-width exceeds the
// radius of a closed contour (dot of i/j, period, colon, o counter).
// Stepping down by less than the smallest contour's diameter covers every
// distance; narrower strokes disable antialiasing so inner seams stay solid.
const RING_STEP_OF_FONT_SIZE = 0.055;
const RING_CACHE_SIZE = 16;
const WRAP_CACHE_SIZE = 64;

const ALIGNMENTS = Object.freeze({
    'center': Pango.Alignment.CENTER,
    'left': Pango.Alignment.LEFT,
    'right': Pango.Alignment.RIGHT,
});

const ANCHORS = new Set(['top', 'center', 'bottom']);
const BACKDROPS = new Set(['none', 'pill', 'box']);

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

function edgePadding(params, fontSize) {
    const ring = borderSpec(params.border, fontSize);
    const backdropMode = params.backdrop ?? 'none';
    const bp = backdropMode === 'pill' ? backdropMetrics(fontSize) : {padX: 0, padY: 0};
    const reach = ring.inner + ring.outer + ring.extraPad;
    return {
        x: Math.ceil(reach) + bp.padX + EDGE_PIXELS,
        y: Math.ceil(reach) + bp.padY + EDGE_PIXELS,
    };
}

function fontDescription(spec) {
    const description = new Pango.FontDescription();
    description.set_family(spec.family);
    description.set_weight(spec.bold ? Pango.Weight.BOLD : Pango.Weight.NORMAL);
    description.set_style(spec.italic ? Pango.Style.ITALIC : Pango.Style.NORMAL);
    description.set_absolute_size(spec.fontSize * Pango.SCALE);
    return description;
}

function applySpaceScale(layout, text, spaceScale) {
    if (!spaceScale || spaceScale === 1) {
        layout.set_attributes(null);
        return;
    }
    const attrs = new Pango.AttrList();
    let bytePos = 0;
    for (const ch of text) {
        const len = utf8.encode(ch).length;
        if (ch === ' ') {
            const attr = Pango.attr_scale_new(spaceScale);
            attr.start_index = bytePos;
            attr.end_index = bytePos + len;
            attrs.insert(attr);
        }
        bytePos += len;
    }
    layout.set_attributes(attrs);
}

function applySpec(layout, spec) {
    layout.set_alignment(ALIGNMENTS[spec.align]);
    layout.set_wrap(Pango.WrapMode.WORD_CHAR);
    layout.set_font_description(fontDescription(spec));
    layout.set_width(Math.round(spec.wrapWidth * Pango.SCALE));
    applySpaceScale(layout, spec.text, spec.spaceScale);
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
 * Lays out one lyric at exact `params.fontSize` (never shrinking per line).
 * @param {Pango.Context} context measuring context
 * @param {string} text
 * @param {{fontSize: number, family: string, bold: boolean, italic?: boolean,
 *          color: string, customColor?: string, border: string,
 *          backdrop?: string, backdropColor?: string, backdropOpacity?: number,
 *          align: string, anchor?: 'top'|'center'|'bottom',
 *          width: number, height: number}} params
 */
export function fitLyric(context, text, params) {
    const fill = resolveTextColor(params.color, params.customColor ?? '');
    if (!(params.align in ALIGNMENTS))
        throw new Error(`lyrics-overlay: unknown text alignment "${params.align}"`);
    const anchor = params.anchor ?? 'center';
    if (!ANCHORS.has(anchor))
        throw new Error(`lyrics-overlay: unknown vertical anchor "${anchor}"`);
    const backdropMode = params.backdrop ?? 'none';
    if (!BACKDROPS.has(backdropMode))
        throw new Error(`lyrics-overlay: unknown backdrop "${backdropMode}"`);

    const ring = borderSpec(params.border, params.fontSize);
    const pad = edgePadding(params, params.fontSize);
    const maxWidth = Math.max(1, params.width - 2 * pad.x);
    const layout = Pango.Layout.new(context);
    const spec = {
        text,
        family: params.family,
        bold: Boolean(params.bold),
        italic: Boolean(params.italic),
        spaceScale: ring.spaceScale,
        align: params.align,
        fontSize: params.fontSize,
        wrapWidth: maxWidth,
    };
    const measure = wrapWidth => {
        applySpec(layout, {...spec, wrapWidth});
        return layout;
    };
    const lineCountAt = wrapWidth => measure(wrapWidth).get_line_count();
    const lines = lineCountAt(maxWidth);
    const wrapKey = `${spec.fontSize}|${spec.family}|${spec.bold}|${spec.italic}|${spec.spaceScale}|${lines}|${text}`;
    let balanced = cacheGet(wrapCache, wrapKey);
    if (balanced === undefined) {
        balanced = balancedWrapWidth(maxWidth, lineCountAt);
        cacheSet(wrapCache, wrapKey, balanced, WRAP_CACHE_SIZE);
    }
    spec.wrapWidth = Math.min(balanced, maxWidth);

    const [ink, logical] = measure(spec.wrapWidth).get_pixel_extents();
    const requiredHeight = Math.ceil(logical.height + 2 * pad.y);
    const surfaceHeight = Math.max(params.height, requiredHeight);

    let left;
    if (params.align === 'left')
        left = pad.x;
    else if (params.align === 'right')
        left = params.width - pad.x - spec.wrapWidth;
    else
        left = (params.width - spec.wrapWidth) / 2;

    let top;
    if (anchor === 'top')
        top = pad.y;
    else if (anchor === 'bottom')
        top = Math.max(pad.y, surfaceHeight - pad.y - logical.height);
    else
        top = Math.max(pad.y, (surfaceHeight - logical.height) / 2);

    const origin = {x: left, y: top};
    const reach = ring.inner + ring.outer + ring.extraPad;
    const colors = ringColors(fill);
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
        const metrics = backdropMetrics(spec.fontSize);
        if (backdropMode === 'box') {
            backdrop = {
                x: 0, y: 0, width: params.width, height: surfaceHeight,
                radius: metrics.radius, rgb: bgRgb, opacity: bgOpacity,
            };
        } else {
            const tightReach = ring.inner + ring.outer;
            const bx = Math.max(0, origin.x + ink.x - tightReach - metrics.padX);
            const by = Math.max(0, origin.y + ink.y - tightReach - metrics.padY);
            const br = Math.min(params.width, origin.x + ink.x + ink.width + tightReach + metrics.padX);
            const bb = Math.min(surfaceHeight, origin.y + ink.y + ink.height + tightReach + metrics.padY);
            backdrop = {
                x: bx, y: by, width: Math.max(1, br - bx), height: Math.max(1, bb - by),
                radius: metrics.radius, rgb: bgRgb, opacity: bgOpacity,
            };
        }
        inkBox = {x: backdrop.x, y: backdrop.y, width: backdrop.width, height: backdrop.height};
    }

    return {
        spec,
        origin,
        ring,
        border: params.border,
        ringColors: colors,
        fill,
        backdrop,
        inkBox,
        lineCount: lines,
        requiredHeight,
        anchor,
    };
}

/**
 * Strokes the current path so that everything within `reach` pixels of it
 * down to `floor` pixels is covered. Keeps the path.
 */
function strokeBand(cr, reach, floor, step) {
    if (reach <= 0)
        return;
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
    entry.shadow?.finish();
    entry.outer?.finish();
    entry.inner?.finish();
}

function strokedMask(line, width, height, dx, dy, reach, floor, step) {
    const surface = new Cairo.ImageSurface(Cairo.Format.A8, width, height);
    const cr = new Cairo.Context(surface);
    cr.moveTo(-dx, -dy);
    PangoCairo.layout_line_path(cr, line);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    cr.setLineCap(Cairo.LineCap.ROUND);
    strokeBand(cr, reach, floor, step);
    cr.$dispose();
    return surface;
}

const GLOW_BANDS = [
    {frac: 1.55, alpha: 0.09},
    {frac: 1.25, alpha: 0.16},
    {frac: 0.95, alpha: 0.28},
    {frac: 0.65, alpha: 0.48},
    {frac: 0.38, alpha: 0.78},
    {frac: 0.16, alpha: 0.96},
];

/**
 * Pre-renders the border (and optional soft ambient shadow) of one laid-out
 * line into cached A8 alpha masks positioned relative to the line baseline.
 */
function lineRings(line, lineText, spec, border, ring) {
    const key = `${spec.fontSize}|${spec.family}|${spec.bold}|${spec.italic}|${spec.spaceScale}|${border}|${lineText}`;
    const cached = cacheGet(ringCache, key);
    if (cached)
        return cached;

    const [ink] = line.get_pixel_extents();
    const {inner, outer, shadow: wantShadow, featheredOuter, extraPad} = ring;
    const pad = Math.ceil(inner + outer + extraPad) + 6;
    const dx = ink.x - pad;
    const dy = ink.y - pad;
    const width = ink.width + 2 * pad;
    const height = ink.height + 2 * pad;
    const step = Math.max(1, spec.fontSize * RING_STEP_OF_FONT_SIZE);

    const innerMask = strokedMask(line, width, height, dx, dy, inner, 0, step);

    let outerMask = null;
    if (outer > 0 && featheredOuter) {
        outerMask = new Cairo.ImageSurface(Cairo.Format.A8, width, height);
        const ocr = new Cairo.Context(outerMask);
        for (const band of GLOW_BANDS) {
            const bandSurf = strokedMask(line, width, height, dx, dy, inner + outer * band.frac, inner, step);
            ocr.setSourceRGBA(0, 0, 0, band.alpha);
            ocr.maskSurface(bandSurf, 0, 0);
            bandSurf.finish();
        }
        ocr.$dispose();
    } else if (outer > 0) {
        outerMask = strokedMask(line, width, height, dx, dy, inner + outer, inner, step);
    }

    let shadowMask = null;
    if (wantShadow) {
        const base = strokedMask(
            line, width, height, dx, dy,
            inner + outer + spec.fontSize * 0.015,
            Math.max(0, inner + outer - 2),
            step,
        );
        shadowMask = new Cairo.ImageSurface(Cairo.Format.A8, width, height);
        const scr = new Cairo.Context(shadowMask);
        const dyOff = Math.max(2, Math.round(spec.fontSize * 0.045));
        const rings = [
            {r: Math.max(3, spec.fontSize * 0.075), oy: dyOff + 2, a: 0.06},
            {r: Math.max(2, spec.fontSize * 0.04), oy: dyOff + 1, a: 0.11},
            {r: 0, oy: dyOff, a: 0.28},
        ];
        for (const pass of rings) {
            scr.setSourceRGBA(0, 0, 0, pass.a);
            if (pass.r === 0) {
                scr.maskSurface(base, 0, pass.oy);
            } else {
                const steps = 8;
                for (let i = 0; i < steps; i++) {
                    const ang = (i / steps) * Math.PI * 2;
                    scr.maskSurface(base, Math.cos(ang) * pass.r, pass.oy + Math.sin(ang) * pass.r);
                }
            }
        }
        scr.$dispose();
        base.finish();
    }

    const entry = {dx, dy, shadow: shadowMask, outer: outerMask, inner: innerMask};
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

    if (fitted.ring.inner === 0) {
        cr.moveTo(fitted.origin.x, fitted.origin.y);
        cr.setSourceRGB(...fitted.fill);
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
        entry.rings = lineRings(entry.line, entry.text, fitted.spec, fitted.border, fitted.ring);

    // Subtle soft ambient shadow behind Variant C double border
    if (fitted.ring.shadow) {
        cr.setSourceRGB(0, 0, 0);
        for (const {x, y, rings} of lines) {
            if (rings.shadow)
                cr.maskSurface(rings.shadow, x + rings.dx, y + rings.dy);
        }
    }

    const colors = fitted.ringColors ?? ringColors(fitted.fill);
    for (const layer of ['outer', 'inner']) {
        cr.setSourceRGB(...colors[layer]);
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
    cr.setSourceRGB(...fitted.fill);
    cr.fill();
}
