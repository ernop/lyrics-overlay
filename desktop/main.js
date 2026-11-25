// Standalone XWayland desktop overlay for lyrics-overlay:
//   gjs -m desktop/main.js
//
// Runs as a normal restartable user process (lyrics-overlay-desktop.service),
// completely independent of GNOME Shell extension loading: changes apply in
// milliseconds with `systemctl --user restart lyrics-overlay-desktop.service`,
// with zero logout required.
//
// Renders:
// - the timed lyric line and quiet timing status pill (LyricWindow);
// - the optional sung-pitch trace panel (PitchWindow);
// - the system tray indicator (TraySni over org.kde.StatusNotifierItem) and,
//   when configured or when the panel hides AppIndicators, the standalone
//   panel-strip status button (TrayButton).

import Gdk from 'gi://Gdk?version=3.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GLibUnix from 'gi://GLibUnix';
import Gtk from 'gi://Gtk?version=3.0';
import System from 'system';

import {ServiceClient} from '../shared/service-client.js';
import {
    RAISER_BUS_NAME, notify, openCompiledSettings, panelHidesRightBox, raiseBrowser,
} from './desktop-actions.js';
import {LyricWindow} from './lyric-window.js';
import {MonitorManager} from './monitors.js';
import {PitchWindow} from './pitch-window.js';
import {ScoreWindow} from './score-window.js';
import {TrayButton} from './tray-button.js';
import {TraySni} from './tray-sni.js';

// Force GTK3 onto the X11 (XWayland) backend before Gtk.init() opens a display.
Gdk.set_allowed_backends('x11');
Gtk.init(null);

const SCHEMA_ID = 'org.gnome.shell.extensions.lyrics-overlay';
const SETTINGS_URI = 'http://localhost:8792/settings';
const DESKTOP_BUS_NAME = 'net.fuseki.LyricsOverlayDesktop';
const DESKTOP_OBJECT_PATH = '/net/fuseki/LyricsOverlayDesktop';

const DESKTOP_IFACE_XML = `
<node>
  <interface name="net.fuseki.LyricsOverlayDesktop1">
    <method name="GetStatus">
      <arg type="s" name="status" direction="out"/>
    </method>
  </interface>
</node>`;

const desktopDir = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const projectDir = GLib.path_get_dirname(desktopDir);
const schemaSourceDir = GLib.build_filenamev([projectDir, 'gnome-extension', 'lyrics-overlay@ernop', 'schemas']);
const iconsDir = GLib.build_filenamev([projectDir, 'gnome-extension', 'lyrics-overlay@ernop', 'icons']);

function log(message) {
    printerr(`lyrics-overlay-desktop: ${message}`);
}

class DesktopApp {
    constructor() {
        const runtimeDir = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'lyrics-overlay', 'desktop-schemas']);
        this._settings = openCompiledSettings(schemaSourceDir, runtimeDir, SCHEMA_ID);
        this._monitors = new MonitorManager();
        this._state = null;
        this._micRequested = false;
        this._hidesRightBox = panelHidesRightBox();
        this._raiserPresent = false;
        this._raiserWatchId = Gio.bus_watch_name(
            Gio.BusType.SESSION,
            RAISER_BUS_NAME,
            Gio.BusNameWatcherFlags.NONE,
            () => { this._raiserPresent = true; },
            () => { this._raiserPresent = false; },
        );

        this._pitchWindow = null;
        this._lyricWindow = new LyricWindow({
            settings: this._settings,
            monitors: this._monitors,
            onClick: () => this._focusSong(),
            onContextMenu: () => this._openSettings(),
            onBoxChanged: (box, monitorIndex) => this._pitchWindow?.setLyricBox(box, monitorIndex),
        });
        this._pitchWindow = new PitchWindow({
            settings: this._settings,
            monitors: this._monitors,
            onContextMenu: () => this._openSettings(),
        });
        this._pitchWindow.setLyricBox(this._lyricWindow.box, this._lyricWindow.monitorIndex);

        this._scoreWindow = new ScoreWindow({
            settings: this._settings,
            monitors: this._monitors,
            onOpenEditor: () => this._openScoreEditor(),
            onContextMenu: () => this._openSettings(),
            onEditScore: patch => this._client.command({op: 'editScore', patch}),
        });

        this._trayButton = new TrayButton({
            settings: this._settings,
            monitors: this._monitors,
            onOpenSettings: () => this._openSettings(),
        });
        this._traySni = new TraySni({
            iconsDir,
            settings: this._settings,
            onOpenSettings: () => this._openSettings(),
            onWatcherChanged: () => this._syncTrayMode(),
        });

        this._client = new ServiceClient({
            onState: state => this._onState(state),
            onLine: line => this._lyricWindow.setLine(line),
            onScore: payload => this._scoreWindow.setPayload(payload),
            onPitch: frames => this._pitchWindow.pushFrames(frames),
        });

        this._settingsIds = [
            this._settings.connect('changed::overlay-enabled', () => this._sync()),
            this._settings.connect('changed::pitch-enabled', () => this._sync()),
            this._settings.connect('changed::score-enabled', () => this._sync()),
            this._settings.connect('changed::tray-mode', () => this._syncTrayMode()),
        ];

        this._exported = Gio.DBusExportedObject.wrapJSObject(DESKTOP_IFACE_XML, {
            GetStatus: () => JSON.stringify(this._statusSnapshot()),
        });
        this._exported.export(Gio.DBus.session, DESKTOP_OBJECT_PATH);

        this._nameOwnerId = Gio.bus_own_name(
            Gio.BusType.SESSION,
            DESKTOP_BUS_NAME,
            Gio.BusNameOwnerFlags.ALLOW_REPLACEMENT | Gio.BusNameOwnerFlags.REPLACE,
            null,
            null,
            () => {
                log('lost D-Bus name (replaced by a newer instance or session ended); stopping');
                Gtk.main_quit();
            },
        );

        this._syncTrayMode();
        this._client.start();
        this._sync();
        log(`ready on ${Gdk.Display.get_default().constructor.$gtype.name} (${this._monitors.count} monitor${this._monitors.count === 1 ? '' : 's'})`);
    }

    shutdown() {
        if (this._micRequested) {
            this._client.command({op: 'pitch', wanted: false, immediate: true});
            this._micRequested = false;
        }
        this._client.stop();
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        if (this._raiserWatchId) {
            Gio.bus_unwatch_name(this._raiserWatchId);
            this._raiserWatchId = 0;
        }
        if (this._nameOwnerId) {
            Gio.bus_unown_name(this._nameOwnerId);
            this._nameOwnerId = 0;
        }
        if (this._exported) {
            this._exported.unexport();
            this._exported = null;
        }
        this._traySni.destroy();
        this._trayButton.destroy();
        this._scoreWindow.destroy();
        this._pitchWindow.destroy();
        this._lyricWindow.destroy();
    }

    _statusSnapshot() {
        return {
            active: Boolean(this._state?.active),
            lyrics: this._state?.lyrics ?? 'none',
            overlayEnabled: this._settings.get_boolean('overlay-enabled'),
            pitchEnabled: this._settings.get_boolean('pitch-enabled'),
            scoreEnabled: this._settings.get_boolean('score-enabled'),
            scoreVisible: this._scoreWindow.visible,
            scoreBox: this._scoreWindow.box,
            scoreConfigVisible: this._scoreWindow.configVisible,
            trayMode: this._settings.get_string('tray-mode'),
            lyricVisible: this._lyricWindow.visible,
            lyricBox: this._lyricWindow.renderBox,
            savedBox: this._lyricWindow.box,
            inkBox: this._lyricWindow.inkBox,
            statusVisible: this._lyricWindow.statusVisible,
            pitchVisible: this._pitchWindow.visible,
            pitchBox: this._pitchWindow.box,
            traySniWatcher: this._traySni.watcherPresent,
            traySniActive: this._traySni.registered,
            trayButtonVisible: this._trayButton.visible,
            trayButtonBox: this._trayButton.box,
            windowRaiserActive: this._raiserPresent,
            monitorCount: this._monitors.count,
        };
    }

    _syncTrayMode() {
        const mode = this._settings.get_string('tray-mode');
        const wantSni = mode === 'auto' || mode === 'sni' || mode === 'both';
        const wantButton = mode === 'panel-button' || mode === 'both'
            || (mode === 'auto' && (!this._traySni.watcherPresent || this._hidesRightBox));
        this._traySni.setEnabled(wantSni);
        this._trayButton.setEnabled(wantButton);
    }

    _onState(state) {
        this._state = state;
        if (state === null)
            this._micRequested = false;
        const active = Boolean(state?.active);
        this._traySni.setActive(active);
        this._trayButton.setActive(active);
        this._pitchWindow.setStatus(state?.pitch?.error ? `Microphone stopped: ${state.pitch.error}` : '');
        this._pitchWindow.setSongKey(state?.key ?? null);
        this._scoreWindow.setSongKey(state?.key ?? null);
        this._sync();
    }

    _sync() {
        const state = this._state;
        const enabled = this._settings.get_boolean('overlay-enabled');
        const pitchEnabled = this._settings.get_boolean('pitch-enabled');
        const scoreEnabled = this._settings.get_boolean('score-enabled');
        const active = Boolean(state?.active);
        const generating = state?.lyrics === 'generating';
        const showStatus = generating && !state.generation?.previewing;
        const statusMsg = showStatus ? (state.generation?.message || 'Timing lyrics\u2026') : '';
        this._lyricWindow.setStatus(statusMsg);
        this._lyricWindow.setShown(enabled && active && (state.lyrics === 'timed' || generating));

        const pitchShown = enabled && pitchEnabled && active;
        this._pitchWindow.setShown(pitchShown);

        const scoreShown = enabled && scoreEnabled && active;
        this._scoreWindow.setShown(scoreShown);

        const micWanted = enabled && pitchEnabled && active && Boolean(state?.sounding);
        if (micWanted !== this._micRequested && state) {
            this._micRequested = micWanted;
            this._client.command({op: 'pitch', wanted: micWanted, immediate: !enabled || !pitchEnabled});
        }
    }

    async _focusSong() {
        let result;
        try {
            result = await this._client.focusSong();
        } catch (error) {
            result = {ok: false, error: error.message};
        }
        if (!result.ok) {
            log(`could not go to the song: ${result.error}`);
            return;
        }
        raiseBrowser(result.windowTitle);
    }

    async _openSettings() {
        let result;
        try {
            result = await this._client.openSettings();
        } catch (error) {
            result = {ok: false, error: error.message};
        }
        if (!result.ok) {
            const why = `${result.error[0].toUpperCase()}${result.error.slice(1)}`;
            notify('Lyrics overlay settings did not open', `${why}. The page is ${SETTINGS_URI}`);
            return;
        }
        raiseBrowser(result.windowTitle);
    }

    _openScoreEditor() {
        const uri = `${SETTINGS_URI}?score=1`;
        try {
            Gio.AppInfo.launch_default_for_uri(uri, null);
        } catch {
            this._openSettings();
        }
    }
}

const app = new DesktopApp();
for (const sig of [2, 15]) {
    GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, sig, () => {
        Gtk.main_quit();
        return GLib.SOURCE_REMOVE;
    });
}

Gtk.main();
app.shutdown();
if (!Gio.DBus.session.is_closed())
    Gio.DBus.session.flush_sync(null);
System.exit(0);
