// The lyric's border rings around a small closed contour (a period, the
// dot of an i) are solid: Cairo's stroker leaves a hole when the stroke is
// wider than the contour, and the border at four times its thickness was
// drawn as a ring with the background inside it.
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

test('a wide double border around a period is solid inner ring, then solid outer ring', async t => {
    // text-layout.js imports ./shared/, which the install script copies in.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyrics-ring-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    fs.symlinkSync(path.join(root, 'gnome-extension/lyrics-overlay@ernop/text-layout.js'), path.join(dir, 'text-layout.js'));
    fs.symlinkSync(path.join(root, 'shared'), path.join(dir, 'shared'));

    const {stdout} = await run('gjs', ['-m', path.join(root, 'tests/paint-lyric-ring.js'), dir, path.join(dir, 'ring.png'), '.']);
    const {ring, samples} = JSON.parse(stdout.trim().split('\n').pop());
    assert.ok(ring.inner > 20 && ring.outer > 20, 'the border is wide next to the period');

    // Yellow letters: the inner ring is black, the outer white. One pixel
    // of antialiasing either side of each boundary is left out.
    const misses = [];
    for (const {distance, angle, rgb} of samples) {
        const want = distance < ring.inner - 2 ? 'black' : distance > ring.inner + 2 ? 'white' : null;
        if (want === null)
            continue;
        const got = rgb.every(channel => channel < 40) ? 'black' : rgb.every(channel => channel > 215) ? 'white' : 'other';
        if (got !== want)
            misses.push(`${want} wanted ${distance.toFixed(0)} px out at angle ${angle}/32, got rgb(${rgb})`);
    }
    assert.deepEqual(misses, []);
});

test('a wide border fills the middle of an o with the inner ring', async t => {
    // The o's counter is a closed contour narrower than the stroke, like
    // a dot; the owner saw a white hole in it (2026-11-19).
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyrics-ring-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));
    fs.symlinkSync(path.join(root, 'gnome-extension/lyrics-overlay@ernop/text-layout.js'), path.join(dir, 'text-layout.js'));
    fs.symlinkSync(path.join(root, 'shared'), path.join(dir, 'shared'));
    for (const size of [60, 100, 160]) {
        const {stdout} = await run('gjs', ['-m', path.join(root, 'tests/paint-lyric-ring.js'), dir, path.join(dir, 'ring.png'), 'o', String(size)]);
        const {center} = JSON.parse(stdout.trim().split('\n').pop());
        assert.ok(center.every(channel => channel < 40), `black wanted in the middle of an o at ${size} px, got rgb(${center})`);
    }
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
