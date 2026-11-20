import test from 'node:test';
import assert from 'node:assert/strict';

import {
    TEXT_COLORS, hexColor, nearestNamedColor, parseHexColor, resolveRingColors, resolveTextColor, ringColors,
} from '../shared/text-ink.js';

const WHITE = [1, 1, 1];
const BLACK = [0, 0, 0];

test('white and black letters keep their original double borders', () => {
    assert.deepEqual(ringColors(TEXT_COLORS.white), {inner: BLACK, outer: WHITE});
    assert.deepEqual(ringColors(TEXT_COLORS.black), {inner: WHITE, outer: BLACK});
});

test('each color gets the inner ring that contrasts more with it', () => {
    const contrast = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    const luminance = rgb => {
        const linear = channel => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
        return 0.2126 * linear(rgb[0]) + 0.7152 * linear(rgb[1]) + 0.0722 * linear(rgb[2]);
    };
    for (const [name, rgb] of Object.entries(TEXT_COLORS)) {
        const {inner, outer} = ringColors(rgb);
        const other = inner[0] === 0 ? WHITE : BLACK;
        assert.deepEqual(outer, other, name);
        assert.ok(contrast(luminance(rgb), luminance(inner)) >= contrast(luminance(rgb), luminance(other)), name);
        assert.ok(contrast(luminance(rgb), luminance(inner)) >= 4.5, `${name} letters read against their inner ring`);
    }
});

test('swatch colors are hex', () => {
    assert.equal(hexColor(TEXT_COLORS.white), '#ffffff');
    assert.equal(hexColor(TEXT_COLORS.yellow), '#ffeb00');
});

test('custom hex colors parse, resolve, find nearest preset, and compute contrast rings', () => {
    assert.deepEqual(parseHexColor('#00ff80'), [0, 1, 128 / 255]);
    assert.equal(parseHexColor('not-a-color'), null);
    assert.deepEqual(resolveTextColor('yellow', ''), TEXT_COLORS.yellow);
    assert.deepEqual(resolveTextColor('yellow', '#ff0000'), [1, 0, 0]);
    assert.throws(() => resolveTextColor('yellow', 'bad'), /invalid custom color/u);
    assert.equal(nearestNamedColor([0.98, 0.9, 0.05]), 'yellow');
    assert.equal(nearestNamedColor([0.05, 0.05, 0.05]), 'black');
    assert.deepEqual(ringColors(TEXT_COLORS.white), {inner: BLACK, outer: WHITE});
    assert.deepEqual(ringColors(TEXT_COLORS.black), {inner: WHITE, outer: BLACK});
});

test('multi-ring defaults alternate contrast cleanly and honor per-ring custom hex overrides', () => {
    assert.deepEqual(resolveRingColors(TEXT_COLORS.pink, 3), [BLACK, WHITE, BLACK]);
    assert.deepEqual(resolveRingColors(TEXT_COLORS.pink, 4), [BLACK, WHITE, TEXT_COLORS.pink, BLACK]);
    assert.deepEqual(resolveRingColors(TEXT_COLORS.white, 4), [BLACK, WHITE, BLACK, WHITE]);
    assert.deepEqual(resolveRingColors(TEXT_COLORS.black, 3), [WHITE, BLACK, WHITE]);
    assert.deepEqual(resolveRingColors(TEXT_COLORS.pink, 3, ['', '#ff0000', '']), [BLACK, [1, 0, 0], BLACK]);
});
