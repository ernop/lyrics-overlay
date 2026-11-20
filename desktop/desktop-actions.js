// Desktop integration helpers for the standalone overlay:
// - raising Firefox via its MPRIS MediaPlayer2.Raise() method;
// - sending standard desktop notifications on org.freedesktop.Notifications;
// - checking whether Dash to Panel hides the panel's rightBox (AppIndicators);
// - converting SVG icons into pixbufs and StatusNotifierItem ARGB32 pixmaps.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';

const decoder = new TextDecoder();

/**
 * Asks Firefox to raise its active window through its MPRIS D-Bus service.
 * Fails silently when Firefox has no MPRIS name on the bus.
 */
export function raiseBrowser() {
    Gio.DBus.session.call(
        'org.freedesktop.DBus',
        '/org/freedesktop/DBus',
        'org.freedesktop.DBus',
        'ListNames',
        null,
        new GLib.VariantType('(as)'),
        Gio.DBusCallFlags.NONE,
        1500,
        null,
        (conn, res) => {
            let names;
            try {
                [names] = conn.call_finish(res).deepUnpack();
            } catch {
                return;
            }
            for (const name of names) {
                if (!name.startsWith('org.mpris.MediaPlayer2.firefox'))
                    continue;
                Gio.DBus.session.call(
                    name,
                    '/org/mpris/MediaPlayer2',
                    'org.mpris.MediaPlayer2',
                    'Raise',
                    null,
                    null,
                    Gio.DBusCallFlags.NONE,
                    1500,
                    null,
                    (c, r) => {
                        try {
                            c.call_finish(r);
                        } catch {
                            // Ignore if Firefox closed or declined raise.
                        }
                    },
                );
            }
        },
    );
}

/** Sends a standard desktop notification via org.freedesktop.Notifications. */
export function notify(title, body) {
    Gio.DBus.session.call(
        'org.freedesktop.Notifications',
        '/org/freedesktop/Notifications',
        'org.freedesktop.Notifications',
        'Notify',
        new GLib.Variant('(susssasa{sv}i)', [
            'Lyrics overlay',
            0,
            'audio-x-generic',
            title,
            body,
            [],
            {},
            5000,
        ]),
        null,
        Gio.DBusCallFlags.NONE,
        2000,
        null,
        (conn, res) => {
            try {
                conn.call_finish(res);
            } catch (error) {
                printerr(`lyrics-overlay-desktop: notify failed: ${error.message}`);
            }
        },
    );
}

/**
 * Returns true if Dash to Panel is enabled and its panel-element-positions
 * explicitly hides rightBox (where AppIndicator / StatusNotifierItem icons go).
 */
export function panelHidesRightBox() {
    try {
        const readDconf = path => {
            const proc = Gio.Subprocess.new(
                ['dconf', 'read', path],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE,
            );
            const [, stdout] = proc.communicate_utf8(null, null);
            return proc.get_successful() ? (stdout ?? '').trim() : '';
        };
        const enabled = readDconf('/org/gnome/shell/enabled-extensions');
        if (!enabled.includes('dash-to-panel@jderose9.github.com'))
            return false;
        const trimmed = readDconf('/org/gnome/shell/extensions/dash-to-panel/panel-element-positions');
        if (!trimmed.startsWith("'") || !trimmed.endsWith("'"))
            return false;
        const layout = JSON.parse(trimmed.slice(1, -1));
        const monitors = Object.values(layout);
        if (!monitors.length)
            return false;
        return monitors.every(elements =>
            Array.isArray(elements) && elements.some(e => e.element === 'rightBox' && e.visible === false));
    } catch {
        return false;
    }
}

/** Loads an SVG icon at exact pixel size as an RGBA GdkPixbuf. */
export function loadSvgPixbuf(svgPath, size) {
    return GdkPixbuf.Pixbuf.new_from_file_at_scale(svgPath, size, size, true);
}

/**
 * Converts an RGBA GdkPixbuf to StatusNotifierItem ARGB32 network byte order
 * (`[A, R, G, B]` per pixel) as a Uint8Array.
 */
export function pixbufToSniArgb32(pixbuf) {
    const width = pixbuf.get_width();
    const height = pixbuf.get_height();
    const stride = pixbuf.get_rowstride();
    const channels = pixbuf.get_n_channels();
    const src = pixbuf.get_pixels();
    const out = new Uint8Array(width * height * 4);
    let dst = 0;
    for (let y = 0; y < height; y++) {
        const row = y * stride;
        for (let x = 0; x < width; x++) {
            const p = row + x * channels;
            const r = src[p];
            const g = src[p + 1];
            const b = src[p + 2];
            const a = channels >= 4 ? src[p + 3] : 255;
            out[dst++] = a;
            out[dst++] = r;
            out[dst++] = g;
            out[dst++] = b;
        }
    }
    return {width, height, bytes: out};
}

/** Compiles the checkout's GSettings schema into `compiledDir` and opens it. */
export function openCompiledSettings(schemaSourceDir, compiledDir, schemaId) {
    GLib.mkdir_with_parents(compiledDir, 0o700);
    const proc = Gio.Subprocess.new(
        ['glib-compile-schemas', '--strict', `--targetdir=${compiledDir}`, schemaSourceDir],
        Gio.SubprocessFlags.STDERR_PIPE,
    );
    const [, , stderr] = proc.communicate_utf8(null, null);
    if (!proc.get_successful())
        throw new Error(`glib-compile-schemas failed: ${stderr.trim()}`);
    const source = Gio.SettingsSchemaSource.new_from_directory(compiledDir, null, true);
    const schema = source.lookup(schemaId, false);
    if (!schema)
        throw new Error(`${schemaSourceDir} does not define ${schemaId}`);
    return new Gio.Settings({settings_schema: schema});
}

export function readTextFile(path) {
    const [, bytes] = GLib.file_get_contents(path);
    return decoder.decode(bytes);
}
