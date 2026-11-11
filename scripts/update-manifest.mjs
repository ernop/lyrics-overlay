// Writes the update manifest Firefox reads at the add-on's update_url: the
// signed build's version, its address in that version's GitHub release,
// and its hash. scripts/release-firefox.sh runs it; the release carries it
// beside the XPI (docs/operations.md, "Release the Firefox extension").
//
//   node scripts/update-manifest.mjs <signed.xpi> <updates.json>

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

// Every release carries its updates.json, so Firefox reads the newest one's.
const LATEST_SUFFIX = '/latest/download/updates.json';

/** The GitHub releases address the add-on's update_url points into. */
export function releasesAddress(manifest) {
    const updateUrl = manifest.browser_specific_settings.gecko.update_url;
    if (!updateUrl.endsWith(LATEST_SUFFIX))
        throw new Error(`update_url must end with ${LATEST_SUFFIX}: ${updateUrl}`);
    return updateUrl.slice(0, -LATEST_SUFFIX.length);
}

/** @param {{manifest: object, xpiName: string, xpiBytes: Uint8Array}} build */
export function updateManifest({manifest, xpiName, xpiBytes}) {
    return {
        addons: {
            [manifest.browser_specific_settings.gecko.id]: {
                updates: [{
                    version: manifest.version,
                    update_link: `${releasesAddress(manifest)}/download/v${manifest.version}/${xpiName}`,
                    update_hash: `sha256:${crypto.createHash('sha256').update(xpiBytes).digest('hex')}`,
                }],
            },
        },
    };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
    const [xpiPath, outPath] = process.argv.slice(2);
    if (!xpiPath || !outPath) {
        console.error('usage: node scripts/update-manifest.mjs <signed.xpi> <updates.json>');
        process.exit(2);
    }
    const manifest = JSON.parse(fs.readFileSync(new URL('../firefox/manifest.json', import.meta.url), 'utf8'));
    const written = updateManifest({manifest, xpiName: path.basename(xpiPath), xpiBytes: fs.readFileSync(xpiPath)});
    fs.writeFileSync(outPath, `${JSON.stringify(written, null, 2)}\n`);
}
