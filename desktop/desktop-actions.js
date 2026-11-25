// Desktop integration helpers for the standalone overlay:
// - raising Firefox through the zero-UI GNOME Shell window-raiser companion
//   (net.fuseki.LyricsOverlayRaiser1.RaiseWindow), falling back to Firefox's
//   MPRIS MediaPlayer2.Raise() on non-GNOME desktops or when absent;
// - sending standard desktop notifications on org.freedesktop.Notifications;
// - checking whether Dash to Panel hides the panel's rightBox (AppIndicators);
// - converting SVG icons into pixbufs and StatusNotifierItem ARGB32 pixmaps.

import GdkX11 from 'gi://GdkX11?version=3.0';
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
                printerr('lyrics-overlay-desktop: multiple windows share the reported title; cannot raise with older window raiser');
                notify(
                    'Multiple windows match',
                    `More than one window is titled "${title}". Close the duplicate tab, or log out and back in to load the updated window raiser.`,
                );
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

const QUIET_MAP_RESTORE_MS = 80;
const QUIET_MAP_FALLBACK_MS = 250;

const CLEAR_DEMANDS_ATTENTION_PY = [
    'import ctypes, sys',
    'xid = int(sys.argv[1])',
    'x11 = ctypes.CDLL("libX11.so.6")',
    'x11.XOpenDisplay.restype = ctypes.c_void_p',
    'd = x11.XOpenDisplay(None)',
    'if not d: sys.exit(0)',
    'root = x11.XDefaultRootWindow(d)',
    'x11.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]',
    'x11.XInternAtom.restype = ctypes.c_ulong',
    'state = x11.XInternAtom(d, b"_NET_WM_STATE", 0)',
    'demands = x11.XInternAtom(d, b"_NET_WM_STATE_DEMANDS_ATTENTION", 0)',
    'class XClientMessageEvent(ctypes.Structure):',
    '    _fields_ = [("type", ctypes.c_int), ("serial", ctypes.c_ulong), ("send_event", ctypes.c_int),',
    '                ("display", ctypes.c_void_p), ("window", ctypes.c_ulong),',
    '                ("message_type", ctypes.c_ulong), ("format", ctypes.c_int), ("l", ctypes.c_long * 5)]',
    'ev = XClientMessageEvent()',
    'ev.type = 33',
    'ev.window = xid',
    'ev.message_type = state',
    'ev.format = 32',
    'ev.l[0] = 0',
    'ev.l[1] = demands',
    'ev.l[2] = 0',
    'ev.l[3] = 1',
    'ev.l[4] = 0',
    'x11.XSendEvent.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_long, ctypes.c_void_p]',
    'x11.XSendEvent(d, root, 0, 0x00180000, ctypes.byref(ev))',
    'x11.XSync(d, 0)',
    'x11.XCloseDisplay(d)',
].join('\n');

/**
 * Maps a GTK3 XWayland window without stealing focus, without triggering
 * GNOME Shell's `"<title>" is ready` attention banner, and without leaving
 * `_NET_WM_STATE_DEMANDS_ATTENTION` set on the taskbar entry.
 *
 * On Mutter/XWayland, whenever an unfocused mapped window overlaps the focused
 * window (e.g. a maximized browser), Mutter marks it `demands_attention=true`
 * even with `focus_on_map=false` and `accept_focus=false`. Setting
 * `skip_taskbar_hint=true` across the map transition prevents GNOME Shell's
 * `WindowAttentionHandler` from posting the `"is ready"` notification, sending
 * `_NET_WM_STATE_REMOVE` for `_NET_WM_STATE_DEMANDS_ATTENTION` clears the
 * Mutter flag before the taskbar entry appears, and restoring `accept_focus`
 * (and `skip_taskbar_hint`) after first paint preserves normal OS-window
 * focus, keyboard, and Alt-Tab behavior.
 */
export class QuietMapGuard {
    /**
     * @param {import('gi://Gtk?version=3.0').Window} win
     * @param {{restoreSkipTaskbar?: boolean}} [options]
     */
    constructor(win, {restoreSkipTaskbar = false} = {}) {
        this._win = win;
        this._restoreSkipTaskbar = Boolean(restoreSkipTaskbar);
        this._gen = 0;
        this._awaitingMap = false;
        this._paintClock = null;
        this._paintId = 0;
        this._restoreId = 0;
        this._fallbackId = 0;
        this._clearProc = null;
        this._clearCancel = null;

        this._win.set_focus_on_map(false);
        this._win.set_accept_focus(false);
        this._win.set_skip_taskbar_hint(true);
        this._mapId = this._win.connect('map-event', () => {
            if (!this._awaitingMap)
                return false;
            this._awaitingMap = false;
            this._scheduleRestore();
            return false;
        });
    }

    /** Call immediately before `win.show_all()`. */
    prepareShow() {
        this._cancelPending();
        this._gen++;
        this._awaitingMap = true;
        this._win.set_focus_on_map(false);
        this._win.set_accept_focus(false);
        this._win.set_skip_taskbar_hint(true);
        const gdkWin = this._win.get_window();
        if (gdkWin instanceof GdkX11.X11Window)
            gdkWin.set_user_time(0);
    }

    /** Call immediately before `win.hide()`. */
    prepareHide() {
        this._cancelPending();
        this._gen++;
        this._awaitingMap = false;
        this._win.set_accept_focus(false);
        this._win.set_skip_taskbar_hint(true);
    }

    destroy() {
        this._cancelPending();
        this._gen++;
        this._awaitingMap = false;
        if (this._mapId) {
            this._win.disconnect(this._mapId);
            this._mapId = 0;
        }
    }

    _scheduleRestore() {
        this._cancelPending();
        const gen = this._gen;
        const finishRestore = () => {
            this._cancelPending();
            if (gen !== this._gen || !this._win.get_visible())
                return;
            const applyHints = () => {
                if (gen !== this._gen || !this._win.get_visible())
                    return;
                this._win.set_accept_focus(true);
                this._win.set_skip_taskbar_hint(this._restoreSkipTaskbar);
            };
            const gdkWin = this._win.get_window();
            if (!(gdkWin instanceof GdkX11.X11Window)) {
                applyHints();
                return;
            }
            const xid = gdkWin.get_xid();
            if (!xid) {
                applyHints();
                return;
            }
            try {
                const cancel = new Gio.Cancellable();
                const proc = Gio.Subprocess.new(
                    ['python3', '-c', CLEAR_DEMANDS_ATTENTION_PY, String(xid)],
                    Gio.SubprocessFlags.STDERR_SILENCE,
                );
                this._clearCancel = cancel;
                this._clearProc = proc;
                proc.wait_async(cancel, (p, res) => {
                    if (this._clearProc === p) {
                        this._clearProc = null;
                        this._clearCancel = null;
                    }
                    try {
                        p.wait_finish(res);
                    } catch {
                        // Ignore cancellation or missing libX11; still restore hints below.
                    }
                    applyHints();
                });
            } catch {
                applyHints();
            }
        };
        const armPostPaint = () => {
            if (this._restoreId)
                return;
            this._restoreId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, QUIET_MAP_RESTORE_MS, () => {
                this._restoreId = 0;
                finishRestore();
                return GLib.SOURCE_REMOVE;
            });
        };
        const clock = this._win.get_frame_clock?.() ?? null;
        if (clock) {
            this._paintClock = clock;
            this._paintId = clock.connect('after-paint', () => {
                this._disconnectPaint();
                armPostPaint();
            });
            // Safety fallback if the frame clock is paused (e.g. another workspace).
            this._fallbackId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, QUIET_MAP_FALLBACK_MS, () => {
                this._fallbackId = 0;
                finishRestore();
                return GLib.SOURCE_REMOVE;
            });
        } else {
            armPostPaint();
        }
    }

    _disconnectPaint() {
        if (this._paintClock && this._paintId) {
            this._paintClock.disconnect(this._paintId);
            this._paintId = 0;
            this._paintClock = null;
        }
    }

    _cancelPending() {
        this._disconnectPaint();
        if (this._restoreId) {
            GLib.source_remove(this._restoreId);
            this._restoreId = 0;
        }
        if (this._fallbackId) {
            GLib.source_remove(this._fallbackId);
            this._fallbackId = 0;
        }
        if (this._clearCancel) {
            this._clearCancel.cancel();
            this._clearCancel = null;
        }
        this._clearProc = null;
    }
}
