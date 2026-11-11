// Panel indicator, shown only while a YouTube song plays: a note, crossed
// out while the overlay is off. A left press turns the overlay on or off;
// a right press opens the settings page.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import St from 'gi://St';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

export const LyricsIndicator = GObject.registerClass(
class LyricsIndicator extends PanelMenu.Button {
    /**
     * @param {{path: string, settings: Gio.Settings, openSettings: () => void}} options
     */
    _init({path, settings, openSettings}) {
        super._init(0.5, 'Lyrics overlay', true);
        this._settings = settings;
        this._active = false;
        this._icons = {
            on: Gio.icon_new_for_string(`${path}/icons/lyrics-on-symbolic.svg`),
            off: Gio.icon_new_for_string(`${path}/icons/lyrics-off-symbolic.svg`),
        };
        this._icon = new St.Icon({style_class: 'system-status-icon'});
        this.add_child(this._icon);

        const toggle = new Clutter.ClickGesture({required_button: Clutter.BUTTON_PRIMARY, recognize_on_press: true});
        toggle.connect('recognize', () => settings.set_boolean('overlay-enabled', !settings.get_boolean('overlay-enabled')));
        this.add_action(toggle);
        const settingsPress = new Clutter.ClickGesture({required_button: Clutter.BUTTON_SECONDARY, recognize_on_press: true});
        settingsPress.connect('recognize', () => openSettings());
        this.add_action(settingsPress);

        settings.connectObject('changed::overlay-enabled', () => this._sync(), this);
        this._sync();
    }

    /** @param {object|null} state the service's state */
    setState(state) {
        this._active = Boolean(state?.active);
        this._sync();
    }

    _sync() {
        this._icon.gicon = this._icons[this._settings.get_boolean('overlay-enabled') ? 'on' : 'off'];
        this.visible = this._active;
    }

    _onDestroy() {
        this._settings.disconnectObject(this);
        super._onDestroy();
    }
});
