// The browser add-on and the desktop extension reach the service at a
// fixed address; it must be on the port the settings start from, and the
// add-on's host permissions must cover it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = relative => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

test('the add-on and the desktop extension use the service port from settings.example.json', () => {
    const {port} = JSON.parse(read('settings.example.json'));
    assert.match(read('firefox/background.js'), new RegExp(`^const SERVICE = 'http://lyrics\\.localhost:${port}';$`, 'mu'));
    // The settings page is at plain localhost, which Firefox does not first try over HTTPS.
    const access = read('firefox/settings-access.js');
    assert.match(access, new RegExp(`^const SETTINGS_ORIGIN = 'http://localhost:${port}';$`, 'mu'));
    assert.match(access, /^const SETTINGS_PAGE = `\$\{SETTINGS_ORIGIN\}\/settings`;$/mu);
    // Match patterns ignore ports, so a permission for a name covers the
    // service's port; the add-on can ask at run time only for what its
    // manifest names.
    const manifest = JSON.parse(read('firefox/manifest.json'));
    assert.match(access, /^const SETTINGS_ACCESS = \{origins: \['http:\/\/localhost\/\*'\]\};$/mu);
    for (const pattern of ['http://lyrics.localhost/*', 'http://localhost/*'])
        assert.ok(manifest.host_permissions.includes(pattern), `the add-on lacks ${pattern}`);
    assert.deepEqual(manifest.background.scripts, ['settings-access.js', 'background.js']);
    assert.match(read('firefox/grant.html'), /<script src="settings-access\.js"><\/script>\n<script src="grant\.js"><\/script>/u);
    assert.match(read('gnome-extension/lyrics-overlay@ernop/extension.js'),
        new RegExp(`^const SETTINGS_URI = 'http://localhost:${port}/settings';$`, 'mu'));
});
