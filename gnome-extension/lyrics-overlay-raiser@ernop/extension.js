// Minimal zero-UI GNOME Shell helper for lyrics-overlay-desktop.
//
// Wayland's focus-stealing prevention blocks external clients (and Firefox's
// own MPRIS Raise() / windows.update({focused: true}) calls) from raising a
// background browser window over another focused app. This helper owns one
// session D-Bus method, RaiseWindow(title), and calls Main.activateWindow()
// inside the compositor for the unique window matching the title the Firefox
// add-on reported. Zero UI, zero Clutter actors, zero GSettings.

import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

const BUS_NAME = 'net.fuseki.LyricsOverlayRaiser';
const OBJECT_PATH = '/net/fuseki/LyricsOverlayRaiser';
const IFACE_XML = `<node>
  <interface name="net.fuseki.LyricsOverlayRaiser1">
    <method name="RaiseWindow">
      <arg type="s" direction="in" name="title"/>
      <arg type="s" direction="out" name="result"/>
    </method>
  </interface>
</node>`;

// The browser can retitle its window a moment after tabs.update() resolves.
const RETITLE_WAIT_MS = 1000;
const FIREFOX_SUFFIX = / [\u2014-] Mozilla Firefox$/u;

function reply(invocation, value) {
    invocation.return_value(new GLib.Variant('(s)', [JSON.stringify(value)]));
}

function normalWindows() {
    return global.display.list_all_windows().filter(
        window => !window.is_skip_taskbar() && window.get_window_type() === Meta.WindowType.NORMAL,
    );
}

function isFirefoxWindow(window) {
    const wmClass = window.get_wm_class() ?? '';
    const wmInstance = window.get_wm_class_instance() ?? '';
    return /firefox/iu.test(wmClass) || /firefox/iu.test(wmInstance);
}

function matchByTitle(title) {
    const windows = normalWindows();
    const exact = windows.filter(window => window.get_title() === title);
    if (exact.length > 0)
        return exact;
    const stripped = title.replace(FIREFOX_SUFFIX, '');
    return windows.filter(window => isFirefoxWindow(window)
        && (window.get_title() ?? '').replace(FIREFOX_SUFFIX, '') === stripped);
}

function raiseFallbackFirefox() {
    const windows = normalWindows().filter(isFirefoxWindow);
    if (windows.length === 0)
        return {ok: false, reason: 'not-found'};
    if (windows.length === 1) {
        Main.activateWindow(windows[0]);
        return {ok: true, matched: 'firefox-single'};
    }
    const stacked = global.display.sort_windows_by_stacking(windows);
    let chosen = stacked[stacked.length - 1];
    let bestTime = chosen.get_user_time();
    for (const window of stacked) {
        const userTime = window.get_user_time();
        if (userTime > bestTime) {
            bestTime = userTime;
            chosen = window;
        }
    }
    Main.activateWindow(chosen);
    console.log('lyrics-overlay-raiser: no window title reported; raised most recent Firefox window');
    return {ok: true, matched: 'firefox-mru'};
}

export default class LyricsOverlayRaiserExtension extends Extension {
    enable() {
        if (this._exported || this._nameOwnerId || this._pending)
            this.disable();
        try {
            this._pending = null;
            this._exported = Gio.DBusExportedObject.wrapJSObject(IFACE_XML, {
                RaiseWindowAsync: (params, invocation) => this._raiseWindow(params, invocation),
            });
            this._exported.export(Gio.DBus.session, OBJECT_PATH);
            this._nameOwnerId = Gio.bus_own_name(
                Gio.BusType.SESSION,
                BUS_NAME,
                Gio.BusNameOwnerFlags.ALLOW_REPLACEMENT | Gio.BusNameOwnerFlags.REPLACE,
                null,
                null,
                null,
            );
        } catch (error) {
            this.disable();
            throw error;
        }
    }

    disable() {
        this._cancelPending('disabled');
        if (this._nameOwnerId) {
            Gio.bus_unown_name(this._nameOwnerId);
            this._nameOwnerId = 0;
        }
        if (this._exported) {
            this._exported.unexport();
            this._exported = null;
        }
    }

    _cancelPending(reason) {
        const pending = this._pending;
        if (!pending)
            return;
        this._pending = null;
        pending.cleanup();
        reply(pending.invocation, {ok: false, reason});
    }

    _raiseWindow([rawTitle], invocation) {
        this._cancelPending('replaced');
        const title = typeof rawTitle === 'string' ? rawTitle : '';
        if (!title) {
            reply(invocation, raiseFallbackFirefox());
            return;
        }

        const tryResolve = () => {
            const matches = matchByTitle(title);
            if (matches.length === 1) {
                Main.activateWindow(matches[0]);
                return {ok: true, matched: 'title'};
            }
            if (matches.length > 1) {
                console.log(`lyrics-overlay-raiser: ${matches.length} windows are titled "${title}"; not guessing which to raise`);
                return {ok: false, reason: 'ambiguous'};
            }
            return null;
        };

        const immediate = tryResolve();
        if (immediate) {
            reply(invocation, immediate);
            return;
        }

        const watched = new Set();
        let timeoutId = 0;
        const token = {};
        const cleanup = () => {
            if (timeoutId) {
                GLib.source_remove(timeoutId);
                timeoutId = 0;
            }
            global.display.disconnectObject(token);
            for (const window of watched)
                window.disconnectObject(token);
            watched.clear();
        };
        const finish = result => {
            if (this._pending?.token !== token)
                return;
            this._pending = null;
            cleanup();
            reply(invocation, result);
        };
        const watchWindow = window => {
            if (watched.has(window) || window.is_skip_taskbar() || window.get_window_type() !== Meta.WindowType.NORMAL)
                return;
            watched.add(window);
            window.connectObject('notify::title', () => {
                const resolved = tryResolve();
                if (resolved)
                    finish(resolved);
            }, token);
        };

        this._pending = {token, invocation, cleanup};
        for (const window of normalWindows())
            watchWindow(window);
        global.display.connectObject('window-created', (_display, window) => {
            watchWindow(window);
            const resolved = tryResolve();
            if (resolved)
                finish(resolved);
        }, token);
        timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RETITLE_WAIT_MS, () => {
            timeoutId = 0;
            console.log(`lyrics-overlay-raiser: no window is titled "${title}"`);
            finish({ok: false, reason: 'not-found'});
            return GLib.SOURCE_REMOVE;
        });
    }
}
