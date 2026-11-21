// Desktop integration helpers for the standalone overlay:
// - raising Firefox through the zero-UI GNOME Shell window-raiser companion
//   (net.fuseki.LyricsOverlayRaiser1.RaiseWindow), falling back to Firefox's
//   MPRIS MediaPlayer2.Raise() on non-GNOME desktops or when absent;
// - sending standard desktop notifications on org.freedesktop.Notifications;
// - checking whether Dash to Panel hides the panel's rightBox (AppIndicators);
// - converting SVG icons into pixbufs and StatusNotifierItem ARGB32 pixmaps.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GdkPixbuf from 'gi://GdkPixbuf';

const decoder = new TextDecoder();

export const RAISER_BUS_NAME = 'net.fuseki.LyricsOverlayRaiser';
export const RAISER_OBJECT_PATH = '/net/fuseki/LyricsOverlayRaiser';
export const RAISER_IFACE = 'net.fuseki.LyricsOverlayRaiser1';

function raiseViaMpris() {
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

/**
 * Raises the browser window matching `windowTitle`.
 * Uses the GNOME Shell window-raiser companion when present (bypasses Wayland
 * focus-stealing prevention and targets the exact window across multiple
 * Firefox windows); falls back to Firefox's MPRIS Raise() when the helper is
 * absent on the session bus.
 */
export function raiseBrowser(windowTitle = '') {
    const title = typeof windowTitle === 'string' ? windowTitle : '';
    Gio.DBus.session.call(
        RAISER_BUS_NAME,
        RAISER_OBJECT_PATH,
        RAISER_IFACE,
        'RaiseWindow',
        new GLib.Variant('(s)', [title]),
        new GLib.VariantType('(s)'),
        Gio.DBusCallFlags.NO_AUTO_START,
        2500,
        null,
        (conn, res) => {
            let reply;
            try {
                const [json] = conn.call_finish(res).deepUnpack();
                reply = JSON.parse(json);
            } catch {
                raiseViaMpris();
                return;
            }
            if (reply.ok)
                return;
            if (reply.reason === 'ambiguous') {
                printerr('lyrics-overlay-desktop: multiple windows share the reported title; not guessing which to raise');
                return;
            }
            if (reply.reason === 'replaced')
                return;
            printerr(`lyrics-overlay-desktop: window raiser did not find the browser (${reply.reason ?? 'unknown'}); trying MPRIS`);
            raiseViaMpris();
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
