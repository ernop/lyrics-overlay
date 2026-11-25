// The lyric's border rings around a small closed contour (a period, the
// dot of an i, the counter of an o) stay solid with no background punch-through,
// font size never shrinks for long lines, and cached renders match fresh ones.
import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sharedDir = path.join(root, 'shared');
const run = promisify(execFile);

test('a proportional double border around a period is solid inner ring, then solid outer trim', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyrics-ring-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));

    const {stdout} = await run('gjs', ['-m', path.join(root, 'tests/paint-lyric-ring.js'), sharedDir, path.join(dir, 'ring.png'), '.', '220', 'double']);
    const {ring, samples} = JSON.parse(stdout.trim().split('\n').pop());
    assert.ok(ring.inner > 20 && ring.outer >= 7, `expected proportional double ring, got ${JSON.stringify(ring)}`);

    // Yellow letters: the inner ring is black, the outer trim is white.
    // Leave 2 px tolerance around each antialiased boundary.
    const misses = [];
    for (const {distance, angle, rgb} of samples) {
        const want = distance < ring.inner - 2 ? 'black' : distance > ring.inner + 2 && distance < ring.inner + ring.outer - 1.5 ? 'white' : null;
        if (want === null)
            continue;
        const got = rgb.every(channel => channel < 45) ? 'black' : rgb.every(channel => channel > 205) ? 'white' : 'other';
        if (got !== want)
            misses.push(`${want} wanted ${distance.toFixed(0)} px out at angle ${angle}/32, got rgb(${rgb})`);
    }
    assert.deepEqual(misses, []);
});

test('triple and quad borders paint 3 and 4 distinct solid concentric bands and respect custom ring colors and widths', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyrics-multi-ring-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));

    // Triple border on yellow letters: black -> white -> black outer seal (zero backdrop needed).
    const tripleRun = await run('gjs', ['-m', path.join(root, 'tests/paint-lyric-ring.js'), sharedDir, path.join(dir, 'triple.png'), '.', '220', 'triple']);
    const triple = JSON.parse(tripleRun.stdout.trim().split('\n').pop());
    assert.equal(triple.ring.rings.length, 3);
    const [r1, r2, r3] = triple.ring.rings.map(r => r.width);
    const misses = [];
    for (const {distance, angle, rgb} of triple.samples) {
        let want = null;
        if (distance < r1 - 2)
            want = 'black';
        else if (distance > r1 + 2 && distance < r1 + r2 - 2)
            want = 'white';
        else if (distance > r1 + r2 + 2 && distance < r1 + r2 + r3 - 2)
            want = 'black';
        if (!want)
            continue;
        const got = rgb.every(c => c < 45) ? 'black' : rgb.every(c => c > 205) ? 'white' : 'other';
        if (got !== want)
            misses.push(`triple: ${want} wanted at ${distance.toFixed(0)} px angle ${angle}/32, got rgb(${rgb})`);
    }
    assert.deepEqual(misses, []);

    // Quad border with custom ring colors & custom ring widths:
    // Ring 1 black, Ring 2 white, Ring 3 red (#ff0000), Ring 4 green (#00ff00).
    const extra = JSON.stringify({
        ringColors: ['#000000', '#ffffff', '#ff0000', '#00ff00'],
        ringWidths: [0.09, 0.08, 0.07, 0.06],
    });
    const quadRun = await run('gjs', ['-m', path.join(root, 'tests/paint-lyric-ring.js'), sharedDir, path.join(dir, 'quad.png'), '.', '200', 'quad', 'Sans', extra]);
    const quad = JSON.parse(quadRun.stdout.trim().split('\n').pop());
    assert.equal(quad.ring.rings.length, 4);
    const [q1, q2, q3, q4] = quad.ring.rings.map(r => r.width);
    const classify = ([r, g, b]) => {
        if (r < 45 && g < 45 && b < 45) return 'black';
        if (r > 205 && g > 205 && b > 205) return 'white';
        if (r > 205 && g < 45 && b < 45) return 'red';
        if (r < 45 && g > 205 && b < 45) return 'green';
        return 'other';
    };
    const qMisses = [];
    for (const {distance, angle, rgb} of quad.samples) {
        let want = null;
        if (distance < q1 - 2)
            want = 'black';
        else if (distance > q1 + 2 && distance < q1 + q2 - 2)
            want = 'white';
        else if (distance > q1 + q2 + 2 && distance < q1 + q2 + q3 - 2)
            want = 'red';
        else if (distance > q1 + q2 + q3 + 2 && distance < q1 + q2 + q3 + q4 - 2)
            want = 'green';
        if (!want)
            continue;
        const got = classify(rgb);
        if (got !== want)
            qMisses.push(`quad: ${want} wanted at ${distance.toFixed(0)} px angle ${angle}/32, got rgb(${rgb})`);
    }
    assert.deepEqual(qMisses, []);
});

test('double, triple, quad and glow borders fill the middle of an o with the solid inner body', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyrics-ring-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    for (const border of ['double', 'triple', 'quad', 'glow']) {
        for (const size of [60, 100, 160]) {
            const {stdout} = await run('gjs', ['-m', path.join(root, 'tests/paint-lyric-ring.js'), sharedDir, path.join(dir, 'ring.png'), 'o', String(size), border]);
            const {center} = JSON.parse(stdout.trim().split('\n').pop());
            assert.ok(center.every(channel => channel < 40), `black wanted in the middle of an o (${border} at ${size} px), got rgb(${center})`);
        }
    }
});

test('font size stays constant on long lines while requiredHeight expands naturally', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyrics-const-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));

    const shortRun = await run('gjs', ['-m', path.join(root, 'tests/paint-lyric-ring.js'), sharedDir, path.join(dir, 'short.png'), 'Hello', '64', 'double']);
    const longRun = await run('gjs', ['-m', path.join(root, 'tests/paint-lyric-ring.js'), sharedDir, path.join(dir, 'long.png'),
        'This is a much longer lyric line that wraps across multiple lines without shrinking', '64', 'double']);
    const shortRes = JSON.parse(shortRun.stdout.trim().split('\n').pop());
    const longRes = JSON.parse(longRun.stdout.trim().split('\n').pop());
    assert.equal(shortRes.fontSize, 64);
    assert.equal(longRes.fontSize, 64);
    assert.ok(longRes.requiredHeight > shortRes.requiredHeight * 1.8, `${longRes.requiredHeight} should exceed ${shortRes.requiredHeight}`);
});

test('multi-ring borders fuse monospace word gaps with zero background punch-through and toggle dark backing cloud cleanly', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyrics-fuse-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));

    for (const border of ['double', 'triple', 'glow']) {
        // Default (cloud off): clean background outside the border rings, zero word-gap bleed.
        const cleanRun = await run('gjs', [
            '-m', path.join(root, 'tests/paint-lyric-ring.js'),
            sharedDir, path.join(dir, `fuse-${border}-clean.png`), 'Good day', '84', border, 'Monospace',
        ]);
        const clean = JSON.parse(cleanRun.stdout.trim().split('\n').pop());
        assert.equal(clean.lineCount, 1);
        assert.ok(clean.spaceScale < 0.65, `monospace space should normalize tight, got ${clean.spaceScale}`);
        assert.equal(clean.midlineBgPixels, 0, `${border}: background leaked between words along x-height midline`);
        if (border !== 'glow')
            assert.ok(clean.auraRgb[2] > 240, `${border}: without cloud, pure blue background stays untouched, got rgb(${clean.auraRgb})`);

        // Optional cloud on: smooth dark backing cloud dims the background around the rings.
        const cloudRun = await run('gjs', [
            '-m', path.join(root, 'tests/paint-lyric-ring.js'),
            sharedDir, path.join(dir, `fuse-${border}-cloud.png`), 'Good day', '84', border, 'Monospace',
            JSON.stringify({borderCloud: true}),
        ]);
        const cloud = JSON.parse(cloudRun.stdout.trim().split('\n').pop());
        const maxBlue = border === 'glow' ? 230 : 180;
        assert.ok(cloud.auraRgb[2] < maxBlue, `${border} + cloud: dark backing cloud should dim blue background, got rgb(${cloud.auraRgb})`);
    }
});

test('a fit and a paint served from the caches match a fresh module with empty caches', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyrics-cache-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    for (const file of fs.readdirSync(sharedDir)) {
        if (file.endsWith('.js'))
            fs.symlinkSync(path.join(sharedDir, file), path.join(dir, file));
    }
    fs.symlinkSync(path.join(sharedDir, 'text-layout.js'), path.join(dir, 'text-layout-fresh.js'));

    const {stdout} = await run('gjs', ['-m', path.join(root, 'tests/text-layout-cache.js'), dir, dir]);
    const result = JSON.parse(stdout.trim().split('\n').pop());
    assert.ok(result.wrapWidth < result.width, 'the lyric wraps, so the wrap cache is used');
    assert.equal(result.sameFit, true);
    assert.equal(result.samePixels, true);
});

test('bottom-anchored lyric trims dead vertical padding to ~2 px while keeping baseline steady across lines', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyrics-trim-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    const script = path.join(dir, 'check-trim.mjs');
    fs.writeFileSync(script, `
import PangoCairo from 'gi://PangoCairo';
import {fitLyric, singleLineHeight} from 'file://${sharedDir}/text-layout.js';
const ctx = PangoCairo.FontMap.get_default().create_context();
const base = {
    fontSize: 48, family: 'Sans', bold: true, italic: false,
    color: 'yellow', border: 'double', align: 'left', anchor: 'bottom',
    maxLines: 0, contentFit: false, width: 1000, height: 1,
};
const slh = singleLineHeight(ctx, base);
const upper = fitLyric(ctx, 'HELLO WORLD', base);
const desc = fitLyric(ctx, 'Hey gyp', base);
const furi = fitLyric(ctx, '東京の夜空gjpqy', {...base, ruby: [['東京', 'とうきょう'], ['の', ''], ['夜空', 'よぞら'], ['gjpqy', '']]});
const descGap = desc.surfaceHeight - (desc.inkBox.y + desc.inkBox.height);
const furiGap = furi.surfaceHeight - (furi.inkBox.y + furi.inkBox.height);
print(JSON.stringify({
    slh,
    upperH: upper.surfaceHeight,
    descH: desc.surfaceHeight,
    upperOriginY: upper.origin.y,
    descOriginY: desc.origin.y,
    descGap,
    furiGap,
}));
`);
    const {stdout} = await run('gjs', ['-m', script]);
    const r = JSON.parse(stdout.trim().split('\n').pop());
    assert.equal(r.upperH, r.slh);
    assert.equal(r.descH, r.slh);
    assert.equal(r.upperOriginY, r.descOriginY, 'uppercase and descender lines share identical baseline');
    assert.ok(r.descGap >= 0 && r.descGap <= 4, `descender bottom gap should be ~2 px, got ${r.descGap}`);
    assert.ok(r.furiGap >= 0 && r.furiGap <= 6, `furigana bottom gap should stay tight while holding baseline, got ${r.furiGap}`);
});
