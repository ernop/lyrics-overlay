// Standard org.kde.StatusNotifierItem tray indicator over session D-Bus.
// Works out of the box on KDE Plasma, Hyprland/Waybar, Sway, XFCE, and
// stock GNOME with AppIndicator support.
//
// Shows only while a YouTube song is active; left-click (Activate) toggles
// overlay-enabled; right-click (SecondaryActivate / ContextMenu) opens the
// settings page.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {loadSvgPixbuf, pixbufToSniArgb32} from './desktop-actions.js';

const WATCHER_NAME = 'org.kde.StatusNotifierWatcher';
const WATCHER_PATH = '/StatusNotifierWatcher';
const WATCHER_IFACE = 'org.kde.StatusNotifierWatcher';
const ITEM_PATH = '/StatusNotifierItem';

const SNI_XML = `
<node>
  <interface name="org.kde.StatusNotifierItem">
    <property name="Category" type="s" access="read"/>
    <property name="Id" type="s" access="read"/>
    <property name="Title" type="s" access="read"/>
    <property name="Status" type="s" access="read"/>
    <property name="WindowId" type="i" access="read"/>
    <property name="IconThemePath" type="s" access="read"/>
    <property name="IconName" type="s" access="read"/>
    <property name="IconPixmap" type="a(iiay)" access="read"/>
    <property name="AttentionIconName" type="s" access="read"/>
    <property name="AttentionIconPixmap" type="a(iiay)" access="read"/>
    <property name="OverlayIconName" type="s" access="read"/>
    <property name="OverlayIconPixmap" type="a(iiay)" access="read"/>
    <property name="ToolTip" type="(sa(iiay)ss)" access="read"/>
    <property name="ItemIsMenu" type="b" access="read"/>
    <property name="Menu" type="o" access="read"/>
    <method name="ContextMenu">
      <arg type="i" name="x" direction="in"/>
      <arg type="i" name="y" direction="in"/>
    </method>
    <method name="Activate">
      <arg type="i" name="x" direction="in"/>
      <arg type="i" name="y" direction="in"/>
    </method>
    <method name="SecondaryActivate">
      <arg type="i" name="x" direction="in"/>
      <arg type="i" name="y" direction="in"/>
    </method>
    <method name="Scroll">
      <arg type="i" name="delta" direction="in"/>
      <arg type="s" name="orientation" direction="in"/>
    </method>
    <signal name="NewTitle"/>
    <signal name="NewIcon"/>
    <signal name="NewAttentionIcon"/>
    <signal name="NewOverlayIcon"/>
    <signal name="NewToolTip"/>
    <signal name="NewStatus">
      <arg type="s" name="status"/>
    </signal>
  </interface>
</node>`;

export class TraySni {
    /**
     * @param {{iconsDir: string, settings: Gio.Settings, onOpenSettings: () => void,
     *          onWatcherChanged?: (present: boolean) => void}} options
     */
    constructor({iconsDir, settings, onOpenSettings, onWatcherChanged = () => {}}) {
        this._iconsDir = iconsDir;
        this._settings = settings;
        this._onOpenSettings = onOpenSettings;
        this._onWatcherChanged = onWatcherChanged;
        this._enabled = true;
        this._active = false;
        this._watcherPresent = false;
        this._exported = null;
        this._registered = false;

        this._pixmaps = {
            on: pixbufToSniArgb32(loadSvgPixbuf(`${iconsDir}/lyrics-on-symbolic.svg`, 24)),
            off: pixbufToSniArgb32(loadSvgPixbuf(`${iconsDir}/lyrics-off-symbolic.svg`, 24)),
        };

        this._settingsId = settings.connect('changed::overlay-enabled', () => this._emitIconChanged());
        this._watchId = Gio.bus_watch_name(
            Gio.BusType.SESSION,
            WATCHER_NAME,
            Gio.BusNameWatcherFlags.NONE,
            () => {
                this._watcherPresent = true;
                this._onWatcherChanged(true);
                this._syncRegistration();
            },
            () => {
                this._watcherPresent = false;
                this._registered = false;
                this._onWatcherChanged(false);
            },
        );
    }

    get watcherPresent() {
        return this._watcherPresent;
    }

    get registered() {
        return this._registered;
    }

    setEnabled(enabled) {
        if (this._enabled === enabled)
            return;
        this._enabled = enabled;
        this._syncRegistration();
    }

    setActive(active) {
        const next = Boolean(active);
        if (this._active === next)
            return;
        this._active = next;
        this._syncRegistration();
    }

    destroy() {
        if (this._watchId) {
            Gio.bus_unwatch_name(this._watchId);
            this._watchId = 0;
        }
        if (this._settingsId) {
            this._settings.disconnect(this._settingsId);
            this._settingsId = 0;
        }
        this._unexport();
    }

    _syncRegistration() {
        const want = this._enabled && this._active && this._watcherPresent;
        if (want) {
            this._ensureExported();
            if (!this._registered)
                this._registerWithWatcher();
        } else {
            this._unexport();
        }
    }

    _isOn() {
        return this._settings.get_boolean('overlay-enabled');
    }

    _ensureExported() {
        if (this._exported)
            return;
        const self = this;
        const impl = {
            get Category() {
                return 'ApplicationStatus';
            },
            get Id() {
                return 'lyrics-overlay';
            },
            get Title() {
                return 'Lyrics overlay';
            },
            get Status() {
                return 'Active';
            },
            get WindowId() {
                return 0;
            },
            get IconThemePath() {
                return self._iconsDir;
            },
            get IconName() {
                return self._isOn() ? 'lyrics-on-symbolic' : 'lyrics-off-symbolic';
            },
            get IconPixmap() {
                const pm = self._isOn() ? self._pixmaps.on : self._pixmaps.off;
                return [[pm.width, pm.height, pm.bytes]];
            },
            get AttentionIconName() {
                return '';
            },
            get AttentionIconPixmap() {
                return [];
            },
            get OverlayIconName() {
                return '';
            },
            get OverlayIconPixmap() {
                return [];
            },
            get ToolTip() {
                return ['', [], 'Lyrics overlay', self._isOn() ? 'On (click to hide, right-click for settings)' : 'Off (click to show, right-click for settings)'];
            },
            get ItemIsMenu() {
                return false;
            },
            get Menu() {
                return '/NO_DBUSMENU';
            },
            Activate(_x, _y) {
                self._settings.set_boolean('overlay-enabled', !self._isOn());
            },
            SecondaryActivate(_x, _y) {
                self._onOpenSettings();
            },
            ContextMenu(_x, _y) {
                self._onOpenSettings();
            },
            Scroll(_delta, _orientation) {},
        };
        this._exported = Gio.DBusExportedObject.wrapJSObject(SNI_XML, impl);
        this._exported.export(Gio.DBus.session, ITEM_PATH);
    }

    _registerWithWatcher() {
        const uniqueName = Gio.DBus.session.get_unique_name();
        if (!uniqueName)
            return;
        this._registered = true;
        Gio.DBus.session.call(
            WATCHER_NAME,
            WATCHER_PATH,
            WATCHER_IFACE,
            'RegisterStatusNotifierItem',
            new GLib.Variant('(s)', [ITEM_PATH]),
            null,
            Gio.DBusCallFlags.NONE,
            2000,
            null,
            (conn, res) => {
                try {
                    conn.call_finish(res);
                } catch {
                    this._registered = false;
                }
            },
        );
    }

    _emitIconChanged() {
        if (!this._exported)
            return;
        this._exported.emit_signal('NewIcon', null);
        this._exported.emit_signal('NewToolTip', null);
    }

    _unexport() {
        this._registered = false;
        if (this._exported) {
            this._exported.unexport();
            this._exported = null;
        }
    }
}
