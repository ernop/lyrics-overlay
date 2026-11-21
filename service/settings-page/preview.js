// Live HTML5 Canvas visualizers for the settings page:
// 1. LyricPreviewCanvas: true-to-life preview of the lyric line using the
//    exact same fixed font size, balanced wrapping, proportional fused
//    double/glow borders, and em-scaled backdrop rules as text-layout.js.
// 2. ScreenPlacementMap: interactive true-aspect monitor map with 8-handle
//    edge/corner resize, drag-to-move with magnetic center snap, and live
//    pitch-panel docking/undocking.
// 3. PitchPreviewCanvas: live preview of the pitch panel using the exact
//    shared pitch-layout.js and scales.js rules.

import {
    OUTER_EDGE, backdropMetrics, balancedWrapWidth, borderSpec, boxFromGeometry, boxZoneAt,
    dockedPanelBox, edgeResizedBox, geometryFromBox, movedBox, normalizedSpaceScale, snapBox,
    snappedDock, verticalAnchorFor,
} from '/shared/overlay-geometry.js';
import {labeledLines, noteLines} from '/shared/pitch-layout.js';
import {keyName, noteLabel, pitchClassNames, scalePitchClasses} from '/shared/scales.js';
import {hexColor, parseHexColor, resolveRingColors, resolveTextColor} from '/shared/text-ink.js';

const EDGE_PIXELS = 4;
const RUBY_SIZE_RATIO = 0.44;
const MIN_RUBY_FONT_SIZE = 12;
const DOCKED_HEIGHT_RANGE = [0.03, 0.6];
const DOCKED_WIDTH_RANGE = [0.05, 0.6];

function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
}

function rgba(rgb, alpha = 1) {
    return `rgba(${Math.round(rgb[0] * 255)}, ${Math.round(rgb[1] * 255)}, ${Math.round(rgb[2] * 255)}, ${alpha})`;
}

function roundedRectPath(ctx, x, y, width, height, radius) {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + width, y, x + width, y + height, r);
    ctx.arcTo(x + width, y + height, x, y + height, r);
    ctx.arcTo(x, y + height, x, y, r);
    ctx.arcTo(x, y, x + width, y, r);
    ctx.closePath();
}

function fontCss(values, sizePx) {
    const family = values['font-family']
        ? `"${values['font-family'].replaceAll('\\', '\\\\').replaceAll('"', '\\"')}", system-ui, sans-serif`
        : 'system-ui, sans-serif';
    return `${values['font-italic'] ? 'italic ' : ''}${values['font-bold'] ? 700 : 400} ${sizePx}px ${family}`;
}

function applyNormalizedWordSpacing(ctx, fontSize, targetSpaceEm) {
    if (!('wordSpacing' in ctx))
        return 1;
    ctx.wordSpacing = '0px';
    const natSpace = Math.max(1, ctx.measureText('a a').width - ctx.measureText('aa').width);
    const spaceScale = normalizedSpaceScale(natSpace / fontSize, targetSpaceEm);
    if (spaceScale < 1)
        ctx.wordSpacing = `${((spaceScale - 1) * natSpace).toFixed(2)}px`;
    return spaceScale;
}

function wrapLines(ctx, text, maxWidth) {
    const words = text.split(/\s+/u).filter(Boolean);
    if (!words.length)
        return [''];
    const lines = [];
    let current = '';
    for (const word of words) {
        const candidate = current ? `${current} ${word}` : word;
        if (!current || ctx.measureText(candidate).width <= maxWidth) {
            current = candidate;
            continue;
        }
        lines.push(current);
        if (ctx.measureText(word).width <= maxWidth) {
            current = word;
        } else {
            let piece = '';
            for (const ch of word) {
                const next = piece + ch;
                if (piece && ctx.measureText(next).width > maxWidth) {
                    lines.push(piece);
                    piece = ch;
                } else {
                    piece = next;
                }
            }
            current = piece;
        }
    }
    if (current)
        lines.push(current);
    return lines;
}

function borderOpts(values) {
    return {
        cloud: Boolean(values['text-border-cloud']),
        ringWidths: [1, 2, 3, 4].map(i => values[`text-border-${i}-width`] ?? 0),
    };
}

function edgePad(values, fontSize) {
    const ring = borderSpec(values['text-border'], fontSize, borderOpts(values));
    const bp = (values['text-backdrop'] ?? 'none') === 'pill' ? backdropMetrics(fontSize) : {padX: 0, padY: 0};
    const reach = ring.totalReach + ring.extraPad;
    return {
        x: Math.ceil(reach) + bp.padX + EDGE_PIXELS,
        y: Math.ceil(reach) + bp.padY + EDGE_PIXELS,
    };
}

function normalizeRubySegments(text, ruby) {
    if (!Array.isArray(ruby) || !ruby.length)
        return null;
    let joined = '';
    const spans = [];
    for (const seg of ruby) {
        if (!Array.isArray(seg) || seg.length < 2)
            return null;
        const base = String(seg[0] ?? '');
        const reading = String(seg[1] ?? '').trim();
        if (reading && base)
            spans.push({start: joined.length, end: joined.length + base.length, reading});
        joined += base;
    }
    return joined === text && spans.length ? spans : null;
}

/**
 * Computes exact monitor-pixel layout at the constant `font-size` without
 * ever shrinking text: long lines wrap cleanly and expand surface height.
 */
export function computeLyricLayout(ctx, text, values, monitor, ruby = null) {
    const boxW = Math.max(160, Math.round(values.box.width * monitor.width));
    const boxH = Math.max(48, Math.round(values.box.height * monitor.height));
    const fontSize = values['font-size'];
    const ring = borderSpec(values['text-border'], fontSize, borderOpts(values));
    const pad = edgePad(values, fontSize);
    const maxWidth = Math.max(1, boxW - 2 * pad.x);
    const lineStep = fontSize * 1.24;

    ctx.font = fontCss(values, fontSize);
    ctx.textBaseline = 'middle';
    const spaceScale = applyNormalizedWordSpacing(ctx, fontSize, ring.targetSpaceEm);
    const xBox = ctx.measureText('x');
    const xMetrics = {
        ascent: xBox.actualBoundingBoxAscent,
        descent: xBox.actualBoundingBoxDescent,
    };
    const lineCountAt = w => wrapLines(ctx, text, w).length;
    const balancedW = Math.min(maxWidth, balancedWrapWidth(maxWidth, lineCountAt));
    const lines = wrapLines(ctx, text, balancedW);
    const lineWidths = lines.map(line => ctx.measureText(line).width);
    const blockW = Math.max(...lineWidths, 1);

    const rubySpans = values['text-furigana'] ? normalizeRubySegments(text, ruby) : null;
    let rubyInfo = null;
    let lineYs = lines.map((_, idx) => (idx + 0.5) * lineStep);
    let blockH = lines.length * lineStep;

    if (rubySpans) {
        const rubyFontSize = Math.max(MIN_RUBY_FONT_SIZE, Math.round(fontSize * RUBY_SIZE_RATIO));
        const rubyRing = borderSpec(values['text-border'], rubyFontSize, borderOpts(values));
        const baseInner = ring.rings[0]?.width ?? 0;
        const rubyGap = Math.max(Math.round(fontSize * 0.11), Math.round(baseInner));
        const rubyRise = rubyFontSize + rubyGap;

        // Locate each wrapped line's character span in `text`.
        const lineRanges = [];
        let cursor = 0;
        for (const line of lines) {
            const idx = text.indexOf(line, cursor);
            const start = idx >= 0 ? idx : cursor;
            lineRanges.push({start, end: start + line.length, spans: []});
            cursor = start + line.length;
        }
        for (const span of rubySpans) {
            const entry = lineRanges.find(r => span.start >= r.start && span.start < r.end);
            if (entry)
                entry.spans.push(span);
        }

        // Compute per-line vertical positions with extra headroom above any
        // wrapped line that carries furigana.
        lineYs = [];
        let yCursor = 0;
        for (let i = 0; i < lines.length; i++) {
            const hasRuby = lineRanges[i].spans.length > 0;
            const headroom = hasRuby ? rubyRise + (i > 0 ? Math.max(Math.round(fontSize * 0.16), Math.round(rubyRing.totalReach)) : 0) : 0;
            yCursor += headroom;
            lineYs.push(yCursor + 0.5 * lineStep);
            yCursor += lineStep;
        }
        blockH = yCursor;

        // Measure relative horizontal center of every ruby span within its line.
        const perLineRuns = [];
        ctx.font = fontCss(values, fontSize);
        applyNormalizedWordSpacing(ctx, fontSize, ring.targetSpaceEm);
        for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const range = lineRanges[i];
            for (const span of range.spans) {
                const localStart = Math.max(0, span.start - range.start);
                const localEnd = Math.min(line.length, span.end - range.start);
                const prefixW = ctx.measureText(line.slice(0, localStart)).width;
                const spanW = ctx.measureText(line.slice(localStart, localEnd)).width;
                perLineRuns.push({
                    lineIdx: i,
                    reading: span.reading,
                    relCenterX: prefixW + spanW / 2,
                    yOffset: -(fontSize * 0.48 + rubyGap + rubyFontSize * 0.45),
                });
            }
        }
        ctx.font = fontCss(values, rubyFontSize);
        if ('wordSpacing' in ctx)
            ctx.wordSpacing = '0px';
        for (const run of perLineRuns)
            run.width = ctx.measureText(run.reading).width;

        if (perLineRuns.length)
            rubyInfo = {fontSize: rubyFontSize, ring: rubyRing, runs: perLineRuns};
    }

    const requiredH = Math.ceil(blockH + 2 * pad.y);
    const renderH = Math.min(monitor.height, Math.max(boxH, requiredH));

    return {
        boxW,
        boxH,
        renderH,
        fontSize,
        ring,
        spaceScale,
        xMetrics,
        lines,
        lineWidths,
        lineYs,
        lineStep,
        blockW,
        blockH,
        pad,
        ruby: rubyInfo,
    };
}

// ----- 1. Live Lyric Preview Canvas

function paintSceneBackground(ctx, width, height, scene) {
    if (scene === 'dark') {
        ctx.fillStyle = '#000000';
        ctx.fillRect(0, 0, width, height);
        return;
    }
    if (scene === 'light') {
        const grad = ctx.createLinearGradient(0, 0, width, height);
        grad.addColorStop(0, '#dbeafe');
        grad.addColorStop(0.55, '#f8fafc');
        grad.addColorStop(1, '#fef3c7');
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, width, height);
        return;
    }
    // Default 'video': warm stage-lit gradient mimicking a music video frame.
    const grad = ctx.createLinearGradient(0, 0, width, height);
    grad.addColorStop(0, '#0c1324');
    grad.addColorStop(0.45, '#1d293e');
    grad.addColorStop(0.8, '#3b1d36');
    grad.addColorStop(1, '#1c1816');
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
    const glow = ctx.createRadialGradient(width * 0.35, height * 0.35, 10, width * 0.35, height * 0.35, width * 0.58);
    glow.addColorStop(0, 'rgba(251, 191, 36, 0.24)');
    glow.addColorStop(1, 'rgba(251, 191, 36, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, width, height);
}

const GLOW_CANVAS_PASSES = [
    {frac: 1.55, alpha: 0.09},
    {frac: 1.25, alpha: 0.16},
    {frac: 0.95, alpha: 0.28},
    {frac: 0.65, alpha: 0.48},
    {frac: 0.38, alpha: 0.78},
    {frac: 0.16, alpha: 0.96},
];

export class LyricPreviewCanvas {
    constructor(canvas, onTelemetry) {
        this._canvas = canvas;
        this._onTelemetry = onTelemetry;
        this._lastArgs = null;
        this._observer = new ResizeObserver(() => {
            if (this._lastArgs)
                this.render(...this._lastArgs);
        });
        this._observer.observe(canvas);
    }

    render(values, monitor, sampleText, scene = 'video', ruby = null) {
        this._lastArgs = [values, monitor, sampleText, scene, ruby];
        const canvas = this._canvas;
        const rect = canvas.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 10)
            return;
        const dpr = window.devicePixelRatio || 1;
        const cw = Math.round(rect.width * dpr);
        const ch = Math.round(rect.height * dpr);
        if (canvas.width !== cw || canvas.height !== ch) {
            canvas.width = cw;
            canvas.height = ch;
        }
        const ctx = canvas.getContext('2d');
        ctx.save();
        ctx.scale(dpr, dpr);
        const w = rect.width;
        const h = rect.height;

        paintSceneBackground(ctx, w, h, scene);

        const layout = computeLyricLayout(ctx, sampleText || 'Amazing grace, how sweet the sound', values, monitor, ruby);
        this._onTelemetry?.(layout);

        // Fit the monitor-pixel surface proportionally inside the preview canvas.
        const margin = 16;
        const scale = Math.min((w - margin * 2) / layout.boxW, (h - margin * 2) / layout.renderH);
        const drawW = layout.boxW * scale;
        const drawH = layout.renderH * scale;
        const bx = (w - drawW) / 2;
        const by = (h - drawH) / 2;

        ctx.save();
        ctx.translate(bx, by);
        ctx.scale(scale, scale);

        const fill = resolveTextColor(values['text-color'], values['text-custom-color'] ?? '');
        const {ring, fontSize, pad} = layout;
        const customHexes = [1, 2, 3, 4].map(i => values[`text-border-${i}-color`] ?? '');
        const ringPalette = resolveRingColors(fill, ring.rings.length, customHexes);
        const align = values['text-align'] ?? 'center';
        const anchor = verticalAnchorFor(values.box.cy, values['pitch-dock'], values['pitch-enabled']);

        let originY;
        if (anchor === 'top')
            originY = pad.y;
        else if (anchor === 'bottom')
            originY = Math.max(pad.y, layout.renderH - pad.y - layout.blockH);
        else
            originY = Math.max(pad.y, (layout.renderH - layout.blockH) / 2);

        const lineX = lineW => {
            if (align === 'left')
                return pad.x;
            if (align === 'right')
                return layout.boxW - pad.x - lineW;
            return (layout.boxW - lineW) / 2;
        };

        // Compute placed, de-overlapped furigana runs in monitor coordinates.
        const rubyRuns = [];
        if (layout.ruby) {
            const rubyMinGap = Math.max(2, Math.round(layout.ruby.fontSize * 0.14));
            const byLine = new Map();
            for (const run of layout.ruby.runs) {
                const lx = lineX(layout.lineWidths[run.lineIdx]);
                const ly = originY + layout.lineYs[run.lineIdx];
                const rawX = lx + run.relCenterX - run.width / 2;
                const clampedX = clamp(rawX, EDGE_PIXELS, layout.boxW - EDGE_PIXELS - run.width);
                const placed = {text: run.reading, x: clampedX, y: ly + run.yOffset, width: run.width};
                if (!byLine.has(run.lineIdx))
                    byLine.set(run.lineIdx, []);
                byLine.get(run.lineIdx).push(placed);
            }
            for (const list of byLine.values()) {
                list.sort((a, b) => a.x - b.x);
                for (let i = 1; i < list.length; i++) {
                    const minX = list[i - 1].x + list[i - 1].width + rubyMinGap;
                    if (list[i].x < minX)
                        list[i].x = minX;
                }
                rubyRuns.push(...list);
            }
        }

        // Backdrop plate (automatic em-proportional padding and corner radius)
        const backdropMode = values['text-backdrop'] ?? 'none';
        if (backdropMode !== 'none' && (values['text-backdrop-opacity'] ?? 0.65) > 0) {
            const bgRgb = parseHexColor(values['text-backdrop-color'] ?? '#000000') ?? [0, 0, 0];
            const metrics = backdropMetrics(fontSize);
            ctx.fillStyle = rgba(bgRgb, values['text-backdrop-opacity'] ?? 0.65);
            if (backdropMode === 'box') {
                roundedRectPath(ctx, 0, 0, layout.boxW, layout.renderH, metrics.radius);
                ctx.fill();
            } else {
                const reach = ring.totalReach;
                let minX = Math.min(...layout.lineWidths.map(lineX));
                let maxX = Math.max(...layout.lineWidths.map(lw => lineX(lw) + lw));
                for (const run of rubyRuns) {
                    minX = Math.min(minX, run.x);
                    maxX = Math.max(maxX, run.x + run.width);
                }
                const px = Math.max(0, minX - reach - metrics.padX);
                const py = Math.max(0, originY - reach - metrics.padY);
                const pr = Math.min(layout.boxW, maxX + reach + metrics.padX);
                const pb = Math.min(layout.renderH, originY + layout.blockH + reach + metrics.padY);
                roundedRectPath(ctx, px, py, Math.max(1, pr - px), Math.max(1, pb - py), metrics.radius);
                ctx.fill();
            }
        }

        const setBaseFont = () => {
            ctx.font = fontCss(values, fontSize);
            ctx.textBaseline = 'middle';
            applyNormalizedWordSpacing(ctx, fontSize, ring.targetSpaceEm);
        };
        const setRubyFont = () => {
            ctx.font = fontCss(values, layout.ruby.fontSize);
            ctx.textBaseline = 'middle';
            if ('wordSpacing' in ctx)
                ctx.wordSpacing = '0px';
        };
        setBaseFont();
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.miterLimit = 2;

        const paintBridge = (color, reach) => {
            if (!ring.bridge || reach <= 0)
                return;
            setBaseFont();
            ctx.fillStyle = color;
            layout.lines.forEach((line, idx) => {
                if (line.trim().length < 2)
                    return;
                const x = lineX(layout.lineWidths[idx]);
                const y = originY + layout.lineYs[idx];
                const m = ctx.measureText(line);
                const left = x - (m.actualBoundingBoxLeft ?? 0);
                const right = x + (m.actualBoundingBoxRight ?? layout.lineWidths[idx]);
                const top = Math.max(y - m.actualBoundingBoxAscent, y - layout.xMetrics.ascent);
                const bottom = Math.min(y + m.actualBoundingBoxDescent, y + layout.xMetrics.descent);
                if (bottom - top < 2 || right <= left)
                    return;
                const bx = left - reach;
                const by = top - reach;
                const bw = (right - left) + 2 * reach;
                const bh = (bottom - top) + 2 * reach;
                const r = Math.min(reach + (bottom - top) * 0.35, bh / 2);
                roundedRectPath(ctx, bx, by, bw, bh, r);
                ctx.fill();
            });
        };

        const paintBasePass = (mode, color, lineWidth = 0) => {
            setBaseFont();
            if (mode === 'stroke') {
                ctx.strokeStyle = color;
                ctx.lineWidth = lineWidth;
            } else {
                ctx.fillStyle = color;
            }
            layout.lines.forEach((line, idx) => {
                const x = lineX(layout.lineWidths[idx]);
                const y = originY + layout.lineYs[idx];
                if (mode === 'stroke')
                    ctx.strokeText(line, x, y);
                else
                    ctx.fillText(line, x, y);
            });
        };

        const paintRubyPass = (mode, color, lineWidth = 0) => {
            if (!rubyRuns.length)
                return;
            setRubyFont();
            if (mode === 'stroke') {
                ctx.strokeStyle = color;
                ctx.lineWidth = lineWidth;
            } else {
                ctx.fillStyle = color;
            }
            for (const run of rubyRuns) {
                if (mode === 'stroke')
                    ctx.strokeText(run.text, run.x, run.y);
                else
                    ctx.fillText(run.text, run.x, run.y);
            }
        };

        const paintSilhouette = (color, baseReach, rubyReach = 0) => {
            paintBridge(color, baseReach);
            paintBasePass('stroke', color, 2 * baseReach);
            if (rubyRuns.length && rubyReach > 0)
                paintRubyPass('stroke', color, 2 * rubyReach);
        };

        // Precompute cumulative reach for each ring from innermost (0) to outermost (n-1).
        const reaches = [];
        let acc = 0;
        for (const entry of ring.rings) {
            acc += entry.width;
            reaches.push(acc);
        }
        const rubyReaches = [];
        if (layout.ruby) {
            let racc = 0;
            for (const entry of layout.ruby.ring.rings) {
                racc += entry.width;
                rubyReaches.push(racc);
            }
        }

        // Optional smooth dark backing cloud behind rings
        if (ring.auraSpread > 0 && ring.auraAlpha > 0 && reaches.length) {
            const solidIdx = ring.featheredOuter && reaches.length > 1 ? reaches.length - 2 : reaches.length - 1;
            const auraReach = reaches[solidIdx];
            const rubyAuraReach = rubyReaches[solidIdx] ?? 0;
            const blurPx = ring.auraSpread * 0.55 * scale * dpr;
            const dropPx = Math.round(fontSize * 0.03) * scale * dpr;
            ctx.save();
            ctx.shadowColor = `rgba(0, 0, 0, ${ring.auraAlpha})`;
            ctx.shadowBlur = blurPx;
            ctx.shadowOffsetX = 0;
            ctx.shadowOffsetY = dropPx;
            paintSilhouette('rgba(0, 0, 0, 1)', auraReach, rubyAuraReach);
            ctx.shadowBlur = blurPx * 0.45;
            ctx.shadowColor = `rgba(0, 0, 0, ${(ring.auraAlpha * 0.55).toFixed(2)})`;
            paintSilhouette('rgba(0, 0, 0, 1)', auraReach, rubyAuraReach);
            ctx.restore();
        }

        // Concentric rings painted outermost -> innermost across base + furigana.
        for (let i = ring.rings.length - 1; i >= 0; i--) {
            const entry = ring.rings[i];
            const rubyEntry = layout.ruby?.ring.rings[i];
            const color = ringPalette[i];
            const prevReach = i > 0 ? reaches[i - 1] : 0;
            const prevRubyReach = i > 0 ? (rubyReaches[i - 1] ?? 0) : 0;
            if (entry.feathered) {
                for (const pass of GLOW_CANVAS_PASSES) {
                    paintSilhouette(
                        rgba(color, pass.alpha),
                        prevReach + entry.width * pass.frac,
                        rubyEntry ? prevRubyReach + rubyEntry.width * pass.frac : 0,
                    );
                }
            } else {
                paintSilhouette(rgba(color, 1), reaches[i], rubyReaches[i] ?? 0);
            }
        }

        // Pure opaque letter fills (base + furigana)
        paintBasePass('fill', rgba(fill, 1));
        paintRubyPass('fill', rgba(fill, 1));

        ctx.restore();
        ctx.restore();
    }
}

// ----- 2. Interactive Screen Placement Map

const CSS_CURSORS = {
    'move': 'move',
    'top': 'ns-resize',
    'bottom': 'ns-resize',
    'left': 'ew-resize',
    'right': 'ew-resize',
    'top-left': 'nwse-resize',
    'bottom-right': 'nwse-resize',
    'top-right': 'nesw-resize',
    'bottom-left': 'nesw-resize',
};

function zoneKey(zone) {
    if (!zone || zone === 'move')
        return zone ?? '';
    return ['top', 'bottom', 'left', 'right'].filter(edge => zone.edges[edge]).join('-');
}

function inside(pt, box) {
    return pt.x >= box.x && pt.x <= box.x + box.width && pt.y >= box.y && pt.y <= box.y + box.height;
}

export class ScreenPlacementMap {
    /**
     * @param {{stage: HTMLElement, canvas: HTMLCanvasElement,
     *          onChange: (changes: Record<string, unknown>) => void,
     *          onHold: (keys: string[], held: boolean) => void}} options
     */
    constructor({stage, canvas, onChange, onHold}) {
        this._stage = stage;
        this._canvas = canvas;
        this._onChange = onChange;
        this._onHold = onHold;
        this._values = null;
        this._monitor = {width: 1920, height: 1080};
        this._sampleText = 'Amazing grace';
        this._drag = null;
        this._hover = null;
        this._guides = {x: [], y: []};

        this._observer = new ResizeObserver(() => this._paint());
        this._observer.observe(canvas);

        canvas.addEventListener('pointerdown', event => this._onDown(event));
        canvas.addEventListener('pointermove', event => this._onMove(event));
        canvas.addEventListener('pointerup', event => this._onUp(event));
        canvas.addEventListener('pointercancel', event => this._onUp(event));
        canvas.addEventListener('pointerleave', () => {
            if (!this._drag && this._hover) {
                this._hover = null;
                this._canvas.style.cursor = 'default';
                this._paint();
            }
        });
    }

    update(values, monitor, sampleText) {
        this._values = values;
        this._monitor = monitor;
        this._sampleText = sampleText || 'Amazing grace';
        this._stage.style.aspectRatio = `${monitor.width} / ${monitor.height}`;
        this._paint();
    }

    _area() {
        return {x: 0, y: 0, width: this._monitor.width, height: this._monitor.height};
    }

    _boxes() {
        const area = this._area();
        const lyric = boxFromGeometry(this._values.box, area);
        let pitch = null;
        if (this._values['pitch-enabled']) {
            const dock = this._values['pitch-dock'];
            if (dock === 'separate') {
                pitch = boxFromGeometry(this._values['pitch-box'], area);
            } else {
                const thickness = dock === 'below' || dock === 'above'
                    ? this._values['pitch-docked-height'] * area.height
                    : this._values['pitch-docked-width'] * area.width;
                pitch = dockedPanelBox(lyric, dock, thickness, area);
            }
        }
        return {area, lyric, pitch};
    }

    _stagePoint(event) {
        const rect = this._canvas.getBoundingClientRect();
        return {
            x: (event.clientX - rect.left) / rect.width * this._monitor.width,
            y: (event.clientY - rect.top) / rect.height * this._monitor.height,
            pxPerMon: rect.width / this._monitor.width,
        };
    }

    _hitTest(point) {
        const {lyric, pitch} = this._boxes();
        const edgeMon = Math.max(18, 11 / point.pxPerMon);
        if (inside(point, lyric))
            return {target: 'lyric', zone: boxZoneAt(point, lyric, edgeMon)};
        if (pitch && inside(point, pitch)) {
            const dock = this._values['pitch-dock'];
            if (dock === 'separate')
                return {target: 'pitch', zone: boxZoneAt(point, pitch, edgeMon)};
            const outer = OUTER_EDGE[dock];
            const z = boxZoneAt(point, pitch, edgeMon);
            if (z !== 'move' && z.edges[outer])
                return {target: 'pitch', zone: {edges: {[outer]: true}}};
            return {target: 'pitch', zone: 'move'};
        }
        return null;
    }

    _onDown(event) {
        if (event.button !== 0 || !this._values)
            return;
        const point = this._stagePoint(event);
        const hit = this._hitTest(point);
        if (!hit)
            return;
        event.preventDefault();
        this._canvas.setPointerCapture(event.pointerId);
        const {lyric, pitch} = this._boxes();
        const start = hit.target === 'lyric' ? lyric : pitch;
        const heldKeys = hit.target === 'lyric'
            ? ['box']
            : ['pitch-dock', 'pitch-box', 'pitch-docked-height', 'pitch-docked-width'];
        this._onHold(heldKeys, true);
        this._drag = {
            ...hit,
            pointerId: event.pointerId,
            press: point,
            start,
            dock: this._values['pitch-dock'],
            heldKeys,
        };
        this._canvas.style.cursor = hit.zone === 'move' ? 'grabbing' : (CSS_CURSORS[zoneKey(hit.zone)] ?? 'move');
        this._paint();
    }

    _onMove(event) {
        if (!this._values)
            return;
        const point = this._stagePoint(event);
        if (!this._drag) {
            const hit = this._hitTest(point);
            const prev = this._hover ? `${this._hover.target}:${zoneKey(this._hover.zone)}` : '';
            const next = hit ? `${hit.target}:${zoneKey(hit.zone)}` : '';
            this._hover = hit;
            this._canvas.style.cursor = hit ? (CSS_CURSORS[zoneKey(hit.zone)] ?? 'move') : 'default';
            if (prev !== next)
                this._paint();
            return;
        }
        const drag = this._drag;
        const area = this._area();
        const dx = point.x - drag.press.x;
        const dy = point.y - drag.press.y;
        const snapMon = 10 / point.pxPerMon;

        if (drag.target === 'lyric') {
            let nextBox;
            if (drag.zone === 'move') {
                const raw = movedBox(drag.start, dx, dy, area);
                if (event.shiftKey) {
                    this._guides = {x: [], y: []};
                    nextBox = raw;
                } else {
                    const snapped = snapBox(raw, area, snapMon);
                    this._guides = snapped.guides;
                    nextBox = snapped.box;
                }
            } else {
                this._guides = {x: [], y: []};
                nextBox = edgeResizedBox(drag.start, drag.zone.edges, dx, dy, area);
            }
            this._onChange({box: geometryFromBox(nextBox, area)});
            this._paint();
            return;
        }

        // Pitch panel drag/resize/docking
        this._guides = {x: [], y: []};
        const {lyric} = this._boxes();
        if (drag.zone !== 'move') {
            const resized = edgeResizedBox(drag.start, drag.zone.edges, dx, dy, area);
            if (drag.dock === 'separate')
                this._onChange({'pitch-box': geometryFromBox(resized, area)});
            else if (drag.dock === 'below' || drag.dock === 'above')
                this._onChange({'pitch-docked-height': clamp(resized.height / area.height, ...DOCKED_HEIGHT_RANGE)});
            else
                this._onChange({'pitch-docked-width': clamp(resized.width / area.width, ...DOCKED_WIDTH_RANGE)});
        } else {
            const moved = movedBox(drag.start, dx, dy, area);
            const snap = snappedDock(moved, lyric, Math.max(24, 16 / point.pxPerMon));
            if (snap) {
                this._onChange({'pitch-dock': snap});
            } else {
                this._onChange({
                    'pitch-dock': 'separate',
                    'pitch-box': geometryFromBox(moved, area),
                });
            }
        }
        this._paint();
    }

    _onUp(event) {
        if (!this._drag)
            return;
        if (this._canvas.hasPointerCapture(event.pointerId))
            this._canvas.releasePointerCapture(event.pointerId);
        const held = this._drag.heldKeys;
        this._drag = null;
        this._guides = {x: [], y: []};
        this._onHold(held, false);
        this._canvas.style.cursor = 'default';
        this._paint();
    }

    _paint() {
        if (!this._values)
            return;
        const canvas = this._canvas;
        const rect = canvas.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 10)
            return;
        const dpr = window.devicePixelRatio || 1;
        const cw = Math.round(rect.width * dpr);
        const ch = Math.round(rect.height * dpr);
        if (canvas.width !== cw || canvas.height !== ch) {
            canvas.width = cw;
            canvas.height = ch;
        }
        const ctx = canvas.getContext('2d');
        ctx.save();
        ctx.scale(dpr, dpr);
        const w = rect.width;
        const h = rect.height;
        const sx = w / this._monitor.width;
        const sy = h / this._monitor.height;

        const bg = ctx.createLinearGradient(0, 0, w, h);
        bg.addColorStop(0, '#0c1324');
        bg.addColorStop(1, '#1a182b');
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, w, h);

        // Rule of thirds + center crosshair
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.1)';
        ctx.lineWidth = 1;
        for (const frac of [1 / 3, 2 / 3]) {
            ctx.beginPath();
            ctx.moveTo(Math.round(w * frac) + 0.5, 0);
            ctx.lineTo(Math.round(w * frac) + 0.5, h);
            ctx.moveTo(0, Math.round(h * frac) + 0.5);
            ctx.lineTo(w, Math.round(h * frac) + 0.5);
            ctx.stroke();
        }
        ctx.strokeStyle = 'rgba(255, 255, 255, 0.22)';
        ctx.setLineDash([4, 4]);
        ctx.beginPath();
        ctx.moveTo(Math.round(w / 2) + 0.5, 0);
        ctx.lineTo(Math.round(w / 2) + 0.5, h);
        ctx.moveTo(0, Math.round(h / 2) + 0.5);
        ctx.lineTo(w, Math.round(h / 2) + 0.5);
        ctx.stroke();
        ctx.setLineDash([]);

        // Active snap guides
        ctx.strokeStyle = '#facc15';
        ctx.lineWidth = 1.5;
        for (const gx of this._guides.x) {
            const x = Math.round(gx * sx) + 0.5;
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, h);
            ctx.stroke();
        }
        for (const gy of this._guides.y) {
            const y = Math.round(gy * sy) + 0.5;
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(w, y);
            ctx.stroke();
        }

        const {lyric, pitch} = this._boxes();
        const activeTarget = this._drag?.target ?? this._hover?.target ?? null;
        const activeZone = zoneKey(this._drag?.zone ?? this._hover?.zone ?? null);

        if (pitch) {
            const px = pitch.x * sx, py = pitch.y * sy, pw = pitch.width * sx, ph = pitch.height * sy;
            roundedRectPath(ctx, px, py, pw, ph, 4);
            ctx.fillStyle = `rgba(0, 0, 0, ${Math.max(0.45, this._values['pitch-background-opacity'] ?? 0.62)})`;
            ctx.fill();
            ctx.strokeStyle = activeTarget === 'pitch' ? '#facc15' : '#4ade80';
            ctx.lineWidth = 1.5;
            ctx.stroke();

            ctx.save();
            ctx.beginPath();
            ctx.rect(px + 3, py + 3, Math.max(1, pw - 6), Math.max(1, ph - 6));
            ctx.clip();
            ctx.strokeStyle = this._values['pitch-line-color'] || '#facc15';
            ctx.lineWidth = 1.5;
            ctx.beginPath();
            for (let i = 0; i <= 16; i++) {
                const tx = px + 4 + (pw - 8) * (i / 16);
                const ty = py + ph * (0.55 - 0.25 * Math.sin(i * 0.5));
                if (i === 0) ctx.moveTo(tx, ty);
                else ctx.lineTo(tx, ty);
            }
            ctx.stroke();
            ctx.restore();

            if (this._values['pitch-dock'] === 'separate') {
                this._drawHandles(ctx, px, py, pw, ph, activeTarget === 'pitch' ? activeZone : '', '#4ade80');
            } else {
                const outer = OUTER_EDGE[this._values['pitch-dock']];
                this._drawSingleEdgeHandle(ctx, px, py, pw, ph, outer, activeTarget === 'pitch' && activeZone === outer);
            }
        }

        const lx = lyric.x * sx, ly = lyric.y * sy, lw = lyric.width * sx, lh = lyric.height * sy;
        ctx.fillStyle = 'rgba(37, 99, 235, 0.22)';
        ctx.fillRect(lx, ly, lw, lh);
        ctx.strokeStyle = activeTarget === 'lyric' ? '#facc15' : '#60a5fa';
        ctx.lineWidth = 2;
        ctx.strokeRect(lx + 1, ly + 1, Math.max(1, lw - 2), Math.max(1, lh - 2));

        const fill = resolveTextColor(this._values['text-color'], this._values['text-custom-color'] ?? '');
        ctx.save();
        ctx.beginPath();
        ctx.rect(lx + 3, ly + 2, Math.max(1, lw - 6), Math.max(1, lh - 4));
        ctx.clip();
        const miniSize = clamp(Math.min(lh * 0.58, this._values['font-size'] * sy), 7, 22);
        ctx.font = `800 ${miniSize}px system-ui, sans-serif`;
        ctx.textBaseline = 'middle';
        const align = this._values['text-align'] ?? 'center';
        ctx.textAlign = align === 'left' ? 'left' : align === 'right' ? 'right' : 'center';
        const tx = align === 'left' ? lx + 5 : align === 'right' ? lx + lw - 5 : lx + lw / 2;
        const anchor = verticalAnchorFor(this._values.box.cy, this._values['pitch-dock'], this._values['pitch-enabled']);
        const ty = anchor === 'top' ? ly + miniSize * 0.65 + 2
            : anchor === 'bottom' ? ly + lh - miniSize * 0.65 - 2
                : ly + lh / 2;
        ctx.lineWidth = 2.5;
        ctx.strokeStyle = '#000000';
        ctx.strokeText(this._sampleText, tx, ty);
        ctx.fillStyle = hexColor(fill);
        ctx.fillText(this._sampleText, tx, ty);
        ctx.restore();

        this._drawHandles(ctx, lx, ly, lw, lh, activeTarget === 'lyric' ? activeZone : '', '#ffffff');
        ctx.restore();
    }

    _drawHandles(ctx, x, y, w, h, hotZone, defaultColor) {
        const s = 7;
        const half = s / 2;
        const pts = [
            ['top-left', x, y],
            ['top-right', x + w, y],
            ['bottom-left', x, y + h],
            ['bottom-right', x + w, y + h],
            ['top', x + w / 2, y],
            ['bottom', x + w / 2, y + h],
            ['left', x, y + h / 2],
            ['right', x + w, y + h / 2],
        ];
        for (const [id, cx, cy] of pts) {
            ctx.fillStyle = hotZone === id ? '#facc15' : defaultColor;
            ctx.strokeStyle = '#000000';
            ctx.lineWidth = 1.25;
            ctx.fillRect(cx - half, cy - half, s, s);
            ctx.strokeRect(cx - half, cy - half, s, s);
        }
    }

    _drawSingleEdgeHandle(ctx, x, y, w, h, edge, hot) {
        const s = 7;
        const pos = {
            top: [x + w / 2, y],
            bottom: [x + w / 2, y + h],
            left: [x, y + h / 2],
            right: [x + w, y + h / 2],
        }[edge];
        if (!pos)
            return;
        ctx.fillStyle = hot ? '#facc15' : '#4ade80';
        ctx.strokeStyle = '#000000';
        ctx.lineWidth = 1.25;
        ctx.fillRect(pos[0] - s / 2, pos[1] - s / 2, s, s);
        ctx.strokeRect(pos[0] - s / 2, pos[1] - s / 2, s, s);
    }
}

// ----- 3. Live Pitch Panel Preview Canvas

const SAMPLE_MELODY = [
    {midi: 62, beats: 1}, {midi: 67, beats: 2}, {midi: 71, beats: 1},
    {midi: 69, beats: 1}, {midi: 67, beats: 2}, {midi: 64, beats: 1}, {midi: 62, beats: 2},
];

function buildSampleTrace() {
    const samples = [];
    let t = 0;
    for (const note of SAMPLE_MELODY) {
        const len = note.beats * 550;
        for (let dt = 40; dt < len; dt += 30) {
            const vib = 0.14 * Math.sin(dt / 42);
            const glide = -0.35 * Math.exp(-dt / 55);
            samples.push({t: t + dt, midi: note.midi + glide + vib});
        }
        t += len;
    }
    return {samples, duration: t};
}

const SAMPLE_TRACE = buildSampleTrace();

export class PitchPreviewCanvas {
    constructor(canvas) {
        this._canvas = canvas;
        this._last = null;
        this._observer = new ResizeObserver(() => {
            if (this._last)
                this.render(...this._last);
        });
        this._observer.observe(canvas);
    }

    render(values, detectedKey) {
        this._last = [values, detectedKey];
        const canvas = this._canvas;
        const rect = canvas.getBoundingClientRect();
        if (rect.width < 10 || rect.height < 10)
            return;
        const dpr = window.devicePixelRatio || 1;
        const cw = Math.round(rect.width * dpr);
        const ch = Math.round(rect.height * dpr);
        if (canvas.width !== cw || canvas.height !== ch) {
            canvas.width = cw;
            canvas.height = ch;
        }
        const ctx = canvas.getContext('2d');
        ctx.save();
        ctx.scale(dpr, dpr);
        const width = rect.width;
        const height = rect.height;

        ctx.clearRect(0, 0, width, height);
        roundedRectPath(ctx, 0, 0, width, height, Math.min(10, height / 4));
        ctx.fillStyle = `rgba(0, 0, 0, ${values['pitch-background-opacity']})`;
        ctx.fill();

        const scaleMode = values['pitch-scale'];
        const key = scaleMode === 'none'
            ? null
            : scaleMode === 'fixed'
                ? {root: values['pitch-scale-root'], type: values['pitch-scale-type']}
                : (detectedKey ?? {root: 7, type: 'major'});
        const names = pitchClassNames(key);
        const scale = key ? scalePitchClasses(key) : null;
        const pad = Math.max(4, Math.min(10, Math.round(height * 0.05)));

        const readout = values['pitch-readout'];
        const readoutCents = values['pitch-readout-cents'];
        const readoutSize = values['pitch-readout-size'];
        const noteSize = Math.max(10, readoutSize * height * (readoutCents ? 0.58 : 0.8));
        const centsSize = Math.max(9, noteSize * 0.42);

        ctx.font = `800 ${noteSize}px system-ui, sans-serif`;
        const maxNoteW = Math.max(...names.map(name => ctx.measureText(`${name}8`).width));
        ctx.font = `800 ${centsSize}px system-ui, sans-serif`;
        const slotWidth = Math.max(maxNoteW, readoutCents ? ctx.measureText('\u221250').width : 0);
        const slotHeight = noteSize * 1.15 + (readoutCents ? centsSize * 1.2 : 0);
        const column = readout === 'left' || readout === 'right' ? readout : null;
        const columnWidth = column ? slotWidth + 2 * pad : 0;

        const labelSize = values['pitch-label-size'];
        ctx.font = `700 ${labelSize}px system-ui, sans-serif`;
        const labelWidth = values['pitch-labels'] === 'none'
            ? 0
            : Math.max(...names.map(name => ctx.measureText(`${name}8`).width)) + pad;

        const plot = {
            left: (column === 'left' ? columnWidth : 0) + pad + labelWidth,
            right: width - pad - (column === 'right' ? columnWidth : 0),
            top: pad,
            bottom: height - pad,
        };
        plot.width = Math.max(1, plot.right - plot.left);
        plot.height = Math.max(1, plot.bottom - plot.top);

        const span = values['pitch-range'] === 'fixed'
            ? {low: values['pitch-range-bottom'] - 0.5, high: values['pitch-range-top'] + 0.5}
            : {low: 66 - values['pitch-follow-span'] / 2, high: 66 + values['pitch-follow-span'] / 2};
        const yOf = midi => plot.top + (span.high - midi) / (span.high - span.low) * plot.height;
        const windowMs = values['pitch-window-seconds'] * 1000;
        const xOf = t => plot.right - (SAMPLE_TRACE.duration - t) / windowMs * plot.width;

        const lines = noteLines(span.low, span.high, scale, key ? key.root : null).map(line => ({...line, y: yOf(line.midi)}));
        for (const line of lines) {
            const y = Math.round(line.y) + 0.5;
            const [alpha, lw] = line.root || (!key && line.c) ? [0.85, 2] : line.inScale ? [0.48, 1.5] : [0.16, 1];
            ctx.strokeStyle = `rgba(255, 255, 255, ${alpha})`;
            ctx.lineWidth = lw;
            ctx.beginPath();
            ctx.moveTo(plot.left, y);
            ctx.lineTo(plot.right, y);
            ctx.stroke();
        }

        const named = labeledLines(lines, values['pitch-labels'], labelSize * 1.15, Boolean(key));
        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (const line of lines) {
            if (!named.has(line.midi))
                continue;
            const bold = line.root || line.inScale || (!key && line.c);
            ctx.font = `${bold ? 700 : 400} ${labelSize}px system-ui, sans-serif`;
            ctx.fillText(noteLabel(line.midi, names), plot.left - pad / 2, line.y);
        }

        ctx.save();
        ctx.beginPath();
        ctx.rect(plot.left, plot.top - values['pitch-line-width'], plot.width, plot.height + 2 * values['pitch-line-width']);
        ctx.clip();
        ctx.strokeStyle = values['pitch-line-color'];
        ctx.fillStyle = values['pitch-line-color'];
        ctx.lineWidth = values['pitch-line-width'];
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        let prev = null;
        for (const sample of SAMPLE_TRACE.samples) {
            const x = xOf(sample.t);
            const y = yOf(sample.midi);
            if (prev && sample.t - prev.t <= 80)
                ctx.lineTo(x, y);
            else
                ctx.moveTo(x, y);
            prev = sample;
        }
        ctx.stroke();
        const last = SAMPLE_TRACE.samples[SAMPLE_TRACE.samples.length - 1];
        ctx.beginPath();
        ctx.arc(xOf(last.t), yOf(last.midi), Math.max(3, values['pitch-line-width'] * 1.5), 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();

        const corner = column || readout === 'off' ? null : readout;
        if (values['pitch-show-key'] && key) {
            const tag = keyName(key);
            const tagSize = Math.max(10, labelSize * 1.05);
            ctx.font = `700 ${tagSize}px system-ui, sans-serif`;
            const tw = ctx.measureText(tag).width;
            const th = tagSize * 1.3;
            const keyCorner = corner === 'top-left' ? 'bottom-left' : 'top-left';
            const tx = plot.left + 6;
            const ty = keyCorner.startsWith('top') ? plot.top + 3 : plot.bottom - th - 3;
            roundedRectPath(ctx, tx - 4, ty, tw + 8, th, 4);
            ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
            ctx.fill();
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            ctx.fillText(tag, tx, ty + th / 2);
        }

        if (readout !== 'off') {
            const currentNote = noteLabel(62, names);
            let rx, ry, align;
            if (column) {
                rx = column === 'left' ? pad : width - pad;
                ry = (height - slotHeight) / 2;
                align = column === 'left' ? 'left' : 'right';
            } else {
                const right = corner.endsWith('right');
                const top = corner.startsWith('top');
                rx = right ? plot.right - pad : plot.left + pad;
                ry = top ? plot.top + 2 : plot.bottom - slotHeight - 2;
                align = right ? 'right' : 'left';
                const boxX = right ? rx - slotWidth - pad / 2 : rx - pad / 2;
                roundedRectPath(ctx, boxX, ry, slotWidth + pad, slotHeight, 5);
                ctx.fillStyle = 'rgba(0, 0, 0, 0.72)';
                ctx.fill();
            }
            ctx.fillStyle = '#ffffff';
            ctx.textAlign = align;
            ctx.textBaseline = 'top';
            ctx.font = `800 ${noteSize}px system-ui, sans-serif`;
            ctx.fillText(currentNote, rx, ry);
            if (readoutCents) {
                ctx.font = `800 ${centsSize}px system-ui, sans-serif`;
                ctx.fillText('+4', rx, ry + noteSize * 1.15);
            }
        }
        ctx.restore();
    }
}
