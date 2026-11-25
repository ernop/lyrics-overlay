// Live floating GTK3 configuration panel anchored right beside the Piano Lead
// Sheet window so every adjustment updates the sheet immediately in full view.
//
// Styling rules:
// - Pure #ffffff text on #111111 background (never gray text anywhere).
// - Selected toggle/option buttons use a 3px contrasting border and distinct
//   active color (#facc15 fill with #000000 ink).
// - Every slider shows visible numerical notch marks (endpoints + intermediates)
//   plus a bold numerical readout.

import Gdk from 'gi://Gdk?version=3.0';
import Gtk from 'gi://Gtk?version=3.0';

import {SCALES, pitchClassNames} from '../shared/scales.js';
import {QuietMapGuard} from './desktop-actions.js';

const PANEL_CSS = `
window.score-cfg-win {
    background-color: #111111;
    color: #ffffff;
    border: 2px solid #ffffff;
    border-radius: 10px;
}
.score-cfg-root {
    background-color: #111111;
    color: #ffffff;
    padding: 12px 14px;
}
.score-cfg-title {
    color: #ffffff;
    font-size: 16px;
    font-weight: 800;
}
.score-cfg-section {
    color: #ffffff;
    font-size: 13px;
    font-weight: 800;
    margin-top: 7px;
    margin-bottom: 2px;
}
.score-cfg-label {
    color: #ffffff;
    font-size: 12px;
    font-weight: 700;
}
.score-cfg-val {
    color: #facc15;
    font-size: 13px;
    font-weight: 800;
}
.score-cfg-badge {
    color: #000000;
    background-color: #93c5fd;
    border-radius: 4px;
    padding: 1px 6px;
    font-size: 11px;
    font-weight: 800;
}
.score-cfg-tick {
    color: #ffffff;
    font-size: 10px;
    font-weight: 700;
}
button.score-cfg-btn {
    background-image: none;
    background-color: #1e2433;
    color: #ffffff;
    border: 2px solid #ffffff;
    border-radius: 6px;
    padding: 3px 8px;
    font-size: 12px;
    font-weight: 700;
    min-height: 24px;
    min-width: 24px;
}
button.score-cfg-btn:hover {
    background-color: #2c354a;
}
button.score-cfg-btn.selected {
    background-color: #facc15;
    color: #000000;
    border: 3px solid #93c5fd;
    font-weight: 800;
}
button.score-cfg-close {
    background-image: none;
    background-color: #1e2433;
    color: #ffffff;
    border: 2px solid #ffffff;
    border-radius: 6px;
    padding: 2px 9px;
    font-size: 13px;
    font-weight: 800;
}
button.score-cfg-close:hover {
    background-color: #991b1b;
}
scale.score-cfg-scale trough {
    background-color: #2b3347;
    min-height: 7px;
    border-radius: 4px;
}
scale.score-cfg-scale highlight {
    background-color: #facc15;
    border-radius: 4px;
}
scale.score-cfg-scale slider {
    background-color: #ffffff;
    border: 2px solid #000000;
    border-radius: 9px;
    min-width: 16px;
    min-height: 16px;
}
combobox.score-cfg-combo button {
    background-image: none;
    background-color: #1e2433;
    color: #ffffff;
    border: 2px solid #ffffff;
    border-radius: 6px;
    padding: 3px 8px;
    font-weight: 700;
}
`;

let cssInstalled = false;

function ensurePanelCss() {
    if (cssInstalled)
        return;
    const screen = Gdk.Screen.get_default();
    if (!screen)
        return;
    const provider = new Gtk.CssProvider();
    provider.load_from_data(PANEL_CSS);
    Gtk.StyleContext.add_provider_for_screen(screen, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    cssInstalled = true;
}

function makeLabel(text, cls = 'score-cfg-label', xalign = 0) {
    const lbl = new Gtk.Label({label: text, xalign});
    lbl.get_style_context().add_class(cls);
    return lbl;
}

const KEY_SCALE_TYPES = Object.keys(SCALES);

export class ScoreConfigPanel {
    /**
     * @param {{
     *   settings: import('gi://Gio').Settings,
     *   onOpenEditor: () => void,
     *   onOpenSettings: () => void,
     *   onEditScore: (patch: object) => void,
     * }} opts
     */
    constructor({settings, onOpenEditor, onOpenSettings, onEditScore}) {
        ensurePanelCss();
        this._settings = settings;
        this._onOpenEditor = onOpenEditor;
        this._onOpenSettings = onOpenSettings;
        this._onEditScore = onEditScore;
        this._syncing = false;
        this._updaters = [];
        this._songInfo = {
            hasScore: false,
            key: null,
            detectedKey: null,
            hasKeyOverride: false,
            clef: 'auto',
            actualClef: 'treble',
        };

        this._win = new Gtk.Window({
            type: Gtk.WindowType.TOPLEVEL,
            title: 'Lead Sheet Options',
            decorated: true,
            resizable: false,
            skip_taskbar_hint: true,
            skip_pager_hint: true,
        });
        this._win.set_keep_above(true);
        this._win.set_type_hint(Gdk.WindowTypeHint.UTILITY);
        this._quietMap = new QuietMapGuard(this._win, {restoreSkipTaskbar: true});
        this._win.get_style_context().add_class('score-cfg-win');
        this._win.connect('delete-event', () => {
            this.hide();
            return true;
        });
        this._win.connect('key-press-event', (_w, ev) => {
            const [, keyval] = ev.get_keyval();
            if (keyval === Gdk.KEY_Escape) {
                this.hide();
                return true;
            }
            return false;
        });

        const scroll = new Gtk.ScrolledWindow({
            hscrollbar_policy: Gtk.PolicyType.NEVER,
            vscrollbar_policy: Gtk.PolicyType.AUTOMATIC,
            propagate_natural_height: true,
            max_content_height: 760,
        });

        const root = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 6});
        root.get_style_context().add_class('score-cfg-root');
        root.set_size_request(420, -1);

        // Header bar
        const head = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 8});
        head.pack_start(makeLabel('Lead Sheet Options (live)', 'score-cfg-title'), true, true, 0);
        const closeBtn = new Gtk.Button({label: '\u2715'});
        closeBtn.get_style_context().add_class('score-cfg-close');
        closeBtn.connect('clicked', () => this.hide());
        head.pack_end(closeBtn, false, false, 0);
        root.pack_start(head, false, false, 0);

        // ----- Size & Layout
        root.pack_start(makeLabel('Size, Zoom & Reflow', 'score-cfg-section'), false, false, 0);
        root.pack_start(this._makeSliderRow({
            label: 'Zoom',
            key: 'score-scale',
            type: 'double',
            min: 0.6,
            max: 3.5,
            step: 0.05,
            marks: [
                [0.6, '60%'],
                [1.0, '100%'],
                [1.75, '175%'],
                [2.5, '250%'],
                [3.5, '350%'],
            ],
            format: v => `${Math.round(v * 100)}%`,
        }), false, false, 0);

        root.pack_start(this._makeSliderRow({
            label: 'Bars / row',
            key: 'score-bars-per-system',
            type: 'int',
            min: 0,
            max: 12,
            step: 1,
            marks: [[0, 'Auto'], [2, '2'], [4, '4'], [6, '6'], [8, '8'], [12, '12']],
            format: v => (v <= 0 ? 'Auto' : String(Math.round(v))),
        }), false, false, 0);

        root.pack_start(this._makeChoiceRow('Spacing', 'score-spacing', [
            ['compact', 'Compact'],
            ['normal', 'Normal'],
            ['spacious', 'Spacious'],
        ]), false, false, 0);

        root.pack_start(this._makeChoiceRow('Page turn', 'score-paging', [
            ['page', 'Full page flip'],
            ['scroll', 'Scroll 1 row'],
        ]), false, false, 0);

        root.pack_start(this._makeSliderRow({
            label: 'Paper',
            key: 'score-background-opacity',
            type: 'double',
            min: 0.75,
            max: 1.0,
            step: 0.02,
            marks: [[0.75, '75%'], [0.88, '88%'], [1.0, '100%']],
            format: v => `${Math.round(v * 100)}%`,
        }), false, false, 0);

        // ----- Song Key, Clef & Musical Notation (per-song key override!)
        root.pack_start(makeLabel('This Song: Key, Clef & Snap', 'score-cfg-section'), false, false, 0);
        root.pack_start(this._makeSongKeyRow(), false, false, 0);
        root.pack_start(this._makeSongClefRow(), false, false, 0);

        root.pack_start(this._makeChoiceRow('Scale snap', 'score-scale-snap', [
            ['soft', 'Soft'],
            ['strict', 'Strict'],
            ['off', 'Off'],
        ]), false, false, 0);

        root.pack_start(this._makeChoiceRow('Note labels', 'score-note-names', [
            ['letters', 'Letters (G4)'],
            ['degrees', 'Degrees (1\u20137)'],
            ['off', 'Off'],
        ]), false, false, 0);

        root.pack_start(this._makeChoiceRow('Vocal voices', 'score-voices', [
            ['both', 'Both'],
            ['top', 'Top'],
            ['bottom', 'Bottom'],
        ]), false, false, 0);

        root.pack_start(this._makeChoiceRow('Harmony 3rd', 'score-harmony', [
            ['off', 'Off'],
            ['above', 'Above'],
            ['below', 'Below'],
            ['both', 'Both'],
        ]), false, false, 0);

        // ----- What's Shown on the Sheet
        root.pack_start(makeLabel('Show on Sheet', 'score-cfg-section'), false, false, 0);
        const showGrid1 = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 5});
        showGrid1.pack_start(this._makeBoolToggle('Bar #', 'score-show-measure-numbers'), true, true, 0);
        showGrid1.pack_start(this._makeBoolToggle('Chords', 'score-show-chords'), true, true, 0);
        showGrid1.pack_start(this._makeBoolToggle('Lyrics', 'score-show-lyrics'), true, true, 0);
        root.pack_start(showGrid1, false, false, 0);

        const showGrid2 = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 5});
        showGrid2.pack_start(this._makeBoolToggle('Red line', 'score-show-playhead'), true, true, 0);
        showGrid2.pack_start(this._makeBoolToggle('Yellow bar', 'score-show-active-measure'), true, true, 0);
        showGrid2.pack_start(this._makeBoolToggle('Snap arrows', 'score-show-snap-moves'), true, true, 0);
        root.pack_start(showGrid2, false, false, 0);

        // ----- Header Fields (configurable top-right metadata!)
        root.pack_start(makeLabel('Header Bar & Upper-Right Info', 'score-cfg-section'), false, false, 0);
        const hdrRow1 = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 5});
        hdrRow1.pack_start(this._makeBoolToggle('Show header', 'score-show-header'), true, true, 0);
        hdrRow1.pack_start(this._makeBoolToggle('Title', 'score-header-title'), true, true, 0);
        hdrRow1.pack_start(this._makeBoolToggle('Key', 'score-header-key'), true, true, 0);
        hdrRow1.pack_start(this._makeBoolToggle('BPM', 'score-header-bpm'), true, true, 0);
        root.pack_start(hdrRow1, false, false, 0);

        const hdrRow2 = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 5});
        hdrRow2.pack_start(this._makeBoolToggle('Time sig', 'score-header-time'), true, true, 0);
        hdrRow2.pack_start(this._makeBoolToggle('Octave (8vb)', 'score-header-clef'), true, true, 0);
        hdrRow2.pack_start(this._makeBoolToggle('Bars', 'score-header-bars'), true, true, 0);
        hdrRow2.pack_start(this._makeBoolToggle('Page', 'score-header-page'), true, true, 0);
        root.pack_start(hdrRow2, false, false, 0);

        // ----- Window & Actions
        root.pack_start(makeLabel('Window', 'score-cfg-section'), false, false, 0);
        const winRow = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 6});
        winRow.pack_start(this._makeBoolToggle('Always on top', 'score-always-on-top'), true, true, 0);
        const edBtn = new Gtk.Button({label: 'Editor & MIDI'});
        edBtn.get_style_context().add_class('score-cfg-btn');
        edBtn.connect('clicked', () => this._onOpenEditor?.());
        winRow.pack_start(edBtn, true, true, 0);
        const setBtn = new Gtk.Button({label: 'All settings'});
        setBtn.get_style_context().add_class('score-cfg-btn');
        setBtn.connect('clicked', () => this._onOpenSettings?.());
        winRow.pack_start(setBtn, true, true, 0);
        root.pack_start(winRow, false, false, 0);

        scroll.add(root);
        this._win.add(scroll);
        this._settingsId = this._settings.connect('changed', () => this.sync());
        this.sync();
    }

    get visible() {
        return this._win.get_visible();
    }

    /** Updates the displayed song key & clef so the Key dropdown always reflects the playing song. */
    setSongInfo(info) {
        this._songInfo = {
            hasScore: Boolean(info?.hasScore),
            key: info?.key ?? null,
            detectedKey: info?.detectedKey ?? null,
            hasKeyOverride: Boolean(info?.hasKeyOverride),
            clef: info?.clef ?? 'auto',
            actualClef: info?.actualClef ?? 'treble',
        };
        this.sync();
    }

    sync() {
        this._syncing = true;
        try {
            for (const fn of this._updaters)
                fn();
        } finally {
            this._syncing = false;
        }
    }

    showNear(sheetBox, workArea) {
        this.sync();
        this._quietMap.prepareShow();
        this._win.show_all();
        this._win.set_keep_above(true);
        const [, natW] = this._win.get_preferred_width();
        const [, natH] = this._win.get_preferred_height();
        const pw = Math.max(420, natW || 430);
        const ph = Math.min(workArea ? workArea.height - 24 : 780, Math.max(460, natH || 640));
        if (sheetBox && workArea) {
            const gap = 12;
            let px;
            if (sheetBox.x + sheetBox.width + gap + pw <= workArea.x + workArea.width)
                px = sheetBox.x + sheetBox.width + gap;
            else if (sheetBox.x - gap - pw >= workArea.x)
                px = sheetBox.x - gap - pw;
            else
                px = Math.max(workArea.x + 8, workArea.x + workArea.width - pw - 8);
            const py = Math.max(
                workArea.y + 8,
                Math.min(workArea.y + workArea.height - ph - 8, sheetBox.y),
            );
            this._win.move(Math.round(px), Math.round(py));
        }
    }

    hide() {
        this._quietMap.prepareHide();
        if (this._win.get_visible())
            this._win.hide();
    }

    toggleNear(sheetBox, workArea) {
        if (this.visible)
            this.hide();
        else
            this.showNear(sheetBox, workArea);
    }

    destroy() {
        if (this._settingsId) {
            this._settings.disconnect(this._settingsId);
            this._settingsId = 0;
        }
        this._quietMap.destroy();
        this._win.destroy();
    }

    // ----- control builders

    _makeSliderRow({label, key, type, min, max, step, marks, format}) {
        const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 2});
        const top = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 6});
        top.pack_start(makeLabel(label, 'score-cfg-label'), false, false, 0);
        const readout = makeLabel('', 'score-cfg-val', 1);
        top.pack_end(readout, false, false, 0);
        box.pack_start(top, false, false, 0);

        const adj = new Gtk.Adjustment({
            value: min,
            lower: min,
            upper: max,
            step_increment: step,
            page_increment: step * 2,
        });
        const scale = new Gtk.Scale({
            orientation: Gtk.Orientation.HORIZONTAL,
            adjustment: adj,
            draw_value: false,
            digits: type === 'int' ? 0 : 2,
        });
        scale.get_style_context().add_class('score-cfg-scale');
        scale.set_increments(step, step * 2);
        for (const [mVal, mText] of marks)
            scale.add_mark(mVal, Gtk.PositionType.BOTTOM, mText);

        scale.connect('value-changed', () => {
            if (this._syncing)
                return;
            const raw = scale.get_value();
            if (type === 'int') {
                const v = Math.round(raw);
                readout.set_label(format(v));
                if (this._settings.get_int(key) !== v)
                    this._settings.set_int(key, v);
            } else {
                const v = Math.round(raw * 100) / 100;
                readout.set_label(format(v));
                if (Math.abs(this._settings.get_double(key) - v) > 0.001)
                    this._settings.set_double(key, v);
            }
        });
        box.pack_start(scale, false, false, 0);

        this._updaters.push(() => {
            const v = type === 'int' ? this._settings.get_int(key) : this._settings.get_double(key);
            scale.set_value(v);
            readout.set_label(format(v));
        });
        return box;
    }

    _makeBoolToggle(label, key) {
        const btn = new Gtk.Button({label});
        btn.get_style_context().add_class('score-cfg-btn');
        btn.connect('clicked', () => {
            if (this._syncing)
                return;
            this._settings.set_boolean(key, !this._settings.get_boolean(key));
        });
        this._updaters.push(() => {
            const on = this._settings.get_boolean(key);
            const ctx = btn.get_style_context();
            if (on)
                ctx.add_class('selected');
            else
                ctx.remove_class('selected');
        });
        return btn;
    }

    _makeChoiceRow(label, key, choices) {
        const row = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 5});
        const lbl = makeLabel(label, 'score-cfg-label');
        lbl.set_size_request(86, -1);
        row.pack_start(lbl, false, false, 0);
        const buttons = [];
        for (const [val, text] of choices) {
            const btn = new Gtk.Button({label: text});
            btn.get_style_context().add_class('score-cfg-btn');
            btn.connect('clicked', () => {
                if (this._syncing)
                    return;
                this._settings.set_string(key, val);
            });
            row.pack_start(btn, true, true, 0);
            buttons.push([val, btn]);
        }
        this._updaters.push(() => {
            const cur = this._settings.get_string(key);
            for (const [val, btn] of buttons) {
                const ctx = btn.get_style_context();
                if (cur === val)
                    ctx.add_class('selected');
                else
                    ctx.remove_class('selected');
            }
        });
        return row;
    }

    _makeSongKeyRow() {
        const row = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 5});
        const lbl = makeLabel('Song key', 'score-cfg-label');
        lbl.set_size_request(86, -1);
        row.pack_start(lbl, false, false, 0);

        const rootCombo = new Gtk.ComboBoxText();
        rootCombo.get_style_context().add_class('score-cfg-combo');
        const noteNames = pitchClassNames(null);
        for (let pc = 0; pc < 12; pc++)
            rootCombo.append(String(pc), noteNames[pc]);
        row.pack_start(rootCombo, false, false, 0);

        const typeCombo = new Gtk.ComboBoxText();
        typeCombo.get_style_context().add_class('score-cfg-combo');
        for (const id of KEY_SCALE_TYPES)
            typeCombo.append(id, SCALES[id].name);
        row.pack_start(typeCombo, true, true, 0);

        const badge = makeLabel('Auto', 'score-cfg-badge');
        row.pack_start(badge, false, false, 0);

        const resetBtn = new Gtk.Button({label: 'Auto'});
        resetBtn.get_style_context().add_class('score-cfg-btn');
        resetBtn.connect('clicked', () => {
            if (this._syncing || !this._songInfo.hasScore)
                return;
            this._onEditScore?.({keyOverride: null});
        });
        row.pack_start(resetBtn, false, false, 0);

        const commitKey = () => {
            if (this._syncing || !this._songInfo.hasScore)
                return;
            const root = Number(rootCombo.get_active_id());
            const type = typeCombo.get_active_id();
            if (Number.isFinite(root) && type && (type in SCALES))
                this._onEditScore?.({keyOverride: {root, type}});
        };
        rootCombo.connect('changed', commitKey);
        typeCombo.connect('changed', commitKey);

        this._updaters.push(() => {
            const info = this._songInfo;
            const activeKey = info.key ?? info.detectedKey ?? {root: 0, type: 'major'};
            rootCombo.set_active_id(String(activeKey.root ?? 0));
            typeCombo.set_active_id(String(activeKey.type ?? 'major'));
            rootCombo.set_sensitive(info.hasScore);
            typeCombo.set_sensitive(info.hasScore);
            resetBtn.set_sensitive(info.hasScore && info.hasKeyOverride);
            badge.set_label(!info.hasScore ? 'Idle' : (info.hasKeyOverride ? 'Edited' : 'Detected'));
        });
        return row;
    }

    _makeSongClefRow() {
        const row = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 5});
        const lbl = makeLabel('Song clef', 'score-cfg-label');
        lbl.set_size_request(86, -1);
        row.pack_start(lbl, false, false, 0);

        const choices = [
            ['auto', 'Auto'],
            ['treble', 'Treble'],
            ['treble-8vb', 'Treble 8vb'],
        ];
        const buttons = [];
        for (const [val, text] of choices) {
            const btn = new Gtk.Button({label: text});
            btn.get_style_context().add_class('score-cfg-btn');
            btn.connect('clicked', () => {
                if (this._syncing || !this._songInfo.hasScore)
                    return;
                this._onEditScore?.({clef: val});
            });
            row.pack_start(btn, true, true, 0);
            buttons.push([val, btn]);
        }
        this._updaters.push(() => {
            const info = this._songInfo;
            for (const [val, btn] of buttons) {
                btn.set_sensitive(info.hasScore);
                const ctx = btn.get_style_context();
                if (info.clef === val)
                    ctx.add_class('selected');
                else
                    ctx.remove_class('selected');
            }
        });
        return row;
    }
}
