// The lyric overlay: one line at a constant font size above normal windows,
// hidden over fullscreen windows and in the overview. Long lines wrap evenly
// and expand the surface vertically along its anchor without ever shrinking
// the text mid-song.
//
// Pointer interaction follows the owner's click-vs-drag rule:
// - Hovering does nothing visually and never changes the cursor; outside the
//   painted text (or status pill), empty space stays click-through.
// - A plain primary press acts immediately on press to select the song's
//   YouTube tab and raise its window; it never starts a drag.
// - A secondary press acts immediately on press to open the settings page.
// - Ctrl+drag moves the box with magnetic center/edge snapping (hold Shift
//   to bypass snap; Escape cancels; Ctrl+press without movement does nothing).
//   The placement outline and snap guides appear only during an active drag.
// - Ctrl+scroll changes the text size; box width/height resize lives on the
//   settings page's Screen map.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Mtk from 'gi://Mtk';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    boxFromGeometry, clampFontSize, expandedRenderBox,
    geometryFromBox, movedBox, snapBox, verticalAnchorFor,
} from './shared/overlay-geometry.js';
import {fitLyric, paintLyric} from './text-layout.js';

const GRIP_MARGIN = 6;
const SNAP_THRESHOLD = 12;
const SCROLL_STEP_RATIO = 1.06;
const SCROLL_COMMIT_MS = 500;

/** Fade durations in milliseconds for the outgoing and incoming line. */
export const TRANSITIONS = Object.freeze({
    'instant': {out: 0, in: 0},
    'fade-in': {out: 0, in: 150},
});

const GEOMETRY_KEYS = ['cx', 'cy', 'width', 'height'];

const LOOK_KEYS = new Set([
    'font-size', 'font-family', 'font-bold', 'font-italic',
    'text-color', 'text-custom-color', 'text-border',
    'text-backdrop', 'text-backdrop-color', 'text-backdrop-opacity',
    'text-align', 'pitch-dock', 'pitch-enabled',
]);

function readGeometry(settings) {
    const geometry = settings.get_value('box').deepUnpack();
    for (const key of GEOMETRY_KEYS) {
        if (typeof geometry[key] !== 'number')
            throw new Error(`lyrics-overlay: setting "box" lacks ${key}`);
    }
    return geometry;
}

function roundedRect(cr, x, y, w, h, r) {
    const radius = Math.max(0, Math.min(r, w / 2, h / 2));
    cr.newSubPath();
    cr.arc(x + w - radius, y + radius, radius, -Math.PI / 2, 0);
    cr.arc(x + w - radius, y + h - radius, radius, 0, Math.PI / 2);
    cr.arc(x + radius, y + h - radius, radius, Math.PI / 2, Math.PI);
    cr.arc(x + radius, y + radius, radius, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

const TextLayer = GObject.registerClass(
class TextLayer extends St.DrawingArea {
    _init() {
        super._init({reactive: false});
        this.text = '';
        this.fitted = null;
    }

    setFitted(text, fitted) {
        this.text = text;
        this.fitted = fitted;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        if (this.fitted)
            paintLyric(cr, this.fitted);
        cr.$dispose();
    }
});

// Quiet, non-intrusive status pill drawn while automatic lyric timing runs
// for a song without synced LRCLIB lyrics. Steady pure-white text on a dark
// translucent pill; no animation or flashing.
const StatusPill = GObject.registerClass(
class StatusPill extends St.DrawingArea {
    _init() {
        super._init({reactive: false, visible: false});
        this._text = '';
        this._align = 'center';
        this._anchor = 'bottom';
        this.pillBox = null;
    }

    _fontDescription() {
        const desc = new Pango.FontDescription();
        desc.set_family('Sans');
        desc.set_weight(Pango.Weight.BOLD);
        desc.set_absolute_size(15 * Pango.SCALE);
        return desc;
    }

    configure(context, {text, align, anchor, width, height}) {
        this._text = text;
        this._align = align;
        this._anchor = anchor;
        if (!text || width < 40 || height < 24) {
            this.pillBox = null;
            this.visible = false;
            return;
        }
        const layout = Pango.Layout.new(context);
        layout.set_font_description(this._fontDescription());
        layout.set_text(text, -1);
        const [, logical] = layout.get_pixel_extents();
        const padX = 14;
        const padY = 6;
        const margin = 6;
        const pillW = Math.min(Math.max(40, width - margin * 2), logical.width + padX * 2);
        const pillH = Math.min(Math.max(24, height - margin * 2), logical.height + padY * 2);
        let px;
        if (align === 'left')
            px = margin;
        else if (align === 'right')
            px = Math.max(margin, width - margin - pillW);
        else
            px = Math.round((width - pillW) / 2);
        let py;
        if (anchor === 'top')
            py = margin;
        else if (anchor === 'bottom')
            py = Math.max(margin, height - margin - pillH);
        else
            py = Math.round((height - pillH) / 2);
        this.pillBox = {x: px, y: py, width: pillW, height: pillH, padX, padY};
        this.visible = true;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        if (!this._text || !this.pillBox) {
            cr.$dispose();
            return;
        }
        const {x, y, width, height, padX, padY} = this.pillBox;
        roundedRect(cr, x + 0.5, y + 0.5, width - 1, height - 1, Math.min(10, height / 2));
        cr.setSourceRGBA(0, 0, 0, 0.78);
        cr.fillPreserve();
        cr.setSourceRGBA(1, 1, 1, 0.38);
        cr.setLineWidth(1);
        cr.stroke();

        const layout = PangoCairo.create_layout(cr);
        layout.set_font_description(this._fontDescription());
        layout.set_text(this._text, -1);
        const [, logical] = layout.get_pixel_extents();
        const tx = x + Math.max(padX, Math.round((width - logical.width) / 2));
        const ty = y + Math.max(padY, Math.round((height - logical.height) / 2));
        cr.save();
        cr.rectangle(x + padX / 2, y, Math.max(1, width - padX), height);
        cr.clip();
        cr.setSourceRGBA(1, 1, 1, 1);
        cr.moveTo(tx, ty);
        PangoCairo.show_layout(cr, layout);
        cr.restore();
        cr.$dispose();
    }
});

// Placement outline, magnetic snap guides, and compact HUD shown ONLY during
// an active Ctrl+drag move (never on plain mouseover).
const BoxOutline = GObject.registerClass(
class BoxOutline extends St.DrawingArea {
    _init() {
        super._init({reactive: false, visible: false});
        this._hudText = '';
        this._snappedX = false;
        this._snappedY = false;
    }

    setAppearance({hudText = '', snappedX = false, snappedY = false}) {
        this._hudText = hudText;
        this._snappedX = snappedX;
        this._snappedY = snappedY;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        if (width < 6 || height < 6) {
            cr.$dispose();
            return;
        }

        // Crisp high-contrast outer border (dark shadow + clean white hairline)
        roundedRect(cr, 2, 2, width - 4, height - 4, 5);
        cr.setSourceRGBA(0, 0, 0, 0.85);
        cr.setLineWidth(3.5);
        cr.strokePreserve();
        cr.setSourceRGBA(1, 1, 1, 0.92);
        cr.setLineWidth(1.5);
        cr.stroke();

        // Magnetic center-snap guide lines while snapped
        if (this._snappedX) {
            cr.setSourceRGBA(0.98, 0.8, 0.08, 0.95);
            cr.setLineWidth(2);
            cr.moveTo(Math.round(width / 2) + 0.5, 4);
            cr.lineTo(Math.round(width / 2) + 0.5, height - 4);
            cr.stroke();
        }
        if (this._snappedY) {
            cr.setSourceRGBA(0.98, 0.8, 0.08, 0.95);
            cr.setLineWidth(2);
            cr.moveTo(4, Math.round(height / 2) + 0.5);
            cr.lineTo(width - 4, Math.round(height / 2) + 0.5);
            cr.stroke();
        }

        // Compact dimensions readout shown during an active Ctrl+drag
        if (this._hudText && height >= 40 && width >= 150) {
            const layout = PangoCairo.create_layout(cr);
            const desc = new Pango.FontDescription();
            desc.set_family('Sans');
            desc.set_weight(Pango.Weight.BOLD);
            desc.set_absolute_size(12 * Pango.SCALE);
            layout.set_font_description(desc);
            layout.set_text(this._hudText, -1);
            const [, logical] = layout.get_pixel_extents();
            const padX = 8, padY = 3;
            const pillW = Math.min(width - 24, logical.width + padX * 2);
            const pillH = logical.height + padY * 2;
            const px = 14;
            const py = 10;
            roundedRect(cr, px, py, pillW, pillH, 5);
            cr.setSourceRGBA(0, 0, 0, 0.9);
            cr.fillPreserve();
            cr.setSourceRGBA(1, 1, 1, 0.9);
            cr.setLineWidth(1);
            cr.stroke();
            cr.save();
            cr.rectangle(px + padX, py + padY, Math.max(1, pillW - padX * 2), pillH);
            cr.clip();
            cr.setSourceRGBA(1, 1, 1, 1);
            cr.moveTo(px + padX, py + padY);
            PangoCairo.show_layout(cr, layout);
            cr.restore();
        }
        cr.$dispose();
    }
});

/**
 * Tight pointer target over the painted lyric ink (or timing status pill):
 * - Plain hover does nothing (no frame, no cursor change, surrounding space
 *   stays click-through).
 * - Plain primary press fires click() immediately on press (never drags).
 * - Secondary press fires menu() immediately on press.
 * - Ctrl+primary press + movement moves the box; Ctrl+press without movement
 *   does nothing.
 * - Ctrl+scroll resizes text.
 */
const OverlayGrip = GObject.registerClass(
class OverlayGrip extends St.Widget {
    /**
     * @param {{begin: (press: {x: number, y: number}) => void,
     *          motion: (pointer: {x: number, y: number}, opts: {noSnap: boolean}) => void,
     *          end: (commit: boolean) => void,
     *          scroll: (steps: number) => void,
     *          click: () => void,
     *          menu: () => void}} handlers
     */
    _init(handlers) {
        super._init({reactive: true, visible: false, accessible_name: 'Lyric overlay'});
        this._handlers = handlers;
        this._grab = null;
        // 'pending-move' (Ctrl+press before passing drag threshold), 'move' (actively moving).
        this._mode = null;
        this._press = null;
    }

    get dragging() {
        return this._mode === 'move';
    }

    vfunc_motion_event(event) {
        if (!this._grab)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = event.get_coords();
        const noSnap = Boolean(event.get_state() & Clutter.ModifierType.SHIFT_MASK);
        if (this._mode === 'pending-move') {
            const threshold = St.Settings.get().drag_threshold;
            if (Math.abs(x - this._press.x) > threshold || Math.abs(y - this._press.y) > threshold) {
                this._mode = 'move';
                this.set_cursor_type(Clutter.CursorType.GRABBING);
                this._handlers.begin(this._press);
                this._handlers.motion({x, y}, {noSnap});
            }
            return Clutter.EVENT_STOP;
        }
        if (this._mode === 'move')
            this._handlers.motion({x, y}, {noSnap});
        return Clutter.EVENT_STOP;
    }

    vfunc_button_press_event(event) {
        if (this._grab)
            return Clutter.EVENT_STOP;
        if (event.get_button() === Clutter.BUTTON_SECONDARY) {
            this._handlers.menu();
            return Clutter.EVENT_STOP;
        }
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_STOP;

        const ctrl = Boolean(event.get_state() & Clutter.ModifierType.CONTROL_MASK);
        if (!ctrl) {
            this._handlers.click();
            return Clutter.EVENT_STOP;
        }

        const [x, y] = event.get_coords();
        this._press = {x, y};
        this._grab = global.stage.grab(this);
        this._mode = 'pending-move';
        return Clutter.EVENT_STOP;
    }

    vfunc_button_release_event(event) {
        if (!this._grab || event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_STOP;
        this._finish(true);
        return Clutter.EVENT_STOP;
    }

    vfunc_key_press_event(event) {
        if (this._grab && event.get_key_symbol() === Clutter.KEY_Escape) {
            this._finish(false);
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_scroll_event(event) {
        if (this._grab || !(event.get_state() & Clutter.ModifierType.CONTROL_MASK))
            return Clutter.EVENT_PROPAGATE;
        // A wheel notch arrives twice, once as an emulated copy.
        if (event.get_flags() & Clutter.EventFlags.FLAG_POINTER_EMULATED)
            return Clutter.EVENT_STOP;
        let steps = 0;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
            steps = 1;
            break;
        case Clutter.ScrollDirection.DOWN:
            steps = -1;
            break;
        case Clutter.ScrollDirection.SMOOTH:
            steps = -event.get_scroll_delta()[1];
            break;
        }
        if (steps)
            this._handlers.scroll(steps);
        return Clutter.EVENT_STOP;
    }

    cancelDrag() {
        if (this._grab)
            this._finish(false);
    }

    _finish(commit) {
        const dragged = this.dragging;
        this._grab.dismiss();
        this._grab = null;
        this._mode = null;
        this._press = null;
        this.set_cursor_type(Clutter.CursorType.INHERIT);
        if (dragged)
            this._handlers.end(commit);
    }
});

export class LyricsOverlay {
    /**
     * @param {{settings: Gio.Settings, onClick: () => void, onContextMenu: () => void,
     *          onBoxChanged: (box: {x: number, y: number, width: number, height: number}, monitorIndex: number) => void}} options
     */
    constructor({settings, onClick, onContextMenu, onBoxChanged}) {
        this._settings = settings;
        this._onBoxChanged = onBoxChanged;
        this._measure = PangoCairo.FontMap.get_default().create_context();
        this._fontSizePreview = null;
        this._scrollCommitId = 0;
        this._line = {text: '', key: 'none'};
        this._statusText = '';
        this._shown = false;
        this._drag = null;
        this._snapGuides = {x: [], y: []};
        this._box = null;
        this._renderBox = null;
        this._monitorIndex = Main.layoutManager.primaryIndex;

        // The layout manager owns the root's visibility (fullscreen
        // tracking); the overlay's own visibility lives on _content.
        this._root = new St.Widget({name: 'lyricsOverlay', reactive: false});
        this._content = new St.Widget({reactive: false, visible: false, accessible_name: 'Lyric line'});
        this._root.add_child(this._content);
        this._textArea = new St.Widget({reactive: false});
        this._layers = [new TextLayer(), new TextLayer()];
        this._current = 0;
        for (const layer of this._layers)
            this._textArea.add_child(layer);
        this._statusPill = new StatusPill();
        this._outline = new BoxOutline();
        this._grip = new OverlayGrip({
            begin: press => this._dragBegin(press),
            motion: (pointer, opts) => this._dragMotion(pointer, opts),
            end: commit => this._dragEnd(commit),
            scroll: steps => this._scrollSize(steps),
            click: () => onClick(),
            menu: () => onContextMenu(),
        });
        for (const child of [this._textArea, this._statusPill, this._outline, this._grip])
            this._content.add_child(child);
        Main.layoutManager.addChrome(this._root, {trackFullscreen: true});

        settings.connectObject('changed', (_settings, key) => this._onSettingChanged(key), this);
        St.Settings.get().connectObject('notify::font-name', () => this._refitText(), this);
        Main.layoutManager.connectObject('monitors-changed', () => this._placeBox(), this);
        global.display.connectObject('workareas-changed', () => this._placeBox(), this);
        Main.overview.connectObject(
            'showing', () => this._syncVisible(),
            'hidden', () => this._syncVisible(), this);
        this._placeBox();
    }

    destroy() {
        this._grip.cancelDrag();
        if (this._scrollCommitId) {
            GLib.source_remove(this._scrollCommitId);
            this._scrollCommitId = 0;
        }
        this.commitFontSize();
        this._settings.disconnectObject(this);
        St.Settings.get().disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        global.display.disconnectObject(this);
        Main.overview.disconnectObject(this);
        this._root.destroy();
    }

    setShown(shown) {
        this._shown = shown;
        this._syncVisible();
    }

    /** Saved box of the lyric on the stage (used by PitchPanel docking). */
    get box() {
        return {...this._box};
    }

    get monitorIndex() {
        return this._monitorIndex;
    }

    /** @param {{text: string, key: string}} line */
    setLine(line) {
        const previous = this._line;
        this._line = line;
        if (line.key !== previous.key)
            this._crossTo(line.text);
        else if (line.text !== this._layers[this._current].text)
            this._fitAndResize(this._layers[this._current], line.text);
        this._syncStatusPill();
        this._placeGrip();
        this._updateOutline();
    }

    /** Quiet in-overlay status text shown while automatic lyric timing runs. */
    setStatus(text) {
        const next = String(text ?? '');
        if (next === this._statusText)
            return;
        this._statusText = next;
        this._syncStatusPill();
        this._placeGrip();
        this._updateOutline();
    }

    get fontSize() {
        return this._fontSizePreview ?? this._settings.get_double('font-size');
    }

    /** Shows a size immediately; commitFontSize() stores it. */
    previewFontSize(size) {
        this._fontSizePreview = clampFontSize(size);
        this._refitText();
    }

    commitFontSize() {
        if (this._fontSizePreview === null)
            return;
        const size = this._fontSizePreview;
        this._fontSizePreview = null;
        this._settings.set_double('font-size', size);
    }

    // ----- layout

    _monitorIndexSetting() {
        const stored = this._settings.get_int('box-monitor');
        return stored >= 0 && stored < Main.layoutManager.monitors.length ? stored : Main.layoutManager.primaryIndex;
    }

    _workArea(monitorIndex) {
        const area = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
        return {x: area.x, y: area.y, width: area.width, height: area.height};
    }

    _anchor() {
        const area = this._workArea(this._monitorIndex);
        const cy = (this._box.y + this._box.height / 2 - area.y) / area.height;
        const pitchDock = this._settings.get_string('pitch-dock');
        const pitchEnabled = this._settings.get_boolean('pitch-enabled');
        return verticalAnchorFor(cy, pitchDock, pitchEnabled);
    }

    _placeBox() {
        if (this._drag)
            return;
        const monitorIndex = this._monitorIndexSetting();
        this._setBox(boxFromGeometry(readGeometry(this._settings), this._workArea(monitorIndex)), monitorIndex);
    }

    _setBox(box, monitorIndex) {
        const widthChanged = !this._box || Math.round(box.width) !== Math.round(this._box.width);
        const heightChanged = !this._box || Math.round(box.height) !== Math.round(this._box.height);
        this._box = box;
        this._monitorIndex = monitorIndex;
        const anchor = this._anchor();
        const anchorChanged = this._layers[this._current].fitted && this._layers[this._current].fitted.spec.anchor !== anchor;
        if (widthChanged || heightChanged || anchorChanged || !this._renderBox)
            this._refitText();
        else
            this._applyRenderBox(expandedRenderBox(this._box, this._activeRequiredHeight(), anchor, this._workArea(this._monitorIndex)));
        this._updateOutline();
        this._onBoxChanged(box, monitorIndex);
    }

    _activeRequiredHeight() {
        const fitted = this._layers[this._current].fitted;
        return fitted ? fitted.requiredHeight : 0;
    }

    _applyRenderBox(renderBox) {
        this._renderBox = renderBox;
        const width = Math.round(renderBox.width);
        const height = Math.round(renderBox.height);
        this._root.set_position(Math.round(renderBox.x), Math.round(renderBox.y));
        if (width !== this._root.width || height !== this._root.height) {
            for (const actor of [this._root, this._content, this._statusPill, this._outline, this._textArea, ...this._layers])
                actor.set_size(width, height);
        }
        this._syncStatusPill();
    }

    _syncStatusPill() {
        const hasLine = Boolean(this._layers[this._current].fitted);
        const box = this._renderBox ?? this._box;
        if (!this._statusText || hasLine || !box) {
            this._statusPill.configure(this._measure, {text: '', align: 'center', anchor: 'bottom', width: 0, height: 0});
            return;
        }
        this._statusPill.configure(this._measure, {
            text: this._statusText,
            align: this._settings.get_string('text-align'),
            anchor: this._anchor(),
            width: Math.round(box.width),
            height: Math.round(box.height),
        });
    }

    _textParams(width, height) {
        const s = this._settings;
        const family = s.get_string('font-family') ||
            Pango.FontDescription.from_string(St.Settings.get().font_name).get_family();
        return {
            fontSize: this.fontSize,
            family,
            bold: s.get_boolean('font-bold'),
            italic: s.get_boolean('font-italic'),
            color: s.get_string('text-color'),
            customColor: s.get_string('text-custom-color'),
            border: s.get_string('text-border'),
            backdrop: s.get_string('text-backdrop'),
            backdropColor: s.get_string('text-backdrop-color'),
            backdropOpacity: s.get_double('text-backdrop-opacity'),
            align: s.get_string('text-align'),
            anchor: this._anchor(),
            width,
            height,
        };
    }

    _fitAndResize(layer, text) {
        const width = Math.round(this._box.width);
        const baseHeight = Math.round(this._box.height);
        const anchor = this._anchor();
        const area = this._workArea(this._monitorIndex);
        if (!text) {
            layer.setFitted('', null);
            this._applyRenderBox(this._box);
            return;
        }
        let fitted = fitLyric(this._measure, text, this._textParams(width, baseHeight));
        const renderBox = expandedRenderBox(this._box, fitted.requiredHeight, anchor, area);
        this._applyRenderBox(renderBox);
        if (Math.round(renderBox.height) !== baseHeight)
            fitted = fitLyric(this._measure, text, this._textParams(Math.round(renderBox.width), Math.round(renderBox.height)));
        layer.setFitted(text, fitted);
    }

    _refitText() {
        const activeLayer = this._layers[this._current];
        this._fitAndResize(activeLayer, activeLayer.text);
        const other = this._layers[1 - this._current];
        if (other.opacity > 0 && other.text) {
            const w = Math.round(this._renderBox.width);
            const h = Math.round(this._renderBox.height);
            other.setFitted(other.text, fitLyric(this._measure, other.text, this._textParams(w, h)));
        }
        this._syncStatusPill();
        this._placeGrip();
        this._updateOutline();
    }

    _crossTo(text) {
        const choice = this._settings.get_string('transition');
        const fade = this._content.visible ? (TRANSITIONS[choice] ?? TRANSITIONS['fade-in']) : TRANSITIONS.instant;
        const outgoing = this._layers[this._current];
        this._current = 1 - this._current;
        const incoming = this._layers[this._current];
        outgoing.remove_all_transitions();
        incoming.remove_all_transitions();
        outgoing.opacity = 0;
        this._fitAndResize(incoming, text);
        this._textArea.set_child_above_sibling(incoming, null);
        if (fade.in > 0 && text) {
            incoming.opacity = 0;
            incoming.ease({opacity: 255, duration: fade.in, mode: Clutter.AnimationMode.EASE_OUT_QUAD, animationRequired: true});
        } else {
            incoming.opacity = 255;
        }
    }

    _placeGrip() {
        if (this._grip.dragging)
            return;
        const fitted = this._layers[this._current].fitted;
        if (!fitted) {
            const pill = this._statusPill.visible ? this._statusPill.pillBox : null;
            if (!pill) {
                this._grip.visible = false;
                return;
            }
            const left = Math.max(0, Math.floor(pill.x - GRIP_MARGIN));
            const top = Math.max(0, Math.floor(pill.y - GRIP_MARGIN));
            const right = Math.min(this._root.width, Math.ceil(pill.x + pill.width + GRIP_MARGIN));
            const bottom = Math.min(this._root.height, Math.ceil(pill.y + pill.height + GRIP_MARGIN));
            this._grip.set_position(left, top);
            this._grip.set_size(Math.max(1, right - left), Math.max(1, bottom - top));
            this._grip.visible = true;
            return;
        }
        const box = fitted.inkBox;
        const left = Math.max(0, Math.floor(box.x - GRIP_MARGIN));
        const top = Math.max(0, Math.floor(box.y - GRIP_MARGIN));
        const right = Math.min(this._root.width, Math.ceil(box.x + box.width + GRIP_MARGIN));
        const bottom = Math.min(this._root.height, Math.ceil(box.y + box.height + GRIP_MARGIN));
        this._grip.set_position(left, top);
        this._grip.set_size(Math.max(1, right - left), Math.max(1, bottom - top));
        this._grip.visible = true;
    }

    _hudSummary() {
        if (!this._drag || !this._box)
            return '';
        const area = this._workArea(this._monitorIndex);
        const w = Math.round(this._box.width);
        const h = Math.round(this._box.height);
        const wp = Math.round(this._box.width / area.width * 100);
        const hp = Math.round(this._box.height / area.height * 100);
        return `${w}\u00d7${h} px (${wp}%\u00d7${hp}%) \u00b7 ${Math.round(this.fontSize)} px`;
    }

    _updateOutline() {
        const active = Boolean(this._drag);
        this._outline.visible = active;
        if (!active)
            return;
        const area = this._workArea(this._monitorIndex);
        const centerX = area.x + area.width / 2;
        const centerY = area.y + area.height / 2;
        this._outline.setAppearance({
            hudText: this._hudSummary(),
            snappedX: this._snapGuides.x.some(gx => Math.abs(gx - centerX) <= 1),
            snappedY: this._snapGuides.y.some(gy => Math.abs(gy - centerY) <= 1),
        });
    }

    _syncVisible() {
        const visible = this._shown && !Main.overview.visible;
        if (!visible)
            this._grip.cancelDrag();
        this._content.visible = visible;
    }

    _onSettingChanged(key) {
        if (key === 'box' || key === 'box-monitor') {
            this._placeBox();
            return;
        }
        if (LOOK_KEYS.has(key))
            this._refitText();
    }

    // ----- Ctrl+drag move

    _dragBegin(press) {
        this._drag = {press, start: {...this._box}, monitorIndex: this._monitorIndex};
        this._snapGuides = {x: [], y: []};
        this._updateOutline();
    }

    _dragMotion(pointer, {noSnap = false} = {}) {
        const drag = this._drag;
        const dx = pointer.x - drag.press.x;
        const dy = pointer.y - drag.press.y;
        const under = global.display.get_monitor_index_for_rect(
            new Mtk.Rectangle({x: Math.round(pointer.x), y: Math.round(pointer.y), width: 1, height: 1}));
        if (under >= 0)
            drag.monitorIndex = under;
        const area = this._workArea(drag.monitorIndex);
        const raw = movedBox(drag.start, dx, dy, area);
        if (noSnap) {
            this._snapGuides = {x: [], y: []};
            this._setBox(raw, drag.monitorIndex);
        } else {
            const snapped = snapBox(raw, area, SNAP_THRESHOLD);
            this._snapGuides = snapped.guides;
            this._setBox(snapped.box, drag.monitorIndex);
        }
    }

    _dragEnd(commit) {
        const drag = this._drag;
        this._drag = null;
        this._snapGuides = {x: [], y: []};
        const moved = ['x', 'y', 'width', 'height'].some(key => this._box[key] !== drag.start[key]);
        if (commit && moved) {
            const geometry = geometryFromBox(this._box, this._workArea(drag.monitorIndex));
            this._settings.set_int('box-monitor', drag.monitorIndex === Main.layoutManager.primaryIndex ? -1 : drag.monitorIndex);
            this._settings.set_value('box', new GLib.Variant('a{sd}', geometry));
        } else if (moved) {
            this._placeBox();
        }
        this._placeGrip();
        this._updateOutline();
    }

    _scrollSize(steps) {
        this.previewFontSize(this.fontSize * SCROLL_STEP_RATIO ** steps);
        if (this._scrollCommitId)
            GLib.source_remove(this._scrollCommitId);
        this._scrollCommitId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SCROLL_COMMIT_MS, () => {
            this._scrollCommitId = 0;
            this.commitFontSize();
            return GLib.SOURCE_REMOVE;
        });
    }
}
