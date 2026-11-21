// Fits one lyric at a constant font size into a region and paints it.
// Long lines wrap evenly into balanced lines without ever shrinking the
// letters mid-song; the caller may expand the surface vertically to
// `requiredHeight` when a multi-line lyric exceeds the box height.
//
// Fitting runs on a shared measuring context; painting rebuilds the same
// layout on the cairo context, so measured and painted text agree to within
// hinting. Wrap widths and pre-rendered border/shadow alpha masks are cached
// per line so resize and scroll steps paint in a few milliseconds.

import Cairo from 'cairo';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

import {backdropMetrics, balancedWrapWidth, borderSpec, normalizedSpaceScale} from './overlay-geometry.js';
import {parseHexColor, resolveRingColors, resolveTextColor, ringColors} from './text-ink.js';

export {borderSpec};

const EDGE_PIXELS = 4;
// Cairo's stroker leaves a hole in a stroke whose half-width exceeds the
// radius of a closed contour (dot of i/j, period, colon, o counter).
// Stepping down by less than the smallest contour's diameter covers every
// distance; narrower strokes disable antialiasing so inner seams stay solid.
const RING_STEP_OF_FONT_SIZE = 0.055;
const RING_CACHE_SIZE = 16;
const WRAP_CACHE_SIZE = 64;
const METRICS_CACHE_SIZE = 32;

const ALIGNMENTS = Object.freeze({
    'center': Pango.Alignment.CENTER,
    'left': Pango.Alignment.LEFT,
    'right': Pango.Alignment.RIGHT,
});

const ANCHORS = new Set(['top', 'center', 'bottom']);
const BACKDROPS = new Set(['none', 'pill', 'box']);
const RUBY_SIZE_RATIO = 0.44;
const MIN_RUBY_FONT_SIZE = 12;

const utf8 = new TextEncoder();
const fromUtf8 = new TextDecoder();

/**
 * Validates and converts `params.ruby` ([[base, reading], ...]) into UTF-8 byte
 * spans for segments that carry a non-empty furigana reading. Returns null when
 * no valid readings apply to `text`.
 */
function rubyByteSpans(text, ruby) {
    if (!Array.isArray(ruby) || !ruby.length)
        return null;
    let joined = '';
    let bytePos = 0;
    const spans = [];
    for (const seg of ruby) {
        if (!Array.isArray(seg) || seg.length < 2)
            return null;
        const base = String(seg[0] ?? '');
        const reading = String(seg[1] ?? '').trim();
        const byteLen = utf8.encode(base).length;
        if (reading && base) {
            // Find the start byte of the final Unicode character in `base` so
            // Pango.Layout.index_to_pos() gives the exact right edge of the span.
            const chars = [...base];
            const lastLen = utf8.encode(chars[chars.length - 1]).length;
            spans.push({
                byteStart: bytePos,
                byteEnd: bytePos + byteLen,
                lastCharByte: bytePos + byteLen - lastLen,
                base,
                reading,
            });
        }
        joined += base;
        bytePos += byteLen;
    }
    if (joined !== text || !spans.length)
        return null;
    return spans;
}

function borderOptions(params) {
    return {
        ringWidths: params.ringWidths,
        cloud: Boolean(params.borderCloud),
    };
}

function edgePadding(params, fontSize) {
    const ring = borderSpec(params.border, fontSize, borderOptions(params));
    const backdropMode = params.backdrop ?? 'none';
    const bp = backdropMode === 'pill' ? backdropMetrics(fontSize) : {padX: 0, padY: 0};
    const reach = ring.totalReach + ring.extraPad;
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

function measureFontMetrics(context, spec) {
    const key = `${spec.fontSize}|${spec.family}|${spec.bold}|${spec.italic}`;
    const cached = cacheGet(metricsCache, key);
    if (cached)
        return cached;
    const layout = Pango.Layout.new(context);
    layout.set_font_description(fontDescription(spec));
    layout.set_text('a a', -1);
    const [, withSpace] = layout.get_pixel_extents();
    layout.set_text('aa', -1);
    const [, withoutSpace] = layout.get_pixel_extents();
    const spaceRatio = Math.max(0.05, (withSpace.width - withoutSpace.width) / spec.fontSize);

    layout.set_text('x', -1);
    const [xInk] = layout.get_iter().get_line_readonly().get_pixel_extents();
    const metrics = {
        spaceRatio,
        xTop: xInk.y,
        xBottom: xInk.y + xInk.height,
    };
    cacheSet(metricsCache, key, metrics, METRICS_CACHE_SIZE);
    return metrics;
}

function lastCharByteInRange(bytes, rangeStart, rangeEnd) {
    let idx = rangeEnd - 1;
    // Walk back past UTF-8 continuation bytes (10xxxxxx) to the lead byte.
    while (idx > rangeStart && (bytes[idx] & 0xc0) === 0x80)
        idx--;
    return idx;
}

/**
 * Computes wrapped-line vertical shifts and horizontal/vertical coordinates for
 * furigana ruby runs above kanji spans. All returned coordinates are relative
 * to the lyric block's canvas origin (x in canvas pixels, y relative to
 * `origin.y`).
 */
function buildRubyLayout(context, layout, text, spans, spec, params, ring, left, pad) {
    const bytes = utf8.encode(text);
    const rubyFontSize = Math.max(MIN_RUBY_FONT_SIZE, Math.round(spec.fontSize * RUBY_SIZE_RATIO));
    const rubySpec = {
        family: spec.family,
        bold: spec.bold,
        italic: spec.italic,
        fontSize: rubyFontSize,
        spaceScale: 1,
        align: 'left',
    };
    const rubyRing = borderSpec(params.border, rubyFontSize, borderOptions(params));
    const rubyFontMetrics = measureFontMetrics(context, rubySpec);
    const rubyMeasure = Pango.Layout.new(context);
    rubyMeasure.set_font_description(fontDescription(rubySpec));

    const wrappedLines = [];
    const iter = layout.get_iter();
    do {
        const line = iter.get_line_readonly();
        const [lineInk] = line.get_pixel_extents();
        const [, lineLogical] = iter.get_line_extents();
        const startByte = line.get_start_index();
        wrappedLines.push({
            startByte,
            endByte: startByte + line.get_length(),
            baseline: iter.get_baseline() / Pango.SCALE,
            x: left + lineLogical.x / Pango.SCALE,
            ink: lineInk,
            runs: [],
        });
    } while (iter.next_line());

    const rubyEdgeX = Math.ceil(rubyRing.totalReach + rubyRing.extraPad) + EDGE_PIXELS;
    const minRubyX = Math.min(pad.x, rubyEdgeX);
    const maxRubyRight = params.width - minRubyX;
    const minRunGap = Math.max(2, Math.round(rubyFontSize * 0.14));

    for (const span of spans) {
        const lineIdx = wrappedLines.findIndex(
            entry => span.byteStart >= entry.startByte && span.byteStart < entry.endByte,
        );
        if (lineIdx < 0)
            continue;
        const entry = wrappedLines[lineIdx];
        const endCharByte = span.byteEnd <= entry.endByte
            ? span.lastCharByte
            : lastCharByteInRange(bytes, span.byteStart, entry.endByte);
        const startPos = layout.index_to_pos(span.byteStart);
        const endPos = layout.index_to_pos(endCharByte);
        const spanLeft = Math.min(startPos.x, endPos.x) / Pango.SCALE;
        const spanRight = Math.max(startPos.x + startPos.width, endPos.x + endPos.width) / Pango.SCALE;
        const centerX = left + (spanLeft + spanRight) / 2;

        rubyMeasure.set_text(span.reading, -1);
        const [rInk, rLogical] = rubyMeasure.get_iter().get_line_readonly().get_pixel_extents();
        const width = Math.max(rLogical.width, rInk.x + rInk.width);
        const rawX = centerX - (rInk.x + rInk.width / 2);
        const clampedX = Math.max(minRubyX, Math.min(maxRubyRight - width, rawX));
        entry.runs.push({
            lineIdx,
            text: span.reading,
            x: Math.round(clampedX),
            width,
            ink: rInk,
        });
    }

    // Prevent adjacent furigana runs on the same wrapped line from colliding.
    for (const entry of wrappedLines) {
        if (entry.runs.length < 2)
            continue;
        entry.runs.sort((a, b) => a.x - b.x);
        for (let i = 1; i < entry.runs.length; i++) {
            const prev = entry.runs[i - 1];
            const cur = entry.runs[i];
            const minX = prev.x + prev.ink.x + prev.ink.width + minRunGap - cur.ink.x;
            if (cur.x < minX)
                cur.x = Math.round(minX);
        }
        // Pull back leftward if pushing right overflowed the right margin.
        const last = entry.runs[entry.runs.length - 1];
        const overflow = last.x + last.ink.x + last.ink.width - maxRubyRight;
        if (overflow > 0) {
            last.x = Math.round(last.x - overflow);
            for (let i = entry.runs.length - 2; i >= 0; i--) {
                const cur = entry.runs[i];
                const next = entry.runs[i + 1];
                const maxX = next.x + next.ink.x - minRunGap - (cur.ink.x + cur.ink.width);
                if (cur.x > maxX)
                    cur.x = Math.round(Math.max(minRubyX, maxX));
            }
        }
    }

    const baseInner = ring.rings[0]?.width ?? 0;
    const rubyGap = Math.max(Math.round(spec.fontSize * 0.11), Math.round(baseInner));
    const interlineAir = Math.max(
        Math.round(spec.fontSize * 0.22),
        Math.round(ring.totalReach + rubyRing.totalReach * 0.65),
    );

    const lineShifts = new Array(wrappedLines.length).fill(0);
    const runs = [];
    let cumulativeShift = 0;
    let prevBottomY = -Infinity;

    for (let i = 0; i < wrappedLines.length; i++) {
        const entry = wrappedLines[i];
        let rubyOffset = 0;
        let rubyTopInk = 0;
        if (entry.runs.length) {
            const maxBottom = Math.max(...entry.runs.map(r => r.ink.y + r.ink.height));
            const minTop = Math.min(...entry.runs.map(r => r.ink.y));
            rubyOffset = entry.ink.y - rubyGap - maxBottom;
            rubyTopInk = rubyOffset + minTop;
        }
        if (i > 0 && entry.runs.length) {
            const desiredTop = prevBottomY + interlineAir;
            const actualTop = entry.baseline + cumulativeShift + rubyTopInk;
            if (actualTop < desiredTop)
                cumulativeShift += desiredTop - actualTop;
        }
        lineShifts[i] = cumulativeShift;
        const baseY = entry.baseline + cumulativeShift;
        prevBottomY = baseY + entry.ink.y + entry.ink.height;

        if (entry.runs.length) {
            const rubyBaseY = baseY + rubyOffset;
            for (const run of entry.runs) {
                runs.push({
                    text: run.text,
                    x: run.x,
                    relY: rubyBaseY,
                    ink: run.ink,
                });
            }
        }
    }

    if (!runs.length)
        return null;

    // Visual bounding box across all base lines and ruby runs (relative to origin.y = 0).
    let minX = Infinity;
    let maxX = -Infinity;
    let minY = Infinity;
    let maxY = -Infinity;
    for (let i = 0; i < wrappedLines.length; i++) {
        const entry = wrappedLines[i];
        const baseY = entry.baseline + lineShifts[i];
        minX = Math.min(minX, entry.x + entry.ink.x - ring.totalReach);
        maxX = Math.max(maxX, entry.x + entry.ink.x + entry.ink.width + ring.totalReach);
        minY = Math.min(minY, baseY + entry.ink.y - ring.totalReach);
        maxY = Math.max(maxY, baseY + entry.ink.y + entry.ink.height + ring.totalReach);
    }
    for (const run of runs) {
        minX = Math.min(minX, run.x + run.ink.x - rubyRing.totalReach);
        maxX = Math.max(maxX, run.x + run.ink.x + run.ink.width + rubyRing.totalReach);
        minY = Math.min(minY, run.relY + run.ink.y - rubyRing.totalReach);
        maxY = Math.max(maxY, run.relY + run.ink.y + run.ink.height + rubyRing.totalReach);
    }

    return {
        spec: rubySpec,
        ring: rubyRing,
        fontMetrics: {xTop: rubyFontMetrics.xTop, xBottom: rubyFontMetrics.xBottom},
        lineShifts,
        runs,
        bounds: {minX, maxX, minY, maxY},
    };
}

/**
 * Lays out one lyric at exact `params.fontSize` (never shrinking per line).
 * @param {Pango.Context} context measuring context
 * @param {string} text
 * @param {{fontSize: number, family: string, bold: boolean, italic?: boolean,
 *          color: string, customColor?: string, border: string,
 *          borderCloud?: boolean, ringColors?: string[], ringWidths?: number[],
 *          backdrop?: string, backdropColor?: string, backdropOpacity?: number,
 *          align: string, anchor?: 'top'|'center'|'bottom',
 *          ruby?: Array<[string, string]>|null,
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

    const ring = borderSpec(params.border, params.fontSize, borderOptions(params));
    const pad = edgePadding(params, params.fontSize);
    const maxWidth = Math.max(1, params.width - 2 * pad.x);
    const layout = Pango.Layout.new(context);
    const fontMetrics = measureFontMetrics(context, {
        family: params.family,
        bold: Boolean(params.bold),
        italic: Boolean(params.italic),
        fontSize: params.fontSize,
    });
    const spec = {
        text,
        family: params.family,
        bold: Boolean(params.bold),
        italic: Boolean(params.italic),
        spaceScale: normalizedSpaceScale(fontMetrics.spaceRatio, ring.targetSpaceEm),
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

    let left;
    if (params.align === 'left')
        left = pad.x;
    else if (params.align === 'right')
        left = params.width - pad.x - spec.wrapWidth;
    else
        left = (params.width - spec.wrapWidth) / 2;

    const spans = rubyByteSpans(text, params.ruby);
    const rubyLayout = spans
        ? buildRubyLayout(context, layout, text, spans, spec, params, ring, left, pad)
        : null;

    let requiredHeight;
    let surfaceHeight;
    let top;
    let textInkBox;
    const solidReach = ring.totalReach;

    if (rubyLayout) {
        const bp = backdropMode === 'pill' ? backdropMetrics(spec.fontSize) : {padX: 0, padY: 0};
        const outerY = Math.ceil(Math.max(ring.extraPad, rubyLayout.ring.extraPad)) + bp.padY + EDGE_PIXELS;
        const contentH = rubyLayout.bounds.maxY - rubyLayout.bounds.minY;
        requiredHeight = Math.max(Math.ceil(contentH + 2 * outerY), Math.ceil(logical.height + 2 * pad.y));
        surfaceHeight = Math.max(params.height, requiredHeight);
        let boxTop;
        if (anchor === 'top')
            boxTop = outerY;
        else if (anchor === 'bottom')
            boxTop = Math.max(outerY, surfaceHeight - outerY - contentH);
        else
            boxTop = Math.max(outerY, (surfaceHeight - contentH) / 2);
        top = boxTop - rubyLayout.bounds.minY;
        textInkBox = {
            x: rubyLayout.bounds.minX,
            y: boxTop,
            width: rubyLayout.bounds.maxX - rubyLayout.bounds.minX,
            height: contentH,
        };
    } else {
        requiredHeight = Math.ceil(logical.height + 2 * pad.y);
        surfaceHeight = Math.max(params.height, requiredHeight);
        if (anchor === 'top')
            top = pad.y;
        else if (anchor === 'bottom')
            top = Math.max(pad.y, surfaceHeight - pad.y - logical.height);
        else
            top = Math.max(pad.y, (surfaceHeight - logical.height) / 2);
        textInkBox = {
            x: left + ink.x - solidReach,
            y: top + ink.y - solidReach,
            width: ink.width + 2 * solidReach,
            height: ink.height + 2 * solidReach,
        };
    }

    const origin = {x: left, y: top};
    const baseColors = ringColors(fill);
    const ringPalette = resolveRingColors(fill, ring.rings.length, params.ringColors);
    const colors = {
        inner: ringPalette[0] ?? baseColors.inner,
        outer: ringPalette[1] ?? baseColors.outer,
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
            const bx = Math.max(0, textInkBox.x - metrics.padX);
            const by = Math.max(0, textInkBox.y - metrics.padY);
            const br = Math.min(params.width, textInkBox.x + textInkBox.width + metrics.padX);
            const bb = Math.min(surfaceHeight, textInkBox.y + textInkBox.height + metrics.padY);
            backdrop = {
                x: bx, y: by, width: Math.max(1, br - bx), height: Math.max(1, bb - by),
                radius: metrics.radius, rgb: bgRgb, opacity: bgOpacity,
            };
        }
        inkBox = {x: backdrop.x, y: backdrop.y, width: backdrop.width, height: backdrop.height};
    }

    return {
        spec,
        fontMetrics: {xTop: fontMetrics.xTop, xBottom: fontMetrics.xBottom},
        origin,
        ring,
        border: params.border,
        ringColors: colors,
        ringPalette,
        fill,
        backdrop,
        inkBox,
        lineCount: lines,
        requiredHeight,
        anchor,
        rubyLayout,
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
const metricsCache = new Map();

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
    entry.aura?.surface.finish();
    for (const mask of entry.masks ?? [])
        mask?.finish();
}

function bridgeRect(ink, lineText, fontMetrics) {
    if (!fontMetrics || lineText.trim().length < 2)
        return null;
    const top = Math.max(ink.y, fontMetrics.xTop);
    const bottom = Math.min(ink.y + ink.height, fontMetrics.xBottom);
    if (bottom - top < 2)
        return null;
    return {x: ink.x, y: top, width: ink.width, height: bottom - top};
}

function strokedMask(line, width, height, dx, dy, reach, floor, step, bridge = null) {
    const surface = new Cairo.ImageSurface(Cairo.Format.A8, width, height);
    const cr = new Cairo.Context(surface);
    if (bridge) {
        const bx = bridge.x - dx - reach;
        const by = bridge.y - dy - reach;
        const bw = bridge.width + 2 * reach;
        const bh = bridge.height + 2 * reach;
        const r = Math.min(reach + bridge.height * 0.35, bh / 2);
        roundedRectangle(cr, bx, by, bw, bh, r);
        cr.fill();
    }
    cr.moveTo(-dx, -dy);
    PangoCairo.layout_line_path(cr, line);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    cr.setLineCap(Cairo.LineCap.ROUND);
    strokeBand(cr, reach, floor, step);
    cr.$dispose();
    return surface;
}

function boxBlurPass(src, width, height, horizontal) {
    const dst = new Cairo.ImageSurface(Cairo.Format.A8, width, height);
    const cr = new Cairo.Context(dst);
    cr.setOperator(Cairo.Operator.ADD);
    // 51/255 = 0.2 exact in A8, so 5 taps preserve alpha without rounding drift.
    cr.setSourceRGBA(0, 0, 0, 51 / 255);
    for (let k = -2; k <= 2; k++)
        cr.maskSurface(src, horizontal ? k : 0, horizontal ? 0 : k);
    cr.$dispose();
    return dst;
}

/**
 * Downscales a line silhouette and runs a 3-pass separable 5-tap box blur
 * (Gaussian approximation, sigma ~= 2.45 downscaled px) to produce a smooth
 * dark backing cloud in ~1 ms at any font size.
 */
function buildAuraMask(srcMask, width, height, spread) {
    const ds = Math.max(1, spread / 7.5);
    const aw = Math.max(1, Math.ceil(width / ds));
    const ah = Math.max(1, Math.ceil(height / ds));

    const down = new Cairo.ImageSurface(Cairo.Format.A8, aw, ah);
    const dcr = new Cairo.Context(down);
    dcr.scale(1 / ds, 1 / ds);
    dcr.setSourceRGBA(0, 0, 0, 1);
    dcr.maskSurface(srcMask, 0, 0);
    dcr.$dispose();

    // Expand by 1 downscaled px so the cloud stays rich right outside the outer rim.
    let cur = new Cairo.ImageSurface(Cairo.Format.A8, aw, ah);
    const ecr = new Cairo.Context(cur);
    ecr.setSourceRGBA(0, 0, 0, 1);
    for (const [ox, oy] of [[0, 0], [-1, 0], [1, 0], [0, -1], [0, 1]])
        ecr.maskSurface(down, ox, oy);
    ecr.$dispose();
    down.finish();

    for (let i = 0; i < 3; i++) {
        const mid = boxBlurPass(cur, aw, ah, true);
        cur.finish();
        cur = boxBlurPass(mid, aw, ah, false);
        mid.finish();
    }
    return {surface: cur, scale: ds};
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
 * Pre-renders every concentric border ring (and optional smooth dark backing
 * cloud) of one laid-out line into cached A8 alpha masks positioned relative
 * to its baseline.
 */
function lineRings(line, lineText, spec, border, ring, fontMetrics) {
    const geomSig = ring.rings.map(r => `${r.width.toFixed(2)}${r.feathered ? 'f' : ''}`).join(',');
    const key = `${spec.fontSize}|${spec.family}|${spec.bold}|${spec.italic}|${spec.spaceScale}|${border}|${geomSig}|${ring.auraSpread.toFixed(1)}|${lineText}`;
    const cached = cacheGet(ringCache, key);
    if (cached)
        return cached;

    const [ink] = line.get_pixel_extents();
    const {rings: ringList, totalReach, bridge: wantBridge, auraSpread, extraPad} = ring;
    const pad = Math.ceil(totalReach + extraPad) + 6;
    const dx = ink.x - pad;
    const dy = ink.y - pad;
    const width = ink.width + 2 * pad;
    const height = ink.height + 2 * pad;
    const step = Math.max(1, spec.fontSize * RING_STEP_OF_FONT_SIZE);
    const bridge = wantBridge ? bridgeRect(ink, lineText, fontMetrics) : null;

    const masks = [];
    let prevReach = 0;
    let lastSolidMask = null;
    for (const entry of ringList) {
        const reach = prevReach + entry.width;
        // Overlap 1.5 px beneath the next inner ring so concentric bands never
        // show a 1-pixel antialiased seam between adjacent colors.
        const seamFloor = prevReach > 0 ? Math.max(0, prevReach - 1.5) : 0;
        let mask;
        if (entry.feathered) {
            mask = new Cairo.ImageSurface(Cairo.Format.A8, width, height);
            const ocr = new Cairo.Context(mask);
            for (const band of GLOW_BANDS) {
                const bandSurf = strokedMask(
                    line, width, height, dx, dy, prevReach + entry.width * band.frac, seamFloor, step, bridge,
                );
                ocr.setSourceRGBA(0, 0, 0, band.alpha);
                ocr.maskSurface(bandSurf, 0, 0);
                bandSurf.finish();
            }
            ocr.$dispose();
        } else {
            mask = strokedMask(line, width, height, dx, dy, reach, seamFloor, step, bridge);
            lastSolidMask = mask;
        }
        masks.push(mask);
        prevReach = reach;
    }

    let aura = null;
    if (auraSpread > 0 && lastSolidMask)
        aura = buildAuraMask(lastSolidMask, width, height, auraSpread);

    const entry = {dx, dy, aura, masks};
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
    const rubyLayout = fitted.rubyLayout ?? null;

    if (!fitted.ring.rings.length && !rubyLayout) {
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
    let lineIdx = 0;
    do {
        const line = iter.get_line_readonly();
        const [, logical] = iter.get_line_extents();
        const start = line.get_start_index();
        const yShift = rubyLayout ? (rubyLayout.lineShifts[lineIdx] ?? 0) : 0;
        lines.push({
            line,
            text: fromUtf8.decode(bytes.subarray(start, start + line.get_length())),
            x: Math.round(fitted.origin.x + logical.x / Pango.SCALE),
            y: Math.round(fitted.origin.y + iter.get_baseline() / Pango.SCALE + yShift),
        });
        lineIdx++;
    } while (iter.next_line());

    // Build Pango layouts for every furigana run so they share the exact
    // same concentric border pipeline as the base lyrics.
    const rubyItems = [];
    if (rubyLayout) {
        const rubyDesc = fontDescription(rubyLayout.spec);
        for (const run of rubyLayout.runs) {
            const rl = PangoCairo.create_layout(cr);
            rl.set_font_description(rubyDesc);
            rl.set_text(run.text, -1);
            rubyItems.push({
                layout: rl,
                line: rl.get_iter().get_line_readonly(),
                text: run.text,
                x: Math.round(run.x),
                y: Math.round(fitted.origin.y + run.relY),
            });
        }
    }

    if (fitted.ring.rings.length) {
        for (const entry of lines) {
            entry.rings = lineRings(
                entry.line, entry.text, fitted.spec, fitted.border, fitted.ring, fitted.fontMetrics,
            );
        }
        for (const entry of rubyItems) {
            entry.rings = lineRings(
                entry.line, entry.text, rubyLayout.spec, fitted.border, rubyLayout.ring, rubyLayout.fontMetrics,
            );
        }

        // Paint layer-by-layer across base lines and furigana together
        // (cloud -> outermost ring -> ... -> innermost ring -> fills) so
        // stacked lines and kanji+furigana fuse into one continuous contour.
        if (fitted.ring.auraSpread > 0 && fitted.ring.auraAlpha > 0) {
            const dropY = Math.round(fitted.spec.fontSize * 0.03);
            for (const {x, y, rings} of lines) {
                if (!rings.aura)
                    continue;
                cr.save();
                cr.translate(x + rings.dx, y + rings.dy + dropY);
                cr.scale(rings.aura.scale, rings.aura.scale);
                cr.setSourceRGBA(0, 0, 0, fitted.ring.auraAlpha);
                cr.maskSurface(rings.aura.surface, 0, 0);
                cr.restore();
            }
            if (rubyLayout && rubyLayout.ring.auraSpread > 0 && rubyLayout.ring.auraAlpha > 0) {
                const rubyDropY = Math.round(rubyLayout.spec.fontSize * 0.03);
                for (const {x, y, rings} of rubyItems) {
                    if (!rings.aura)
                        continue;
                    cr.save();
                    cr.translate(x + rings.dx, y + rings.dy + rubyDropY);
                    cr.scale(rings.aura.scale, rings.aura.scale);
                    cr.setSourceRGBA(0, 0, 0, rubyLayout.ring.auraAlpha);
                    cr.maskSurface(rings.aura.surface, 0, 0);
                    cr.restore();
                }
            }
        }

        const palette = fitted.ringPalette ?? resolveRingColors(fitted.fill, fitted.ring.rings.length);
        for (let i = fitted.ring.rings.length - 1; i >= 0; i--) {
            cr.setSourceRGB(...palette[i]);
            for (const {x, y, rings} of lines) {
                if (rings.masks[i])
                    cr.maskSurface(rings.masks[i], x + rings.dx, y + rings.dy);
            }
            for (const {x, y, rings} of rubyItems) {
                if (rings.masks[i])
                    cr.maskSurface(rings.masks[i], x + rings.dx, y + rings.dy);
            }
        }
    }

    cr.newPath();
    for (const {line, x, y} of lines) {
        cr.moveTo(x, y);
        PangoCairo.layout_line_path(cr, line);
    }
    for (const {line, x, y} of rubyItems) {
        cr.moveTo(x, y);
        PangoCairo.layout_line_path(cr, line);
    }
    cr.setSourceRGB(...fitted.fill);
    cr.fill();
}
