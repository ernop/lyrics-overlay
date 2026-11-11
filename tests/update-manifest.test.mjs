// Firefox updates the add-on from the update manifest at its update_url
// (scripts/update-manifest.mjs writes it at each release); the README and
// the settings page offer the same release's file to an add-on too old to
// update itself.
import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';

import {releasesAddress, updateManifest} from '../scripts/update-manifest.mjs';

const read = relative => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('firefox/manifest.json'));

test('the update manifest names this version in its own release, with the file’s hash', () => {
    const xpiBytes = new TextEncoder().encode('a signed add-on');
    const releases = 'https://github.com/ernop/lyrics-overlay/releases';
    assert.equal(releasesAddress(manifest), releases);
    assert.deepEqual(updateManifest({manifest, xpiName: 'lyrics-overlay.xpi', xpiBytes}), {
        addons: {
            'lyrics-overlay@local': {
                updates: [{
                    version: manifest.version,
                    update_link: `${releases}/download/v${manifest.version}/lyrics-overlay.xpi`,
                    update_hash: `sha256:${crypto.createHash('sha256').update(xpiBytes).digest('hex')}`,
                }],
            },
        },
    });
});

test('an update_url outside the newest release is refused', () => {
    const elsewhere = structuredClone(manifest);
    elsewhere.browser_specific_settings.gecko.update_url = 'https://example.com/updates.json';
    assert.throws(() => releasesAddress(elsewhere), /update_url must end with/u);
});

test('the README and the settings page offer the newest release’s add-on', () => {
    const download = `${releasesAddress(manifest)}/latest/download/lyrics-overlay.xpi`;
    assert.ok(read('README.md').includes(`(${download})`), 'README download link');
    assert.match(read('service/settings-page/settings.js'), new RegExp(`^const ADDON_DOWNLOAD = '${download.replaceAll('.', '\\.')}';$`, 'mu'));
});

test('the release script writes the update manifest beside the signed add-on', () => {
    assert.match(read('scripts/release-firefox.sh'), /^node scripts\/update-manifest\.mjs "\$installer" "\$update_manifest"$/mu);
});
