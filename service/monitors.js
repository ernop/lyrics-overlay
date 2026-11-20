// Logical monitor geometry from GNOME Mutter's DisplayConfig on the session
// bus, so the settings page's interactive placement map matches the real
// monitors' aspect ratios and pixel sizes. Exposes only dimensions, offsets,
// scale and primary status (never hardware vendor or serial strings). Falls
// back to a single 1920x1080 display when no DisplayConfig service runs
// (such as headless tests).

import Gio from 'gi://Gio';

const FALLBACK = Object.freeze([
    Object.freeze({index: 0, x: 0, y: 0, width: 1920, height: 1080, scale: 1, primary: true, label: 'Primary (1920\u00d71080)'}),
]);

/**
 * Parses Mutter's GetCurrentState tuple into generic monitor records ordered
 * identically to Mutter's logical monitor list (Main.layoutManager.monitors).
 */
export function parseDisplayState(unpacked) {
    const [, rawMonitors, rawLogical] = unpacked;
    const sizeByConnector = new Map();
    for (const [spec, modes] of rawMonitors) {
        const connector = spec[0];
        const current = modes.find(mode => Boolean(mode[6]?.['is-current'])) ?? modes[0];
        if (current)
            sizeByConnector.set(connector, {width: current[1], height: current[2]});
    }
    const result = [];
    rawLogical.forEach((entry, index) => {
        const [x, y, scale, transform, primary, attached] = entry;
        const firstConnector = attached[0]?.[0];
        const physical = sizeByConnector.get(firstConnector) ?? {width: 1920, height: 1080};
        const rotated = transform % 2 === 1;
        const rawWidth = rotated ? physical.height : physical.width;
        const rawHeight = rotated ? physical.width : physical.height;
        const factor = scale > 0 ? scale : 1;
        const width = Math.max(1, Math.round(rawWidth / factor));
        const height = Math.max(1, Math.round(rawHeight / factor));
        result.push({
            index,
            x,
            y,
            width,
            height,
            scale: factor,
            primary: Boolean(primary),
            label: primary ? `Primary (${width}\u00d7${height})` : `Monitor ${index + 1} (${width}\u00d7${height})`,
        });
    });
    return result.length ? result : [...FALLBACK];
}

/** @returns {Promise<Array<{index: number, x: number, y: number, width: number, height: number, scale: number, primary: boolean, label: string}>>} */
export function readMonitors() {
    return new Promise(resolve => {
        try {
            Gio.DBus.session.call(
                'org.gnome.Mutter.DisplayConfig',
                '/org/gnome/Mutter/DisplayConfig',
                'org.gnome.Mutter.DisplayConfig',
                'GetCurrentState',
                null,
                null,
                Gio.DBusCallFlags.NO_AUTO_START,
                1500,
                null,
                (connection, result) => {
                    try {
                        const answer = connection.call_finish(result);
                        resolve(parseDisplayState(answer.deepUnpack()));
                    } catch {
                        resolve([...FALLBACK]);
                    }
                },
            );
        } catch {
            resolve([...FALLBACK]);
        }
    });
}
