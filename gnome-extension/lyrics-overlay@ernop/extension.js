// Lyrics overlay for GNOME Shell: renders what the lyrics-overlay service
// decides. The service owns lookup, timing and per-song memory; this
// extension owns the indicator, the overlay and their look (GSettings).

import GLib from 'gi://GLib';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {LyricsIndicator} from './indicator.js';
import {LyricContextMenu} from './lyric-menu.js';
import {LyricsOverlay} from './overlay.js';
import {ServiceClient} from './service-client.js';

// The service's port in settings.example.json (tests/firefox-service-url.test.mjs).
const STATUS_PAGE_URI = 'http://lyrics.localhost:8792/';
// The browser retitles its window for the tab it just selected a moment
// after it answers; past this the title it named is not coming.
const RETITLE_WAIT_MS = 1000;

export default class LyricsOverlayExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        this._state = null;
        this._micRequested = false;
        this._cancelRaise = null;
        this._overlay = new LyricsOverlay({
            settings: this._settings,
            onClick: () => this._focusSong(),
            onContextMenu: point => this._lyricMenu.open(point),
        });
        this._client = new ServiceClient({
            onState: state => this._onState(state),
            onLine: line => this._overlay.setLine(line),
            onPitch: frames => this._overlay.pushPitch(frames),
        });
        const menuOptions = {
            settings: this._settings,
            client: this._client,
            overlay: this._overlay,
            statusPageUri: STATUS_PAGE_URI,
            focusSong: () => this._focusSong(),
        };
        this._indicator = new LyricsIndicator({path: this.path, ...menuOptions});
        this._lyricMenu = new LyricContextMenu(menuOptions);
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
        this._lyricMenu.destroy();
        this._indicator.destroy();
        this._overlay.destroy();
        this._lyricMenu = null;
        this._indicator = null;
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
        this._lyricMenu.setState(state);
        this._overlay.setPitchStatus(state?.pitch.error ? `Microphone stopped: ${state.pitch.error}` : '');
        this._sync();
    }

    _sync() {
        const state = this._state;
        const enabled = this._settings.get_boolean('overlay-enabled');
        const pitchEnabled = this._settings.get_boolean('pitch-enabled');
        const shown = enabled && Boolean(state?.active) && state.lyrics === 'timed';
        this._overlay.setShown(shown);
        this._overlay.setPitchShown(shown && pitchEnabled);
        const micWanted = shown && pitchEnabled && Boolean(state?.sounding);
        if (micWanted !== this._micRequested && state) {
            this._micRequested = micWanted;
            // Turning the trace or overlay off stops the microphone at once;
            // a pause or a song change lets it linger briefly.
            this._client.command({op: 'pitch', wanted: micWanted, immediate: !enabled || !pitchEnabled});
        }
    }

    /** Brings the playing tab forward in the browser, then raises its window. */
    async _focusSong() {
        const client = this._client;
        let result;
        try {
            result = await client.focusSong();
        } catch (error) {
            result = {ok: false, error: error.message};
        }
        if (this._client !== client)
            return;
        if (!result.ok) {
            console.log(`lyrics-overlay: could not go to the song: ${result.error}`);
            return;
        }
        this._raiseWindowTitled(result.windowTitle);
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
