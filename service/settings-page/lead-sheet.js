// Interactive White-Paper Piano Lead Sheet Viewer & Editor Modal
// (?score=1, shortcut S, topbar "Lead sheet" button).
//
// Displays the full song as crisp white-paper sheet music (#ffffff paper,
// #000000 ink, zero gray text) with live playhead tracking and instant
// non-destructive editing (tempo ½×/2×, meter, key, clef, beat shift,
// individual note pitch/duration/split/merge/delete/add, and chord symbols).
// Every edit persists via POST /api/score/edit and updates the floating
// desktop Lead Sheet live.

import {SCALES, pitchClassNames} from '/shared/scales.js';
import {
    MIDDLE_STAFF_STEP, STAFF_BOTTOM_STEP, STAFF_TOP_STEP,
    applyScoreEdits, buildLeadSheet, findActiveLeadSheetPosition,
    layoutSystemLyrics, sampleLeadSheetForPreview,
} from '/shared/score-layout.js';
import {buildMidiPlaybackPlan, encodeLeadSheetMidi} from '/shared/score-midi.js';

const SVG_NS = 'http://www.w3.org/2000/svg';
const DURATION_STEPS = [0.25, 0.5, 0.75, 1, 1.5, 2, 3, 4];
const METER_CHOICES = [[4, 4], [3, 4], [6, 8], [2, 4]];

function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v === null || v === undefined || v === false)
            continue;
        if (k === 'style' && typeof v === 'object')
            Object.assign(node.style, v);
        else if (k.startsWith('on') && typeof v === 'function')
            node.addEventListener(k.slice(2).toLowerCase(), v);
        else
            node.setAttribute(k, v === true ? '' : String(v));
    }
    for (const ch of children) {
        if (ch === null || ch === undefined || ch === false)
            continue;
        node.append(typeof ch === 'string' ? document.createTextNode(ch) : ch);
    }
    return node;
}

function svgEl(tag, attrs = {}, text = null) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (v !== null && v !== undefined)
            node.setAttribute(k, String(v));
    }
    if (text !== null)
        node.textContent = String(text);
    return node;
}

function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
}

function cloneEdits(edits) {
    return JSON.parse(JSON.stringify(edits && typeof edits === 'object' ? edits : {}));
}

function diatonicChordsForKey(key) {
    if (!key || !(key.type in SCALES))
        return ['C', 'Dm', 'Em', 'F', 'G', 'G7', 'Am'];
    const names = pitchClassNames(key);
    const r = key.root;
    const isMinor = key.type === 'minor' || key.type === 'dorian' || key.type === 'phrygian';
    if (isMinor) {
        return [
            `${names[r]}m`,
            `${names[(r + 3) % 12]}`,
            `${names[(r + 5) % 12]}m`,
            `${names[(r + 7) % 12]}m`,
            `${names[(r + 7) % 12]}7`,
            `${names[(r + 8) % 12]}`,
            `${names[(r + 10) % 12]}`,
        ];
    }
    return [
        `${names[r]}`,
        `${names[(r + 2) % 12]}m`,
        `${names[(r + 4) % 12]}m`,
        `${names[(r + 5) % 12]}`,
        `${names[(r + 7) % 12]}`,
        `${names[(r + 7) % 12]}7`,
        `${names[(r + 9) % 12]}m`,
    ];
}

// ----- SVG music notation glyphs (pure black #000000 ink on #ffffff paper)

function drawSvgClef(g, x, yForStep, sp, octaveDown) {
    const gY = yForStep(32);
    const bY = yForStep(34);
    const topY = yForStep(39.8);
    const botY = yForStep(27.6);
    const d = [
        `M ${x + sp * 0.05} ${gY + sp * 0.15}`,
        `C ${x - sp * 0.45} ${gY - sp * 0.55}, ${x + sp * 0.55} ${gY - sp * 0.85}, ${x + sp * 0.72} ${gY + sp * 0.05}`,
        `C ${x + sp * 0.82} ${gY + sp * 0.82}, ${x - sp * 0.55} ${gY + sp * 1.15}, ${x - sp * 0.62} ${gY + sp * 0.10}`,
        `C ${x - sp * 0.68} ${bY - sp * 0.75}, ${x + sp * 0.55} ${yForStep(37.5)}, ${x + sp * 0.35} ${topY}`,
        `C ${x + sp * 0.18} ${topY - sp * 0.65}, ${x - sp * 0.30} ${topY - sp * 0.35}, ${x - sp * 0.15} ${yForStep(37.5)}`,
        `L ${x + sp * 0.18} ${botY}`,
        `C ${x + sp * 0.25} ${botY + sp * 0.65}, ${x - sp * 0.35} ${botY + sp * 0.65}, ${x - sp * 0.42} ${botY + sp * 0.22}`,
    ].join(' ');
    g.append(svgEl('path', {
        d, fill: 'none', stroke: '#000000',
        'stroke-width': Math.max(1.4, sp * 0.21),
        'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    }));
    g.append(svgEl('circle', {
        cx: x - sp * 0.36, cy: botY + sp * 0.18, r: Math.max(1.2, sp * 0.18), fill: '#000000',
    }));
    if (octaveDown) {
        g.append(svgEl('text', {
            x: x + sp * 0.05, y: botY + sp * 1.15,
            fill: '#000000', 'font-size': Math.max(8, sp * 0.95),
            'font-weight': '700', 'text-anchor': 'middle',
        }, '8'));
    }
}

function drawSvgAccidental(g, kind, x, y, sp) {
    const sym = kind === 'sharp' ? '\u266f' : kind === 'flat' ? '\u266d' : kind === 'natural' ? '\u266e' : '';
    if (!sym)
        return;
    g.append(svgEl('text', {
        x, y: y + sp * 0.42, fill: '#000000',
        'font-size': Math.max(12, sp * 1.75), 'font-weight': '700', 'text-anchor': 'middle',
    }, sym));
}

function drawSvgRest(g, item, x, yForStep, sp) {
    if (item.figure === 'whole') {
        g.append(svgEl('rect', {x: x - sp * 0.45, y: yForStep(36), width: sp * 0.90, height: sp * 0.46, fill: '#000000'}));
    } else if (item.figure === 'half') {
        g.append(svgEl('rect', {x: x - sp * 0.45, y: yForStep(34) - sp * 0.46, width: sp * 0.90, height: sp * 0.46, fill: '#000000'}));
    } else if (item.figure === 'quarter') {
        const midY = yForStep(34);
        const d = `M ${x - sp * 0.18} ${midY - sp * 1.15} L ${x + sp * 0.26} ${midY - sp * 0.45} L ${x - sp * 0.24} ${midY + sp * 0.18} L ${x + sp * 0.26} ${midY + sp * 0.72} C ${x - sp * 0.28} ${midY + sp * 0.68}, ${x - sp * 0.34} ${midY + sp * 1.15}, ${x + sp * 0.12} ${midY + sp * 1.32}`;
        g.append(svgEl('path', {
            d, fill: 'none', stroke: '#000000',
            'stroke-width': Math.max(1.5, sp * 0.22), 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        }));
    } else if (item.figure === 'sixteenth') {
        const midY = yForStep(34);
        g.append(svgEl('circle', {cx: x - sp * 0.18, cy: midY - sp * 0.55, r: sp * 0.20, fill: '#000000'}));
        g.append(svgEl('circle', {cx: x - sp * 0.26, cy: midY + sp * 0.08, r: sp * 0.20, fill: '#000000'}));
        g.append(svgEl('path', {
            d: `M ${x - sp * 0.14} ${midY - sp * 0.52} Q ${x + sp * 0.15} ${midY - sp * 0.35}, ${x + sp * 0.34} ${midY - sp * 0.70} L ${x - sp * 0.18} ${midY + sp * 1.20}`,
            fill: 'none', stroke: '#000000', 'stroke-width': Math.max(1.3, sp * 0.16), 'stroke-linecap': 'round',
        }));
    } else {
        const midY = yForStep(34);
        g.append(svgEl('circle', {cx: x - sp * 0.22, cy: midY - sp * 0.32, r: sp * 0.22, fill: '#000000'}));
        g.append(svgEl('path', {
            d: `M ${x - sp * 0.18} ${midY - sp * 0.28} Q ${x + sp * 0.12} ${midY - sp * 0.12}, ${x + sp * 0.34} ${midY - sp * 0.50} L ${x - sp * 0.12} ${midY + sp * 1.05}`,
            fill: 'none', stroke: '#000000', 'stroke-width': Math.max(1.4, sp * 0.17), 'stroke-linecap': 'round',
        }));
    }
    if (item.dots > 0)
        g.append(svgEl('circle', {cx: x + sp * 0.72, cy: yForStep(35), r: Math.max(1.4, sp * 0.17), fill: '#000000'}));
}

function renderSystemSvg(leadSheet, sys, {
    width,
    selectedNoteId,
    selectedBar,
    noteNames,
    showMeasureNumbers = true,
    showChords = true,
    showLyrics = true,
    showSnapMoves = false,
    barsPerSystem = 6,
    editable,
    onSelectNote,
    onSelectBar,
    onEditChord,
    onAuditionBar,
}) {
    const sp = 9.2;
    const staffH = sp * 4;

    // Inspect system note pitch range so chords, bar #, note labels & lyrics NEVER collide!
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

    const extraAbove = Math.max(0, sysMaxStep - STAFF_TOP_STEP) * (sp * 0.5);
    const chordReserve = showChords ? 24 : 8;
    const staffTopY = Math.round(chordReserve + 18 + extraAbove);
    const staffBottomY = staffTopY + staffH;
    const yForStep = step => staffBottomY - (step - STAFF_BOTTOM_STEP) * (sp * 0.5);

    const staffLeft = 10;
    const staffRight = width - 10;

    // Header measurements (clef + key sig + time sig on first system).
    let cursorX = staffLeft + sp * 1.35;
    const clefX = cursorX;
    cursorX += sp * 1.65;
    const keySigStartX = cursorX;
    cursorX += leadSheet.keySig.accidentals.length * (sp * 0.92);
    if (leadSheet.keySig.accidentals.length)
        cursorX += sp * 0.45;
    const isFirst = sys.index === 0;
    const timeSigX = isFirst ? cursorX + sp * 0.65 : null;
    if (isFirst)
        cursorX += sp * 1.75;
    const measuresLeft = cursorX + sp * 0.45;
    const fullMeasuresW = Math.max(80, staffRight - measuresLeft);
    const mCount = Math.max(1, sys.measures.length);

    // Proportional measure widths (sparse bars compact, dense bars breathe; partial final row not stretched).
    const targetCols = Math.max(mCount, barsPerSystem);
    const effectiveMeasuresW = mCount < targetCols ? fullMeasuresW * (mCount / targetCols) : fullMeasuresW;
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

    // Precompute placement + beam geometry + exact ink bounds BEFORE building SVG nodes.
    const stemLen = sp * 3.15;
    const rx = sp * 0.58;
    const measurePlans = [];
    let highestInkY = Math.min(staffTopY - sp * 1.0, yForStep(39.8) - sp * 0.35);
    let lowestInkY = Math.max(staffBottomY + sp * 0.9, yForStep(27.6) + (leadSheet.clef === 'treble-8vb' ? sp * 1.35 : sp * 0.55));

    for (let mi = 0; mi < mCount; mi++) {
        const m = sys.measures[mi];
        const mx0 = mStarts[mi];
        const mw = mWidths[mi];
        const mx1 = mx0 + mw;
        const innerL = mx0 + sp * 1.0;
        const innerR = mx1 - sp * 0.85;
        const innerW = Math.max(16, innerR - innerL);

        const placed = [];
        if (m.multiRest <= 0) {
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
            const minGap = sp * 0.46;
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
            if (Math.abs(y1 - y0) > sp * 1.1)
                y1 = y0 + Math.sign(y1 - y0) * sp * 1.1;
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
            beamTipY.set(gid, {x0, y0, x1, y1, dir, group});
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

    const showNoteLabels = noteNames !== 'off' || showSnapMoves;
    const lyricEntries = [];
    if (showLyrics) {
        for (const plan of measurePlans) {
            for (const p of plan.placed) {
                const it = p.item;
                if (it.kind !== 'note' || !it.lyric)
                    continue;
                lyricEntries.push({
                    x: p.x,
                    text: it.lyric,
                    bold: selectedNoteId !== null && it.noteId === selectedNoteId,
                });
            }
        }
    }
    const lyricFontPx = 12;
    const lyricLineH = 15;
    const lyricLayout = showLyrics
        ? layoutSystemLyrics(lyricEntries, {
            leftBound: staffLeft,
            rightBound: staffRight,
            baseFontPx: lyricFontPx,
            minScale: 0.78,
            maxTiers: 3,
        })
        : {placements: [], tierCount: 0};

    const barNumY = Math.round(Math.min(staffTopY - sp * 0.65, highestInkY - 6));
    const chordY = Math.round(Math.max(16, Math.min(barNumY - 12, highestInkY - 16)));
    const noteLabelY = Math.round(Math.max(staffBottomY + 18, lowestInkY + 13));
    const lyricY = Math.round(!showNoteLabels ? Math.max(staffBottomY + 20, lowestInkY + 15) : (noteLabelY + 16));
    const lyricBottom = showLyrics && lyricLayout.tierCount > 0
        ? lyricY + (lyricLayout.tierCount - 1) * lyricLineH + 12
        : (showNoteLabels ? noteLabelY + 12 : Math.max(staffBottomY + 18, lowestInkY + 10));
    const height = Math.max(118, Math.round(lyricBottom));

    const svg = svgEl('svg', {
        class: 'ls-system-svg',
        viewBox: `0 0 ${width} ${height}`,
        'data-sys-index': sys.index,
        role: 'img',
        'aria-label': `Measures ${sys.firstBar} to ${sys.lastBar}`,
    });

    // Layer 0: Measure backgrounds (for live playhead highlight & bar selection).
    const bgLayer = svgEl('g', {class: 'ls-bg-layer'});
    for (let mi = 0; mi < mCount; mi++) {
        const {m, mx0, mw} = measurePlans[mi];
        const isBarSelected = selectedBar === m.barNumber;
        const rect = svgEl('rect', {
            class: `ls-measure-bg${isBarSelected ? ' ls-bar-selected' : ''}`,
            'data-bar': m.barNumber,
            'data-mi': mi,
            x: mx0,
            y: staffTopY - sp * 1.4,
            width: mw,
            height: staffH + sp * 2.8,
            fill: isBarSelected ? 'rgba(37, 99, 235, 0.12)' : 'transparent',
        });
        if (editable) {
            rect.style.cursor = 'pointer';
            rect.addEventListener('click', () => onSelectBar(m));
        }
        bgLayer.append(rect);
    }
    svg.append(bgLayer);

    // Layer 1: 5 black staff lines + left closing barline + clef/key/time.
    const staffLayer = svgEl('g');
    for (let li = 0; li < 5; li++) {
        const ly = Math.round(staffTopY + li * sp) + 0.5;
        staffLayer.append(svgEl('line', {
            x1: staffLeft, y1: ly, x2: usedStaffRight, y2: ly, stroke: '#000000', 'stroke-width': 1.1,
        }));
    }
    staffLayer.append(svgEl('line', {
        x1: staffLeft + 0.5, y1: staffTopY, x2: staffLeft + 0.5, y2: staffBottomY, stroke: '#000000', 'stroke-width': 1.6,
    }));
    drawSvgClef(staffLayer, clefX, yForStep, sp, leadSheet.clef === 'treble-8vb');
    for (let i = 0; i < leadSheet.keySig.accidentals.length; i++) {
        const acc = leadSheet.keySig.accidentals[i];
        drawSvgAccidental(staffLayer, acc.kind, keySigStartX + i * sp * 0.92, yForStep(acc.step), sp);
    }
    if (isFirst && timeSigX !== null) {
        staffLayer.append(svgEl('text', {
            x: timeSigX, y: staffTopY + sp * 1.75, fill: '#000000',
            'font-size': Math.round(sp * 2.2), 'font-weight': '800', 'text-anchor': 'middle',
        }, String(leadSheet.meter?.[0] ?? 4)));
        staffLayer.append(svgEl('text', {
            x: timeSigX, y: staffTopY + sp * 3.75, fill: '#000000',
            'font-size': Math.round(sp * 2.2), 'font-weight': '800', 'text-anchor': 'middle',
        }, String(leadSheet.meter?.[1] ?? 4)));
    }
    svg.append(staffLayer);

    // Layer 2: Measures (barlines, chords, rests, notes, beams, ties, labels, lyrics).
    const notesLayer = svgEl('g');
    const playheadLine = svgEl('line', {
        class: 'ls-playhead',
        x1: 0, y1: staffTopY - sp * 1.2, x2: 0, y2: staffBottomY + sp * 1.2,
        stroke: '#b91c1c', 'stroke-width': 2.2, visibility: 'hidden',
    });

    const allPlacedNotes = [];
    const measureMeta = [];
    for (let mi = 0; mi < mCount; mi++) {
        const {m, mx0, mx1, innerL, innerW, placed, beamTipY} = measurePlans[mi];
        measureMeta.push({barNumber: m.barNumber, innerL, innerW});

        // Measure number (pure black; click to audition MIDI from this bar).
        if (showMeasureNumbers) {
            const barTag = m.multiRest > 0 ? `${m.barNumber}\u2013${m.barEnd}` : String(m.barNumber);
            const barNumEl = svgEl('text', {
                x: mx0 + 4, y: barNumY, fill: '#000000', 'font-size': 10, 'font-weight': '700',
            }, barTag);
            if (onAuditionBar) {
                barNumEl.style.cursor = 'pointer';
                barNumEl.append(svgEl('title', {}, `Click to play MIDI from bar ${m.barNumber}`));
                barNumEl.addEventListener('click', ev => {
                    ev.stopPropagation();
                    onAuditionBar(m);
                });
            }
            notesLayer.append(barNumEl);
        }

        // Right barline.
        if (m.barEnd >= leadSheet.totalBars) {
            notesLayer.append(svgEl('line', {x1: mx1 - 5.5, y1: staffTopY, x2: mx1 - 5.5, y2: staffBottomY, stroke: '#000000', 'stroke-width': 1.2}));
            notesLayer.append(svgEl('line', {x1: mx1 - 1, y1: staffTopY, x2: mx1 - 1, y2: staffBottomY, stroke: '#000000', 'stroke-width': 3}));
        } else {
            notesLayer.append(svgEl('line', {x1: mx1, y1: staffTopY, x2: mx1, y2: staffBottomY, stroke: '#000000', 'stroke-width': 1.3}));
        }

        // Clickable chord symbols above the staff (plus clickable "+Ch" slot on beat 0 when chords shown).
        if (showChords) {
            const hasBeat0Chord = m.chords.some(c => c.beatInBar === 0);
            if (editable && !hasBeat0Chord && m.multiRest === 0) {
                const slot = svgEl('g', {class: 'ls-chord-slot'});
                slot.append(svgEl('rect', {
                    x: mx0 + 6, y: chordY - 15, width: 34, height: 19, rx: 4,
                    fill: 'transparent', stroke: 'transparent',
                }));
                slot.append(svgEl('text', {
                    class: 'ls-chord-add-hint', x: mx0 + 23, y: chordY - 1,
                    fill: '#000000', 'font-size': 11, 'font-weight': '700', 'text-anchor': 'middle',
                }, '+Ch'));
                slot.addEventListener('click', ev => {
                    ev.stopPropagation();
                    onEditChord(m.barNumber, 0, '');
                });
                notesLayer.append(slot);
            }
            for (const ch of m.chords) {
                const cx = clamp(innerL + (ch.beatInBar / Math.max(1, m.barBeats)) * innerW, mx0 + 6, mx1 - 18);
                const cg = svgEl('g', {class: 'ls-chord-chip'});
                const approxW = Math.max(26, ch.symbol.length * 9 + 10);
                cg.append(svgEl('rect', {
                    class: 'ls-chord-box', x: cx - 4, y: chordY - 16, width: approxW, height: 21, rx: 4,
                    fill: 'transparent',
                }));
                cg.append(svgEl('text', {
                    x: cx, y: chordY, fill: '#000000', 'font-size': 15, 'font-weight': '800',
                }, ch.symbol));
                if (editable) {
                    cg.style.cursor = 'pointer';
                    cg.addEventListener('click', ev => {
                        ev.stopPropagation();
                        onEditChord(m.barNumber, ch.beatInBar, ch.symbol);
                    });
                }
                notesLayer.append(cg);
            }
        }

        if (m.multiRest > 0) {
            const midY = yForStep(34);
            const bl = mx0 + Math.min((mx1 - mx0) * 0.22, 22);
            const br = mx1 - Math.min((mx1 - mx0) * 0.22, 22);
            notesLayer.append(svgEl('rect', {x: bl, y: midY - sp * 0.42, width: Math.max(14, br - bl), height: sp * 0.84, fill: '#000000'}));
            notesLayer.append(svgEl('line', {x1: bl, y1: yForStep(36), x2: bl, y2: yForStep(32), stroke: '#000000', 'stroke-width': 1.8}));
            notesLayer.append(svgEl('line', {x1: br, y1: yForStep(36), x2: br, y2: yForStep(32), stroke: '#000000', 'stroke-width': 1.8}));
            notesLayer.append(svgEl('text', {
                x: (mx0 + mx1) / 2, y: yForStep(40.2), fill: '#000000',
                'font-size': 14, 'font-weight': '800', 'text-anchor': 'middle',
            }, String(m.multiRest)));
            continue;
        }

        let lastNoteLabelRightX = -Infinity;
        for (let pi = 0; pi < placed.length; pi++) {
            const p = placed[pi];
            const it = p.item;
            if (it.kind === 'rest') {
                drawSvgRest(notesLayer, it, p.x, yForStep, sp);
                continue;
            }
            if (it.kind !== 'note')
                continue;

            const ny = yForStep(it.writtenStep);
            const isSelected = selectedNoteId !== null && it.noteId === selectedNoteId;
            const ng = svgEl('g', {
                class: `ls-note${isSelected ? ' ls-note-selected' : ''}${it.edited ? ' ls-note-edited' : ''}`,
                'data-note-id': it.noteId,
                'data-item-id': it.id,
            });

            ng.append(svgEl('circle', {
                class: 'ls-note-active-halo',
                cx: p.x, cy: ny, r: sp * 1.08,
                fill: '#fde047', visibility: 'hidden',
            }));

            if (isSelected) {
                ng.append(svgEl('circle', {
                    cx: p.x, cy: ny, r: sp * 1.25,
                    fill: 'rgba(253, 224, 71, 0.72)', stroke: '#1d4ed8', 'stroke-width': 2.5,
                }));
            }

            for (const h of (it.harmonies ?? [])) {
                const hy = yForStep(h.writtenStep);
                const col = h.direction === 'above' ? '#1d4ed8' : '#15803d';
                const drx = sp * 0.36;
                const dry = sp * 0.24;
                ng.append(svgEl('polygon', {
                    points: `${p.x},${hy - dry} ${p.x + drx},${hy} ${p.x},${hy + dry} ${p.x - drx},${hy}`,
                    fill: '#ffffff', stroke: col, 'stroke-width': 1.4,
                }));
            }

            const halfW = rx + sp * 0.38;
            if (it.writtenStep <= STAFF_BOTTOM_STEP - 2) {
                for (let step = STAFF_BOTTOM_STEP - 2; step >= it.writtenStep; step -= 2) {
                    const ly = yForStep(step);
                    ng.append(svgEl('line', {x1: p.x - halfW, y1: ly, x2: p.x + halfW, y2: ly, stroke: '#000000', 'stroke-width': 1.2}));
                }
            }
            if (it.writtenStep >= STAFF_TOP_STEP + 2) {
                for (let step = STAFF_TOP_STEP + 2; step <= it.writtenStep; step += 2) {
                    const ly = yForStep(step);
                    ng.append(svgEl('line', {x1: p.x - halfW, y1: ly, x2: p.x + halfW, y2: ly, stroke: '#000000', 'stroke-width': 1.2}));
                }
            }

            if (showSnapMoves && !it.tieFromPrev && it.snapDelta) {
                const ghostX = p.x - sp * 1.08;
                let ghostY = yForStep(it.rawWrittenStep ?? it.writtenStep);
                if (Math.abs(ghostY - ny) < sp * 0.35)
                    ghostY = ny + (it.snapDelta > 0 ? sp * 0.65 : -sp * 0.65);
                const dirSign = ny < ghostY ? -1 : 1;
                const aStart = ghostY + dirSign * Math.max(2.6, sp * 0.34);
                const head = Math.max(3.2, sp * 0.38);
                ng.append(svgEl('circle', {
                    cx: ghostX, cy: ghostY, r: Math.max(2.3, sp * 0.3),
                    fill: '#ffffff', stroke: '#c2410c', 'stroke-width': 1.7,
                }));
                ng.append(svgEl('path', {
                    d: `M ${ghostX} ${aStart} L ${ghostX} ${ny} M ${ghostX - head * 0.65} ${ny - dirSign * head} L ${ghostX} ${ny} L ${ghostX + head * 0.65} ${ny - dirSign * head}`,
                    fill: 'none', stroke: '#c2410c', 'stroke-width': 1.7, 'stroke-linecap': 'round', 'stroke-linejoin': 'round',
                }));
            }

            const noteX = p.x + (it.headShiftX ? it.headShiftX * sp * 1.15 : 0);
            const noteInk = (leadSheet.hasMultipleVoices && it.voice === 2) ? '#1e3a8a' : '#000000';
            if (it.accidental)
                drawSvgAccidental(ng, it.accidental, noteX - sp * 1.15, ny, sp);

            const isWhole = it.figure === 'whole';
            const nrx = sp * (isWhole ? 0.72 : 0.62);
            const nry = sp * 0.45;
            ng.append(svgEl('ellipse', {
                cx: noteX, cy: ny, rx: nrx, ry: nry,
                transform: isWhole ? null : `rotate(-20 ${noteX} ${ny})`,
                fill: it.hollow ? '#ffffff' : noteInk,
                stroke: noteInk,
                'stroke-width': it.hollow ? 2.0 : 0,
            }));

            if (it.dots > 0) {
                const dotY = (it.writtenStep % 2 === 0) ? ny - sp * 0.42 : ny;
                ng.append(svgEl('circle', {cx: noteX + rx + sp * 0.36, cy: dotY, r: 1.6, fill: noteInk}));
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
                ng.append(svgEl('line', {x1: stemX, y1: ny, x2: stemX, y2: tipY, stroke: noteInk, 'stroke-width': 1.35}));
                if (it.beamGroup === null && it.flags > 0) {
                    for (let f = 0; f < it.flags; f++) {
                        const y0 = tipY + (dir > 0 ? f * sp * 0.62 : -f * sp * 0.62);
                        const dy = dir > 0 ? sp * 1.35 : -sp * 1.35;
                        ng.append(svgEl('path', {
                            d: `M ${stemX} ${y0} C ${stemX + sp * 0.85} ${y0 + dy * 0.35}, ${stemX + sp * 0.92} ${y0 + dy * 0.78}, ${stemX + sp * 0.35} ${y0 + dy}`,
                            fill: 'none', stroke: noteInk, 'stroke-width': 2.0, 'stroke-linecap': 'round',
                        }));
                    }
                }
            }

            if (showNoteLabels && !it.tieFromPrev && !(leadSheet.hasMultipleVoices && it.voice === 2)) {
                let lbl = '';
                let lblFill = noteInk;
                let lblWeight = isSelected ? '800' : '600';
                if (showSnapMoves && it.snapDelta) {
                    const fromName = String(it.rawNoteName ?? '').replace(/\d+$/u, '');
                    const toName = String(it.noteName ?? '').replace(/\d+$/u, '');
                    lbl = `${fromName}\u2192${toName}`;
                    lblFill = '#c2410c';
                    lblWeight = '800';
                } else if (noteNames === 'degrees') {
                    lbl = it.degree;
                } else if (noteNames === 'letters') {
                    lbl = it.noteName;
                }
                if (lbl) {
                    const approxW = lbl.length * 6;
                    if (noteX - approxW / 2 >= lastNoteLabelRightX + 2 || (showSnapMoves && it.snapDelta)) {
                        ng.append(svgEl('text', {
                            x: noteX, y: noteLabelY, fill: lblFill,
                            'font-size': 10, 'font-weight': lblWeight, 'text-anchor': 'middle',
                        }, lbl));
                        lastNoteLabelRightX = Math.max(lastNoteLabelRightX, noteX + approxW / 2);
                    }
                }
            }

            if (editable) {
                const hit = svgEl('circle', {cx: noteX, cy: ny, r: 13, fill: 'transparent', style: 'cursor:pointer'});
                ng.append(hit);
                ng.addEventListener('click', ev => {
                    ev.stopPropagation();
                    onSelectNote(it, m);
                });
            }

            notesLayer.append(ng);
            allPlacedNotes.push({x: noteX, ny, item: it});
        }

        // Beams.
        for (const bg of beamTipY.values()) {
            const thick = 3.3;
            const beamFill = (leadSheet.hasMultipleVoices && bg.group?.[0]?.item?.voice === 2) ? '#1e3a8a' : '#000000';
            const pts = `${bg.x0},${bg.y0} ${bg.x1},${bg.y1} ${bg.x1},${bg.y1 + bg.dir * thick} ${bg.x0},${bg.y0 + bg.dir * thick}`;
            notesLayer.append(svgEl('polygon', {points: pts, fill: beamFill}));
            for (let i = 0; i < bg.group.length; i++) {
                const g = bg.group[i];
                if (g.item.flags < 2)
                    continue;
                const gx = g.x + (bg.dir > 0 ? rx - 0.6 : -rx + 0.6);
                const nextHas2 = i + 1 < bg.group.length && bg.group[i + 1].item.flags >= 2;
                const prevHas2 = i > 0 && bg.group[i - 1].item.flags >= 2;
                let bx0 = gx;
                let bx1 = gx;
                if (nextHas2)
                    bx1 = bg.group[i + 1].x + (bg.dir > 0 ? rx - 0.6 : -rx + 0.6);
                else if (!prevHas2)
                    if (i + 1 < bg.group.length) bx1 = gx + sp * 0.9; else bx0 = gx - sp * 0.9;
                else
                    continue;
                const t0 = bg.x1 > bg.x0 ? (bx0 - bg.x0) / (bg.x1 - bg.x0) : 0;
                const t1 = bg.x1 > bg.x0 ? (bx1 - bg.x0) / (bg.x1 - bg.x0) : 0;
                const off = bg.dir * (thick + 2.2);
                const by0 = bg.y0 + t0 * (bg.y1 - bg.y0) + off;
                const by1 = bg.y0 + t1 * (bg.y1 - bg.y0) + off;
                notesLayer.append(svgEl('polygon', {
                    points: `${bx0},${by0} ${bx1},${by1} ${bx1},${by1 + bg.dir * 2.7} ${bx0},${by0 + bg.dir * 2.7}`,
                    fill: '#000000',
                }));
            }
        }
    }

    // Multi-tier / shrink-to-fit system lyrics (ZERO truncation, ZERO overlap!).
    if (showLyrics && lyricLayout.placements.length) {
        for (const lp of lyricLayout.placements) {
            const wy = lyricY + lp.tier * lyricLineH;
            if (lp.needsGuide) {
                notesLayer.append(svgEl('line', {
                    x1: lp.x, y1: Math.max(lyricY - 10, wy - lyricLineH + 2),
                    x2: lp.x, y2: wy - lp.fontPx + 1,
                    stroke: '#000000', 'stroke-width': 0.9,
                }));
            }
            notesLayer.append(svgEl('text', {
                x: lp.drawX, y: wy, fill: '#000000',
                'font-size': Math.round(lp.fontPx * 10) / 10,
                'font-weight': lp.bold ? '800' : '500',
                'text-anchor': 'middle',
            }, lp.text));
        }
    }

    // Ties across adjacent notes / barlines.
    for (let i = 0; i < allPlacedNotes.length; i++) {
        const cur = allPlacedNotes[i];
        if (!cur.item.tieToNext)
            continue;
        const bulge = cur.item.stemDir > 0 ? sp * 0.85 : -sp * 0.85;
        const yOff = bulge > 0 ? sp * 0.36 : -sp * 0.36;
        const x1 = cur.x + sp * 0.42;
        const y1 = cur.ny + yOff;
        let x2 = Math.min(usedStaffRight, cur.x + sp * 1.8);
        let y2 = y1;
        if (i + 1 < allPlacedNotes.length && allPlacedNotes[i + 1].item.noteId === cur.item.noteId) {
            x2 = allPlacedNotes[i + 1].x - sp * 0.42;
            y2 = allPlacedNotes[i + 1].ny + yOff;
        }
        const midY = (y1 + y2) / 2 + bulge;
        notesLayer.append(svgEl('path', {
            d: `M ${x1} ${y1} C ${x1 + (x2 - x1) * 0.28} ${midY}, ${x1 + (x2 - x1) * 0.72} ${midY}, ${x2} ${y2}`,
            fill: 'none', stroke: '#000000', 'stroke-width': 1.4, 'stroke-linecap': 'round',
        }));
    }

    svg.append(notesLayer);
    svg.append(playheadLine);
    svg._measureMeta = measureMeta;
    svg._playheadLine = playheadLine;
    return svg;
}

/**
 * Mounts the interactive White-Paper Piano Lead Sheet Viewer & Editor Modal,
 * including a collapsible in-sheet Display & Layout config drawer with live
 * view directly onto the white sheet below.
 */
export function createLeadSheetModal({model, call, command, set, showBanner, view}) {
    let open = false;
    let configOpen = false;
    let payload = null;
    let leadSheet = null;
    let isSample = false;
    let followPlayback = true;
    let selectedNoteId = null;
    let selectedBar = null;
    let undoStack = [];
    let redoStack = [];
    let saving = false;
    let chordPopup = null;
    let rafId = 0;
    let lastActiveSys = -1;
    let lastActiveItemId = null;
    let lastActiveBar = null;
    let lastFetchedVideo = null;
    let lastFetchedEditedAt = null;
    let lastFetchedStatus = null;

    const titleEl = el('h2', {class: 'modal-title'}, 'Piano Lead Sheet');
    const metaEl = el('span', {class: 'ls-meta'});
    const statusEl = el('span', {class: 'ls-status', hidden: 'hidden'});
    const sheetOptsBtn = el('button', {
        type: 'button', class: 'compact', 'aria-pressed': 'false',
        onClick: () => {
            configOpen = !configOpen;
            sheetOptsBtn.setAttribute('aria-pressed', String(configOpen));
            configDrawer.hidden = !configOpen;
        },
    }, '\u2699 Sheet options');
    const closeBtn = el('button', {type: 'button', class: 'compact', onClick: () => close()}, 'Close (Esc)');

    // Collapsible in-sheet live config drawer (updates both modal & floating desktop sheet live)
    const cfgUpdaters = [];
    const cfgChoice = (label, key, options) => {
        const btns = options.map(([val, text]) => {
            const b = el('button', {
                type: 'button', class: 'compact',
                onClick: () => set?.(key, val),
            }, text);
            return [val, b];
        });
        cfgUpdaters.push(vals => {
            for (const [val, b] of btns)
                b.setAttribute('aria-pressed', String(vals[key] === val));
        });
        return el('div', {class: 'ls-cfg-item'},
            el('span', {class: 'ls-tool-lbl'}, label),
            el('div', {class: 'seg compact'}, ...btns.map(([, b]) => b)),
        );
    };
    const cfgToggle = (label, key) => {
        const b = el('button', {
            type: 'button', class: 'compact',
            onClick: () => set?.(key, !model.values?.[key]),
        }, label);
        cfgUpdaters.push(vals => b.setAttribute('aria-pressed', String(Boolean(vals[key]))));
        return b;
    };
    const cfgSlider = (label, key, {min, max, step, ticks, format, integer = false}) => {
        const valEl = el('span', {class: 'ls-cfg-val'});
        const input = el('input', {
            type: 'range', min: String(min), max: String(max), step: String(step),
            class: 'ls-cfg-range', 'aria-label': label,
        });
        input.addEventListener('input', () => {
            const raw = Number(input.value);
            const v = integer ? Math.round(raw) : Math.round(raw * 100) / 100;
            valEl.textContent = format(v);
            set?.(key, v);
        });
        const tickRow = el('div', {class: 'ls-cfg-ticks'}, ...ticks.map(t => el('span', {}, format(t))));
        cfgUpdaters.push(vals => {
            const v = vals[key] ?? min;
            input.value = String(v);
            valEl.textContent = format(v);
        });
        return el('div', {class: 'ls-cfg-slider'},
            el('div', {class: 'ls-cfg-slider-head'}, el('span', {class: 'ls-tool-lbl'}, label), valEl),
            input,
            tickRow,
        );
    };

    const configDrawer = el('div', {class: 'ls-config-drawer', hidden: 'hidden'},
        el('div', {class: 'ls-cfg-row'},
            cfgSlider('Zoom', 'score-scale', {min: 0.6, max: 3.5, step: 0.05, ticks: [0.6, 1.0, 1.75, 2.5, 3.5], format: v => `${Math.round(v * 100)}%`}),
            cfgSlider('Bars / row', 'score-bars-per-system', {min: 0, max: 12, step: 1, ticks: [0, 2, 4, 6, 8, 12], format: v => (v <= 0 ? 'Auto' : String(Math.round(v))), integer: true}),
            cfgSlider('Paper opacity', 'score-background-opacity', {min: 0.75, max: 1.0, step: 0.01, ticks: [0.75, 0.88, 1.0], format: v => `${Math.round(v * 100)}%`}),
        ),
        el('div', {class: 'ls-cfg-row'},
            cfgChoice('Spacing', 'score-spacing', [['compact', 'Compact'], ['normal', 'Normal'], ['spacious', 'Spacious']]),
            cfgChoice('Page turns', 'score-paging', [['page', 'Flip page'], ['scroll', 'Scroll 1 row']]),
            cfgChoice('Note labels', 'score-note-names', [['off', 'Off'], ['letters', 'Letters'], ['degrees', 'Degrees']]),
            cfgChoice('Vocal voices', 'score-voices', [['both', 'Both'], ['top', 'Top'], ['bottom', 'Bottom']]),
            cfgChoice('Harmony 3rds', 'score-harmony', [['off', 'Off'], ['above', 'Above'], ['below', 'Below'], ['both', 'Both']]),
            cfgChoice('Scale snap', 'score-scale-snap', [['off', 'Off'], ['soft', 'Soft'], ['strict', 'Strict']]),
        ),
        el('div', {class: 'ls-cfg-row'},
            el('div', {class: 'ls-cfg-item'},
                el('span', {class: 'ls-tool-lbl'}, 'Show on sheet'),
                el('div', {class: 'ls-cfg-toggles'},
                    cfgToggle('Bar #', 'score-show-measure-numbers'),
                    cfgToggle('Chords', 'score-show-chords'),
                    cfgToggle('Lyrics', 'score-show-lyrics'),
                    cfgToggle('Red playhead', 'score-show-playhead'),
                    cfgToggle('Yellow active bar', 'score-show-active-measure'),
                    cfgToggle('Snap arrows', 'score-show-snap-moves'),
                    cfgToggle('Always on top', 'score-always-on-top'),
                ),
            ),
        ),
        el('div', {class: 'ls-cfg-row'},
            el('div', {class: 'ls-cfg-item'},
                el('span', {class: 'ls-tool-lbl'}, 'Header info'),
                el('div', {class: 'ls-cfg-toggles'},
                    cfgToggle('Header', 'score-show-header'),
                    cfgToggle('Title', 'score-header-title'),
                    cfgToggle('Key', 'score-header-key'),
                    cfgToggle('Time', 'score-header-time'),
                    cfgToggle('BPM', 'score-header-bpm'),
                    cfgToggle('8vb', 'score-header-clef'),
                    cfgToggle('Bars', 'score-header-bars'),
                    cfgToggle('Page', 'score-header-page'),
                ),
            ),
        ),
    );
    view(vals => {
        for (const fn of cfgUpdaters)
            fn(vals);
    });

    // Song-level recalculation toolbar controls
    const tempoBtns = [0.5, 1, 2].map(mul => el('button', {
        type: 'button', class: 'compact', 'data-mul': mul,
        onClick: () => mutateEdits(ed => {
            if (mul === 1) delete ed.tempoMul; else ed.tempoMul = mul;
        }),
    }, mul === 0.5 ? '\u00bd\u00d7' : `${mul}\u00d7`));

    const meterBtns = METER_CHOICES.map(([n, d]) => el('button', {
        type: 'button', class: 'compact',
        onClick: () => mutateEdits(ed => { ed.meter = [n, d]; }),
    }, `${n}/${d}`));

    const keyRootSelect = el('select', {class: 'ls-select', 'aria-label': 'Key root'});
    keyRootSelect.append(el('option', {value: 'auto'}, 'Key: Auto'));
    const pcNames = pitchClassNames({root: 0, type: 'major'});
    for (let r = 0; r < 12; r++)
        keyRootSelect.append(el('option', {value: String(r)}, pcNames[r]));

    const keyTypeSelect = el('select', {class: 'ls-select', 'aria-label': 'Scale type'});
    for (const [k, def] of Object.entries(SCALES))
        keyTypeSelect.append(el('option', {value: k}, def.name));

    const applyKeyChange = () => {
        if (keyRootSelect.value === 'auto') {
            mutateEdits(ed => { delete ed.keyOverride; });
        } else {
            mutateEdits(ed => {
                ed.keyOverride = {root: Number(keyRootSelect.value), type: keyTypeSelect.value || 'major'};
            });
        }
    };
    keyRootSelect.addEventListener('change', applyKeyChange);
    keyTypeSelect.addEventListener('change', () => {
        if (keyRootSelect.value !== 'auto')
            applyKeyChange();
    });

    const clefBtns = [['auto', 'Auto'], ['treble', 'Treble'], ['treble-8vb', '8vb']].map(([val, lbl]) => el('button', {
        type: 'button', class: 'compact',
        onClick: () => mutateEdits(ed => {
            if (val === 'auto') delete ed.clef; else ed.clef = val;
        }),
    }, lbl));

    const beatShiftVal = el('span', {class: 'ls-shift-val'}, '0');
    const shiftMinusBtn = el('button', {
        type: 'button', class: 'compact', title: 'Shift barlines left by 1 beat',
        onClick: () => mutateEdits(ed => {
            const next = clamp((ed.beatShift ?? 0) - 1, -8, 8);
            if (next === 0) delete ed.beatShift; else ed.beatShift = next;
        }),
    }, '\u22121 beat');
    const shiftPlusBtn = el('button', {
        type: 'button', class: 'compact', title: 'Shift barlines right by 1 beat',
        onClick: () => mutateEdits(ed => {
            const next = clamp((ed.beatShift ?? 0) + 1, -8, 8);
            if (next === 0) delete ed.beatShift; else ed.beatShift = next;
        }),
    }, '+1 beat');

    const followBtn = el('button', {
        type: 'button', class: 'compact', 'aria-pressed': 'true',
        onClick: () => {
            followPlayback = !followPlayback;
            followBtn.setAttribute('aria-pressed', String(followPlayback));
            if (followPlayback)
                scrollToCurrent(true);
        },
    }, 'Follow');
    const jumpNowBtn = el('button', {type: 'button', class: 'compact', onClick: () => scrollToCurrent(true)}, 'Jump to now');
    const undoBtn = el('button', {type: 'button', class: 'compact', disabled: 'disabled', onClick: () => undo()}, 'Undo');
    const redoBtn = el('button', {type: 'button', class: 'compact', disabled: 'disabled', onClick: () => redo()}, 'Redo');
    const resetEditsBtn = el('button', {type: 'button', class: 'compact', onClick: () => resetEdits()}, 'Reset edits');
    const refineHqBtn = el('button', {
        type: 'button', class: 'compact primary',
        title: 'Re-run vocal separation at high overlap (slower, cleaner separation)',
        onClick: async () => {
            await command({op: 'generateScore', force: true, quality: 'high'});
            refreshScore(true);
        },
    }, 'Refine (HQ)');
    const reextractBtn = el('button', {
        type: 'button', class: 'compact',
        onClick: async () => {
            await command({op: 'generateScore', force: true, quality: 'standard'});
            refreshScore(true);
        },
    }, 'Re-extract');

    // Built-in WebAudio MIDI audition player + .mid export
    let audioCtx = null;
    let midiPlaying = false;
    let midiPlan = null;
    let midiStartCtxTime = 0;
    let midiStartSongTime = 0;
    let midiSpeed = 1.0;
    let midiPlayMelody = true;
    let midiPlayChords = true;
    let midiPlayClick = false;
    let midiSchedId = 0;
    let midiMelIdx = 0;
    let midiChordIdx = 0;
    let midiBeatIdx = 0;
    let midiActiveNodes = [];

    function midiToHz(midi) {
        return 440 * Math.pow(2, (midi - 69) / 12);
    }

    function schedulePianoVoice(ctx, midi, when, duration, gainPeak, bright = true) {
        const osc1 = ctx.createOscillator();
        const osc2 = ctx.createOscillator();
        const gain = ctx.createGain();
        const freq = midiToHz(midi);
        osc1.type = bright ? 'triangle' : 'sine';
        osc2.type = 'sine';
        osc1.frequency.setValueAtTime(freq, when);
        osc2.frequency.setValueAtTime(freq * 2, when);
        const subGain = ctx.createGain();
        subGain.gain.setValueAtTime(bright ? 0.22 : 0.12, when);

        const dur = Math.max(0.06, duration);
        gain.gain.setValueAtTime(0.0001, when);
        gain.gain.linearRampToValueAtTime(gainPeak, when + 0.012);
        gain.gain.exponentialRampToValueAtTime(Math.max(0.0008, gainPeak * 0.45), when + Math.min(dur * 0.65, 0.35));
        gain.gain.exponentialRampToValueAtTime(0.0001, when + dur + 0.08);

        osc1.connect(gain);
        osc2.connect(subGain);
        subGain.connect(gain);
        gain.connect(ctx.destination);
        osc1.start(when);
        osc2.start(when);
        osc1.stop(when + dur + 0.1);
        osc2.stop(when + dur + 0.1);
        midiActiveNodes.push(osc1, osc2);
    }

    function scheduleClickVoice(ctx, when, downbeat) {
        const osc = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.type = 'sine';
        osc.frequency.setValueAtTime(downbeat ? 1180 : 820, when);
        gain.gain.setValueAtTime(0.0001, when);
        gain.gain.linearRampToValueAtTime(downbeat ? 0.16 : 0.09, when + 0.003);
        gain.gain.exponentialRampToValueAtTime(0.0001, when + 0.035);
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.start(when);
        osc.stop(when + 0.045);
        midiActiveNodes.push(osc);
    }

    function stopMidiPlayback() {
        if (midiSchedId) {
            clearInterval(midiSchedId);
            midiSchedId = 0;
        }
        for (const node of midiActiveNodes) {
            try { node.stop(); } catch { /* already stopped */ }
        }
        midiActiveNodes = [];
        midiPlaying = false;
        midiPlayBtn.textContent = '\u25b6 Play MIDI';
        midiPlayBtn.setAttribute('aria-pressed', 'false');
    }

    function midiCurrentSongTime() {
        if (!midiPlaying || !audioCtx)
            return null;
        return midiStartSongTime + Math.max(0, audioCtx.currentTime - midiStartCtxTime) * midiSpeed;
    }

    function startMidiPlayback(fromSongTime = null) {
        stopMidiPlayback();
        if (!leadSheet)
            return;
        midiPlan = buildMidiPlaybackPlan(leadSheet);
        if (!midiPlan)
            return;
        const AudioCtor = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtor) {
            updateStatus('WebAudio is unavailable in this browser');
            return;
        }
        if (!audioCtx)
            audioCtx = new AudioCtor();
        if (audioCtx.state === 'suspended')
            audioCtx.resume().catch(() => {});

        const startSec = Number.isFinite(fromSongTime)
            ? Math.max(0, fromSongTime)
            : (selectedBar !== null
                ? (leadSheet.measures.find(m => m.barNumber === selectedBar)?.startTime ?? 0)
                : 0);

        midiStartSongTime = startSec;
        midiStartCtxTime = audioCtx.currentTime + 0.05;
        midiMelIdx = midiPlan.melody.findIndex(n => n.end > startSec + 0.01);
        if (midiMelIdx < 0) midiMelIdx = midiPlan.melody.length;
        midiChordIdx = midiPlan.chords.findIndex(c => c.end > startSec + 0.01);
        if (midiChordIdx < 0) midiChordIdx = midiPlan.chords.length;
        midiBeatIdx = midiPlan.beats.findIndex(b => b.time >= startSec - 0.01);
        if (midiBeatIdx < 0) midiBeatIdx = midiPlan.beats.length;

        midiPlaying = true;
        midiPlayBtn.textContent = '\u23f9 Stop MIDI';
        midiPlayBtn.setAttribute('aria-pressed', 'true');

        const lookahead = 0.2;
        const pump = () => {
            if (!midiPlaying || !audioCtx || !midiPlan)
                return;
            const nowSong = midiCurrentSongTime();
            const horizon = nowSong + lookahead * midiSpeed;

            while (midiMelIdx < midiPlan.melody.length && midiPlan.melody[midiMelIdx].start <= horizon) {
                const n = midiPlan.melody[midiMelIdx++];
                if (!midiPlayMelody)
                    continue;
                const when = midiStartCtxTime + Math.max(0, (n.start - midiStartSongTime) / midiSpeed);
                const dur = Math.max(0.05, (n.end - n.start) / midiSpeed);
                schedulePianoVoice(audioCtx, n.midi, when, dur, 0.22, true);
            }
            while (midiChordIdx < midiPlan.chords.length && midiPlan.chords[midiChordIdx].start <= horizon) {
                const ch = midiPlan.chords[midiChordIdx++];
                if (!midiPlayChords)
                    continue;
                const when = midiStartCtxTime + Math.max(0, (ch.start - midiStartSongTime) / midiSpeed);
                const dur = Math.max(0.15, (ch.end - ch.start) / midiSpeed);
                const perNote = 0.14 / Math.max(2, ch.midis.length);
                for (const m of ch.midis)
                    schedulePianoVoice(audioCtx, m, when, dur, perNote, false);
            }
            while (midiBeatIdx < midiPlan.beats.length && midiPlan.beats[midiBeatIdx].time <= horizon) {
                const b = midiPlan.beats[midiBeatIdx++];
                if (!midiPlayClick)
                    continue;
                const when = midiStartCtxTime + Math.max(0, (b.time - midiStartSongTime) / midiSpeed);
                scheduleClickVoice(audioCtx, when, b.downbeat);
            }

            if (nowSong > midiPlan.duration + 0.35)
                stopMidiPlayback();
        };
        pump();
        midiSchedId = setInterval(pump, 40);
    }

    function downloadCurrentMidi() {
        if (!leadSheet)
            return;
        const bytes = encodeLeadSheetMidi(leadSheet, {
            title: titleEl.textContent || 'Piano Lead Sheet',
            includeChords: midiPlayChords,
            includeLyrics: true,
        });
        if (!bytes)
            return;
        const blob = new Blob([bytes], {type: 'audio/midi'});
        const url = URL.createObjectURL(blob);
        const slug = String(titleEl.textContent || 'lead-sheet')
            .replace(/[^a-z0-9._-]+/giu, '-')
            .replace(/^-+|-+$/gu, '')
            .slice(0, 64) || 'lead-sheet';
        const a = el('a', {href: url, download: `${slug}.mid`});
        document.body.append(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1500);
    }

    const midiPlayBtn = el('button', {
        type: 'button', class: 'compact primary', 'aria-pressed': 'false',
        title: 'Audition the engraved lead sheet with WebAudio MIDI (click any bar number to play from that bar)',
        onClick: () => (midiPlaying ? stopMidiPlayback() : startMidiPlayback()),
    }, '\u25b6 Play MIDI');
    const midiMelBtn = el('button', {
        type: 'button', class: 'compact', 'aria-pressed': 'true',
        onClick: () => {
            midiPlayMelody = !midiPlayMelody;
            midiMelBtn.setAttribute('aria-pressed', String(midiPlayMelody));
        },
    }, 'Melody');
    const midiChordsBtn = el('button', {
        type: 'button', class: 'compact', 'aria-pressed': 'true',
        onClick: () => {
            midiPlayChords = !midiPlayChords;
            midiChordsBtn.setAttribute('aria-pressed', String(midiPlayChords));
        },
    }, 'Chords');
    const midiClickBtn = el('button', {
        type: 'button', class: 'compact', 'aria-pressed': 'false',
        onClick: () => {
            midiPlayClick = !midiPlayClick;
            midiClickBtn.setAttribute('aria-pressed', String(midiPlayClick));
        },
    }, 'Click');
    const midiSpeedBtns = [0.5, 0.75, 1.0, 1.25].map(sp => {
        const b = el('button', {
            type: 'button', class: 'compact', 'aria-pressed': String(sp === 1.0),
            onClick: () => {
                const curT = midiPlaying ? midiCurrentSongTime() : null;
                midiSpeed = sp;
                for (const [val, btn] of midiSpeedBtns)
                    btn.setAttribute('aria-pressed', String(val === midiSpeed));
                if (midiPlaying && curT !== null)
                    startMidiPlayback(curT);
            },
        }, `${Math.round(sp * 100)}%`);
        return [sp, b];
    });
    const midiDownloadBtn = el('button', {
        type: 'button', class: 'compact',
        title: 'Download Standard Type-1 MIDI file (.mid) with melody, lyrics, and chords',
        onClick: () => downloadCurrentMidi(),
    }, '\u2b07 .mid');

    const songToolbar = el('div', {class: 'ls-toolbar'},
        el('div', {class: 'ls-tool-group'},
            el('span', {class: 'ls-tool-lbl'}, 'Audition'),
            midiPlayBtn, midiMelBtn, midiChordsBtn, midiClickBtn,
            el('div', {class: 'seg compact'}, ...midiSpeedBtns.map(([, b]) => b)),
            midiDownloadBtn,
        ),
        el('div', {class: 'ls-tool-group'}, el('span', {class: 'ls-tool-lbl'}, 'Tempo'), el('div', {class: 'seg compact'}, ...tempoBtns)),
        el('div', {class: 'ls-tool-group'}, el('span', {class: 'ls-tool-lbl'}, 'Meter'), el('div', {class: 'seg compact'}, ...meterBtns)),
        el('div', {class: 'ls-tool-group'}, keyRootSelect, keyTypeSelect),
        el('div', {class: 'ls-tool-group'}, el('span', {class: 'ls-tool-lbl'}, 'Clef'), el('div', {class: 'seg compact'}, ...clefBtns)),
        el('div', {class: 'ls-tool-group'}, el('span', {class: 'ls-tool-lbl'}, 'Barline'), shiftMinusBtn, beatShiftVal, shiftPlusBtn),
        el('div', {class: 'ls-tool-group ls-tool-right'}, followBtn, jumpNowBtn, undoBtn, redoBtn, resetEditsBtn, refineHqBtn, reextractBtn),
    );

    // Note Inspector bar (single-line strip right above the white paper)
    const noteReadout = el('span', {class: 'ls-note-readout'}, 'Click any note on the white sheet to edit pitch or duration, or click a chord symbol above any measure.');
    const pitchBtns = [
        [-12, '\u2212oct'], [-1, '\u22121 st'], [1, '+1 st'], [12, '+oct'],
    ].map(([d, lbl]) => el('button', {type: 'button', class: 'compact', onClick: () => nudgeSelectedPitch(d)}, lbl));
    const shorterBtn = el('button', {type: 'button', class: 'compact', title: 'Shorter ([)', onClick: () => stepSelectedDuration(-1)}, 'Shorter');
    const longerBtn = el('button', {type: 'button', class: 'compact', title: 'Longer (])', onClick: () => stepSelectedDuration(1)}, 'Longer');
    const splitBtn = el('button', {type: 'button', class: 'compact', title: 'Split note in half (X)', onClick: () => splitSelectedNote()}, 'Split');
    const mergeBtn = el('button', {type: 'button', class: 'compact', title: 'Merge with next note (M)', onClick: () => mergeSelectedWithNext()}, 'Merge next');
    const deleteBtn = el('button', {type: 'button', class: 'compact danger', title: 'Delete note (Del)', onClick: () => deleteSelectedNote()}, 'Delete');
    const addNoteBtn = el('button', {type: 'button', class: 'compact', title: 'Insert a quarter note in selected bar', onClick: () => addNoteInSelectedBar()}, '+ Add note');
    const noteActions = el('div', {class: 'ls-note-actions'},
        ...pitchBtns, shorterBtn, longerBtn, splitBtn, mergeBtn, deleteBtn, addNoteBtn,
    );
    const inspectorBar = el('div', {class: 'ls-inspector'}, noteReadout, noteActions);

    // White sheet-music paper container
    const paperHeader = el('div', {class: 'ls-paper-head'});
    const systemsWrap = el('div', {class: 'ls-systems-wrap'});
    const paper = el('div', {class: 'ls-paper'}, paperHeader, systemsWrap);
    const body = el('div', {class: 'ls-body'}, paper);

    const dialog = el('div', {
        class: 'ls-modal',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': 'Interactive Piano Lead Sheet',
    },
    el('div', {class: 'modal-head'},
        el('div', {class: 'modal-head-left'}, titleEl, metaEl, statusEl),
        el('div', {class: 'modal-head-right'}, sheetOptsBtn, closeBtn),
    ),
    configDrawer,
    songToolbar,
    inspectorBar,
    body);

    const backdrop = el('div', {class: 'modal-backdrop', hidden: 'hidden'}, dialog);
    backdrop.addEventListener('mousedown', event => {
        if (event.target === backdrop)
            close();
    });
    document.body.append(backdrop);

    // ----- Edits state & persistence

    function currentEdits() {
        return cloneEdits(payload?.score?.edits);
    }

    function effectiveRawScore() {
        if (!payload?.score)
            return null;
        return applyScoreEdits(payload.score);
    }

    function selectedRawNote() {
        if (!selectedNoteId || !payload?.score)
            return null;
        const eff = effectiveRawScore();
        return eff?.notes?.find(n => String(n.id) === String(selectedNoteId)) ?? null;
    }

    async function saveEdits(nextEdits, pushHistory = true) {
        if (!payload?.score || isSample)
            return;
        if (pushHistory) {
            undoStack.push(currentEdits());
            if (undoStack.length > 60)
                undoStack.shift();
            redoStack = [];
        }
        payload = {
            ...payload,
            score: {...payload.score, edits: cloneEdits(nextEdits)},
        };
        rebuildAndRender();
        saving = true;
        updateStatus('Saving\u2026');
        try {
            const res = await call('POST', '/api/score/edit', {
                videoId: payload.videoId,
                edits: nextEdits,
            });
            if (res?.ok && res.score) {
                payload = {...payload, score: res.score};
                lastFetchedEditedAt = res.score.editedAt ?? null;
                updateStatus('Saved');
            } else {
                showBanner(res?.error || 'Could not save lead sheet edit');
                updateStatus('');
            }
        } catch (error) {
            showBanner(`Could not save lead sheet edit: ${error.message}`);
            updateStatus('');
        } finally {
            saving = false;
            syncToolbarState();
        }
    }

    function mutateEdits(fn) {
        if (!payload?.score || isSample)
            return;
        const next = currentEdits();
        fn(next);
        saveEdits(next, true);
    }

    function undo() {
        if (!undoStack.length || !payload?.score)
            return;
        redoStack.push(currentEdits());
        const prev = undoStack.pop();
        saveEdits(prev, false);
    }

    function redo() {
        if (!redoStack.length || !payload?.score)
            return;
        undoStack.push(currentEdits());
        const next = redoStack.pop();
        saveEdits(next, false);
    }

    function resetEdits() {
        if (!payload?.score)
            return;
        saveEdits({}, true);
    }

    // ----- Individual note & chord operations

    function setNoteOverride(ed, note, patch) {
        if (note.added) {
            ed.addedNotes = (ed.addedNotes ?? []).map(a => (String(a.id) === String(note.id) ? {...a, ...patch} : a));
            return;
        }
        ed.noteOverrides = ed.noteOverrides ?? {};
        ed.noteOverrides[String(note.id)] = {...(ed.noteOverrides[String(note.id)] ?? {}), ...patch};
    }

    function nudgeSelectedPitch(semitones) {
        const note = selectedRawNote();
        if (!note)
            return;
        const nextPitch = clamp(Math.round(note.pitch) + semitones, 28, 100);
        mutateEdits(ed => setNoteOverride(ed, note, {pitch: nextPitch}));
    }

    function stepSelectedDuration(dir) {
        const note = selectedRawNote();
        if (!note || !leadSheet)
            return;
        const spb = 60 / Math.max(30, leadSheet.bpm || 120);
        const curBeats = Number.isFinite(note.durBeats) ? note.durBeats : Math.max(0.25, (note.end - note.start) / spb);
        let idx = 0;
        let bestErr = Infinity;
        for (let i = 0; i < DURATION_STEPS.length; i++) {
            const err = Math.abs(DURATION_STEPS[i] - curBeats);
            if (err < bestErr) {
                bestErr = err;
                idx = i;
            }
        }
        const nextBeats = DURATION_STEPS[clamp(idx + dir, 0, DURATION_STEPS.length - 1)];
        const nextEnd = Math.round((note.start + nextBeats * spb) * 1000) / 1000;
        mutateEdits(ed => setNoteOverride(ed, note, {durBeats: nextBeats, end: nextEnd}));
    }

    function deleteSelectedNote() {
        const note = selectedRawNote();
        if (!note)
            return;
        const id = String(note.id);
        selectedNoteId = null;
        mutateEdits(ed => {
            if (note.added) {
                ed.addedNotes = (ed.addedNotes ?? []).filter(a => String(a.id) !== id);
            } else {
                const del = new Set((ed.deletedNoteIds ?? []).map(String));
                del.add(id);
                ed.deletedNoteIds = [...del];
            }
        });
    }

    function splitSelectedNote() {
        const note = selectedRawNote();
        if (!note || !leadSheet)
            return;
        const spb = 60 / Math.max(30, leadSheet.bpm || 120);
        const curBeats = Number.isFinite(note.durBeats) ? note.durBeats : Math.max(0.5, (note.end - note.start) / spb);
        if (curBeats < 0.5)
            return;
        const halfBeats = Math.max(0.25, Math.round((curBeats / 2) / 0.25) * 0.25);
        const midTime = Math.round(((note.start + note.end) * 0.5) * 1000) / 1000;
        const newId = `u${Date.now()}`;
        mutateEdits(ed => {
            setNoteOverride(ed, note, {end: midTime, durBeats: halfBeats});
            ed.addedNotes = [...(ed.addedNotes ?? []), {
                id: newId,
                start: midTime,
                end: note.end,
                pitch: Math.round(note.pitch),
                durBeats: Math.max(0.25, curBeats - halfBeats),
            }];
        });
    }

    function mergeSelectedWithNext() {
        const eff = effectiveRawScore();
        if (!eff || !selectedNoteId)
            return;
        const idx = eff.notes.findIndex(n => String(n.id) === String(selectedNoteId));
        if (idx < 0 || idx + 1 >= eff.notes.length)
            return;
        const cur = eff.notes[idx];
        const nxt = eff.notes[idx + 1];
        const spb = 60 / Math.max(30, leadSheet?.bpm || 120);
        const combinedBeats = Math.max(0.25, Math.min(8, Math.round(((nxt.end - cur.start) / spb) / 0.25) * 0.25));
        mutateEdits(ed => {
            setNoteOverride(ed, cur, {end: nxt.end, durBeats: combinedBeats});
            if (nxt.added) {
                ed.addedNotes = (ed.addedNotes ?? []).filter(a => String(a.id) !== String(nxt.id));
            } else {
                const del = new Set((ed.deletedNoteIds ?? []).map(String));
                del.add(String(nxt.id));
                ed.deletedNoteIds = [...del];
            }
        });
    }

    function addNoteInSelectedBar() {
        if (!leadSheet || !payload?.score)
            return;
        const targetBar = selectedBar ?? leadSheet.measures[0]?.barNumber ?? 1;
        const m = leadSheet.measures.find(x => x.barNumber === targetBar) ?? leadSheet.measures[0];
        if (!m)
            return;
        const spb = 60 / Math.max(30, leadSheet.bpm || 120);
        const sel = selectedRawNote();
        const start = sel && sel.start >= m.startTime && sel.start < m.endTime
            ? Math.min(m.endTime - spb * 0.5, sel.end + 0.02)
            : m.startTime + 0.02;
        const end = Math.min(m.endTime, start + spb);
        const pitch = sel ? Math.round(sel.pitch) : (leadSheet.key ? 60 + leadSheet.key.root : 64);
        const newId = `u${Date.now()}`;
        selectedNoteId = newId;
        mutateEdits(ed => {
            ed.addedNotes = [...(ed.addedNotes ?? []), {
                id: newId,
                start: Math.round(start * 1000) / 1000,
                end: Math.round(Math.max(start + 0.15, end) * 1000) / 1000,
                pitch,
                durBeats: 1,
            }];
        });
    }

    function openChordEditor(barNumber, beatInBar, currentSymbol) {
        closeChordPopup();
        const key = `${barNumber}:${beatInBar}`;
        const input = el('input', {
            type: 'text', class: 'ls-chord-input', value: currentSymbol || '',
            placeholder: 'e.g. G#m, F#7, B', 'aria-label': `Chord at bar ${barNumber}`,
        });
        const apply = sym => {
            const clean = String(sym ?? '').trim();
            closeChordPopup();
            mutateEdits(ed => {
                ed.chordOverrides = {...(ed.chordOverrides ?? {}), [key]: clean};
            });
        };
        const quickPicks = diatonicChordsForKey(leadSheet?.key).map(sym => el('button', {
            type: 'button', class: 'compact ls-chord-pick',
            'aria-pressed': String(sym === currentSymbol),
            onClick: () => apply(sym),
        }, sym));
        const form = el('form', {class: 'ls-chord-popover'},
            el('div', {class: 'ls-chord-pop-head'},
                el('strong', {}, `Chord at bar ${barNumber}, beat ${beatInBar + 1}`),
                el('button', {type: 'button', class: 'compact', onClick: closeChordPopup}, 'Cancel'),
            ),
            el('div', {class: 'ls-chord-pop-row'},
                input,
                el('button', {type: 'submit', class: 'compact primary'}, 'Set'),
                el('button', {type: 'button', class: 'compact danger', onClick: () => apply('')}, 'Clear'),
            ),
            el('div', {class: 'ls-chord-picks'}, ...quickPicks),
        );
        form.addEventListener('submit', ev => {
            ev.preventDefault();
            apply(input.value);
        });
        dialog.append(form);
        chordPopup = form;
        input.focus();
        input.select();
    }

    function closeChordPopup() {
        if (chordPopup) {
            chordPopup.remove();
            chordPopup = null;
        }
    }

    // ----- Rendering & Live Playhead

    function updateStatus(text) {
        statusEl.textContent = text;
        statusEl.hidden = !text;
    }

    function syncToolbarState() {
        const score = payload?.score ?? null;
        const editable = Boolean(score) && !isSample;
        const edits = score?.edits ?? {};
        const mul = edits.tempoMul ?? 1;
        for (const b of tempoBtns) {
            b.disabled = !editable;
            b.setAttribute('aria-pressed', String(Number(b.dataset.mul) === mul));
        }
        const curMeter = edits.meter ?? score?.meter ?? [4, 4];
        for (let i = 0; i < meterBtns.length; i++) {
            const [n, d] = METER_CHOICES[i];
            meterBtns[i].disabled = !editable;
            meterBtns[i].setAttribute('aria-pressed', String(curMeter[0] === n && curMeter[1] === d));
        }
        keyRootSelect.disabled = !editable;
        keyTypeSelect.disabled = !editable || !edits.keyOverride;
        if (edits.keyOverride) {
            keyRootSelect.value = String(edits.keyOverride.root);
            keyTypeSelect.value = edits.keyOverride.type;
        } else {
            keyRootSelect.value = 'auto';
            keyTypeSelect.value = score?.key?.type ?? 'major';
        }
        const curClef = edits.clef ?? 'auto';
        const clefVals = ['auto', 'treble', 'treble-8vb'];
        for (let i = 0; i < clefBtns.length; i++) {
            clefBtns[i].disabled = !editable;
            clefBtns[i].setAttribute('aria-pressed', String(curClef === clefVals[i]));
        }
        const shift = edits.beatShift ?? 0;
        beatShiftVal.textContent = shift > 0 ? `+${shift}` : String(shift);
        shiftMinusBtn.disabled = !editable || shift <= -8;
        shiftPlusBtn.disabled = !editable || shift >= 8;

        undoBtn.disabled = !editable || undoStack.length === 0;
        redoBtn.disabled = !editable || redoStack.length === 0;
        resetEditsBtn.disabled = !editable || Object.keys(edits).length === 0;
        const running = payload?.status === 'running' || model.state?.score?.status === 'running';
        refineHqBtn.disabled = !model.state?.active || running;
        reextractBtn.disabled = !model.state?.active || running;
        refineHqBtn.textContent = running ? 'Extracting\u2026' : (score?.quality === 'high' ? 'Refine (HQ \u2713)' : 'Refine (HQ)');

        // Sync note inspector bar
        const note = selectedRawNote();
        const hasNote = editable && Boolean(note);
        for (const b of pitchBtns)
            b.disabled = !hasNote;
        shorterBtn.disabled = !hasNote;
        longerBtn.disabled = !hasNote;
        splitBtn.disabled = !hasNote;
        mergeBtn.disabled = !hasNote;
        deleteBtn.disabled = !hasNote;
        addNoteBtn.disabled = !editable || !leadSheet;

        if (hasNote && leadSheet) {
            const item = leadSheet.measures.flatMap(m => m.items).find(it => it.kind === 'note' && it.noteId === String(note.id));
            const label = item ? `${item.noteName} (deg ${item.degree || '\u2014'})` : `MIDI ${Math.round(note.pitch)}`;
            const bar = item ? `Bar ${item.barNumber}` : (selectedBar ? `Bar ${selectedBar}` : '');
            const spb = 60 / Math.max(30, leadSheet.bpm || 120);
            const dur = Number.isFinite(note.durBeats) ? note.durBeats : Math.round(((note.end - note.start) / spb) * 4) / 4;
            noteReadout.textContent = `${bar} \u00b7 ${label} \u00b7 ${dur} beat${dur === 1 ? '' : 's'} \u00b7 Keys: \u2191/\u2193 pitch, [/] length, X split, M merge, Del delete`;
        } else if (selectedBar && editable) {
            noteReadout.textContent = `Bar ${selectedBar} selected \u2014 click any note to edit it, click a chord above a bar, or click "+ Add note".`;
        } else if (editable) {
            noteReadout.textContent = 'Click any note on the white sheet to edit pitch/rhythm, or click any chord symbol above a bar.';
        } else {
            noteReadout.textContent = 'Preview sheet \u2014 play a song and click Extract melody to inspect & edit its lead sheet.';
        }
    }

    function rebuildAndRender() {
        const vals = model.values ?? {};
        const svgW = Math.max(540, Math.min(1380, Math.round(paper.clientWidth - 36) || 1080));
        const settingBars = vals['score-bars-per-system'] ?? 0;
        const barsPerSystem = settingBars > 0
            ? clamp(Math.round(settingBars), 1, 12)
            : clamp(Math.floor((svgW - 80) / 165), 1, 12);
        const scaleSnap = vals['score-scale-snap'] ?? 'soft';
        const harmony = vals['score-harmony'] ?? 'off';
        const voiceMode = vals['score-voices'] ?? 'both';
        const noteNames = vals['score-note-names'] ?? 'letters';
        const showHeader = vals['score-show-header'] !== false;
        const showMeasureNumbers = vals['score-show-measure-numbers'] !== false;
        const showChords = vals['score-show-chords'] !== false;
        const showLyrics = vals['score-show-lyrics'] !== false;
        const showSnapMoves = Boolean(vals['score-show-snap-moves']);
        const fallbackKey = !payload?.score?.key && !payload?.score?.edits?.keyOverride
            ? (model.state?.key ?? null)
            : null;

        if (payload?.score?.notes?.length) {
            isSample = false;
            leadSheet = buildLeadSheet(payload.score, {
                lyricLines: payload.lyricsLines ?? [],
                ...(fallbackKey ? {keyOverride: fallbackKey} : {}),
                scaleSnap,
                harmony,
                voiceMode,
                barsPerSystem,
                showChords,
            });
            titleEl.textContent = payload.title || payload.videoId || 'Piano Lead Sheet';
        } else {
            isSample = true;
            leadSheet = sampleLeadSheetForPreview({scaleSnap, harmony, barsPerSystem});
            titleEl.textContent = payload?.active
                ? (payload.title || 'Piano Lead Sheet')
                : 'Piano Lead Sheet (Sample Preview)';
        }

        const editable = !isSample && Boolean(payload?.score);
        if (leadSheet) {
            const parts = [];
            if (vals['score-header-key'] !== false && leadSheet.keyLabel) parts.push(leadSheet.keyLabel);
            if (Boolean(vals['score-header-time'])) parts.push(`${leadSheet.meter[0]}/${leadSheet.meter[1]}`);
            if (vals['score-header-bpm'] !== false) parts.push(`${leadSheet.bpm} BPM`);
            if (Boolean(vals['score-header-clef']) && leadSheet.clef === 'treble-8vb') parts.push('8vb');
            if (vals['score-header-bars'] !== false) parts.push(`${leadSheet.totalBars} bars`);
            parts.push(`${leadSheet.noteCount} notes`);
            if (leadSheet.chordCount) parts.push(`${leadSheet.chordCount} chords`);
            if (payload?.score?.quality === 'high') parts.push('HQ');
            if (leadSheet.edited) parts.push('Edited');
            metaEl.textContent = parts.join(' \u00b7 ');

            paperHeader.hidden = !showHeader;
            paperHeader.replaceChildren(
                vals['score-header-title'] !== false ? el('div', {class: 'ls-paper-title'}, titleEl.textContent) : el('div'),
                el('div', {class: 'ls-paper-meta'}, parts.join(' \u00b7 ')),
            );
        }

        systemsWrap.replaceChildren();
        if (payload?.status === 'running') {
            systemsWrap.append(el('div', {class: 'ls-paper-banner'},
                payload.message || 'Extracting piano lead sheet\u2026',
            ));
        } else if (isSample && payload?.active && payload?.status !== 'ready') {
            const extractNow = el('button', {
                type: 'button', class: 'compact primary',
                onClick: async () => {
                    await command({op: 'generateScore', force: true, quality: 'standard'});
                    refreshScore(true);
                },
            }, 'Extract melody for current song');
            systemsWrap.append(el('div', {class: 'ls-paper-banner'},
                el('span', {}, payload.message || 'No lead sheet extracted for the current song yet (showing sample below).'),
                extractNow,
            ));
        }

        for (const sys of (leadSheet?.systems ?? [])) {
            systemsWrap.append(renderSystemSvg(leadSheet, sys, {
                width: svgW,
                selectedNoteId,
                selectedBar,
                noteNames,
                showMeasureNumbers,
                showChords,
                showLyrics,
                showSnapMoves,
                barsPerSystem,
                editable,
                onSelectNote: (item, measure) => {
                    selectedNoteId = item.noteId;
                    selectedBar = measure.barNumber;
                    rebuildAndRender();
                },
                onSelectBar: measure => {
                    selectedBar = measure.barNumber;
                    selectedNoteId = null;
                    rebuildAndRender();
                },
                onEditChord: (barNumber, beatInBar, sym) => openChordEditor(barNumber, beatInBar, sym),
                onAuditionBar: measure => startMidiPlayback(measure.startTime),
            }));
        }

        lastActiveSys = -1;
        lastActiveItemId = null;
        lastActiveBar = null;
        syncToolbarState();
        paintLivePlayhead(false);
    }

    function currentMediaTime() {
        if (midiPlaying)
            return midiCurrentSongTime();
        const clock = payload?.clock;
        if (!clock || !Number.isFinite(clock.mediaTime))
            return null;
        const elapsed = clock.playing ? Math.max(0, (Date.now() - clock.sentAtMs) / 1000) : 0;
        return clock.mediaTime + elapsed * (clock.rate || 1);
    }

    function paintLivePlayhead(allowScroll = true) {
        if (!open || !leadSheet || (isSample && !midiPlaying))
            return;
        const t = currentMediaTime();
        if (t === null)
            return;
        const pos = findActiveLeadSheetPosition(leadSheet, t);
        const svgs = systemsWrap.querySelectorAll('.ls-system-svg');
        const showActiveMeasure = midiPlaying || Boolean(model.values?.['score-show-active-measure']);
        const showPlayhead = midiPlaying || Boolean(model.values?.['score-show-playhead']);

        if (!showActiveMeasure) {
            if (lastActiveBar !== null) {
                for (const r of systemsWrap.querySelectorAll('.ls-measure-bg.ls-bar-active'))
                    r.classList.remove('ls-bar-active');
                lastActiveBar = null;
            }
            if (lastActiveItemId !== null) {
                for (const h of systemsWrap.querySelectorAll('.ls-note-active-halo[visibility="visible"]'))
                    h.setAttribute('visibility', 'hidden');
                lastActiveItemId = null;
            }
        } else {
            if (pos.barNumber !== lastActiveBar) {
                for (const r of systemsWrap.querySelectorAll('.ls-measure-bg.ls-bar-active'))
                    r.classList.remove('ls-bar-active');
                if (pos.barNumber !== null) {
                    const target = systemsWrap.querySelector(`.ls-measure-bg[data-bar="${pos.barNumber}"]`);
                    target?.classList.add('ls-bar-active');
                }
                lastActiveBar = pos.barNumber;
            }

            if (pos.activeItemId !== lastActiveItemId) {
                for (const h of systemsWrap.querySelectorAll('.ls-note-active-halo[visibility="visible"]'))
                    h.setAttribute('visibility', 'hidden');
                if (pos.activeItemId) {
                    const noteG = systemsWrap.querySelector(`.ls-note[data-item-id="${CSS.escape(pos.activeItemId)}"] .ls-note-active-halo`);
                    noteG?.setAttribute('visibility', 'visible');
                }
                lastActiveItemId = pos.activeItemId;
            }
        }

        // Optional crimson playhead hairline on active system.
        for (const svg of svgs) {
            const idx = Number(svg.getAttribute('data-sys-index'));
            const line = svg._playheadLine;
            if (!line)
                continue;
            if (showPlayhead && idx === pos.systemIndex && pos.measureIndex >= 0 && svg._measureMeta?.[pos.measureIndex]) {
                const mm = svg._measureMeta[pos.measureIndex];
                const px = mm.innerL + clamp(pos.measureProgress, 0, 1) * mm.innerW;
                line.setAttribute('x1', px.toFixed(1));
                line.setAttribute('x2', px.toFixed(1));
                line.setAttribute('visibility', 'visible');
            } else {
                line.setAttribute('visibility', 'hidden');
            }
        }

        if (allowScroll && followPlayback && pos.systemIndex !== lastActiveSys) {
            lastActiveSys = pos.systemIndex;
            const targetSvg = svgs[pos.systemIndex];
            targetSvg?.scrollIntoView({behavior: 'smooth', block: 'start'});
        }
    }

    function scrollToCurrent(force = false) {
        if (!leadSheet || isSample)
            return;
        const t = currentMediaTime();
        if (t === null)
            return;
        const pos = findActiveLeadSheetPosition(leadSheet, t);
        const svgs = systemsWrap.querySelectorAll('.ls-system-svg');
        if (force || followPlayback)
            svgs[pos.systemIndex]?.scrollIntoView({behavior: 'smooth', block: 'start'});
    }

    function tickRaf() {
        if (!open) {
            rafId = 0;
            return;
        }
        paintLivePlayhead(true);
        rafId = requestAnimationFrame(tickRaf);
    }

    async function refreshScore(force = false) {
        if (!open || saving)
            return;
        try {
            const next = await call('GET', '/api/score');
            const changed = force
                || next.videoId !== lastFetchedVideo
                || next.status !== lastFetchedStatus
                || (next.score?.editedAt ?? null) !== lastFetchedEditedAt
                || Boolean(next.score) !== Boolean(payload?.score)
                || (next.score?.notes?.length ?? 0) !== (payload?.score?.notes?.length ?? 0)
                || (next.lyricsLines?.length ?? 0) !== (payload?.lyricsLines?.length ?? 0);
            if (next.videoId !== lastFetchedVideo) {
                selectedNoteId = null;
                selectedBar = null;
                undoStack = [];
                redoStack = [];
            }
            payload = next;
            lastFetchedVideo = next.videoId;
            lastFetchedStatus = next.status;
            lastFetchedEditedAt = next.score?.editedAt ?? null;
            if (changed)
                rebuildAndRender();
            else
                syncToolbarState();
        } catch {
            // Transient poll error; handled by main settings poller.
        }
    }

    function syncUrl() {
        const url = new URL(window.location.href);
        if (open)
            url.searchParams.set('score', '1');
        else
            url.searchParams.delete('score');
        window.history.replaceState(null, '', url.toString());
    }

    function openModal() {
        open = true;
        backdrop.hidden = false;
        syncUrl();
        refreshScore(true);
        if (!rafId)
            rafId = requestAnimationFrame(tickRaf);
    }

    function close() {
        if (!open)
            return;
        stopMidiPlayback();
        closeChordPopup();
        open = false;
        backdrop.hidden = true;
        if (rafId) {
            cancelAnimationFrame(rafId);
            rafId = 0;
        }
        syncUrl();
    }

    window.addEventListener('keydown', event => {
        const tag = event.target?.tagName;
        const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target?.isContentEditable;

        if (event.key === 'Escape' && open) {
            event.preventDefault();
            if (chordPopup)
                closeChordPopup();
            else
                close();
            return;
        }

        if (!open) {
            if (!typing && !event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 's') {
                event.preventDefault();
                openModal();
            }
            return;
        }

        if (typing)
            return;

        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
            event.preventDefault();
            if (event.shiftKey) redo(); else undo();
            return;
        }
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'y') {
            event.preventDefault();
            redo();
            return;
        }

        if (!selectedNoteId)
            return;
        if (event.key === 'ArrowUp') {
            event.preventDefault();
            nudgeSelectedPitch(event.shiftKey ? 12 : 1);
        } else if (event.key === 'ArrowDown') {
            event.preventDefault();
            nudgeSelectedPitch(event.shiftKey ? -12 : -1);
        } else if (event.key === '[') {
            event.preventDefault();
            stepSelectedDuration(-1);
        } else if (event.key === ']') {
            event.preventDefault();
            stepSelectedDuration(1);
        } else if (event.key.toLowerCase() === 'x') {
            event.preventDefault();
            splitSelectedNote();
        } else if (event.key.toLowerCase() === 'm') {
            event.preventDefault();
            mergeSelectedWithNext();
        } else if (event.key === 'Delete' || event.key === 'Backspace') {
            event.preventDefault();
            deleteSelectedNote();
        }
    });

    model.stateViews.push(() => {
        if (open)
            refreshScore(false);
    });
    view(() => {
        if (open)
            rebuildAndRender();
    });

    const controller = {open: openModal, close, isOpen: () => open};
    model.scoreModal = controller;

    if (new URLSearchParams(window.location.search).get('score') === '1')
        openModal();

    return controller;
}
