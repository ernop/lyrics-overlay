// The browser add-on and the desktop extension reach the service at a
// fixed address; it must be on the port the settings start from, and the
// add-on's host permission must cover it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const read = relative => fs.readFileSync(new URL(`../${relative}`, import.meta.url), 'utf8');

test('the add-on and the desktop extension use the service port from settings.example.json', () => {
    const {port} = JSON.parse(read('settings.example.json'));
    const address = `http://lyrics.localhost:${port}`;
    assert.match(read('firefox/background.js'), new RegExp(`^const SERVICE = '${address}';$`, 'mu'));
    // Match patterns ignore ports, so the permission for the name covers the service's port.
    assert.ok(JSON.parse(read('firefox/manifest.json')).host_permissions.includes('http://lyrics.localhost/*'));
    assert.match(read('gnome-extension/lyrics-overlay@ernop/extension.js'), new RegExp(`^const STATUS_PAGE_URI = '${address}/';$`, 'mu'));
});
