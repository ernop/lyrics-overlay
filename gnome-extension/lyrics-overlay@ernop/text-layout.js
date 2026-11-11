// Fits one lyric into a region and paints it. Fitting runs on a shared
// measuring context; painting rebuilds the same layout on the cairo
// context, so measured and painted text agree to within hinting.

import Cairo from 'cairo';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

import {balancedWrapWidth, fitFontSize} from './shared/overlay-geometry.js';
import {TEXT_COLORS, ringColors} from './shared/text-ink.js';

const SMALLEST_FITTED_SIZE = 12;
const EDGE_PIXELS = 4;

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
    spec.wrapWidth = balancedWrapWidth(room(spec.fontSize).width, wrapWidth => measure(spec.fontSize, wrapWidth).get_line_count());

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

/** Paints a fitted lyric with its region's top-left at the cairo origin. */
export function paintLyric(cr, fitted) {
    const layout = PangoCairo.create_layout(cr);
    applySpec(layout, fitted.spec);
    cr.moveTo(fitted.origin.x, fitted.origin.y);
    const {inner, outer} = fitted.ring;
    if (inner === 0) {
        cr.setSourceRGBA(...fitted.fill, 1);
        PangoCairo.show_layout(cr, layout);
        return;
    }
    const rings = ringColors(fitted.fill);
    PangoCairo.layout_path(cr, layout);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    cr.setLineCap(Cairo.LineCap.ROUND);
    if (outer > 0) {
        cr.setSourceRGBA(...rings.outer, 1);
        cr.setLineWidth(2 * (inner + outer));
        cr.strokePreserve();
    }
    cr.setSourceRGBA(...rings.inner, 1);
    cr.setLineWidth(2 * inner);
    cr.strokePreserve();
    cr.setSourceRGBA(...fitted.fill, 1);
    cr.fill();
}
