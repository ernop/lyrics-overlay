// Panel indicator, shown only while a YouTube song plays. A left press
// toggles the overlay; a right press opens the menu: the overlay and pitch
// trace switches, the song and its lyric sets, timing nudges, and the
// overlay's look. The same menu contents open
// at the pointer on a right press on the lyric (lyric-menu.js). Menu
// controls act on press and leave the menu open, so choices can be
// compared on the live overlay.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import PangoCairo from 'gi://PangoCairo';
import St from 'gi://St';
import {ensureActorVisibleInScrollView} from 'resource:///org/gnome/shell/misc/animationUtils.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import {LYRICS_STATUS_TEXT} from './shared/lyrics-status.js';
import {TEXT_COLORS, hexColor, ringColors} from './shared/text-ink.js';
import {SizeSlider} from './size-slider.js';

/** Lyrics states in which nothing can be shown; the icon loses its lines. */
const NOTHING_TO_SHOW = new Set(['none', 'plain', 'error', 'not-music']);

const COLOR_LABELS = Object.freeze({
    'white': 'White', 'yellow': 'Yellow', 'orange': 'Orange', 'red': 'Red', 'pink': 'Pink', 'magenta': 'Magenta',
    'purple': 'Purple', 'blue': 'Blue', 'cyan': 'Cyan', 'green': 'Green', 'black': 'Black',
});

const BORDER_LABELS = Object.freeze({
    'double': 'Double',
    'single': 'Single',
    'none': 'None',
});

const ALIGN_LABELS = Object.freeze({
    'center': 'Centered',
    'left': 'Left',
});

const TRANSITION_LABELS = Object.freeze({
    'instant': 'Instant',
    'fade-in': 'Fade in, 0.15 s',
    'crossfade-quick': 'Crossfade, 0.12 s',
    'crossfade-soft': 'Crossfade, 0.25 s',
});

// Text families worth offering, by kind; the menu lists those installed. The
// rest of a typical install is per-script Noto, math and symbol fonts, which
// cannot set a Latin lyric, and copies of these under other names (Nerd Font
// and Powerline builds, single-weight names such as "Quicksand Light").
const STANDARD_FAMILIES = Object.freeze({
    sans: Object.freeze([
        'Ubuntu Sans', 'Ubuntu', 'Noto Sans', 'Noto Sans Display', 'DejaVu Sans', 'Liberation Sans', 'Liberation Sans Narrow',
        'Nimbus Sans', 'Nimbus Sans Narrow', 'FreeSans', 'URW Gothic', 'Cantarell', 'Adwaita Sans', 'Inter', 'Inter Display',
        'Roboto', 'Roboto Condensed', 'Open Sans', 'Open Sans Condensed', 'Lato', 'Fira Sans', 'Source Sans 3',
        'IBM Plex Sans', 'IBM Plex Sans Condensed', 'PT Sans', 'PT Sans Narrow', 'PT Sans Caption', 'Atkinson Hyperlegible',
        'Andika', 'B612', 'Carlito', 'Montserrat', 'Montserrat Alternates', 'Manrope', 'League Spartan', 'Quicksand',
        'Comfortaa', 'Dosis', 'Linux Biolinum O', 'Bebas Neue', 'Arial', 'Helvetica', 'Verdana',
    ]),
    serif: Object.freeze([
        'Noto Serif', 'Noto Serif Display', 'DejaVu Serif', 'Liberation Serif', 'Nimbus Roman', 'FreeSerif', 'C059', 'P052',
        'URW Bookman', 'EB Garamond', 'Merriweather', 'IBM Plex Serif', 'PT Serif', 'PT Serif Caption', 'Roboto Slab',
        'Charis SIL', 'Gentium Plus', 'Gentium Book Plus', 'Caladea', 'Linux Libertine O', 'Linux Libertine Display O',
        'Georgia', 'Times New Roman',
    ]),
    monospace: Object.freeze([
        'Ubuntu Mono', 'Ubuntu Sans Mono', 'DejaVu Sans Mono', 'Noto Sans Mono', 'Noto Mono', 'Liberation Mono',
        'Nimbus Mono PS', 'FreeMono', 'Fira Code', 'JetBrains Mono', 'IBM Plex Mono', 'Cascadia Code', 'Cascadia Mono',
        'Hack', 'Inconsolata', 'mononoki', 'PT Mono', 'B612 Mono', 'Linux Libertine Mono O',
    ]),
    script: Object.freeze(['Z003']),
});

/** The installed families of each kind; kinds with none installed are left out. */
function installedStandardFamilies() {
    const installed = new Set(PangoCairo.FontMap.get_default().list_families().map(family => family.get_name()));
    return Object.values(STANDARD_FAMILIES)
        .map(families => families.filter(family => installed.has(family)))
        .filter(families => families.length > 0);
}

function formatOffset(seconds) {
    if (seconds === 0)
        return '0.0 s';
    return `${seconds > 0 ? '+' : '\u2212'}${Math.abs(seconds).toFixed(1)} s`;
}

function statusText(state) {
    const status = LYRICS_STATUS_TEXT[state.lyrics];
    if (!state.chosen)
        return status;
    return `${status}${state.userChose ? ', your choice' : ''}: ${state.chosen.label}`;
}

/** Runs onPress when the item is pressed or activated from the keyboard. */
function onPress(actor, handler) {
    const gesture = new Clutter.ClickGesture({recognize_on_press: true});
    gesture.connect('recognize', () => handler());
    actor.add_action(gesture);
    actor.connect('key-press-event', (_actor, event) => {
        const symbol = event.get_key_symbol();
        if (symbol !== Clutter.KEY_space && symbol !== Clutter.KEY_Return && symbol !== Clutter.KEY_KP_Enter)
            return Clutter.EVENT_PROPAGATE;
        handler();
        return Clutter.EVENT_STOP;
    });
    return actor;
}

function actionItem(text, handler) {
    return onPress(new PopupMenu.PopupMenuItem(text, {activate: false}), handler);
}

function infoItem(text, styleClass = null) {
    const item = new PopupMenu.PopupMenuItem(text, {activate: false, hover: false, can_focus: false});
    if (styleClass)
        item.label.add_style_class_name(styleClass);
    return item;
}

function switchItem(text, active, handler) {
    const item = new PopupMenu.PopupSwitchMenuItem(text, active, {activate: false});
    return onPress(item, () => {
        item.toggle();
        handler(item.state);
    });
}

function pressButton(text, handler) {
    return onPress(new St.Bin({
        style_class: 'button lyrics-overlay-button',
        reactive: true,
        can_focus: true,
        track_hover: true,
        y_align: Clutter.ActorAlign.CENTER,
        child: new St.Label({text}),
    }), handler);
}

function submenuItem(text = '') {
    const item = new PopupMenu.PopupSubMenuMenuItem(text);
    item._clickGesture.recognize_on_press = true;
    // The menu body scrolls as one (ScrollingSection). A submenu that
    // scrolled on its own, as GNOME's do once the menu reaches its
    // max-height, would get only the room the other rows leave: a row or two.
    item.menu._needsScrollbar = () => false;
    return item;
}

/**
 * A section whose items scroll once the menu reaches its max-height, so the
 * menu fits any screen and any opening point. The menu tracks a section
 * through its actor's _delegate, as it does GNOME's scrolling submenus.
 */
class ScrollingSection extends PopupMenu.PopupMenuSection {
    constructor() {
        super();
        this.actor = new St.ScrollView({
            hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.AUTOMATIC,
            overlay_scrollbars: true,
            child: this.box,
        });
        this.actor._delegate = this;
        this.actor.clip_to_allocation = true;
        global.stage.connectObject('notify::key-focus', () => {
            const focus = global.stage.get_key_focus();
            if (focus && this.box.contains(focus))
                ensureActorVisibleInScrollView(this.actor, focus);
        }, this);
        this.actor.connect('destroy', () => global.stage.disconnectObject(this));
    }
}

/** A square of a letter color, ringed like the lyric so black and white both show on any menu. */
function colorSwatch(rgb) {
    return new St.Widget({
        style_class: 'lyrics-overlay-swatch',
        style: `background-color: ${hexColor(rgb)}; border-color: ${hexColor(ringColors(rgb).inner)};`,
        y_align: Clutter.ActorAlign.CENTER,
    });
}

export class LyricsMenu {
    /**
     * @param {{menu: PopupMenu.PopupMenu, settings: Gio.Settings,
     *          client: import('./service-client.js').ServiceClient,
     *          overlay: import('./overlay.js').LyricsOverlay, statusPageUri: string,
     *          focusSong: () => void}} options
     */
    constructor({menu, settings, client, overlay, statusPageUri, focusSong}) {
        this._menu = menu;
        this._settings = settings;
        this._client = client;
        this._overlay = overlay;
        this._setsSignature = '';
        menu.actor.add_style_class_name('lyrics-overlay-menu');
        const body = new ScrollingSection();
        menu.addMenuItem(body);

        this._enabledItem = switchItem('Lyrics overlay', settings.get_boolean('overlay-enabled'),
            state => settings.set_boolean('overlay-enabled', state));
        body.addMenuItem(this._enabledItem);
        this._pitchItem = switchItem('Pitch trace from the microphone', settings.get_boolean('pitch-enabled'),
            state => settings.set_boolean('pitch-enabled', state));
        body.addMenuItem(this._pitchItem);

        this._songSection = new PopupMenu.PopupMenuSection();
        this._identityItem = infoItem('', 'lyrics-overlay-identity');
        this._statusItem = infoItem('');
        this._micItem = infoItem('');
        this._micErrorItem = infoItem('');
        this._timingItem = this._buildTimingRow();
        this._setsItem = submenuItem();
        this._goToItem = actionItem('Go to the song in Firefox', () => {
            menu.close();
            focusSong();
        });
        this._wrongItem = actionItem('Wrong lyrics: hide this set', () => client.command({op: 'reject'}));
        this._searchItem = actionItem('Search again', () => client.command({op: 'searchAgain'}));
        this._lookUpItem = actionItem('Look up lyrics for this video', () => client.command({op: 'lookUp'}));
        for (const item of [new PopupMenu.PopupSeparatorMenuItem(), this._identityItem, this._statusItem,
            this._micItem, this._micErrorItem, this._timingItem, this._setsItem, this._goToItem, this._wrongItem,
            this._searchItem, this._lookUpItem])
            this._songSection.addMenuItem(item);
        body.addMenuItem(this._songSection);

        body.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        body.addMenuItem(this._buildSizeRow());
        this._fontItem = this._buildFontMenu();
        body.addMenuItem(this._fontItem);
        this._colorItem = this._buildChoiceMenu('text-color', COLOR_LABELS, 'Color');
        for (const [value, choice] of this._colorItem.choices)
            choice.insert_child_below(colorSwatch(TEXT_COLORS[value]), choice.label);
        body.addMenuItem(this._colorItem.item);
        this._borderItem = this._buildChoiceMenu('text-border', BORDER_LABELS, 'Border');
        body.addMenuItem(this._borderItem.item);
        this._alignItem = this._buildChoiceMenu('text-align', ALIGN_LABELS, 'Alignment');
        body.addMenuItem(this._alignItem.item);
        this._transitionItem = this._buildChoiceMenu('transition', TRANSITION_LABELS, 'Transition');
        body.addMenuItem(this._transitionItem.item);
        body.addMenuItem(actionItem('Reset position and size', () => {
            settings.reset('box-monitor');
            settings.reset('box');
        }));
        body.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        this._helpItem = submenuItem('Mouse controls on the lyric');
        for (const help of ['Click the lyric to go to the song', 'Right-click the lyric for this menu',
            'Ctrl+drag the lyric to move it', 'Alt+drag the lyric to resize its box', 'Ctrl+scroll on the lyric to size the text'])
            this._helpItem.menu.addMenuItem(infoItem(help));
        body.addMenuItem(this._helpItem);
        body.addMenuItem(actionItem('Open the lyrics status page', () => {
            menu.close();
            Gio.AppInfo.launch_default_for_uri(statusPageUri, global.create_app_launch_context(0, -1));
        }));

        settings.connectObject('changed', (_settings, key) => this._onSettingChanged(key), this);
        menu.box.connectObject('style-changed', () => this._syncInk(), this);
        menu.connectObject('open-state-changed', (_menu, open) => {
            if (open)
                this._syncInk();
            else
                this._sizeSlider.finish();
        }, this);
        this._syncSettings();
        this.setState(null);
    }

    destroy() {
        this._settings.disconnectObject(this);
        this._menu.box.disconnectObject(this);
        this._menu.disconnectObject(this);
        this._sizeSlider.finish();
    }

    setState(state) {
        const song = Boolean(state?.active);
        this._songSection.actor.visible = song;
        if (!song)
            return;
        this._identityItem.label.text = state.identityText || 'Unidentified song';
        this._statusItem.label.text = statusText(state);
        this._micItem.label.text = `Microphone: ${state.pitch.microphone}`;
        this._micItem.visible = state.pitch.capturing && Boolean(state.pitch.microphone);
        this._micErrorItem.label.text = `Microphone stopped: ${state.pitch.error}`;
        this._micErrorItem.visible = Boolean(state.pitch.error);
        this._timingItem.visible = state.lyrics === 'timed';
        this._offsetLabel.text = formatOffset(state.offsetSeconds);
        this._syncSets(state.candidates);
        this._wrongItem.visible = Boolean(state.chosen);
        const busy = state.lyrics === 'searching' || state.lyrics === 'waiting';
        this._searchItem.visible = !busy && state.lyrics !== 'not-music';
        this._lookUpItem.visible = state.lyrics === 'not-music';
    }

    _buildTimingRow() {
        const row = new PopupMenu.PopupBaseMenuItem({activate: false, hover: false, can_focus: false});
        row.add_child(new St.Label({text: 'Timing', y_align: Clutter.ActorAlign.CENTER, x_expand: true}));
        row.add_child(pressButton('Too fast', () => this._client.command({op: 'tooFast'})));
        this._offsetLabel = new St.Label({style_class: 'lyrics-overlay-value', y_align: Clutter.ActorAlign.CENTER});
        row.add_child(this._offsetLabel);
        row.add_child(pressButton('Too slow', () => this._client.command({op: 'tooSlow'})));
        row.add_child(pressButton('Reset', () => this._client.command({op: 'resetOffset'})));
        return row;
    }

    _buildSizeRow() {
        const row = new PopupMenu.PopupBaseMenuItem({activate: false, hover: false, can_focus: false});
        row.add_style_class_name('lyrics-overlay-size-row');
        row.add_child(new St.Label({text: 'Size', y_align: Clutter.ActorAlign.CENTER}));
        this._sizeSlider = new SizeSlider();
        this._sizeLabel = new St.Label({style_class: 'lyrics-overlay-value', y_align: Clutter.ActorAlign.CENTER});
        this._sizeSlider.connect('preview', (_slider, size) => {
            this._sizeLabel.text = `${Math.round(size)} px`;
            this._overlay.previewFontSize(size);
        });
        this._sizeSlider.connect('commit', () => this._overlay.commitFontSize());
        row.add_child(this._sizeSlider);
        row.add_child(this._sizeLabel);
        return row;
    }

    _buildFontMenu() {
        const item = submenuItem();
        this._boldItem = switchItem('Bold', this._settings.get_boolean('font-bold'),
            state => this._settings.set_boolean('font-bold', state));
        item.menu.addMenuItem(this._boldItem);
        this._familyItems = new Map();
        const addFamily = family => {
            const familyItem = actionItem(family || 'Desktop font', () => this._settings.set_string('font-family', family));
            if (family)
                familyItem.label.style = `font-family: "${family}";`;
            item.menu.addMenuItem(familyItem);
            this._familyItems.set(family, familyItem);
        };
        addFamily('');
        for (const families of installedStandardFamilies()) {
            item.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
            families.forEach(addFamily);
        }
        return item;
    }

    _buildChoiceMenu(key, labels, title) {
        const item = submenuItem();
        const choices = new Map();
        for (const [value, label] of Object.entries(labels)) {
            const choice = actionItem(label, () => this._settings.set_string(key, value));
            item.menu.addMenuItem(choice);
            choices.set(value, choice);
        }
        return {item, choices, key, labels, title};
    }

    _syncChoiceMenu({item, choices, key, labels, title}) {
        const value = this._settings.get_string(key);
        item.label.text = `${title}: ${labels[value]}`;
        for (const [choiceValue, choice] of choices)
            choice.setOrnament(choiceValue === value ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NO_DOT);
    }

    _syncSettings() {
        this._enabledItem.setToggleState(this._settings.get_boolean('overlay-enabled'));
        this._pitchItem.setToggleState(this._settings.get_boolean('pitch-enabled'));
        this._boldItem.setToggleState(this._settings.get_boolean('font-bold'));
        const size = this._overlay.fontSize;
        this._sizeSlider.size = size;
        this._sizeLabel.text = `${Math.round(size)} px`;
        const family = this._settings.get_string('font-family');
        this._fontItem.label.text = `Font: ${family || 'desktop font'}${this._settings.get_boolean('font-bold') ? ', bold' : ''}`;
        for (const [choiceFamily, item] of this._familyItems)
            item.setOrnament(choiceFamily === family ? PopupMenu.Ornament.DOT : PopupMenu.Ornament.NO_DOT);
        for (const choiceMenu of [this._colorItem, this._borderItem, this._alignItem, this._transitionItem])
            this._syncChoiceMenu(choiceMenu);
    }

    _onSettingChanged(_key) {
        this._syncSettings();
    }

    _syncSets(candidates) {
        const signature = JSON.stringify(candidates);
        if (signature === this._setsSignature)
            return;
        this._setsSignature = signature;
        this._setsItem.menu.removeAll();
        this._setsItem.visible = candidates.length > 0;
        this._setsItem.label.text = `Lyric sets: ${candidates.length}`;
        for (const candidate of candidates) {
            const parts = [candidate.label, candidate.timed ? 'timed' : 'untimed'];
            if (candidate.rejected)
                parts.push('marked wrong');
            const item = actionItem(parts.join(' - '), () => this._client.command({op: 'choose', id: candidate.id}));
            item.setOrnament(candidate.current ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
            this._setsItem.menu.addMenuItem(item);
        }
    }

    // Neutral text is pure black on a light menu and pure white on a dark
    // one; the theme's own near-black and dimmed grays are overridden.
    _syncInk() {
        const background = this._menu.box.get_theme_node().get_background_color();
        const luminance = 0.2126 * background.red + 0.7152 * background.green + 0.0722 * background.blue;
        const [wanted, other] = luminance < 128
            ? ['lyrics-overlay-menu-dark', 'lyrics-overlay-menu-light']
            : ['lyrics-overlay-menu-light', 'lyrics-overlay-menu-dark'];
        const actor = this._menu.actor;
        // A class change restyles the box, which calls this again.
        if (actor.has_style_class_name(wanted))
            return;
        actor.remove_style_class_name(other);
        actor.add_style_class_name(wanted);
    }
}

export const LyricsIndicator = GObject.registerClass(
class LyricsIndicator extends PanelMenu.Button {
    /**
     * @param {{path: string, settings: Gio.Settings,
     *          client: import('./service-client.js').ServiceClient,
     *          overlay: import('./overlay.js').LyricsOverlay, statusPageUri: string,
     *          focusSong: () => void}} options
     */
    _init({path, settings, client, overlay, statusPageUri, focusSong}) {
        super._init(0.5, 'Lyrics overlay', false);
        this._settings = settings;
        this._state = null;
        this._icons = {};
        for (const name of ['on', 'off', 'on-none', 'off-none'])
            this._icons[name] = Gio.icon_new_for_string(`${path}/icons/lyrics-${name}-symbolic.svg`);
        this._icon = new St.Icon({style_class: 'system-status-icon'});
        this.add_child(this._icon);

        this._clickGesture.required_button = Clutter.BUTTON_SECONDARY;
        const toggle = new Clutter.ClickGesture({required_button: Clutter.BUTTON_PRIMARY, recognize_on_press: true});
        toggle.connect('recognize', () => settings.set_boolean('overlay-enabled', !settings.get_boolean('overlay-enabled')));
        this.add_action(toggle);

        this._lyricsMenu = new LyricsMenu({menu: this.menu, settings, client, overlay, statusPageUri, focusSong});
        settings.connectObject('changed::overlay-enabled', () => this._sync(), this);
        this._sync();
    }

    setState(state) {
        this._state = state;
        this._lyricsMenu.setState(state);
        this._sync();
    }

    _sync() {
        const enabled = this._settings.get_boolean('overlay-enabled');
        const nothing = NOTHING_TO_SHOW.has(this._state?.lyrics);
        this._icon.gicon = this._icons[`${enabled ? 'on' : 'off'}${nothing ? '-none' : ''}`];
        this.visible = Boolean(this._state?.active);
    }

    _onDestroy() {
        this._settings.disconnectObject(this);
        this._lyricsMenu.destroy();
        super._onDestroy();
    }
});
