// Pure Cairo/Pango rough sheet-music renderer shared between the standalone
// desktop overlay (desktop/lyric-window.js) and standalone verification tools.
// Draws a crisp 5-line musical staff directly below each lyric line, aligning
// every note horizontally under its matching word's pixel anchor.

import Cairo from 'cairo';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

import {
    MIDDLE_STAFF_STEP, STAFF_BOTTOM_STEP, STAFF_TOP_STEP,
    computeAutoBarsPerSystem, layoutSystemLyrics, planLeadSheetPage,
} from './score-layout.js';

export {computeAutoBarsPerSystem, planLeadSheetPage};

const FONT_FAMILY = 'Sans';
const COLOR_WHITE = [1, 1, 1];
const COLOR_BLACK = [0, 0, 0];
const COLOR_ACTIVE = [0.98, 0.80, 0.08]; // #facc15 bright gold
const COLOR_HARMONY_ABOVE = [0.13, 0.83, 0.93]; // #22d3ee cyan (dark staff)
const COLOR_HARMONY_BELOW = [0.29, 0.87, 0.50]; // #4ade80 green (dark staff)
const COLOR_PAPER_HARMONY_ABOVE = [0.11, 0.31, 0.85]; // #1d4ed8 deep blue (white paper)
const COLOR_PAPER_HARMONY_BELOW = [0.08, 0.50, 0.24]; // #15803d forest green (white paper)
const COLOR_PAPER_PLAYHEAD = [0.73, 0.11, 0.11]; // #b91c1c deep crimson playhead
const COLOR_PAPER_ACTIVE_BG = [0.99, 0.88, 0.28]; // #fde047 gold highlight
const COLOR_PAPER_SNAP = [0.76, 0.25, 0.05]; // #c2410c vivid burnt-orange (high contrast on white paper)
const COLOR_PAPER_VOICE2 = [0.118, 0.227, 0.541]; // #1e3a8a deep royal indigo (10.4:1 contrast on white paper)
const RADIUS = 8;

function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
}

function roundedRect(cr, x, y, width, height, radius) {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    cr.newSubPath();
    cr.arc(x + width - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + width - r, y + height - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + height - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

function drawText(cr, text, x, y, sizePx, rgb, {bold = true, align = 'left'} = {}) {
    const layout = PangoCairo.create_layout(cr);
    const desc = new Pango.FontDescription();
    desc.set_family(FONT_FAMILY);
    desc.set_weight(bold ? Pango.Weight.BOLD : Pango.Weight.NORMAL);
    desc.set_absolute_size(sizePx * Pango.SCALE);
    layout.set_font_description(desc);
    layout.set_text(String(text), -1);
    const [, logical] = layout.get_pixel_extents();
    let dx = x;
    if (align === 'center')
        dx = x - logical.width / 2;
    else if (align === 'right')
        dx = x - logical.width;
    cr.save();
    cr.setSourceRGB(rgb[0], rgb[1], rgb[2]);
    cr.moveTo(Math.round(dx), Math.round(y));
    PangoCairo.show_layout(cr, layout);
    cr.restore();
    return logical;
}

function measureTextWidth(cr, text, sizePx, bold = false) {
    const layout = PangoCairo.create_layout(cr);
    const desc = new Pango.FontDescription();
    desc.set_family(FONT_FAMILY);
    desc.set_weight(bold ? Pango.Weight.BOLD : Pango.Weight.NORMAL);
    desc.set_absolute_size(sizePx * Pango.SCALE);
    layout.set_font_description(desc);
    layout.set_text(String(text), -1);
    const [, logical] = layout.get_pixel_extents();
    return logical.width;
}

/** Draws a vector treble clef centered on the G4 line (step 32). */
function drawTrebleClef(cr, x, yForStep, sp, octaveDown, inkRgb = COLOR_WHITE) {
    const gY = yForStep(32); // G4 line
    const bY = yForStep(34);
    const topY = yForStep(39.8);
    const botY = yForStep(27.6);

    cr.save();
    cr.setSourceRGB(inkRgb[0], inkRgb[1], inkRgb[2]);
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineJoin(Cairo.LineJoin.ROUND);

    // Main G-clef scroll around G4 -> belly down to E4 -> loop up above F5 -> spine down to tail.
    cr.setLineWidth(Math.max(1.4, sp * 0.21));
    cr.newPath();
    cr.moveTo(x + sp * 0.05, gY + sp * 0.15);
    cr.curveTo(x - sp * 0.45, gY - sp * 0.55, x + sp * 0.55, gY - sp * 0.85, x + sp * 0.72, gY + sp * 0.05);
    cr.curveTo(x + sp * 0.82, gY + sp * 0.82, x - sp * 0.55, gY + sp * 1.15, x - sp * 0.62, gY + sp * 0.10);
    cr.curveTo(x - sp * 0.68, bY - sp * 0.75, x + sp * 0.55, yForStep(37.5), x + sp * 0.35, topY);
    cr.curveTo(x + sp * 0.18, topY - sp * 0.65, x - sp * 0.30, topY - sp * 0.35, x - sp * 0.15, yForStep(37.5));
    cr.lineTo(x + sp * 0.18, botY);
    cr.curveTo(x + sp * 0.25, botY + sp * 0.65, x - sp * 0.35, botY + sp * 0.65, x - sp * 0.42, botY + sp * 0.22);
    cr.stroke();

    // Small decorative terminal dot on lower curl.
    cr.arc(x - sp * 0.36, botY + sp * 0.18, Math.max(1.2, sp * 0.18), 0, Math.PI * 2);
    cr.fill();

    if (octaveDown) {
        drawText(cr, '8', x + sp * 0.05, botY + sp * 0.35, Math.max(8, sp * 0.95), inkRgb, {
            bold: true,
            align: 'center',
        });
    }
    cr.restore();
}

function drawSharp(cr, x, y, sp, rgb) {
    const h = sp * 1.15;
    const w = sp * 0.42;
    cr.save();
    cr.setSourceRGB(rgb[0], rgb[1], rgb[2]);
    cr.setLineCap(Cairo.LineCap.ROUND);
    // Two vertical bars
    cr.setLineWidth(Math.max(1.0, sp * 0.13));
    cr.moveTo(x - w * 0.45, y - h * 0.52);
    cr.lineTo(x - w * 0.45, y + h * 0.52);
    cr.moveTo(x + w * 0.45, y - h * 0.58);
    cr.lineTo(x + w * 0.45, y + h * 0.46);
    cr.stroke();
    // Two thicker slanted crossbars
    cr.setLineWidth(Math.max(1.6, sp * 0.22));
    cr.moveTo(x - w, y - sp * 0.18);
    cr.lineTo(x + w, y - sp * 0.34);
    cr.moveTo(x - w, y + sp * 0.34);
    cr.lineTo(x + w, y + sp * 0.18);
    cr.stroke();
    cr.restore();
}

function drawFlat(cr, x, y, sp, rgb) {
    cr.save();
    cr.setSourceRGB(rgb[0], rgb[1], rgb[2]);
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    cr.setLineWidth(Math.max(1.2, sp * 0.16));
    cr.moveTo(x - sp * 0.22, y - sp * 1.15);
    cr.lineTo(x - sp * 0.22, y + sp * 0.45);
    cr.curveTo(x + sp * 0.52, y + sp * 0.10, x + sp * 0.46, y - sp * 0.48, x - sp * 0.22, y - sp * 0.12);
    cr.stroke();
    cr.restore();
}

function drawNatural(cr, x, y, sp, rgb) {
    const w = sp * 0.34;
    cr.save();
    cr.setSourceRGB(rgb[0], rgb[1], rgb[2]);
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineWidth(Math.max(1.0, sp * 0.13));
    cr.moveTo(x - w, y - sp * 0.85);
    cr.lineTo(x - w, y + sp * 0.35);
    cr.moveTo(x + w, y - sp * 0.35);
    cr.lineTo(x + w, y + sp * 0.85);
    cr.stroke();
    cr.setLineWidth(Math.max(1.5, sp * 0.20));
    cr.moveTo(x - w, y - sp * 0.20);
    cr.lineTo(x + w, y - sp * 0.34);
    cr.moveTo(x - w, y + sp * 0.34);
    cr.lineTo(x + w, y + sp * 0.20);
    cr.stroke();
    cr.restore();
}

function drawAccidental(cr, kind, x, y, sp, rgb) {
    if (kind === 'sharp')
        drawSharp(cr, x, y, sp, rgb);
    else if (kind === 'flat')
        drawFlat(cr, x, y, sp, rgb);
    else if (kind === 'natural')
        drawNatural(cr, x, y, sp, rgb);
}

function drawLedgerLines(cr, x, writtenStep, yForStep, sp, rx, rgb) {
    cr.save();
    cr.setSourceRGB(rgb[0], rgb[1], rgb[2]);
    cr.setLineWidth(Math.max(1.1, sp * 0.13));
    const halfW = rx + sp * 0.38;
    if (writtenStep <= STAFF_BOTTOM_STEP - 2) {
        for (let step = STAFF_BOTTOM_STEP - 2; step >= writtenStep; step -= 2) {
            const ly = yForStep(step);
            cr.moveTo(x - halfW, ly);
            cr.lineTo(x + halfW, ly);
        }
    }
    if (writtenStep >= STAFF_TOP_STEP + 2) {
        for (let step = STAFF_TOP_STEP + 2; step <= writtenStep; step += 2) {
            const ly = yForStep(step);
            cr.moveTo(x - halfW, ly);
            cr.lineTo(x + halfW, ly);
        }
    }
    cr.stroke();
    cr.restore();
}

function drawNotehead(cr, x, y, sp, hollow, isWhole, rgb) {
    const rx = sp * (isWhole ? 0.72 : 0.62);
    const ry = sp * 0.45;
    cr.save();
    cr.translate(x, y);
    cr.setSourceRGB(rgb[0], rgb[1], rgb[2]);
    if (hollow) {
        cr.setFillRule(Cairo.FillRule.EVEN_ODD);
        cr.save();
        if (!isWhole)
            cr.rotate(-0.34);
        cr.scale(rx, ry);
        cr.arc(0, 0, 1, 0, Math.PI * 2);
        cr.restore();

        cr.save();
        cr.rotate(isWhole ? 0.25 : -0.34);
        cr.scale(rx * (isWhole ? 0.50 : 0.64), ry * (isWhole ? 0.68 : 0.48));
        cr.newSubPath();
        cr.arc(0, 0, 1, 0, Math.PI * 2);
        cr.restore();
        cr.fill();
    } else {
        cr.rotate(-0.34);
        cr.scale(rx, ry);
        cr.arc(0, 0, 1, 0, Math.PI * 2);
        cr.fill();
    }
    cr.restore();
}

function drawHarmonyDiamond(cr, x, y, sp, rgb) {
    const rx = sp * 0.36;
    const ry = sp * 0.24;
    cr.save();
    cr.setSourceRGB(rgb[0], rgb[1], rgb[2]);
    cr.setLineWidth(Math.max(1.3, sp * 0.15));
    cr.newPath();
    cr.moveTo(x, y - ry);
    cr.lineTo(x + rx, y);
    cr.lineTo(x, y + ry);
    cr.lineTo(x - rx, y);
    cr.closePath();
    cr.stroke();
    cr.restore();
}

function drawRest(cr, item, x, yForStep, sp, inkRgb = COLOR_WHITE) {
    cr.save();
    cr.setSourceRGB(inkRgb[0], inkRgb[1], inkRgb[2]);
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineJoin(Cairo.LineJoin.ROUND);

    if (item.figure === 'whole') {
        cr.rectangle(x - sp * 0.45, yForStep(36), sp * 0.90, sp * 0.46);
        cr.fill();
    } else if (item.figure === 'half') {
        cr.rectangle(x - sp * 0.45, yForStep(34) - sp * 0.46, sp * 0.90, sp * 0.46);
        cr.fill();
    } else if (item.figure === 'quarter') {
        const midY = yForStep(34);
        cr.setLineWidth(Math.max(1.5, sp * 0.22));
        cr.moveTo(x - sp * 0.18, midY - sp * 1.15);
        cr.lineTo(x + sp * 0.26, midY - sp * 0.45);
        cr.lineTo(x - sp * 0.24, midY + sp * 0.18);
        cr.lineTo(x + sp * 0.26, midY + sp * 0.72);
        cr.curveTo(x - sp * 0.28, midY + sp * 0.68, x - sp * 0.34, midY + sp * 1.15, x + sp * 0.12, midY + sp * 1.32);
        cr.stroke();
    } else if (item.figure === 'sixteenth') {
        const midY = yForStep(34);
        cr.arc(x - sp * 0.18, midY - sp * 0.55, sp * 0.20, 0, Math.PI * 2);
        cr.fill();
        cr.arc(x - sp * 0.26, midY + sp * 0.08, sp * 0.20, 0, Math.PI * 2);
        cr.fill();
        cr.setLineWidth(Math.max(1.3, sp * 0.16));
        cr.moveTo(x - sp * 0.14, midY - sp * 0.52);
        cr.curveTo(x + sp * 0.12, midY - sp * 0.34, x + sp * 0.24, midY - sp * 0.50, x + sp * 0.34, midY - sp * 0.70);
        cr.lineTo(x - sp * 0.18, midY + sp * 1.20);
        cr.stroke();
        cr.moveTo(x - sp * 0.22, midY + sp * 0.10);
        cr.curveTo(x + sp * 0.04, midY + sp * 0.25, x + sp * 0.16, midY + sp * 0.08, x + sp * 0.24, midY - sp * 0.10);
        cr.stroke();
    } else {
        // Eighth rest
        const midY = yForStep(34);
        cr.arc(x - sp * 0.22, midY - sp * 0.32, sp * 0.22, 0, Math.PI * 2);
        cr.fill();
        cr.setLineWidth(Math.max(1.4, sp * 0.17));
        cr.moveTo(x - sp * 0.18, midY - sp * 0.28);
        cr.curveTo(x + sp * 0.08, midY - sp * 0.10, x + sp * 0.24, midY - sp * 0.28, x + sp * 0.34, midY - sp * 0.50);
        cr.lineTo(x - sp * 0.12, midY + sp * 1.05);
        cr.stroke();
    }

    if (item.dots > 0) {
        cr.arc(x + sp * 0.72, yForStep(35), Math.max(1.4, sp * 0.17), 0, Math.PI * 2);
        cr.fill();
    }
    cr.restore();
}

function drawFlag(cr, stemX, tipY, stemDir, flags, sp, rgb) {
    cr.save();
    cr.setSourceRGB(rgb[0], rgb[1], rgb[2]);
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setLineWidth(Math.max(1.8, sp * 0.25));
    for (let f = 0; f < flags; f++) {
        const y0 = tipY + (stemDir > 0 ? f * sp * 0.62 : -f * sp * 0.62);
        const dy = stemDir > 0 ? sp * 1.35 : -sp * 1.35;
        cr.moveTo(stemX, y0);
        cr.curveTo(
            stemX + sp * 0.85,
            y0 + dy * 0.35,
            stemX + sp * 0.92,
            y0 + dy * 0.78,
            stemX + sp * 0.35,
            y0 + dy,
        );
        cr.stroke();
    }
    cr.restore();
}

function drawArcCurve(cr, x1, y1, x2, y2, bulge, rgb, width) {
    const midX = (x1 + x2) / 2;
    const midY = (y1 + y2) / 2 + bulge;
    cr.save();
    cr.setSourceRGB(rgb[0], rgb[1], rgb[2]);
    cr.setLineWidth(width);
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.moveTo(x1, y1);
    cr.curveTo(x1 + (x2 - x1) * 0.28, midY, x1 + (x2 - x1) * 0.72, midY, x2, y2);
    cr.stroke();
    cr.restore();
}

/**
 * Computes collision-free horizontal positions for every item in a single
 * visual system (one wrapped lyric line's words + notes), anchored directly
 * underneath each matching word's pixel span.
 */
function placeSystemItems(items, wordAnchorsMap, contentLeft, contentRight, sp) {
    const placed = [];
    const byWord = new Map();
    for (const item of items) {
        if (item.kind === 'note') {
            const list = byWord.get(item.wordIndex) ?? [];
            list.push(item);
            byWord.set(item.wordIndex, list);
        }
    }

    // Track per-word sub-index so multi-note melismas spread cleanly across their word.
    const wordNoteCursor = new Map();
    let prevAnchorX = contentLeft;

    for (const item of items) {
        const anchor = wordAnchorsMap.get(item.wordIndex);
        let targetX = prevAnchorX + sp * 1.8;
        if (anchor) {
            if (item.kind === 'note') {
                const group = byWord.get(item.wordIndex) ?? [item];
                const k = group.length;
                const pos = wordNoteCursor.get(item.wordIndex) ?? 0;
                wordNoteCursor.set(item.wordIndex, pos + 1);
                if (k === 1) {
                    targetX = anchor.xLeft + Math.min(anchor.width * 0.42, Math.max(sp * 1.1, anchor.width * 0.5));
                } else {
                    const pad = Math.min(anchor.width * 0.12, sp * 0.6);
                    const usable = Math.max(anchor.width - 2 * pad, (k - 1) * sp * 1.9);
                    targetX = anchor.xLeft + pad + (usable * pos) / Math.max(1, k - 1);
                }
            } else if (item.kind === 'barline') {
                targetX = Math.max(contentLeft, anchor.xLeft - sp * 1.0);
            } else if (item.kind === 'rest') {
                targetX = (prevAnchorX + anchor.xLeft) / 2;
            }
        }
        prevAnchorX = targetX;

        const leftExt = item.kind === 'note'
            ? (item.accidental ? sp * 1.85 : sp * 0.85)
            : (item.kind === 'barline' ? sp * 0.45 : sp * 0.75);
        const rightExt = item.kind === 'note'
            ? (item.dots > 0 ? sp * 1.45 : sp * 0.95)
            : (item.kind === 'barline' ? sp * 0.55 : sp * 0.85);

        placed.push({
            item,
            x: clamp(targetX, contentLeft + leftExt, contentRight - rightExt),
            leftExt,
            rightExt,
        });
    }

    // Forward anti-collision pass: ensure no two adjacent symbols ever touch or overlap.
    const minGap = sp * 0.55;
    for (let i = 1; i < placed.length; i++) {
        const prev = placed[i - 1];
        const cur = placed[i];
        const minX = prev.x + prev.rightExt + minGap + cur.leftExt;
        if (cur.x < minX)
            cur.x = minX;
    }

    // Pullback pass if pushing rightward exceeded the system right edge.
    if (placed.length) {
        const last = placed[placed.length - 1];
        const overflow = (last.x + last.rightExt) - contentRight;
        if (overflow > 0) {
            const first = placed[0];
            const available = Math.max(1, contentRight - contentLeft - first.leftExt - last.rightExt);
            const currentSpan = Math.max(1, last.x - first.x);
            if (currentSpan > available) {
                const scale = available / currentSpan;
                const origin = contentLeft + first.leftExt;
                for (const p of placed)
                    p.x = origin + (p.x - first.x) * scale;
            } else {
                last.x -= overflow;
                for (let i = placed.length - 2; i >= 0; i--) {
                    const cur = placed[i];
                    const next = placed[i + 1];
                    const maxX = next.x - next.leftExt - minGap - cur.rightExt;
                    if (cur.x > maxX)
                        cur.x = Math.max(contentLeft + cur.leftExt, maxX);
                }
            }
        }
    }

    return placed;
}

/**
 * Paints one rough sheet-music staff system into `[box.x, box.y, box.width, box.height]`.
 *
 * @param {Cairo.Context} cr
 * @param {{
 *   box: {x: number, y: number, width: number, height: number},
 *   lineScore: ReturnType<import('./score-layout.js').buildLineScore>,
 *   items: Array<object>,
 *   wordAnchors: Map<number, {xLeft: number, xRight: number, xCenter: number, width: number}>,
 *   activeNoteId?: number|null,
 *   showHeader?: boolean,
 *   noteNames?: 'off'|'letters'|'degrees',
 *   backgroundOpacity?: number,
 * }} params
 */
export function paintStaffSystem(cr, {
    box,
    lineScore,
    items,
    wordAnchors,
    activeNoteId = null,
    showHeader = true,
    noteNames = 'letters',
    backgroundOpacity = 0.78,
}) {
    if (!lineScore || !box || box.width < 80 || box.height < 40)
        return;

    const {x, y, width, height} = box;
    const sp = clamp(height * 0.096, 5.8, 13.5);
    const showLabels = noteNames === 'letters' || noteNames === 'degrees';
    const labelBandH = showLabels ? Math.max(14, Math.round(sp * 1.45)) : 0;
    const headerBandH = showHeader && (lineScore.keyLabel || lineScore.bpm) ? Math.max(15, Math.round(sp * 1.55)) : 0;

    // 1. Crisp dark translucent backing strip with subtle white rim.
    if (backgroundOpacity > 0) {
        roundedRect(cr, x, y, width, height, RADIUS);
        cr.setSourceRGBA(0, 0, 0, backgroundOpacity);
        cr.fillPreserve();
        cr.setSourceRGBA(1, 1, 1, Math.min(0.32, backgroundOpacity * 0.42));
        cr.setLineWidth(1);
        cr.stroke();
    }

    // Center the 5-line staff cleanly between header tag (top) and note names (bottom),
    // keeping treble clef's top loop cleanly below the header badge.
    const staffH = sp * 4;
    const minTopY = y + headerBandH + sp * 1.15;
    const maxTopY = Math.max(minTopY, y + height - labelBandH - staffH - sp * 0.9);
    let staffTopY = minTopY + Math.max(0, (maxTopY - minTopY) / 2);
    const notesOnly = items.filter(it => it.kind === 'note');
    if (notesOnly.length) {
        let minStep = STAFF_BOTTOM_STEP;
        let maxStep = STAFF_TOP_STEP;
        for (const n of notesOnly) {
            minStep = Math.min(minStep, n.writtenStep);
            maxStep = Math.max(maxStep, n.writtenStep);
            if (n.harmonyAbove)
                maxStep = Math.max(maxStep, n.harmonyAbove.writtenStep);
            if (n.harmonyBelow)
                minStep = Math.min(minStep, n.harmonyBelow.writtenStep);
        }
        const extraAbove = Math.max(0, maxStep - STAFF_TOP_STEP) * (sp * 0.5);
        const extraBelow = Math.max(0, STAFF_BOTTOM_STEP - minStep) * (sp * 0.5);
        const shift = clamp((extraAbove - extraBelow) * 0.45, -sp * 0.9, sp * 0.9);
        staffTopY = clamp(staffTopY + shift, minTopY, maxTopY);
    }
    const staffBottomY = staffTopY + staffH;
    const yForStep = step => staffBottomY - (step - STAFF_BOTTOM_STEP) * (sp * 0.5);

    // 2. Key + BPM badge in top-left corner (pure white bold), shifted past clef top loop.
    if (headerBandH > 0) {
        const parts = [];
        if (lineScore.keyLabel)
            parts.push(lineScore.keyLabel);
        if (lineScore.bpm)
            parts.push(`${lineScore.bpm} BPM`);
        if (lineScore.clef === 'treble-8vb')
            parts.push('8vb');
        drawText(cr, parts.join(' \u00b7 '), x + Math.round(sp * 3.1), y + 2, Math.max(10, sp * 1.12), COLOR_WHITE, {bold: true});
    }

    // 3. 5 Staff Lines.
    const staffLeft = x + 8;
    const staffRight = x + width - 8;
    cr.save();
    cr.setSourceRGBA(1, 1, 1, 0.85);
    cr.setLineWidth(Math.max(1.0, sp * 0.11));
    for (let lineIdx = 0; lineIdx < 5; lineIdx++) {
        const ly = Math.round(staffTopY + lineIdx * sp) + 0.5;
        cr.moveTo(staffLeft, ly);
        cr.lineTo(staffRight, ly);
    }
    cr.stroke();
    cr.restore();

    // 4. Clef, Key Signature, and Time Signature.
    let cursorX = staffLeft + sp * 1.15;
    drawTrebleClef(cr, cursorX, yForStep, sp, lineScore.clef === 'treble-8vb');
    cursorX += sp * 1.45;

    for (const acc of lineScore.keySig?.accidentals ?? []) {
        drawAccidental(cr, acc.kind, cursorX, yForStep(acc.step), sp * 0.92, COLOR_WHITE);
        cursorX += sp * 0.85;
    }
    if ((lineScore.keySig?.accidentals?.length ?? 0) > 0)
        cursorX += sp * 0.25;

    if (showHeader && Array.isArray(lineScore.meter) && lineScore.meter.length === 2) {
        const tsSize = Math.max(10, sp * 1.75);
        drawText(cr, String(lineScore.meter[0]), cursorX + sp * 0.5, staffTopY - sp * 0.18, tsSize, COLOR_WHITE, {
            bold: true,
            align: 'center',
        });
        drawText(cr, String(lineScore.meter[1]), cursorX + sp * 0.5, staffTopY + sp * 1.82, tsSize, COLOR_WHITE, {
            bold: true,
            align: 'center',
        });
        cursorX += sp * 1.55;
    }

    // 5. Place items horizontally anchored to their matching words.
    const contentLeft = cursorX + sp * 0.6;
    const contentRight = staffRight - sp * 0.8;
    if (!items.length || contentRight <= contentLeft + sp)
        return;

    const placed = placeSystemItems(items, wordAnchors, contentLeft, contentRight, sp);
    const rx = sp * 0.62;
    const stemLen = sp * 3.15;

    // Precompute beam group geometry (sloped beam endpoints connecting stems).
    const beamGroups = new Map();
    for (const entry of placed) {
        if (entry.item.kind === 'note' && entry.item.beamGroup !== null) {
            const list = beamGroups.get(entry.item.beamGroup) ?? [];
            list.push(entry);
            beamGroups.set(entry.item.beamGroup, list);
        }
    }
    const stemTipYById = new Map();
    const beamLines = [];

    for (const [gid, group] of beamGroups.entries()) {
        if (group.length < 2)
            continue;
        const dir = group[0].item.stemDir;
        const first = group[0];
        const last = group[group.length - 1];
        const x1 = first.x + (dir > 0 ? rx * 0.92 : -rx * 0.92);
        const x2 = last.x + (dir > 0 ? rx * 0.92 : -rx * 0.92);
        const y1Raw = yForStep(first.item.writtenStep) - dir * stemLen;
        const y2Raw = yForStep(last.item.writtenStep) - dir * stemLen;
        const dx = Math.max(1, x2 - x1);
        const maxSlope = 0.30;
        const clampedDy = clamp(y2Raw - y1Raw, -dx * maxSlope, dx * maxSlope);
        let beamY1 = (y1Raw + y2Raw) / 2 - clampedDy / 2;
        let beamY2 = (y1Raw + y2Raw) / 2 + clampedDy / 2;

        // Guarantee every stem in the beam group has at least `sp * 2.1` length.
        const minStem = sp * 2.15;
        let adjust = 0;
        for (const entry of group) {
            const sx = entry.x + (dir > 0 ? rx * 0.92 : -rx * 0.92);
            const t = clamp((sx - x1) / dx, 0, 1);
            const by = beamY1 + t * (beamY2 - beamY1);
            const ny = yForStep(entry.item.writtenStep);
            if (dir > 0 && ny - by < minStem)
                adjust = Math.min(adjust, (ny - minStem) - by);
            else if (dir < 0 && by - ny < minStem)
                adjust = Math.max(adjust, (ny + minStem) - by);
        }
        const minBeamY = y + headerBandH + 2;
        const maxBeamY = y + height - labelBandH - 3;
        beamY1 = clamp(beamY1 + adjust, minBeamY, maxBeamY);
        beamY2 = clamp(beamY2 + adjust, minBeamY, maxBeamY);

        for (const entry of group) {
            const sx = entry.x + (dir > 0 ? rx * 0.92 : -rx * 0.92);
            const t = clamp((sx - x1) / dx, 0, 1);
            stemTipYById.set(entry.item.id, beamY1 + t * (beamY2 - beamY1));
        }
        beamLines.push({gid, group, dir, x1, y1: beamY1, x2, y2: beamY2});
    }

    // 6. Paint barlines, rests, harmony guide notes, active playhead, lead notes, stems, flags.
    const notePosById = new Map();

    for (const entry of placed) {
        const {item, x: px} = entry;

        if (item.kind === 'barline') {
            cr.save();
            cr.setSourceRGBA(1, 1, 1, 0.92);
            cr.setLineWidth(Math.max(1.2, sp * 0.14));
            cr.moveTo(Math.round(px) + 0.5, staffTopY);
            cr.lineTo(Math.round(px) + 0.5, staffBottomY);
            cr.stroke();
            cr.restore();
            continue;
        }

        if (item.kind === 'rest') {
            drawRest(cr, item, px, yForStep, sp);
            continue;
        }

        const isActive = activeNoteId !== null && item.id === activeNoteId;
        const rgb = isActive ? COLOR_ACTIVE : COLOR_WHITE;
        const ny = yForStep(item.writtenStep);
        notePosById.set(item.id, {x: px, y: ny, item, isActive});

        // Subtle gold vertical playhead marker behind active note.
        if (isActive) {
            cr.save();
            cr.setSourceRGBA(COLOR_ACTIVE[0], COLOR_ACTIVE[1], COLOR_ACTIVE[2], 0.24);
            cr.rectangle(px - sp * 1.15, staffTopY - sp * 0.7, sp * 2.3, staffH + sp * 1.4);
            cr.fill();
            cr.restore();
        }

        // Harmony guide notes (3rd above in cyan, 3rd below in green) painted before lead notehead.
        if (item.harmonyAbove) {
            const hy = yForStep(item.harmonyAbove.writtenStep);
            drawLedgerLines(cr, px, item.harmonyAbove.writtenStep, yForStep, sp, sp * 0.52, COLOR_HARMONY_ABOVE);
            if (item.harmonyAbove.accidental)
                drawAccidental(cr, item.harmonyAbove.accidental, px - sp * 1.15, hy, sp * 0.78, COLOR_HARMONY_ABOVE);
            drawHarmonyDiamond(cr, px, hy, sp, COLOR_HARMONY_ABOVE);
        }
        if (item.harmonyBelow) {
            const hy = yForStep(item.harmonyBelow.writtenStep);
            drawLedgerLines(cr, px, item.harmonyBelow.writtenStep, yForStep, sp, sp * 0.52, COLOR_HARMONY_BELOW);
            if (item.harmonyBelow.accidental)
                drawAccidental(cr, item.harmonyBelow.accidental, px - sp * 1.15, hy, sp * 0.78, COLOR_HARMONY_BELOW);
            drawHarmonyDiamond(cr, px, hy, sp, COLOR_HARMONY_BELOW);
        }

        // Ledger lines, accidental, notehead, dot.
        drawLedgerLines(cr, px, item.writtenStep, yForStep, sp, rx, rgb);
        if (item.accidental)
            drawAccidental(cr, item.accidental, px - sp * 1.15, ny, sp, rgb);
        drawNotehead(cr, px, ny, sp, item.hollow, item.figure === 'whole', rgb);

        if (item.dots > 0) {
            // Shift dot slightly above staff line when note sits directly on a line.
            const dotY = item.writtenStep % 2 === 0 ? ny - sp * 0.36 : ny;
            cr.save();
            cr.setSourceRGB(rgb[0], rgb[1], rgb[2]);
            cr.arc(px + rx + sp * 0.42, dotY, Math.max(1.5, sp * 0.19), 0, Math.PI * 2);
            cr.fill();
            cr.restore();
        }

        // Stem + unbeamed flag(s), clamped inside top header and bottom label bands.
        const stemMinY = y + headerBandH + 2;
        const stemMaxY = y + height - labelBandH - 3;
        if (item.stem) {
            const dir = item.stemDir;
            const stemX = px + (dir > 0 ? rx * 0.92 : -rx * 0.92);
            const rawTipY = stemTipYById.get(item.id) ?? (ny - dir * stemLen);
            const tipY = clamp(rawTipY, stemMinY, stemMaxY);
            cr.save();
            cr.setSourceRGB(rgb[0], rgb[1], rgb[2]);
            cr.setLineWidth(Math.max(1.3, sp * 0.15));
            cr.moveTo(stemX, ny - dir * sp * 0.12);
            cr.lineTo(stemX, tipY);
            cr.stroke();
            cr.restore();

            if (item.flags > 0 && item.beamGroup === null)
                drawFlag(cr, stemX, tipY, dir, item.flags, sp, rgb);
        }

        if (item.triplet && item.beamGroup === null) {
            const ty = item.stemDir > 0 ? ny - stemLen - sp * 1.1 : ny + stemLen + sp * 0.15;
            drawText(cr, '3', px, ty, Math.max(8.5, sp * 0.9), rgb, {bold: true, align: 'center'});
        }

        // Crisp note name or scale degree label along bottom band.
        if (showLabels) {
            const label = noteNames === 'degrees' ? (item.degree || item.noteName) : item.noteName;
            if (label) {
                const labelSize = Math.max(9, sp * 0.98);
                drawText(cr, label, px, y + height - labelBandH - 1, labelSize, rgb, {bold: true, align: 'center'});
            }
        }
    }

    // 7. Paint sloped beams for beamed eighth / 16th groups.
    const beamThick = Math.max(2.6, sp * 0.40);
    for (const beam of beamLines) {
        const {group, dir, x1, y1, x2, y2} = beam;
        const hasActive = activeNoteId !== null && group.some(e => e.item.id === activeNoteId);
        const rgb = hasActive ? COLOR_ACTIVE : COLOR_WHITE;
        const offsetSign = dir > 0 ? 1 : -1;

        cr.save();
        cr.setSourceRGB(rgb[0], rgb[1], rgb[2]);
        cr.newPath();
        cr.moveTo(x1, y1);
        cr.lineTo(x2, y2);
        cr.lineTo(x2, y2 + offsetSign * beamThick);
        cr.lineTo(x1, y1 + offsetSign * beamThick);
        cr.closePath();
        cr.fill();

        // Secondary 16th-note beam segments.
        const secondOffset = offsetSign * (beamThick + sp * 0.28);
        const dx = Math.max(1, x2 - x1);
        for (let i = 0; i < group.length; i++) {
            if (group[i].item.flags < 2)
                continue;
            const sx = group[i].x + (dir > 0 ? rx * 0.92 : -rx * 0.92);
            let bx1 = sx;
            let bx2 = sx;
            if (i + 1 < group.length && group[i + 1].item.flags >= 2) {
                bx2 = group[i + 1].x + (dir > 0 ? rx * 0.92 : -rx * 0.92);
            } else if (i > 0 && group[i - 1].item.flags >= 2) {
                continue; // Already covered by previous pair.
            } else {
                // Short stub beam toward interior of group.
                const stub = sp * 0.85;
                if (i === 0)
                    bx2 = sx + stub;
                else
                    bx1 = sx - stub;
            }
            const t1 = clamp((bx1 - x1) / dx, 0, 1);
            const t2 = clamp((bx2 - x1) / dx, 0, 1);
            const sy1 = y1 + t1 * (y2 - y1) + secondOffset;
            const sy2 = y1 + t2 * (y2 - y1) + secondOffset;
            cr.newPath();
            cr.moveTo(bx1, sy1);
            cr.lineTo(bx2, sy2);
            cr.lineTo(bx2, sy2 + offsetSign * beamThick * 0.82);
            cr.lineTo(bx1, sy1 + offsetSign * beamThick * 0.82);
            cr.closePath();
            cr.fill();
        }
        cr.restore();

        if (group.some(e => e.item.triplet)) {
            const midX = (x1 + x2) / 2;
            const midY = (y1 + y2) / 2 + (dir > 0 ? -sp * 1.15 : sp * 0.35);
            drawText(cr, '3', midX, midY, Math.max(8.5, sp * 0.92), rgb, {bold: true, align: 'center'});
        }
    }

    // 8. Paint ties and melisma slurs (clamped clear of header and bottom label band).
    const arcMinY = y + headerBandH + 2;
    const arcMaxY = y + height - labelBandH - 3;
    const orderedNotes = placed.filter(e => e.item.kind === 'note');
    for (let i = 0; i < orderedNotes.length; i++) {
        const cur = orderedNotes[i];
        if (cur.item.tieToNext && i + 1 < orderedNotes.length) {
            const next = orderedNotes[i + 1];
            const y1 = yForStep(cur.item.writtenStep);
            const y2 = yForStep(next.item.writtenStep);
            let bulge = cur.item.stemDir > 0 ? sp * 0.85 : -sp * 0.85;
            if (bulge > 0 && Math.max(y1, y2) + sp * 0.38 + bulge > arcMaxY)
                bulge = -sp * 0.85;
            const sy1 = clamp(y1 + (bulge > 0 ? sp * 0.38 : -sp * 0.38), arcMinY, arcMaxY);
            const sy2 = clamp(y2 + (bulge > 0 ? sp * 0.38 : -sp * 0.38), arcMinY, arcMaxY);
            const rgb = (cur.item.id === activeNoteId || next.item.id === activeNoteId) ? COLOR_ACTIVE : COLOR_WHITE;
            drawArcCurve(cr, cur.x + sp * 0.45, sy1, next.x - sp * 0.45, sy2, bulge, rgb, Math.max(1.4, sp * 0.16));
        }
        if (cur.item.slurStart) {
            for (let j = i + 1; j < orderedNotes.length; j++) {
                if (orderedNotes[j].item.slurEnd) {
                    const end = orderedNotes[j];
                    const y1 = yForStep(cur.item.writtenStep);
                    const y2 = yForStep(end.item.writtenStep);
                    let bulge = cur.item.stemDir > 0 ? sp * 1.05 : -sp * 1.05;
                    if (bulge > 0 && Math.max(y1, y2) + sp * 0.55 + bulge > arcMaxY)
                        bulge = -sp * 1.05;
                    const sy1 = clamp(y1 + (bulge > 0 ? sp * 0.55 : -sp * 0.55), arcMinY, arcMaxY);
                    const sy2 = clamp(y2 + (bulge > 0 ? sp * 0.55 : -sp * 0.55), arcMinY, arcMaxY);
                    drawArcCurve(cr, cur.x, sy1, end.x, sy2, bulge, COLOR_WHITE, Math.max(1.2, sp * 0.13));
                    break;
                }
            }
        }
    }
}

/**
 * Paints the rough sheet music staff band(s) directly below each wrapped line
 * of `fitted` (using `fitted.scoreLayout` produced by `fitLyric`).
 */
export function paintLineScoreBelow(cr, fitted, lineScore, {
    activeNoteId = null,
    noteNames = 'letters',
    backgroundOpacity = 0.78,
} = {}) {
    const scoreLayout = fitted?.scoreLayout;
    if (!scoreLayout || !lineScore || !Array.isArray(lineScore.items) || !lineScore.items.length)
        return;

    const anchorByWord = new Map();
    const lineByWord = new Map();
    for (const anchor of scoreLayout.wordAnchors) {
        anchorByWord.set(anchor.index, anchor);
        lineByWord.set(anchor.index, anchor.lineIdx);
    }

    const itemsByLine = scoreLayout.bands.map(() => []);
    for (const item of lineScore.items) {
        const lineIdx = lineByWord.get(item.wordIndex) ?? 0;
        if (lineIdx >= 0 && lineIdx < itemsByLine.length)
            itemsByLine[lineIdx].push(item);
    }

    for (let i = 0; i < scoreLayout.bands.length; i++) {
        const band = scoreLayout.bands[i];
        const lineItems = itemsByLine[i];
        if (!lineItems.length && i > 0)
            continue;
        paintStaffSystem(cr, {
            box: {x: band.x, y: band.y, width: band.width, height: band.height},
            lineScore,
            items: lineItems,
            wordAnchors: anchorByWord,
            activeNoteId,
            showHeader: i === 0,
            noteNames,
            backgroundOpacity,
        });
    }
}

// ---------------------------------------------------------------------------
// White-paper Piano Lead Sheet renderer (floating desktop window + verification)
// ---------------------------------------------------------------------------

function drawMultiBarRest(cr, count, x0, x1, yForStep, sp) {
    const midY = yForStep(34);
    const barLeft = x0 + Math.min((x1 - x0) * 0.22, sp * 2.2);
    const barRight = x1 - Math.min((x1 - x0) * 0.22, sp * 2.2);
    cr.save();
    cr.setSourceRGB(0, 0, 0);
    // Heavy horizontal bar between staff lines 2 and 4, with vertical end serifs.
    cr.rectangle(barLeft, midY - sp * 0.42, Math.max(sp * 1.4, barRight - barLeft), sp * 0.84);
    cr.fill();
    cr.setLineWidth(Math.max(1.6, sp * 0.18));
    cr.moveTo(barLeft, yForStep(36));
    cr.lineTo(barLeft, yForStep(32));
    cr.moveTo(barRight, yForStep(36));
    cr.lineTo(barRight, yForStep(32));
    cr.stroke();
    cr.restore();
    const countFontPx = Math.max(11, sp * 1.45);
    drawText(cr, String(count), (x0 + x1) / 2, yForStep(STAFF_TOP_STEP) - countFontPx * 1.22 - sp * 0.25, countFontPx, COLOR_BLACK, {
        bold: true,
        align: 'center',
    });
}

function drawTruncatedText(cr, text, x, y, maxW, sizePx, rgb, {bold = false, align = 'center'} = {}) {
    const clean = String(text ?? '').trim();
    if (!clean || maxW < 6)
        return;
    const layout = PangoCairo.create_layout(cr);
    const desc = new Pango.FontDescription();
    desc.set_family(FONT_FAMILY);
    desc.set_weight(bold ? Pango.Weight.BOLD : Pango.Weight.NORMAL);
    desc.set_absolute_size(sizePx * Pango.SCALE);
    layout.set_font_description(desc);
    layout.set_ellipsize(Pango.EllipsizeMode.END);
    layout.set_width(Math.round(maxW * Pango.SCALE));
    if (align === 'center')
        layout.set_alignment(Pango.Alignment.CENTER);
    else if (align === 'right')
        layout.set_alignment(Pango.Alignment.RIGHT);
    layout.set_text(clean, -1);
    const [, logical] = layout.get_pixel_extents();
    let dx = x;
    if (align === 'center')
        dx = x - maxW / 2;
    else if (align === 'right')
        dx = x - maxW;
    cr.save();
    cr.setSourceRGB(rgb[0], rgb[1], rgb[2]);
    cr.moveTo(Math.round(dx), Math.round(y));
    PangoCairo.show_layout(cr, layout);
    cr.restore();
    return logical;
}

/**
 * Computes the layout dimensions for a Piano Lead Sheet page by delegating
 * directly to the shared pure planner `planLeadSheetPage()` so desktop
 * engraving, `ScoreWindow`, and Settings preview stay 100% identical.
 */
export function computeLeadSheetDimensions(leadSheet, {
    barsPerSystem = 0,
    scale = 1.0,
    spacing = 'normal',
    showHeader = true,
    showMeasureNumbers = true,
    showChords = true,
    showLyrics = true,
    noteNames = 'letters',
    showSnapMoves = false,
    maxWidth = null,
    maxHeight = null,
} = {}) {
    return planLeadSheetPage(leadSheet, {
        width: maxWidth,
        height: maxHeight,
        scale,
        barsPerSystem,
        spacing,
        showHeader,
        showMeasureNumbers,
        showChords,
        showLyrics,
        noteNames,
        showSnapMoves,
    });
}

function paintLeadSheetSystem(cr, leadSheet, sys, {
    x,
    y,
    width,
    height,
    systemGap = 16,
    sp,
    uiScale = 1,
    isFirstSystem,
    isCurrentSystem,
    activeMeasureIndex,
    activeNoteId,
    activeItemId,
    measureProgress,
    noteNames,
    showMeasureNumbers = true,
    showChords = true,
    showLyrics = true,
    showPlayhead = false,
    showActiveMeasure = false,
    showSnapMoves = false,
    barsPerSystem = 6,
}) {
    const staffH = sp * 4;
    const showNoteLabels = noteNames === 'letters' || noteNames === 'degrees' || showSnapMoves;
    const chordH = showChords ? Math.max(Math.round(15 * uiScale), Math.round(sp * 2.05)) : 0;
    const barNumH = showMeasureNumbers
        ? (showChords ? Math.round(sp * 0.55) : Math.max(Math.round(10 * uiScale), Math.round(sp * 1.15)))
        : 0;
    const noteLabelH = showNoteLabels ? Math.max(Math.round(12 * uiScale), Math.round(sp * 1.55)) : 0;
    const lyricBandH = showLyrics ? Math.max(Math.round(14 * uiScale), Math.round(sp * 1.80)) : 0;

    // Inspect system note pitch range so the 5-line staff shifts dynamically
    // and chords / note labels / lyrics NEVER collide with ledger lines or stems.
    let sysMinStep = STAFF_BOTTOM_STEP;
    let sysMaxStep = STAFF_TOP_STEP;
    for (const m of sys.measures) {
        for (const it of m.items) {
            if (it.kind !== 'note')
                continue;
            sysMinStep = Math.min(sysMinStep, it.writtenStep);
            sysMaxStep = Math.max(sysMaxStep, it.writtenStep);
            for (const h of (it.harmonies ?? [])) {
                sysMinStep = Math.min(sysMinStep, h.writtenStep);
                sysMaxStep = Math.max(sysMaxStep, h.writtenStep);
            }
        }
    }

    const extraAbove = Math.max(0, sysMaxStep - STAFF_TOP_STEP) * (sp * 0.52);
    const extraBelow = Math.max(0, STAFF_BOTTOM_STEP - sysMinStep) * (sp * 0.52);
    const clefTailExtra = leadSheet.clef === 'treble-8vb' ? sp * 1.55 : sp * 0.95;
    const topNeeded = chordH + barNumH + Math.max(sp * 1.85, extraAbove + sp * 1.45);
    const bottomNeeded = Math.max(sp * 1.55 + clefTailExtra * 0.65, extraBelow + sp * 1.15) + noteLabelH + lyricBandH;
    const slack = Math.max(0, height - (topNeeded + staffH + bottomNeeded));
    const staffTopY = Math.round(y + topNeeded + slack * 0.25);
    const staffBottomY = staffTopY + staffH;
    const yForStep = step => staffBottomY - (step - STAFF_BOTTOM_STEP) * (sp * 0.5);

    const innerPad = Math.round(clamp(4 * uiScale, 3, 10));
    const staffLeft = x + innerPad;
    const staffRight = x + width - innerPad;

    // Subtle left margin accent only when an active-tracking cue is enabled.
    if (isCurrentSystem && (showActiveMeasure || showPlayhead)) {
        cr.save();
        cr.setSourceRGB(0, 0, 0);
        cr.rectangle(x + Math.round(1 * uiScale), staffTopY, Math.max(3, Math.round(3 * uiScale)), staffH);
        cr.fill();
        cr.restore();
    }

    // 1. Clef + Key Signature + (on first system) Time Signature width.
    let cursorX = staffLeft + sp * 1.35;
    const clefX = cursorX;
    cursorX += sp * 1.65;
    const keySigStartX = cursorX;
    cursorX += leadSheet.keySig.accidentals.length * (sp * 0.92);
    if (leadSheet.keySig.accidentals.length)
        cursorX += sp * 0.45;
    const timeSigX = isFirstSystem ? cursorX + sp * 0.65 : null;
    if (isFirstSystem)
        cursorX += sp * 1.75;
    const measuresLeft = cursorX + sp * 0.45;
    const fullMeasuresW = Math.max(60, staffRight - measuresLeft);
    const mCount = Math.max(1, sys.measures.length);

    // Proportional measure widths: sparse/rest bars stay compact, dense bars breathe.
    // On a partial final system (fewer bars than `barsPerSystem`), keep natural measure
    // width instead of stretching 1-2 leftover measures across the entire page!
    const targetCols = Math.max(mCount, barsPerSystem);
    const effectiveMeasuresW = mCount < targetCols
        ? fullMeasuresW * (mCount / targetCols)
        : fullMeasuresW;
    const weights = sys.measures.map(m => Math.max(0.85, Number(m.visualWeight) || 1.4));
    const totalWeight = weights.reduce((s, w) => s + w, 0) || mCount;
    const mStarts = [];
    const mWidths = [];
    let mxCursor = measuresLeft;
    for (let mi = 0; mi < mCount; mi++) {
        const mw = effectiveMeasuresW * (weights[mi] / totalWeight);
        mStarts.push(mxCursor);
        mWidths.push(mw);
        mxCursor += mw;
    }
    const usedStaffRight = Math.min(staffRight, mxCursor);

    // Precompute per-measure horizontal placement & beam geometry BEFORE painting so we
    // know exact `highestInkY` and `lowestInkY` across the whole system -> zero collisions!
    const rx = sp * 0.58;
    const stemLen = sp * 3.15;
    const measurePlans = [];
    let highestInkY = Math.min(staffTopY - sp * 1.0, yForStep(39.8) - sp * 0.35);
    let lowestInkY = Math.max(staffBottomY + sp * 0.9, yForStep(27.6) + (leadSheet.clef === 'treble-8vb' ? sp * 1.35 : sp * 0.55));

    for (let mi = 0; mi < mCount; mi++) {
        const m = sys.measures[mi];
        const mx0 = mStarts[mi];
        const mw = mWidths[mi];
        const mx1 = mx0 + mw;
        const innerL = mx0 + sp * 0.95;
        const innerR = mx1 - sp * 0.80;
        const innerW = Math.max(14, innerR - innerL);

        const placed = [];
        if (m.multiRest <= 0) {
            // Group items by rhythmic beat slot so simultaneous Voice 1 + Voice 2 align vertically at the exact same x.
            const slotMap = new Map();
            for (const it of m.items) {
                const slotKey = (it.kind === 'rest' && it.wholeBar) ? -1 : Math.round((Number(it.beatInBar) || 0) * 24);
                let tx = innerL + (it.beatInBar / Math.max(1, m.barBeats)) * innerW;
                if (it.kind === 'rest' && it.wholeBar)
                    tx = (mx0 + mx1) * 0.5;
                const leftExt = it.kind === 'note' ? (it.accidental ? sp * 1.45 : sp * 0.72) : sp * 0.65;
                const rightExt = it.kind === 'note'
                    ? (it.dots > 0 ? sp * 1.25 : sp * 0.80) + (it.headShiftX ? sp * 1.15 : 0)
                    : sp * 0.65;
                let slot = slotMap.get(slotKey);
                if (!slot) {
                    slot = {
                        slotKey,
                        x: clamp(tx, innerL + leftExt * 0.3, innerR - rightExt * 0.3),
                        leftExt,
                        rightExt,
                        entries: [],
                    };
                    slotMap.set(slotKey, slot);
                } else {
                    slot.leftExt = Math.max(slot.leftExt, leftExt);
                    slot.rightExt = Math.max(slot.rightExt, rightExt);
                }
                const entry = {item: it, x: slot.x, leftExt, rightExt};
                slot.entries.push(entry);
                placed.push(entry);
            }
            const slots = [...slotMap.values()].sort((a, b) => a.slotKey - b.slotKey);
            const minGap = sp * 0.44;
            for (let i = 1; i < slots.length; i++) {
                const minX = slots[i - 1].x + slots[i - 1].rightExt + minGap + slots[i].leftExt;
                if (slots[i].x < minX)
                    slots[i].x = minX;
            }
            if (slots.length) {
                const last = slots[slots.length - 1];
                const overflow = (last.x + last.rightExt) - innerR;
                if (overflow > 0) {
                    const first = slots[0];
                    const avail = Math.max(8, innerR - innerL - first.leftExt * 0.5 - last.rightExt * 0.5);
                    const span = Math.max(1, last.x - first.x);
                    const scale = Math.min(1, avail / span);
                    const origin = innerL + first.leftExt * 0.5;
                    for (const slot of slots)
                        slot.x = origin + (slot.x - first.x) * scale;
                }
                for (const slot of slots) {
                    for (const entry of slot.entries)
                        entry.x = slot.x;
                }
            }
        }

        const beamGroups = new Map();
        for (const p of placed) {
            if (p.item.kind === 'note' && p.item.beamGroup !== null) {
                const arr = beamGroups.get(p.item.beamGroup) ?? [];
                arr.push(p);
                beamGroups.set(p.item.beamGroup, arr);
            }
        }
        const beamTipY = new Map();
        for (const [gid, group] of beamGroups.entries()) {
            const dir = group[0].item.stemDir;
            const x0 = group[0].x + (dir > 0 ? rx - 0.6 : -rx + 0.6);
            const x1 = group[group.length - 1].x + (dir > 0 ? rx - 0.6 : -rx + 0.6);
            let y0 = yForStep(group[0].item.writtenStep) - dir * stemLen;
            let y1 = yForStep(group[group.length - 1].item.writtenStep) - dir * stemLen;
            const maxSlope = sp * 1.1;
            if (Math.abs(y1 - y0) > maxSlope)
                y1 = y0 + Math.sign(y1 - y0) * maxSlope;
            const minStem = sp * 2.4;
            for (const g of group) {
                const gx = g.x + (dir > 0 ? rx - 0.6 : -rx + 0.6);
                const t = x1 > x0 ? (gx - x0) / (x1 - x0) : 0;
                const by = y0 + t * (y1 - y0);
                const ny = yForStep(g.item.writtenStep);
                const actual = dir > 0 ? (ny - by) : (by - ny);
                if (actual < minStem) {
                    const shift = minStem - actual;
                    y0 -= dir * shift;
                    y1 -= dir * shift;
                }
            }
            const voice = group[0].item.voice === 2 ? 2 : 1;
            beamTipY.set(gid, {x0, y0, x1, y1, dir, voice, group});
            highestInkY = Math.min(highestInkY, y0 - sp * 0.4, y1 - sp * 0.4);
            lowestInkY = Math.max(lowestInkY, y0 + sp * 0.4, y1 + sp * 0.4);
        }

        for (const p of placed) {
            const it = p.item;
            if (it.kind !== 'note')
                continue;
            const ny = yForStep(it.writtenStep);
            highestInkY = Math.min(highestInkY, ny - sp * 0.6);
            lowestInkY = Math.max(lowestInkY, ny + sp * 0.65);
            if (it.stem && it.beamGroup === null) {
                const tipY = ny - it.stemDir * stemLen;
                highestInkY = Math.min(highestInkY, tipY - sp * 0.25);
                lowestInkY = Math.max(lowestInkY, tipY + sp * 0.25);
            }
            for (const h of (it.harmonies ?? [])) {
                const hy = yForStep(h.writtenStep);
                highestInkY = Math.min(highestInkY, hy - sp * 0.5);
                lowestInkY = Math.max(lowestInkY, hy + sp * 0.5);
            }
        }
        measurePlans.push({m, mx0, mx1, mw, innerL, innerR, innerW, placed, beamTipY});
    }

    // Dynamic, collision-free vertical bands anchored outside actual system ink!
    const chordFontPx = Math.max(11, sp * 1.48);
    const barNumFontPx = Math.max(8.5, sp * 0.96);
    const noteLabelFontPx = Math.max(8.5, sp * 0.96);
    const lyricFontPx = Math.max(10.5, sp * 1.24);

    // Pre-layout all lyrics across the whole system so we know whether narrow/tight
    // passages need 1, 2, or 3 staggered lyric tiers (ZERO truncation, ZERO overlap!).
    const lyricEntries = [];
    if (showLyrics) {
        for (const plan of measurePlans) {
            for (const p of plan.placed) {
                const it = p.item;
                if (it.kind !== 'note' || !it.lyric)
                    continue;
                const isAct = showActiveMeasure && (
                    (activeItemId !== null && it.id === activeItemId)
                    || (activeItemId === null && activeNoteId !== null && it.noteId === activeNoteId)
                );
                lyricEntries.push({x: p.x, text: it.lyric, bold: isAct});
            }
        }
    }
    const lyricLayout = showLyrics
        ? layoutSystemLyrics(lyricEntries, {
            leftBound: staffLeft,
            rightBound: staffRight,
            baseFontPx: lyricFontPx,
            minScale: 0.78,
            maxTiers: 3,
            measureWidth: (t, px, bold) => measureTextWidth(cr, t, px, bold),
        })
        : {placements: [], tierCount: 0};
    const lyricLineH = Math.max(Math.round(13 * uiScale), Math.round(lyricFontPx * 1.24));
    const effectiveLyricBandH = showLyrics && lyricLayout.tierCount > 0
        ? lyricLayout.tierCount * lyricLineH + Math.round(2 * uiScale)
        : 0;

    const barNumY = Math.round(Math.max(
        y + (showChords ? chordFontPx + sp * 0.25 : 1),
        Math.min(staffTopY - barNumFontPx - sp * 0.45, highestInkY - barNumFontPx - sp * 0.25),
    ));
    const chordY = Math.round(Math.max(
        y + 1,
        Math.min(barNumY - chordFontPx - sp * 0.2, highestInkY - chordFontPx - sp * 0.45),
    ));
    // Keep note labels & lyrics snugly anchored below actual ink; never pull them up into the staff.
    const belowStaffFloor = Math.max(staffBottomY + sp * 1.15, lowestInkY + sp * 0.42);
    const maxBottomY = y + height + Math.round(Math.max(0, systemGap) * 0.65);
    const noteLabelY = Math.round(belowStaffFloor);
    const idealLyricY = showNoteLabels
        ? (noteLabelY + noteLabelH + Math.max(2, Math.round(2 * uiScale)))
        : Math.max(staffBottomY + sp * 1.18, lowestInkY + sp * 0.45);
    const lyricY = Math.round(Math.min(
        Math.max(belowStaffFloor, maxBottomY - effectiveLyricBandH),
        idealLyricY,
    ));

    // 2. Optional active-measure soft yellow paper highlight BEFORE drawing black staff lines.
    if (showActiveMeasure && isCurrentSystem && activeMeasureIndex >= 0 && activeMeasureIndex < mCount) {
        const plan = measurePlans[activeMeasureIndex];
        cr.save();
        cr.setSourceRGBA(0.99, 0.94, 0.54, 0.42);
        cr.rectangle(plan.mx0, staffTopY - sp * 1.2, plan.mw, staffH + sp * 2.4);
        cr.fill();
        cr.restore();
    }

    // 3. 5 crisp black staff lines + left closing barline.
    cr.save();
    cr.setSourceRGB(0, 0, 0);
    cr.setLineWidth(Math.max(1.0, sp * 0.11));
    for (let li = 0; li < 5; li++) {
        const ly = Math.round(staffTopY + li * sp) + 0.5;
        cr.moveTo(staffLeft, ly);
        cr.lineTo(usedStaffRight, ly);
    }
    cr.stroke();
    cr.setLineWidth(Math.max(1.4, sp * 0.16));
    cr.moveTo(Math.round(staffLeft) + 0.5, staffTopY);
    cr.lineTo(Math.round(staffLeft) + 0.5, staffBottomY);
    cr.stroke();
    cr.restore();

    // 4. Draw Clef, Key Signature, and Time Signature in pure black ink.
    drawTrebleClef(cr, clefX, yForStep, sp, leadSheet.clef === 'treble-8vb', COLOR_BLACK);
    for (let i = 0; i < leadSheet.keySig.accidentals.length; i++) {
        const acc = leadSheet.keySig.accidentals[i];
        drawAccidental(cr, acc.kind, keySigStartX + i * sp * 0.92, yForStep(acc.step), sp, COLOR_BLACK);
    }
    if (isFirstSystem && timeSigX !== null) {
        const num = String(leadSheet.meter?.[0] ?? 4);
        const den = String(leadSheet.meter?.[1] ?? 4);
        const tsSize = Math.max(11, sp * 2.15);
        drawText(cr, num, timeSigX, staffTopY - sp * 0.35, tsSize, COLOR_BLACK, {bold: true, align: 'center'});
        drawText(cr, den, timeSigX, staffTopY + sp * 1.65, tsSize, COLOR_BLACK, {bold: true, align: 'center'});
    }

    // 5. Measure-by-measure engraving: barlines, measure numbers, chord symbols, notes, rests, ties, lyrics.
    const allPlacedNotes = [];
    for (let mi = 0; mi < mCount; mi++) {
        const {m, mx0, mx1, innerL, innerW, placed, beamTipY} = measurePlans[mi];

        if (showMeasureNumbers) {
            const barTag = m.multiRest > 0 ? `${m.barNumber}\u2013${m.barEnd}` : String(m.barNumber);
            drawText(cr, barTag, mx0 + 3, barNumY, Math.max(8.5, sp * 0.96), COLOR_BLACK, {bold: false, align: 'left'});
        }

        if (showChords) {
            for (const ch of m.chords) {
                const cx = innerL + (ch.beatInBar / Math.max(1, m.barBeats)) * innerW;
                drawText(cr, ch.symbol, clamp(cx, mx0 + 6, mx1 - 14), chordY, chordFontPx, COLOR_BLACK, {
                    bold: true,
                    align: 'left',
                });
            }
        }

        const isSongEnd = m.barEnd >= leadSheet.totalBars;
        cr.save();
        cr.setSourceRGB(0, 0, 0);
        if (isSongEnd) {
            cr.setLineWidth(Math.max(1.1, sp * 0.13));
            cr.moveTo(Math.round(mx1 - sp * 0.55) + 0.5, staffTopY);
            cr.lineTo(Math.round(mx1 - sp * 0.55) + 0.5, staffBottomY);
            cr.stroke();
            cr.setLineWidth(Math.max(2.6, sp * 0.34));
            cr.moveTo(Math.round(mx1 - 1) + 0.5, staffTopY);
            cr.lineTo(Math.round(mx1 - 1) + 0.5, staffBottomY);
            cr.stroke();
        } else {
            cr.setLineWidth(Math.max(1.2, sp * 0.14));
            cr.moveTo(Math.round(mx1) + 0.5, staffTopY);
            cr.lineTo(Math.round(mx1) + 0.5, staffBottomY);
            cr.stroke();
        }
        cr.restore();

        if (m.multiRest > 0) {
            drawMultiBarRest(cr, m.multiRest, mx0, mx1, yForStep, sp);
            continue;
        }

        let lastNoteLabelRightX = -Infinity;
        for (let pi = 0; pi < placed.length; pi++) {
            const p = placed[pi];
            const it = p.item;
            if (it.kind === 'rest') {
                drawRest(cr, it, p.x, yForStep, sp, COLOR_BLACK);
                continue;
            }
            if (it.kind !== 'note')
                continue;

            const ny = yForStep(it.writtenStep);
            const isActive = showActiveMeasure && (
                (activeItemId !== null && it.id === activeItemId)
                || (activeItemId === null && activeNoteId !== null && it.noteId === activeNoteId)
            );

            if (isActive) {
                cr.save();
                cr.setSourceRGB(...COLOR_PAPER_ACTIVE_BG);
                cr.arc(p.x, ny, sp * 1.02, 0, Math.PI * 2);
                cr.fill();
                cr.restore();
            }

            for (const h of (it.harmonies ?? [])) {
                const hy = yForStep(h.writtenStep);
                const hRgb = h.direction === 'above' ? COLOR_PAPER_HARMONY_ABOVE : COLOR_PAPER_HARMONY_BELOW;
                drawLedgerLines(cr, p.x, h.writtenStep, yForStep, sp, rx * 0.8, hRgb);
                drawHarmonyDiamond(cr, p.x, hy, sp, hRgb);
            }

            if (showSnapMoves && !it.tieFromPrev && it.snapDelta) {
                const ghostX = p.x - sp * 1.05;
                let ghostY = yForStep(it.rawWrittenStep ?? it.writtenStep);
                if (Math.abs(ghostY - ny) < sp * 0.35)
                    ghostY = ny + (it.snapDelta > 0 ? sp * 0.65 : -sp * 0.65);
                const dirSign = ny < ghostY ? -1 : 1; // -1 = arrow points UP, +1 = arrow points DOWN
                cr.save();
                cr.setSourceRGB(...COLOR_PAPER_SNAP);
                cr.setLineWidth(Math.max(1.4, sp * 0.17));
                // Hollow ghost dot at raw detected pitch
                cr.arc(ghostX, ghostY, Math.max(2.3, sp * 0.30), 0, Math.PI * 2);
                cr.stroke();
                // Vertical arrow from raw pitch toward snapped pitch
                const ax = ghostX;
                const aStart = ghostY + dirSign * Math.max(2.6, sp * 0.34);
                const aEnd = ny;
                cr.moveTo(ax, aStart);
                cr.lineTo(ax, aEnd);
                // Short horizontal pointer to snapped notehead + arrowhead
                const head = Math.max(3.2, sp * 0.38);
                cr.moveTo(ax - head * 0.65, aEnd - dirSign * head);
                cr.lineTo(ax, aEnd);
                cr.lineTo(ax + head * 0.65, aEnd - dirSign * head);
                cr.stroke();
                cr.restore();
            }

            const noteX = p.x + (it.headShiftX ? it.headShiftX * sp * 1.15 : 0);
            const noteInk = (leadSheet.hasMultipleVoices && it.voice === 2) ? COLOR_PAPER_VOICE2 : COLOR_BLACK;
            drawLedgerLines(cr, noteX, it.writtenStep, yForStep, sp, rx, noteInk);
            if (it.accidental)
                drawAccidental(cr, it.accidental, noteX - sp * 1.18, ny, sp, noteInk);
            drawNotehead(cr, noteX, ny, sp, it.hollow, it.figure === 'whole', noteInk);

            if (it.dots > 0) {
                const dotY = (it.writtenStep % 2 === 0) ? ny - sp * 0.42 : ny;
                cr.save();
                cr.setSourceRGB(...noteInk);
                cr.arc(noteX + rx + sp * 0.36, dotY, Math.max(1.3, sp * 0.16), 0, Math.PI * 2);
                cr.fill();
                cr.restore();
            }

            if (it.stem) {
                const dir = it.stemDir;
                const stemX = noteX + (dir > 0 ? rx - 0.6 : -rx + 0.6);
                let tipY = ny - dir * stemLen;
                if (it.beamGroup !== null && beamTipY.has(it.beamGroup)) {
                    const bg = beamTipY.get(it.beamGroup);
                    const t = bg.x1 > bg.x0 ? (stemX - bg.x0) / (bg.x1 - bg.x0) : 0;
                    tipY = bg.y0 + t * (bg.y1 - bg.y0);
                }
                cr.save();
                cr.setSourceRGB(...noteInk);
                cr.setLineWidth(Math.max(1.2, sp * 0.14));
                cr.moveTo(stemX, ny);
                cr.lineTo(stemX, tipY);
                cr.stroke();
                cr.restore();

                if (it.beamGroup === null && it.flags > 0)
                    drawFlag(cr, stemX, tipY, dir, it.flags, sp, noteInk);
            }

            if (showNoteLabels && !it.tieFromPrev && !(leadSheet.hasMultipleVoices && it.voice === 2)) {
                let lbl = '';
                let lblRgb = noteInk;
                let lblBold = isActive;
                if (showSnapMoves && it.snapDelta) {
                    const fromName = String(it.rawNoteName ?? '').replace(/\d+$/u, '');
                    const toName = String(it.noteName ?? '').replace(/\d+$/u, '');
                    lbl = `${fromName}\u2192${toName}`;
                    lblRgb = COLOR_PAPER_SNAP;
                    lblBold = true;
                } else if (noteNames === 'degrees') {
                    lbl = it.degree;
                } else if (noteNames === 'letters') {
                    lbl = it.noteName;
                }
                if (lbl) {
                    const approxW = measureTextWidth(cr, lbl, noteLabelFontPx, lblBold);
                    const leftEdge = noteX - approxW / 2;
                    if (leftEdge >= lastNoteLabelRightX + 2 || (showSnapMoves && it.snapDelta)) {
                        drawText(cr, lbl, noteX, noteLabelY, noteLabelFontPx, lblRgb, {bold: lblBold, align: 'center'});
                        lastNoteLabelRightX = Math.max(lastNoteLabelRightX, noteX + approxW / 2);
                    }
                }
            }

            allPlacedNotes.push({x: noteX, ny, item: it, mx0, mx1});
        }

        // Draw primary & secondary beams in matching voice ink (black for Voice 1, indigo for Voice 2).
        for (const bg of beamTipY.values()) {
            const thick = Math.max(2.6, sp * 0.36);
            const beamInk = (leadSheet.hasMultipleVoices && bg.voice === 2) ? COLOR_PAPER_VOICE2 : COLOR_BLACK;
            cr.save();
            cr.setSourceRGB(...beamInk);
            cr.newPath();
            cr.moveTo(bg.x0, bg.y0);
            cr.lineTo(bg.x1, bg.y1);
            cr.lineTo(bg.x1, bg.y1 + bg.dir * thick);
            cr.lineTo(bg.x0, bg.y0 + bg.dir * thick);
            cr.closePath();
            cr.fill();

            for (let i = 0; i < bg.group.length; i++) {
                const g = bg.group[i];
                if (g.item.flags < 2)
                    continue;
                const gx = g.x + (bg.dir > 0 ? rx - 0.6 : -rx + 0.6);
                const nextHas2 = i + 1 < bg.group.length && bg.group[i + 1].item.flags >= 2;
                const prevHas2 = i > 0 && bg.group[i - 1].item.flags >= 2;
                let bx0 = gx;
                let bx1 = gx;
                if (nextHas2) {
                    bx1 = bg.group[i + 1].x + (bg.dir > 0 ? rx - 0.6 : -rx + 0.6);
                } else if (!prevHas2) {
                    const stub = sp * 0.95;
                    if (i + 1 < bg.group.length)
                        bx1 = gx + stub;
                    else
                        bx0 = gx - stub;
                } else {
                    continue;
                }
                const t0 = bg.x1 > bg.x0 ? (bx0 - bg.x0) / (bg.x1 - bg.x0) : 0;
                const t1 = bg.x1 > bg.x0 ? (bx1 - bg.x0) / (bg.x1 - bg.x0) : 0;
                const off = bg.dir * (thick + sp * 0.24);
                const by0 = bg.y0 + t0 * (bg.y1 - bg.y0) + off;
                const by1 = bg.y0 + t1 * (bg.y1 - bg.y0) + off;
                cr.newPath();
                cr.moveTo(bx0, by0);
                cr.lineTo(bx1, by1);
                cr.lineTo(bx1, by1 + bg.dir * thick * 0.85);
                cr.lineTo(bx0, by0 + bg.dir * thick * 0.85);
                cr.closePath();
                cr.fill();
            }
            cr.restore();
        }

        // Optional moving red playhead hairline inside the active measure.
        if (showPlayhead && isCurrentSystem && mi === activeMeasureIndex && Number.isFinite(measureProgress)) {
            const px = innerL + clamp(measureProgress, 0, 1) * innerW;
            cr.save();
            cr.setSourceRGB(...COLOR_PAPER_PLAYHEAD);
            cr.setLineWidth(2);
            cr.moveTo(Math.round(px) + 0.5, staffTopY - sp * 1.1);
            cr.lineTo(Math.round(px) + 0.5, staffBottomY + sp * 1.1);
            cr.stroke();
            cr.restore();
        }
    }

    // 6. Multi-tier / shrink-to-fit system lyrics (zero truncation, zero overlap!).
    if (showLyrics && lyricLayout.placements.length) {
        for (const lp of lyricLayout.placements) {
            const wy = lyricY + lp.tier * lyricLineH;
            if (lp.needsGuide) {
                cr.save();
                cr.setSourceRGB(0, 0, 0);
                cr.setLineWidth(Math.max(0.85, 0.9 * uiScale));
                const gx = Math.round(lp.x) + 0.5;
                cr.moveTo(gx, Math.max(lyricY - 1, wy - Math.round(4 * uiScale)));
                cr.lineTo(gx, wy);
                cr.stroke();
                cr.restore();
            }
            drawText(cr, lp.text, lp.drawX, wy, lp.fontPx, COLOR_BLACK, {
                bold: lp.bold,
                align: 'center',
            });
        }
    }

    // 7. Ties across adjacent notes (including across barlines within the system!).
    for (let i = 0; i < allPlacedNotes.length; i++) {
        const cur = allPlacedNotes[i];
        if (!cur.item.tieToNext)
            continue;
        const bulge = cur.item.stemDir > 0 ? sp * 0.82 : -sp * 0.82;
        const yOff = bulge > 0 ? sp * 0.36 : -sp * 0.36;
        if (i + 1 < allPlacedNotes.length && allPlacedNotes[i + 1].item.noteId === cur.item.noteId) {
            const nxt = allPlacedNotes[i + 1];
            drawArcCurve(cr, cur.x + sp * 0.42, cur.ny + yOff, nxt.x - sp * 0.42, nxt.ny + yOff, bulge, COLOR_BLACK, Math.max(1.3, sp * 0.15));
        } else {
            drawArcCurve(cr, cur.x + sp * 0.42, cur.ny + yOff, Math.min(usedStaffRight, cur.x + sp * 1.8), cur.ny + yOff, bulge * 0.7, COLOR_BLACK, Math.max(1.3, sp * 0.15));
        }
    }
    if (allPlacedNotes.length && allPlacedNotes[0].item.tieFromPrev) {
        const first = allPlacedNotes[0];
        const bulge = first.item.stemDir > 0 ? sp * 0.82 : -sp * 0.82;
        const yOff = bulge > 0 ? sp * 0.36 : -sp * 0.36;
        drawArcCurve(cr, Math.max(measuresLeft, first.x - sp * 1.6), first.ny + yOff, first.x - sp * 0.42, first.ny + yOff, bulge * 0.7, COLOR_BLACK, Math.max(1.3, sp * 0.15));
    }
}

/**
 * Paints a crisp white-paper Piano Lead Sheet page into `(0, 0, width, height)`.
 * Pure #ffffff paper + #000000 ink (zero gray text).
 *
 * Paging modes:
 * - `'page'` (default): keeps all visible rows stationary until the last bar on
 *   the page finishes, then flips immediately to the next full page.
 * - `'scroll'`: keeps the active system on row 1 and shifts upcoming rows up one
 *   system at a time.
 *
 * Returns `{gearBox}` (clickable hitbox for the top-right sheet config button
 * when `showConfigButton` is enabled).
 */
export function paintLeadSheetPage(cr, leadSheet, {
    width,
    height,
    title = '',
    statusMessage = '',
    currentSystemIndex = undefined,
    startSystemIndex = 0,
    manualSystemOffset = 0,
    activeMeasureIndex = -1,
    activeNoteId = null,
    activeItemId = null,
    measureProgress = 0,
    noteNames = 'letters',
    paperOpacity = 0.96,
    scale = 1.0,
    spacing = 'normal',
    barsPerSystem = 0,
    paging = 'page',
    showHeader = true,
    headerFields = null,
    showMeasureNumbers = true,
    showChords = true,
    showLyrics = true,
    showPlayhead = false,
    showActiveMeasure = false,
    showSnapMoves = false,
    showConfigButton = false,
    framelessPaper = false,
} = {}) {
    if (!width || !height || width < 140 || height < 80)
        return {gearBox: null};

    const hf = {
        title: true,
        key: true,
        time: false,
        bpm: true,
        clef: false,
        bars: true,
        page: true,
        ...(headerFields && typeof headerFields === 'object' ? headerFields : {}),
    };

    const dims = planLeadSheetPage(leadSheet, {
        width,
        height,
        scale,
        barsPerSystem,
        spacing,
        showHeader,
        showMeasureNumbers,
        showChords,
        showLyrics,
        noteNames,
        showSnapMoves,
    });
    const uiScale = dims.effectiveScale;
    const headerScale = dims.headerScale;
    const sp = dims.sp;
    const padX = dims.padX;
    const padY = dims.padY;

    // 1. Crisp white sheet-music paper.
    if (framelessPaper) {
        cr.save();
        cr.setSourceRGBA(1, 1, 1, clamp(paperOpacity, 0.75, 1.0));
        cr.rectangle(0, 0, width, height);
        cr.fill();
        cr.restore();
    } else {
        const borderW = Math.max(2, Math.round(2 * headerScale));
        roundedRect(cr, borderW * 0.75, borderW * 0.75, width - borderW * 1.5, height - borderW * 1.5, Math.round(10 * headerScale));
        cr.setSourceRGBA(1, 1, 1, clamp(paperOpacity, 0.75, 1.0));
        cr.fillPreserve();
        cr.setSourceRGB(0, 0, 0);
        cr.setLineWidth(borderW);
        cr.stroke();
    }

    // Compute visible page window (`page` vs `scroll` mode).
    const visRows = Math.max(1, dims.rows);
    const totalSystems = leadSheet?.systems?.length ?? 0;
    const curSysIdx = currentSystemIndex !== undefined
        ? clamp(currentSystemIndex, 0, Math.max(0, totalSystems - 1))
        : clamp(startSystemIndex, 0, Math.max(0, totalSystems - 1));

    let pageStart;
    let activeSlot;
    if (paging === 'scroll') {
        pageStart = clamp(curSysIdx + manualSystemOffset, 0, Math.max(0, totalSystems - 1));
        activeSlot = manualSystemOffset === 0 ? 0 : -1;
    } else {
        const basePageStart = Math.floor(curSysIdx / visRows) * visRows;
        const maxPageStart = Math.max(0, Math.floor((Math.max(1, totalSystems) - 1) / visRows) * visRows);
        pageStart = clamp(basePageStart + manualSystemOffset * visRows, 0, maxPageStart);
        activeSlot = manualSystemOffset === 0 ? (curSysIdx - pageStart) : -1;
    }

    // 2. Optional top sheet header bar + optional crisp config button on top-right.
    let gearBox = null;
    const gearSize = Math.round(24 * headerScale);
    if (showConfigButton) {
        gearBox = {
            x: Math.round(width - padX - gearSize),
            y: Math.round(padY + (showHeader ? Math.max(0, (dims.headerH - gearSize) / 2 - 2) : 2)),
            width: gearSize,
            height: gearSize,
        };
    }

    let bodyTop = dims.bodyTop;
    if (showHeader) {
        const headerH = dims.headerH;
        const headerTitle = hf.title ? (title || 'Piano Lead Sheet') : '';
        let metaText = '';
        if (leadSheet && totalSystems > 0) {
            const parts = [];
            if (hf.key && leadSheet.keyLabel)
                parts.push(leadSheet.keyLabel);
            if (hf.time && leadSheet.meter)
                parts.push(`${leadSheet.meter[0]}/${leadSheet.meter[1]}`);
            if (hf.bpm && leadSheet.bpm)
                parts.push(`${leadSheet.bpm} BPM`);
            if (hf.clef && leadSheet.clef === 'treble-8vb')
                parts.push('8vb');
            if (leadSheet.hasMultipleVoices)
                parts.push('2 voices');
            const firstVis = leadSheet.systems[pageStart];
            const lastVis = leadSheet.systems[Math.min(totalSystems - 1, pageStart + visRows - 1)];
            if (hf.bars && firstVis && lastVis)
                parts.push(`Bars ${firstVis.firstBar}\u2013${lastVis.lastBar}/${leadSheet.totalBars}`);
            if (hf.page && paging === 'page' && totalSystems > visRows) {
                const pageNum = Math.floor(pageStart / visRows) + 1;
                const totalPages = Math.ceil(totalSystems / visRows);
                parts.push(`Page ${pageNum}/${totalPages}`);
            }
            metaText = parts.join('  \u00b7  ');
        }

        const rightReserve = gearBox ? gearSize + Math.round(8 * headerScale) : 0;
        const availHeaderW = Math.max(40, width - padX * 2 - rightReserve);
        const titleFontPx = Math.max(12, Math.round(14.5 * headerScale));
        let metaFontPx = Math.max(10.5, Math.round(12.5 * headerScale));
        const headerGapPx = Math.round(12 * headerScale);
        let metaW = metaText ? measureTextWidth(cr, metaText, metaFontPx, true) : 0;
        const titleW = headerTitle ? measureTextWidth(cr, headerTitle, titleFontPx, true) : 0;

        // Shrink metadata gently on narrow windows so title + meta NEVER collide.
        if (metaText && headerTitle && titleW + metaW + headerGapPx > availHeaderW) {
            const targetMetaMax = availHeaderW * 0.68;
            if (metaW > targetMetaMax) {
                metaFontPx = Math.max(9.5, metaFontPx * (targetMetaMax / metaW));
                metaW = measureTextWidth(cr, metaText, metaFontPx, true);
            }
        }
        const maxMetaW = headerTitle ? Math.min(availHeaderW * 0.72, Math.ceil(metaW) + 2) : availHeaderW;
        const drawnMetaW = metaText ? Math.min(maxMetaW, Math.ceil(metaW) + 2) : 0;
        const availTitleW = headerTitle
            ? Math.max(0, availHeaderW - (drawnMetaW > 0 ? drawnMetaW + headerGapPx : 0))
            : 0;

        if (headerTitle && availTitleW >= 48) {
            drawTruncatedText(
                cr, headerTitle, padX, padY + Math.round(2 * headerScale),
                availTitleW,
                titleFontPx, COLOR_BLACK, {bold: true, align: 'left'},
            );
        }
        if (metaText) {
            const metaRightX = width - padX - rightReserve;
            const metaY = padY + Math.round(3 * headerScale);
            if (metaW <= maxMetaW) {
                drawText(cr, metaText, metaRightX, metaY, metaFontPx, COLOR_BLACK, {bold: true, align: 'right'});
            } else {
                drawTruncatedText(cr, metaText, metaRightX, metaY, maxMetaW, metaFontPx, COLOR_BLACK, {bold: true, align: 'right'});
            }
        }

        cr.save();
        cr.setSourceRGB(0, 0, 0);
        cr.setLineWidth(Math.max(1.5, 1.5 * headerScale));
        cr.moveTo(padX, headerH + padY);
        cr.lineTo(width - padX, headerH + padY);
        cr.stroke();
        cr.restore();

        bodyTop = dims.bodyTop;
    }

    const bodyH = dims.bodyH;

    // 3. Status/empty sheet view (while extracting or waiting for a song).
    if (!leadSheet || !totalSystems) {
        const emptySp = clamp(bodyH * 0.08, 6.5 * headerScale, 11 * headerScale);
        const staffTopY = Math.round(bodyTop + bodyH * 0.34);
        cr.save();
        cr.setSourceRGB(0, 0, 0);
        cr.setLineWidth(Math.max(1.1, 1.1 * headerScale));
        for (let i = 0; i < 5; i++) {
            const ly = Math.round(staffTopY + i * emptySp) + 0.5;
            cr.moveTo(padX + Math.round(10 * headerScale), ly);
            cr.lineTo(width - padX - Math.round(10 * headerScale), ly);
        }
        cr.stroke();
        cr.restore();
        const yForStep = step => (staffTopY + emptySp * 4) - (step - STAFF_BOTTOM_STEP) * (emptySp * 0.5);
        drawTrebleClef(cr, padX + Math.round(26 * headerScale), yForStep, emptySp, false, COLOR_BLACK);
        const msg = statusMessage || 'Play a song to view its piano lead sheet (right-click for sheet options)';
        drawTruncatedText(cr, msg, width / 2, Math.round(staffTopY + emptySp * 5.2), width - padX * 2 - 20, Math.max(11, Math.round(13.5 * headerScale)), COLOR_BLACK, {
            bold: true,
            align: 'center',
        });
    } else {
        // 4. Paint each visible system row top-anchored with balanced engraved inter-system gaps.
        const sysH = dims.systemH;
        const sysGap = dims.systemGap;
        const topOffset = bodyTop + dims.topMargin;

        for (let slot = 0; slot < visRows; slot++) {
            const sysIdx = pageStart + slot;
            if (sysIdx >= totalSystems)
                break;
            const sys = leadSheet.systems[sysIdx];
            const sy = topOffset + slot * (sysH + sysGap);
            const isCurrent = slot === activeSlot;
            paintLeadSheetSystem(cr, leadSheet, sys, {
                x: padX,
                y: sy,
                width: width - padX * 2,
                height: sysH,
                systemGap: sysGap,
                sp,
                uiScale,
                isFirstSystem: sysIdx === 0,
                isCurrentSystem: isCurrent,
                activeMeasureIndex: isCurrent ? activeMeasureIndex : -1,
                activeNoteId: isCurrent ? activeNoteId : null,
                activeItemId: isCurrent ? activeItemId : null,
                measureProgress: isCurrent ? measureProgress : 0,
                noteNames,
                showMeasureNumbers,
                showChords,
                showLyrics,
                showPlayhead,
                showActiveMeasure,
                showSnapMoves,
                barsPerSystem: dims.barsPerSystem,
            });
        }
    }

    // 5. Paint crisp sheet config button (`⚙`) last so it stays clearly clickable even with header hidden.
    if (gearBox) {
        roundedRect(cr, gearBox.x + 0.5, gearBox.y + 0.5, gearBox.width - 1, gearBox.height - 1, 5);
        cr.setSourceRGB(1, 1, 1);
        cr.fillPreserve();
        cr.setSourceRGB(0, 0, 0);
        cr.setLineWidth(1.5);
        cr.stroke();
        drawText(
            cr, '\u2699', gearBox.x + gearBox.width / 2, gearBox.y + Math.round(gearBox.height * 0.14),
            Math.max(11, Math.round(gearBox.height * 0.62)), COLOR_BLACK, {bold: true, align: 'center'},
        );
    }

    return {
        gearBox,
        startSystemIndex: pageStart,
        activeSlot,
        visibleRows: visRows,
        barsPerSystem: dims.barsPerSystem,
        effectiveScale: uiScale,
        clampedScale: dims.clampedScale,
        reflowed: dims.reflowed,
        topMargin: dims.topMargin,
        systemH: dims.systemH,
        systemGap: dims.systemGap,
        bodyTop: dims.bodyTop,
        bodyH: dims.bodyH,
    };
}
