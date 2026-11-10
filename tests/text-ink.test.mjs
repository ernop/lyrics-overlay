import test from 'node:test';
import assert from 'node:assert/strict';

import {TEXT_COLORS, hexColor, ringColors} from '../shared/text-ink.js';

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
