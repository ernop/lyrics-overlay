// Lyrics overlay for GNOME Shell: renders what the lyrics-overlay service
// decides. The service owns lookup, timing, the microphone and per-song
// memory; this extension owns the indicator, the lyric and the pitch panel,
// drawn as the settings (GSettings) say. A right press on any of the three
// shows the settings page, which is the browser's one settings tab.

import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {LyricsIndicator} from './indicator.js';
import {LyricsOverlay} from './overlay.js';
import {PitchPanel} from './pitch-panel.js';
import {ServiceClient} from './service-client.js';

// The page the browser extension opens, on the service's port in
// settings.example.json (tests/firefox-service-url.test.mjs).
const SETTINGS_URI = 'http://localhost:8792/settings';
// The browser retitles its window for the tab it just selected a moment
// after it answers; past this the title it named is not coming.
const RETITLE_WAIT_MS = 1000;

export default class LyricsOverlayExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._state = null;
        this._micRequested = false;
        this._cancelRaise = null;
        this._pitchPanel = null;
        this._overlay = new LyricsOverlay({
            settings: this._settings,
            onClick: () => this._focusSong(),
            onContextMenu: () => this._openSettings(),
            onBoxChanged: (box, monitorIndex) => this._pitchPanel?.setLyricBox(box, monitorIndex),
        });
        this._pitchPanel = new PitchPanel({settings: this._settings, onContextMenu: () => this._openSettings()});
        this._pitchPanel.setLyricBox(this._overlay.box, this._overlay.monitorIndex);
        this._client = new ServiceClient({
            onState: state => this._onState(state),
            onLine: line => this._overlay.setLine(line),
            onPitch: frames => this._pitchPanel.pushFrames(frames),
        });
        this._indicator = new LyricsIndicator({
            path: this.path, settings: this._settings, openSettings: () => this._openSettings(),
        });
        // The owner's Dash to Panel hides the right box and shows the center
        // box at the bottom right, just left of the system menu: that is the
        // tray (Resource Monitor is placed there too). Appending puts the
        // indicator beside the system menu; on a stock panel it follows the
        // clock. Where Dash to Panel is installed, the shell e2e test fails
        // if its live layout stops showing this box there.
        Main.panel.addToStatusArea(this.uuid, this._indicator, -1, 'center');
        this._settings.connectObject(
            'changed::overlay-enabled', () => this._sync(),
            'changed::pitch-enabled', () => this._sync(), this);
        this._client.start();
        this._sync();
    }

    disable() {
        this._settings.disconnectObject(this);
        this._cancelRaise?.();
        if (this._micRequested)
            this._client.command({op: 'pitch', wanted: false, immediate: true});
        this._client.stop();
        this._indicator.destroy();
        this._pitchPanel.destroy();
        this._overlay.destroy();
        this._indicator = null;
        this._pitchPanel = null;
        this._overlay = null;
        this._client = null;
        this._settings = null;
        this._state = null;
    }

    _onState(state) {
        this._state = state;
        // A restarted service has forgotten the microphone request.
        if (state === null)
            this._micRequested = false;
        this._indicator.setState(state);
        this._pitchPanel.setStatus(state?.pitch.error ? `Microphone stopped: ${state.pitch.error}` : '');
        this._pitchPanel.setSongKey(state?.key ?? null);
        this._sync();
    }

    _sync() {
        const state = this._state;
        const enabled = this._settings.get_boolean('overlay-enabled');
        const pitchEnabled = this._settings.get_boolean('pitch-enabled');
        const active = Boolean(state?.active);
        this._overlay.setShown(enabled && active && state.lyrics === 'timed');
        // The panel does not need timed lyrics: singing along to a song
        // without them still shows the pitch.
        const pitchShown = enabled && pitchEnabled && active;
        this._pitchPanel.setShown(pitchShown);
        const micWanted = pitchShown && Boolean(state?.sounding);
        if (micWanted !== this._micRequested && state) {
            this._micRequested = micWanted;
            // Turning the panel or overlay off stops the microphone at once;
            // a pause or a song change lets it linger briefly.
            this._client.command({op: 'pitch', wanted: micWanted, immediate: !enabled || !pitchEnabled});
        }
    }

    /** Brings the playing tab forward in the browser, then raises its window. */
    async _focusSong() {
        const result = await this._ask(client => client.focusSong());
        if (!result)
            return;
        if (!result.ok) {
            console.log(`lyrics-overlay: could not go to the song: ${result.error}`);
            return;
        }
        this._raiseWindowTitled(result.windowTitle);
    }

    /** Shows the browser's one settings tab, then raises its window. */
    async _openSettings() {
        const result = await this._ask(client => client.openSettings());
        if (!result)
            return;
        if (!result.ok) {
            const why = `${result.error[0].toUpperCase()}${result.error.slice(1)}`;
            Main.notify('Lyrics overlay settings did not open', `${why}. The page is ${SETTINGS_URI}`);
            return;
        }
        this._raiseWindowTitled(result.windowTitle);
    }

    /** @returns {Promise<object|null>} the service's answer, or null when the extension went away meanwhile */
    async _ask(call) {
        const client = this._client;
        let result;
        try {
            result = await call(client);
        } catch (error) {
            result = {ok: false, error: error.message};
        }
        return this._client === client ? result : null;
    }

    _raiseWindowTitled(title) {
        this._cancelRaise?.();
        const raise = () => {
            const matches = global.display.list_all_windows().filter(window => window.get_title() === title);
            if (matches.length > 1)
                console.log(`lyrics-overlay: ${matches.length} windows are titled "${title}"; not guessing which to raise`);
            else if (matches.length === 1)
                Main.activateWindow(matches[0]);
            return matches.length > 0;
        };
        if (raise())
            return;
        const windows = global.display.list_all_windows();
        let timeoutId = 0;
        const disconnect = () => {
            for (const window of windows)
                window.disconnectObject(this);
            this._cancelRaise = null;
        };
        this._cancelRaise = () => {
            disconnect();
            GLib.source_remove(timeoutId);
        };
        for (const window of windows) {
            window.connectObject('notify::title', () => {
                if (raise())
                    this._cancelRaise();
            }, this);
        }
        timeoutId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RETITLE_WAIT_MS, () => {
            console.log(`lyrics-overlay: no window is titled "${title}"`);
            disconnect();
            return GLib.SOURCE_REMOVE;
        });
    }
}
