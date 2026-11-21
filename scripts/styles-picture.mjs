// Renders docs/styles.png (via build/e2e-artifacts/readme-styles.png) using
// the real Cairo/Pango renderer (shared/text-layout.js) and real offline
// SudachiPy furigana worker (service/furigana.py) on public-domain lines.
// Run by scripts/update-readme-pictures.sh:
//
//   node scripts/styles-picture.mjs

import {execFileSync} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUTPUT = path.join(root, 'build', 'e2e-artifacts', 'readme-styles.png');
const sharedDir = path.join(root, 'shared');

function findPython() {
    const venv = path.join(root, '.venv', 'bin', 'python');
    return fs.existsSync(venv) ? venv : 'python3';
}

function annotate(lines) {
    const req = `${JSON.stringify({id: 1, texts: lines})}\n`;
    const out = execFileSync(findPython(), ['-u', path.join(root, 'service', 'furigana.py')], {
        input: req,
        encoding: 'utf8',
    });
    const parsed = out.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
    const answer = parsed.find(m => m.id === 1);
    if (!answer?.results)
        throw new Error(`furigana.py did not return results: ${out}`);
    return answer.results;
}

const JP_LINE_1 = '桜 弥生の空は 見渡す限り';
const JP_LINE_2 = '霞か雲か 朝日に匂う';
const [ruby1, ruby2] = annotate([JP_LINE_1, JP_LINE_2]);

const rows = [
    {
        badge: 'Triple border · White',
        text: 'Amazing grace, how sweet the sound',
        color: 'white',
        border: 'triple',
        fontSize: 58,
    },
    {
        badge: 'Quad border + Furigana · Pink',
        text: JP_LINE_1,
        ruby: ruby1,
        color: 'pink',
        border: 'quad',
        fontSize: 58,
    },
    {
        badge: 'Custom ring colors + Furigana',
        text: JP_LINE_2,
        ruby: ruby2,
        color: 'yellow',
        border: 'triple',
        ringColors: ['#1e1b4b', '#ffffff', '#000000'],
        ringWidths: [0.13, 0.08, 0.06],
        fontSize: 56,
    },
    {
        badge: 'Glow + Soft cloud · Cyan',
        text: 'I once was lost, but now am found',
        color: 'cyan',
        border: 'glow',
        borderCloud: true,
        fontSize: 56,
    },
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lyrics-styles-picture-'));
try {
    const script = path.join(tmp, 'render.mjs');
    fs.mkdirSync(path.dirname(OUTPUT), {recursive: true});
    fs.writeFileSync(script, `
import Cairo from 'cairo';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import {fitLyric, paintLyric} from 'file://${sharedDir}/text-layout.js';

const W = 1280;
const rows = ${JSON.stringify(rows)};
const ctxMeasure = PangoCairo.FontMap.get_default().create_context();

function roundedRect(cr, x, y, w, h, r) {
    const rad = Math.max(0, Math.min(r, w / 2, h / 2));
    cr.newSubPath();
    cr.arc(x + w - rad, y + rad, rad, -Math.PI / 2, 0);
    cr.arc(x + w - rad, y + h - rad, rad, 0, Math.PI / 2);
    cr.arc(x + rad, y + h - rad, rad, Math.PI / 2, Math.PI);
    cr.arc(x + rad, y + rad, rad, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

const fittedRows = rows.map(row => {
    const fitted = fitLyric(ctxMeasure, row.text, {
        fontSize: row.fontSize,
        family: 'Sans',
        bold: true,
        italic: false,
        color: row.color,
        border: row.border,
        borderCloud: Boolean(row.borderCloud),
        ringColors: row.ringColors,
        ringWidths: row.ringWidths,
        backdrop: 'none',
        align: 'center',
        anchor: 'center',
        ruby: row.ruby ?? null,
        width: W,
        height: 112,
    });
    const h = Math.max(118, fitted.requiredHeight) + 34;
    return {row, fitted, h};
});

const H = fittedRows.reduce((sum, r) => sum + r.h, 0);
const surf = new Cairo.ImageSurface(Cairo.Format.ARGB32, W, H);
const cr = new Cairo.Context(surf);

// Split dark/light stage background so contrast over both extremes is immediate.
const darkGrad = new Cairo.LinearGradient(0, 0, W / 2, H);
darkGrad.addColorStopRGB(0, 0.055, 0.075, 0.125);
darkGrad.addColorStopRGB(1, 0.12, 0.08, 0.15);
cr.setSource(darkGrad);
cr.rectangle(0, 0, W / 2, H);
cr.fill();

const lightGrad = new Cairo.LinearGradient(W / 2, 0, W, H);
lightGrad.addColorStopRGB(0, 0.93, 0.96, 1.0);
lightGrad.addColorStopRGB(1, 0.99, 0.96, 0.89);
cr.setSource(lightGrad);
cr.rectangle(W / 2, 0, W / 2, H);
cr.fill();

// Subtle vertical split seam
cr.setSourceRGBA(0.5, 0.55, 0.65, 0.35);
cr.rectangle(Math.floor(W / 2), 0, 1, H);
cr.fill();

// Top-right corner legend showing the contrast split
const legend = PangoCairo.create_layout(cr);
const legendDesc = new Pango.FontDescription();
legendDesc.set_family('Sans');
legendDesc.set_weight(Pango.Weight.BOLD);
legendDesc.set_absolute_size(12 * Pango.SCALE);
legend.set_font_description(legendDesc);
legend.set_text('Light background', -1);
const [, legLog] = legend.get_pixel_extents();
roundedRect(cr, W - legLog.width - 30, 10, legLog.width + 18, legLog.height + 8, 6);
cr.setSourceRGBA(1, 1, 1, 0.92);
cr.fillPreserve();
cr.setSourceRGBA(0, 0, 0, 0.2);
cr.setLineWidth(1);
cr.stroke();
cr.setSourceRGB(0, 0, 0);
cr.moveTo(W - legLog.width - 21, 14);
PangoCairo.show_layout(cr, legend);

let yOff = 0;
const badgeDesc = new Pango.FontDescription();
badgeDesc.set_family('Sans');
badgeDesc.set_weight(Pango.Weight.BOLD);
badgeDesc.set_absolute_size(13 * Pango.SCALE);

for (let i = 0; i < fittedRows.length; i++) {
    const {row, fitted, h} = fittedRows[i];
    if (i > 0) {
        cr.setSourceRGBA(0.5, 0.55, 0.65, 0.24);
        cr.rectangle(0, yOff, W, 1);
        cr.fill();
    }

    const lbl = PangoCairo.create_layout(cr);
    lbl.set_font_description(badgeDesc);
    lbl.set_text(row.badge, -1);
    const [, log] = lbl.get_pixel_extents();
    roundedRect(cr, 14, yOff + 10, log.width + 18, log.height + 8, 6);
    cr.setSourceRGBA(0, 0, 0, 0.78);
    cr.fillPreserve();
    cr.setSourceRGBA(1, 1, 1, 0.25);
    cr.setLineWidth(1);
    cr.stroke();
    cr.setSourceRGB(1, 1, 1);
    cr.moveTo(23, yOff + 14);
    PangoCairo.show_layout(cr, lbl);

    const drawY = yOff + 26;
    cr.save();
    cr.translate(0, drawY);
    paintLyric(cr, fitted);
    cr.restore();
    yOff += h;
}

surf.writeToPNG(${JSON.stringify(OUTPUT)});
surf.finish();
print('wrote ${path.relative(root, OUTPUT)} ' + W + 'x' + H);
`);
    execFileSync('gjs', ['-m', script], {stdio: 'inherit'});
} finally {
    fs.rmSync(tmp, {recursive: true, force: true});
}
