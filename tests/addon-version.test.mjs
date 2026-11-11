import test from 'node:test';
import assert from 'node:assert/strict';

import {AddonVersion, compareVersions, isAddonVersion} from '../service/addon-version.js';

test('versions compare part by part as numbers, missing parts counting as zero', () => {
    assert.ok(compareVersions('1.2.0', '1.3.0') < 0);
    assert.ok(compareVersions('1.10.0', '1.9.0') > 0, 'not as text');
    assert.equal(compareVersions('1.3', '1.3.0'), 0);
    assert.ok(compareVersions('2', '1.99.99') > 0);
});

test('a version is up to four dot-separated whole numbers', () => {
    for (const version of ['1', '1.3.0', '1.3.0.12'])
        assert.ok(isAddonVersion(version), version);
    for (const version of ['', '1.3.0a1', '1..3', '1.2.3.4.5', 'v1.3.0', 1.3, null])
        assert.ok(!isAddonVersion(version), String(version));
});

test('the status follows the add-on that reported last', () => {
    const addon = new AddonVersion({current: '1.3.0'});
    assert.deepEqual(addon.describe(), {status: 'unheard', current: '1.3.0'});
    addon.heard(null);
    assert.deepEqual(addon.describe(), {status: 'unnamed', current: '1.3.0'}, 'an add-on before 1.3.0 names no version');
    addon.heard('1.3.0');
    assert.deepEqual(addon.describe(), {status: 'current', version: '1.3.0', current: '1.3.0'});
    addon.heard('1.2.5');
    assert.deepEqual(addon.describe(), {status: 'older', version: '1.2.5', current: '1.3.0'});
    addon.heard('1.4.0');
    assert.deepEqual(addon.describe(), {status: 'newer', version: '1.4.0', current: '1.3.0'});
});

test('the current version must be one', () => {
    assert.throws(() => new AddonVersion({current: undefined}), /current version/u);
    assert.throws(() => new AddonVersion({current: '1.3.0-beta'}), /current version/u);
});
