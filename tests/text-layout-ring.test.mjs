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
const run = promisify(execFile);

test('a proportional double border around a period is solid inner ring, then solid outer trim', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyrics-ring-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    fs.symlinkSync(path.join(root, 'gnome-extension/lyrics-overlay@ernop/text-layout.js'), path.join(dir, 'text-layout.js'));
    fs.symlinkSync(path.join(root, 'shared'), path.join(dir, 'shared'));

    const {stdout} = await run('gjs', ['-m', path.join(root, 'tests/paint-lyric-ring.js'), dir, path.join(dir, 'ring.png'), '.', '220', 'double']);
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

test('double and glow borders fill the middle of an o with the solid inner body', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyrics-ring-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    fs.symlinkSync(path.join(root, 'gnome-extension/lyrics-overlay@ernop/text-layout.js'), path.join(dir, 'text-layout.js'));
    fs.symlinkSync(path.join(root, 'shared'), path.join(dir, 'shared'));
    for (const border of ['double', 'glow']) {
        for (const size of [60, 100, 160]) {
            const {stdout} = await run('gjs', ['-m', path.join(root, 'tests/paint-lyric-ring.js'), dir, path.join(dir, 'ring.png'), 'o', String(size), border]);
            const {center} = JSON.parse(stdout.trim().split('\n').pop());
            assert.ok(center.every(channel => channel < 40), `black wanted in the middle of an o (${border} at ${size} px), got rgb(${center})`);
        }
    }
});

test('font size stays constant on long lines while requiredHeight expands naturally', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyrics-const-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    fs.symlinkSync(path.join(root, 'gnome-extension/lyrics-overlay@ernop/text-layout.js'), path.join(dir, 'text-layout.js'));
    fs.symlinkSync(path.join(root, 'shared'), path.join(dir, 'shared'));

    const shortRun = await run('gjs', ['-m', path.join(root, 'tests/paint-lyric-ring.js'), dir, path.join(dir, 'short.png'), 'Hello', '64', 'double']);
    const longRun = await run('gjs', ['-m', path.join(root, 'tests/paint-lyric-ring.js'), dir, path.join(dir, 'long.png'),
        'This is a much longer lyric line that wraps across multiple lines without shrinking', '64', 'double']);
    const shortRes = JSON.parse(shortRun.stdout.trim().split('\n').pop());
    const longRes = JSON.parse(longRun.stdout.trim().split('\n').pop());
    assert.equal(shortRes.fontSize, 64);
    assert.equal(longRes.fontSize, 64);
    assert.ok(longRes.requiredHeight > shortRes.requiredHeight * 1.8, `${longRes.requiredHeight} should exceed ${shortRes.requiredHeight}`);
});

test('a fit and a paint served from the caches match a fresh module with empty caches', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyrics-cache-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    fs.symlinkSync(path.join(root, 'gnome-extension/lyrics-overlay@ernop/text-layout.js'), path.join(dir, 'text-layout.js'));
    fs.symlinkSync(path.join(root, 'gnome-extension/lyrics-overlay@ernop/text-layout.js'), path.join(dir, 'text-layout-fresh.js'));
    fs.symlinkSync(path.join(root, 'shared'), path.join(dir, 'shared'));

    const {stdout} = await run('gjs', ['-m', path.join(root, 'tests/text-layout-cache.js'), dir, dir]);
    const result = JSON.parse(stdout.trim().split('\n').pop());
    assert.ok(result.wrapWidth < result.width, 'the lyric wraps, so the wrap cache is used');
    assert.equal(result.sameFit, true);
    assert.equal(result.samePixels, true);
});
