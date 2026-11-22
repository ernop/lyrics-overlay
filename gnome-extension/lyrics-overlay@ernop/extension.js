// Lyrics overlay for GNOME Shell: renders what the lyrics-overlay service
// decides. The service owns lookup, timing, the microphone and per-song
// memory; this extension owns the indicator, the lyric and the pitch panel,
// drawn as the settings (GSettings) say. A right press on any of the three
// shows the settings page, which is the browser's one settings tab.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {LyricsIndicator} from './indicator.js';
import {LyricsOverlay} from './overlay.js';
import {PitchPanel} from './pitch-panel.js';
import {ServiceClient} from './shared/service-client.js';

// The page the browser extension opens, on the service's port in
// settings.example.json (tests/firefox-service-url.test.mjs).
const SETTINGS_URI = 'http://localhost:8792/settings';
// The browser retitles its window for the tab it just selected a moment
// after it answers; past this the title it named is not coming.
const RETITLE_WAIT_MS = 1000;
const FIREFOX_SUFFIX = / [\u2014-] Mozilla Firefox$/u;

function isFirefoxWindow(window) {
    const wmClass = window.get_wm_class() ?? '';
    const wmInstance = window.get_wm_class_instance() ?? '';
    return /firefox/iu.test(wmClass) || /firefox/iu.test(wmInstance);
}

function matchWindowsByTitle(title) {
    const windows = global.display.list_all_windows().filter(
        window => !window.is_skip_taskbar() && window.get_window_type() === Meta.WindowType.NORMAL,
    );
    const exact = windows.filter(window => window.get_title() === title);
    if (exact.length > 0) {
        const exactFirefox = exact.filter(isFirefoxWindow);
        return exactFirefox.length > 0 ? exactFirefox : exact;
    }
    const stripped = title.replace(FIREFOX_SUFFIX, '');
    return windows.filter(window => isFirefoxWindow(window)
        && (window.get_title() ?? '').replace(FIREFOX_SUFFIX, '') === stripped);
}

function pickMostRecentWindow(windows) {
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
    return chosen;
}

export default class LyricsOverlayExtension extends Extension {
    enable() {
        if (this._settings || this._overlay || this._client || this._indicator || this._pitchPanel)
            this.disable();
        if (Main.panel.statusArea[this.uuid])
            Main.panel.statusArea[this.uuid].destroy();
        try {
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
            const client = new ServiceClient({
                onState: state => {
                    if (this._client === client)
                        this._onState(state);
                },
                onLine: line => {
                    if (this._client === client)
                        this._overlay?.setLine(line);
                },
                onPitch: frames => {
                    if (this._client === client)
                        this._pitchPanel?.pushFrames(frames);
                },
            });
            this._client = client;
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
        } catch (error) {
            this.disable();
            throw error;
        }
    }

    disable() {
        this._settings?.disconnectObject(this);
        this._cancelRaise?.();
        this._cancelRaise = null;
        if (this._micRequested && this._client)
            this._client.command({op: 'pitch', wanted: false, immediate: true});
        this._micRequested = false;
        this._client?.stop();
        this._indicator?.destroy();
        this._pitchPanel?.destroy();
        this._overlay?.destroy();
        this._indicator = null;
        this._pitchPanel = null;
        this._overlay = null;
        this._client = null;
        this._settings = null;
        this._state = null;
    }

    _onState(state) {
        if (!this._indicator || !this._pitchPanel || !this._overlay)
            return;
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
        if (!this._settings || !this._overlay || !this._pitchPanel)
            return;
        const state = this._state;
        const enabled = this._settings.get_boolean('overlay-enabled');
        const pitchEnabled = this._settings.get_boolean('pitch-enabled');
        const active = Boolean(state?.active);
        const generating = state?.lyrics === 'generating';
        const showStatus = generating && !state.generation?.previewing;
        this._overlay.setStatus(showStatus ? (state.generation?.message || 'Timing lyrics\u2026') : '');
        this._overlay.setShown(enabled && active && (state.lyrics === 'timed' || generating));
        // The panel does not need timed lyrics: singing along to a song
        // without them still shows the pitch.
        const pitchShown = enabled && pitchEnabled && active;
        this._pitchPanel.setShown(pitchShown);
        const micWanted = enabled && pitchEnabled && active && Boolean(state?.sounding);
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
        if (!title)
            return;
        const raise = () => {
            const matches = matchWindowsByTitle(title);
            if (matches.length === 1)
                Main.activateWindow(matches[0]);
            else if (matches.length > 1) {
                Main.activateWindow(pickMostRecentWindow(matches));
                console.log(`lyrics-overlay: ${matches.length} windows match "${title}"; raised most recent`);
            }
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
