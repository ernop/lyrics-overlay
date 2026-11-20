// The lyric overlay: one line in a box above normal windows, hidden over
// fullscreen windows and in the overview.
//
// In normal playback, only the painted text (or backdrop) takes the pointer:
// a click goes to the song, a right press opens the settings page, Ctrl+drag
// moves the box, Alt+drag resizes it about its center, and Ctrl+scroll sizes
// the text. A click is never part of a drag: a plain press that travels past
// the drag threshold does nothing.
//
// In interactive adjust mode (overlay-adjust-mode), the whole box lights up
// with 8 corner/edge resize handles, drag-anywhere move with center-line
// magnetic snap, scroll-to-size, live dimensions readout, and a sample line
// whenever no timed lyric is playing.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Mtk from 'gi://Mtk';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    boxFromGeometry, boxZoneAt, clampFontSize, edgeResizedBox, geometryFromBox, movedBox, resizedBox, snapBox,
} from './shared/overlay-geometry.js';
import {fitLyric, paintLyric} from './text-layout.js';

const GRIP_MARGIN = 6;
const ADJUST_EDGE_ZONE = 16;
const SNAP_THRESHOLD = 12;
const SCROLL_STEP_RATIO = 1.06;
const SCROLL_COMMIT_MS = 500;
const DEFAULT_PREVIEW_TEXT = 'Amazing grace, how sweet the sound';

/** Fade durations in milliseconds for the outgoing and incoming line. */
export const TRANSITIONS = Object.freeze({
    'instant': {out: 0, in: 0},
    'fade-in': {out: 0, in: 150},
    'crossfade-quick': {out: 120, in: 120},
    'crossfade-soft': {out: 250, in: 250},
});

const GEOMETRY_KEYS = ['cx', 'cy', 'width', 'height'];

const LOOK_KEYS = new Set([
    'font-size', 'font-family', 'font-bold', 'font-weight', 'font-italic',
    'text-uppercase', 'text-letter-spacing', 'text-fit-mode', 'text-max-lines',
    'text-color', 'text-custom-color', 'text-opacity', 'text-border',
    'text-border-scale', 'text-border-color-mode', 'text-border-color',
    'text-shadow', 'text-backdrop', 'text-backdrop-color', 'text-backdrop-opacity',
    'text-backdrop-radius', 'text-backdrop-padding', 'text-align', 'text-valign',
]);

const RESIZE_CURSORS = {
    'top': Clutter.CursorType.N_RESIZE,
    'bottom': Clutter.CursorType.S_RESIZE,
    'left': Clutter.CursorType.W_RESIZE,
    'right': Clutter.CursorType.E_RESIZE,
    'top-left': Clutter.CursorType.NW_RESIZE,
    'top-right': Clutter.CursorType.NE_RESIZE,
    'bottom-left': Clutter.CursorType.SW_RESIZE,
    'bottom-right': Clutter.CursorType.SE_RESIZE,
};

function cursorForZone(zone, grabbing = false) {
    if (zone === null)
        return Clutter.CursorType.INHERIT;
    if (zone === 'move')
        return grabbing ? Clutter.CursorType.GRABBING : Clutter.CursorType.MOVE;
    const vertical = ['top', 'bottom'].find(edge => zone.edges[edge]);
    const horizontal = ['left', 'right'].find(edge => zone.edges[edge]);
    return RESIZE_CURSORS[[vertical, horizontal].filter(Boolean).join('-')] ?? Clutter.CursorType.ALL_RESIZE;
}

function zoneId(zone) {
    if (!zone || zone === 'move')
        return zone ?? '';
    return ['top', 'bottom', 'left', 'right'].filter(edge => zone.edges[edge]).join('-');
}

function readGeometry(settings) {
    const geometry = settings.get_value('box').deepUnpack();
    for (const key of GEOMETRY_KEYS) {
        if (typeof geometry[key] !== 'number')
            throw new Error(`lyrics-overlay: setting "box" lacks ${key}`);
    }
    return geometry;
}

function dragModeFor(state) {
    const control = Boolean(state & Clutter.ModifierType.CONTROL_MASK);
    const alt = Boolean(state & Clutter.ModifierType.MOD1_MASK);
    if (control && !alt)
        return 'move';
    if (alt && !control)
        return 'resize';
    return null;
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

const BoxOutline = GObject.registerClass(
class BoxOutline extends St.DrawingArea {
    _init() {
        super._init({reactive: false, visible: false});
        this._adjust = false;
        this._activeZone = null;
        this._hudText = '';
        this._snappedX = false;
        this._snappedY = false;
    }

    setAppearance({adjust, activeZone = null, hudText = '', snappedX = false, snappedY = false}) {
        this._adjust = adjust;
        this._activeZone = activeZone;
        this._hudText = hudText;
        this._snappedX = snappedX;
        this._snappedY = snappedY;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        if (width < 4 || height < 4) {
            cr.$dispose();
            return;
        }
        if (this._adjust) {
            cr.setSourceRGBA(0, 0, 0, 0.28);
            cr.rectangle(0, 0, width, height);
            cr.fill();
        }
        // High-contrast outer frame
        cr.rectangle(2, 2, width - 4, height - 4);
        cr.setSourceRGBA(0, 0, 0, 1);
        cr.setLineWidth(4);
        cr.strokePreserve();
        cr.setSourceRGBA(this._adjust ? 0.38 : 1, this._adjust ? 0.65 : 1, 1, 1);
        cr.setLineWidth(2);
        cr.stroke();

        // Magnetic center-snap guide lines across the box
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

        // 8 resize handles in adjust mode
        if (this._adjust) {
            const activeId = zoneId(this._activeZone);
            const corner = 12;
            const edgeLong = Math.min(28, Math.max(12, Math.round(width * 0.08)));
            const edgeTall = Math.min(24, Math.max(10, Math.round(height * 0.22)));
            const edgeThick = 7;
            const handles = [
                {id: 'top-left', x: 1, y: 1, w: corner, h: corner},
                {id: 'top-right', x: width - corner - 1, y: 1, w: corner, h: corner},
                {id: 'bottom-left', x: 1, y: height - corner - 1, w: corner, h: corner},
                {id: 'bottom-right', x: width - corner - 1, y: height - corner - 1, w: corner, h: corner},
                {id: 'top', x: Math.round((width - edgeLong) / 2), y: 1, w: edgeLong, h: edgeThick},
                {id: 'bottom', x: Math.round((width - edgeLong) / 2), y: height - edgeThick - 1, w: edgeLong, h: edgeThick},
                {id: 'left', x: 1, y: Math.round((height - edgeTall) / 2), w: edgeThick, h: edgeTall},
                {id: 'right', x: width - edgeThick - 1, y: Math.round((height - edgeTall) / 2), w: edgeThick, h: edgeTall},
            ];
            for (const handle of handles) {
                const hot = activeId === handle.id;
                roundedRect(cr, handle.x, handle.y, handle.w, handle.h, 3);
                cr.setSourceRGBA(hot ? 0.15 : 1, hot ? 0.39 : 1, hot ? 0.92 : 1, 1);
                cr.fillPreserve();
                cr.setSourceRGBA(0, 0, 0, 1);
                cr.setLineWidth(1.5);
                cr.stroke();
            }
        }

        // Compact pure-white-on-black HUD telemetry pill
        if (this._hudText && height >= 42 && width >= 150) {
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

const TextGrip = GObject.registerClass(
class TextGrip extends St.Widget {
    /**
     * @param {{begin: Function, motion: Function, end: Function, scroll: Function,
     *          click: () => void, menu: () => void}} handlers
     */
    _init(handlers) {
        super._init({reactive: true, visible: false});
        this._handlers = handlers;
        this._grab = null;
        // While the primary button is held: 'move' or 'resize' (a modifier
        // drag), 'click' (a plain press still within the drag threshold) or
        // 'stray' (a plain press that travelled; its release does nothing).
        this._mode = null;
        this._press = null;
    }

    get dragging() {
        return this._mode === 'move' || this._mode === 'resize';
    }

    vfunc_button_press_event(event) {
        if (this._grab)
            return Clutter.EVENT_STOP;
        const [x, y] = event.get_coords();
        if (event.get_button() === Clutter.BUTTON_SECONDARY) {
            this._handlers.menu();
            return Clutter.EVENT_STOP;
        }
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_STOP;
        this._mode = dragModeFor(event.get_state()) ?? 'click';
        this._press = {x, y};
        this._grab = global.stage.grab(this);
        if (this.dragging) {
            this.set_cursor_type(this._mode === 'move' ? Clutter.CursorType.GRABBING : Clutter.CursorType.ALL_RESIZE);
            this._handlers.begin(this._mode, {x, y});
        }
        return Clutter.EVENT_STOP;
    }

    vfunc_motion_event(event) {
        if (!this._grab) {
            this._hoverCursor(event.get_state());
            return Clutter.EVENT_PROPAGATE;
        }
        const [x, y] = event.get_coords();
        if (this.dragging) {
            this._handlers.motion({x, y});
        } else if (this._mode === 'click') {
            const threshold = St.Settings.get().drag_threshold;
            if (Math.abs(x - this._press.x) > threshold || Math.abs(y - this._press.y) > threshold)
                this._mode = 'stray';
        }
        return Clutter.EVENT_STOP;
    }

    vfunc_button_release_event(event) {
        if (!this._grab || event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_STOP;
        const mode = this._mode;
        this._finish(true);
        if (mode === 'click')
            this._handlers.click();
        this._hoverCursor(event.get_state());
        return Clutter.EVENT_STOP;
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

    vfunc_leave_event(event) {
        if (!this._grab)
            this.set_cursor_type(Clutter.CursorType.INHERIT);
        return super.vfunc_leave_event(event);
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

    _hoverCursor(state) {
        const mode = dragModeFor(state);
        if (mode === 'move')
            this.set_cursor_type(Clutter.CursorType.MOVE);
        else if (mode === 'resize')
            this.set_cursor_type(Clutter.CursorType.ALL_RESIZE);
        else
            this.set_cursor_type(Clutter.CursorType.INHERIT);
    }
});

/**
 * Full-box interactive grip active only during overlay-adjust-mode:
 * drag any of 8 edges/corners to resize, drag anywhere inside to move
 * with magnetic center snap, scroll anywhere to size text, Escape to exit.
 */
const AdjustGrip = GObject.registerClass(
class AdjustGrip extends St.Widget {
    _init(handlers) {
        super._init({reactive: true, visible: false, accessible_name: 'Lyric box adjust handles'});
        this._handlers = handlers;
        this._grab = null;
        this._hoverZoneId = '';
    }

    get dragging() {
        return Boolean(this._grab);
    }

    vfunc_button_press_event(event) {
        if (this._grab)
            return Clutter.EVENT_STOP;
        const [x, y] = event.get_coords();
        if (event.get_button() === Clutter.BUTTON_SECONDARY) {
            this._handlers.menu();
            return Clutter.EVENT_STOP;
        }
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_STOP;
        const zone = this._handlers.zoneAt({x, y});
        this._grab = global.stage.grab(this);
        this.set_cursor_type(cursorForZone(zone, true));
        this._handlers.begin(zone, {x, y});
        return Clutter.EVENT_STOP;
    }

    vfunc_motion_event(event) {
        const [x, y] = event.get_coords();
        if (!this._grab) {
            const zone = this._handlers.zoneAt({x, y});
            this.set_cursor_type(cursorForZone(zone, false));
            const nextId = zoneId(zone);
            if (nextId !== this._hoverZoneId) {
                this._hoverZoneId = nextId;
                this._handlers.hover(zone);
            }
            return Clutter.EVENT_PROPAGATE;
        }
        const noSnap = Boolean(event.get_state() & Clutter.ModifierType.SHIFT_MASK);
        this._handlers.motion({x, y}, {noSnap});
        return Clutter.EVENT_STOP;
    }

    vfunc_button_release_event(event) {
        if (!this._grab || event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_STOP;
        this._finish(true);
        const [x, y] = event.get_coords();
        const zone = this._handlers.zoneAt({x, y});
        this.set_cursor_type(cursorForZone(zone, false));
        this._hoverZoneId = zoneId(zone);
        this._handlers.hover(zone);
        return Clutter.EVENT_STOP;
    }

    vfunc_key_press_event(event) {
        if (event.get_key_symbol() === Clutter.KEY_Escape) {
            if (this._grab)
                this._finish(false);
            this._handlers.exit();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    vfunc_scroll_event(event) {
        if (this._grab)
            return Clutter.EVENT_STOP;
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

    vfunc_leave_event(event) {
        if (!this._grab) {
            this.set_cursor_type(Clutter.CursorType.INHERIT);
            if (this._hoverZoneId !== '') {
                this._hoverZoneId = '';
                this._handlers.hover(null);
            }
        }
        return super.vfunc_leave_event(event);
    }

    cancelDrag() {
        if (this._grab)
            this._finish(false);
    }

    _finish(commit) {
        this._grab.dismiss();
        this._grab = null;
        this.set_cursor_type(Clutter.CursorType.INHERIT);
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
        this._shown = false;
        this._drag = null;
        this._hoverZone = null;
        this._snapGuides = {x: [], y: []};
        this._box = null;
        this._monitorIndex = Main.layoutManager.primaryIndex;
        this._textSize = {width: 0, height: 0};

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
        this._outline = new BoxOutline();
        this._grip = new TextGrip({
            begin: (mode, press) => this._dragBegin(mode, press),
            motion: pointer => this._dragMotion(pointer),
            end: commit => this._dragEnd(commit),
            scroll: steps => this._scrollSize(steps),
            click: () => onClick(),
            menu: () => onContextMenu(),
        });
        this._adjustGrip = new AdjustGrip({
            zoneAt: point => boxZoneAt(point, this._box, ADJUST_EDGE_ZONE),
            hover: zone => {
                this._hoverZone = zone;
                this._updateOutline();
            },
            begin: (zone, press) => this._adjustBegin(zone, press),
            motion: (pointer, opts) => this._adjustMotion(pointer, opts),
            end: commit => this._adjustEnd(commit),
            scroll: steps => this._scrollSize(steps),
            menu: () => onContextMenu(),
            exit: () => this._settings.set_boolean('overlay-adjust-mode', false),
        });
        for (const child of [this._textArea, this._outline, this._grip, this._adjustGrip])
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
        this._syncAdjustMode();
    }

    destroy() {
        this._grip.cancelDrag();
        this._adjustGrip.cancelDrag();
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

    get adjustMode() {
        return this._settings.get_boolean('overlay-adjust-mode');
    }

    setShown(shown) {
        this._shown = shown;
        this._syncVisible();
    }

    /** Stage box of the lyric, whether or not it shows. */
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
        const shownText = this._effectiveText();
        if (line.key !== previous.key)
            this._crossTo(shownText);
        else if (shownText !== this._layers[this._current].text)
            this._fitLayer(this._layers[this._current], shownText);
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

    _effectiveText() {
        if (this._line.text)
            return this._line.text;
        if (this.adjustMode)
            return this._settings.get_string('overlay-preview-text').trim() || DEFAULT_PREVIEW_TEXT;
        return '';
    }

    _monitorIndexSetting() {
        const stored = this._settings.get_int('box-monitor');
        return stored >= 0 && stored < Main.layoutManager.monitors.length ? stored : Main.layoutManager.primaryIndex;
    }

    _workArea(monitorIndex) {
        const area = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
        return {x: area.x, y: area.y, width: area.width, height: area.height};
    }

    _placeBox() {
        if (this._drag)
            return;
        const monitorIndex = this._monitorIndexSetting();
        this._setBox(boxFromGeometry(readGeometry(this._settings), this._workArea(monitorIndex)), monitorIndex);
    }

    _setBox(box, monitorIndex) {
        this._box = box;
        this._monitorIndex = monitorIndex;
        const width = Math.round(box.width);
        const height = Math.round(box.height);
        this._root.set_position(Math.round(box.x), Math.round(box.y));
        if (width !== this._root.width || height !== this._root.height) {
            for (const actor of [this._root, this._content, this._outline, this._adjustGrip, this._textArea, ...this._layers])
                actor.set_size(width, height);
            this._textSize = {width, height};
            this._refitText();
        }
        this._updateOutline();
        this._onBoxChanged(box, monitorIndex);
    }

    _textParams() {
        const s = this._settings;
        const family = s.get_string('font-family') ||
            Pango.FontDescription.from_string(St.Settings.get().font_name).get_family();
        return {
            fontSize: this.fontSize,
            family,
            bold: s.get_boolean('font-bold'),
            fontWeight: s.get_int('font-weight'),
            italic: s.get_boolean('font-italic'),
            uppercase: s.get_boolean('text-uppercase'),
            letterSpacing: s.get_double('text-letter-spacing'),
            fitMode: s.get_string('text-fit-mode'),
            maxLines: s.get_int('text-max-lines'),
            color: s.get_string('text-color'),
            customColor: s.get_string('text-custom-color'),
            textOpacity: s.get_double('text-opacity'),
            border: s.get_string('text-border'),
            borderScale: s.get_double('text-border-scale'),
            borderColorMode: s.get_string('text-border-color-mode'),
            borderColor: s.get_string('text-border-color'),
            shadow: s.get_double('text-shadow'),
            backdrop: s.get_string('text-backdrop'),
            backdropColor: s.get_string('text-backdrop-color'),
            backdropOpacity: s.get_double('text-backdrop-opacity'),
            backdropRadius: s.get_int('text-backdrop-radius'),
            backdropPadding: s.get_int('text-backdrop-padding'),
            align: s.get_string('text-align'),
            valign: s.get_string('text-valign'),
            width: this._textSize.width,
            height: this._textSize.height,
        };
    }

    _fitLayer(layer, text) {
        layer.setFitted(text, text ? fitLyric(this._measure, text, this._textParams()) : null);
    }

    _refitText() {
        // A faded-out layer is refitted when it next takes a line
        // (_crossTo), so a resize step fits and paints only what shows.
        for (const [index, layer] of this._layers.entries()) {
            if (index === this._current || layer.opacity > 0)
                this._fitLayer(layer, layer.text);
        }
        this._placeGrip();
        this._updateOutline();
    }

    _crossTo(text) {
        const fade = this._content.visible ? TRANSITIONS[this._settings.get_string('transition')] : TRANSITIONS.instant;
        const outgoing = this._layers[this._current];
        this._current = 1 - this._current;
        const incoming = this._layers[this._current];
        outgoing.remove_all_transitions();
        incoming.remove_all_transitions();
        if (fade.out > 0 && outgoing.text) {
            outgoing.ease({opacity: 0, duration: fade.out, mode: Clutter.AnimationMode.EASE_OUT_QUAD, animationRequired: true});
        } else {
            outgoing.opacity = 0;
        }
        this._fitLayer(incoming, text);
        this._textArea.set_child_above_sibling(incoming, null);
        if (fade.in > 0 && text) {
            incoming.opacity = 0;
            incoming.ease({opacity: 255, duration: fade.in, mode: Clutter.AnimationMode.EASE_OUT_QUAD, animationRequired: true});
        } else {
            incoming.opacity = 255;
        }
    }

    _placeGrip() {
        if (this.adjustMode) {
            this._grip.visible = false;
            return;
        }
        if (this._grip.dragging)
            return;
        const fitted = this._layers[this._current].fitted;
        if (!fitted) {
            this._grip.visible = false;
            return;
        }
        const box = fitted.inkBox;
        const left = Math.max(0, Math.floor(box.x - GRIP_MARGIN));
        const top = Math.max(0, Math.floor(box.y - GRIP_MARGIN));
        const right = Math.min(this._textSize.width, Math.ceil(box.x + box.width + GRIP_MARGIN));
        const bottom = Math.min(this._textSize.height, Math.ceil(box.y + box.height + GRIP_MARGIN));
        this._grip.set_position(left, top);
        this._grip.set_size(Math.max(1, right - left), Math.max(1, bottom - top));
        this._grip.visible = true;
    }

    _hudSummary() {
        if (!this._box)
            return '';
        const area = this._workArea(this._monitorIndex);
        const w = Math.round(this._box.width);
        const h = Math.round(this._box.height);
        const wp = Math.round(this._box.width / area.width * 100);
        const hp = Math.round(this._box.height / area.height * 100);
        const fitted = this._layers[this._current].fitted;
        const sizeText = fitted
            ? fitted.clamped
                ? `${Math.round(fitted.spec.fontSize)}/${Math.round(fitted.targetFontSize)} px (box limited)`
                : `${Math.round(fitted.spec.fontSize)} px`
            : `${Math.round(this.fontSize)} px`;
        return `${w}\u00d7${h} px (${wp}%\u00d7${hp}%) \u00b7 ${sizeText}`;
    }

    _updateOutline() {
        const adjust = this.adjustMode;
        const active = adjust || Boolean(this._drag);
        this._outline.visible = active;
        if (!active)
            return;
        const area = this._workArea(this._monitorIndex);
        const centerX = area.x + area.width / 2;
        const centerY = area.y + area.height / 2;
        this._outline.setAppearance({
            adjust,
            activeZone: this._drag?.zone ?? this._hoverZone,
            hudText: this._hudSummary(),
            snappedX: this._snapGuides.x.some(gx => Math.abs(gx - centerX) <= 1),
            snappedY: this._snapGuides.y.some(gy => Math.abs(gy - centerY) <= 1),
        });
    }

    _syncAdjustMode() {
        const adjust = this.adjustMode;
        if (!adjust) {
            this._adjustGrip.cancelDrag();
            this._hoverZone = null;
            this._snapGuides = {x: [], y: []};
        }
        this._adjustGrip.visible = adjust;
        const text = this._effectiveText();
        const layer = this._layers[this._current];
        if (text !== layer.text) {
            layer.remove_all_transitions();
            layer.opacity = 255;
            this._fitLayer(layer, text);
        }
        this._placeGrip();
        this._updateOutline();
    }

    _syncVisible() {
        const visible = this._shown && !Main.overview.visible;
        if (!visible) {
            this._grip.cancelDrag();
            this._adjustGrip.cancelDrag();
        }
        this._content.visible = visible;
    }

    _onSettingChanged(key) {
        if (key === 'box' || key === 'box-monitor') {
            this._placeBox();
            return;
        }
        if (key === 'overlay-adjust-mode' || key === 'overlay-preview-text') {
            this._syncAdjustMode();
            return;
        }
        if (LOOK_KEYS.has(key))
            this._refitText();
    }

    // ----- pointer (normal playback mode)

    _dragBegin(mode, press) {
        this._drag = {kind: 'normal', mode, press, start: {...this._box}, monitorIndex: this._monitorIndex};
        this._updateOutline();
    }

    _dragMotion(pointer) {
        const drag = this._drag;
        if (drag.mode === 'move') {
            const under = global.display.get_monitor_index_for_rect(
                new Mtk.Rectangle({x: Math.round(pointer.x), y: Math.round(pointer.y), width: 1, height: 1}));
            if (under >= 0)
                drag.monitorIndex = under;
            const box = movedBox(drag.start, pointer.x - drag.press.x, pointer.y - drag.press.y, this._workArea(drag.monitorIndex));
            this._setBox(box, drag.monitorIndex);
        } else {
            this._setBox(resizedBox(drag.start, drag.press, pointer, this._workArea(drag.monitorIndex)), drag.monitorIndex);
        }
    }

    _dragEnd(commit) {
        const drag = this._drag;
        this._drag = null;
        this._snapGuides = {x: [], y: []};
        this._commitOrRestore(drag, commit);
        this._placeGrip();
        this._updateOutline();
    }

    // ----- pointer (interactive adjust mode)

    _adjustBegin(zone, press) {
        this._drag = {kind: 'adjust', zone, press, start: {...this._box}, monitorIndex: this._monitorIndex};
        this._snapGuides = {x: [], y: []};
        this._updateOutline();
    }

    _adjustMotion(pointer, {noSnap = false} = {}) {
        const drag = this._drag;
        const dx = pointer.x - drag.press.x;
        const dy = pointer.y - drag.press.y;
        if (drag.zone === 'move') {
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
        } else {
            this._snapGuides = {x: [], y: []};
            const area = this._workArea(drag.monitorIndex);
            this._setBox(edgeResizedBox(drag.start, drag.zone.edges, dx, dy, area), drag.monitorIndex);
        }
    }

    _adjustEnd(commit) {
        const drag = this._drag;
        this._drag = null;
        this._snapGuides = {x: [], y: []};
        this._commitOrRestore(drag, commit);
        this._updateOutline();
    }

    _commitOrRestore(drag, commit) {
        const moved = ['x', 'y', 'width', 'height'].some(key => this._box[key] !== drag.start[key]);
        if (commit && moved) {
            const geometry = geometryFromBox(this._box, this._workArea(drag.monitorIndex));
            this._settings.set_int('box-monitor', drag.monitorIndex === Main.layoutManager.primaryIndex ? -1 : drag.monitorIndex);
            this._settings.set_value('box', new GLib.Variant('a{sd}', geometry));
        } else if (moved) {
            this._placeBox();
        }
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
