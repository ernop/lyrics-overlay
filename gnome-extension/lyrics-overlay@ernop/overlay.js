// The lyric overlay: one line in a box above normal windows, hidden over
// fullscreen windows and in the overview. Only the painted text takes the
// pointer: a click goes to the song, a right press opens the menu,
// Ctrl+drag moves the box, Alt+drag resizes it about its center, and
// Ctrl+scroll sizes the text. A click is never part of a drag: a plain
// press that travels past the drag threshold does nothing.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Mtk from 'gi://Mtk';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {PitchView} from './pitch-view.js';
import {boxFromGeometry, clampFontSize, geometryFromBox, movedBox, resizedBox} from './shared/overlay-geometry.js';
import {fitLyric, paintLyric} from './text-layout.js';

const PITCH_SHARE = 0.45;
const GRIP_MARGIN = 6;
const SCROLL_STEP_RATIO = 1.06;
const SCROLL_COMMIT_MS = 500;

/** Fade durations in milliseconds for the outgoing and incoming line. */
export const TRANSITIONS = Object.freeze({
    'instant': {out: 0, in: 0},
    'fade-in': {out: 0, in: 150},
    'crossfade-quick': {out: 120, in: 120},
    'crossfade-soft': {out: 250, in: 250},
});

const GEOMETRY_KEYS = ['cx', 'cy', 'width', 'height'];

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
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        cr.rectangle(2, 2, width - 4, height - 4);
        cr.setSourceRGBA(0, 0, 0, 1);
        cr.setLineWidth(4);
        cr.strokePreserve();
        cr.setSourceRGBA(1, 1, 1, 1);
        cr.setLineWidth(2);
        cr.stroke();
        cr.$dispose();
    }
});

const TextGrip = GObject.registerClass(
class TextGrip extends St.Widget {
    /**
     * @param {{begin: Function, motion: Function, end: Function, scroll: Function,
     *          click: () => void, menu: (point: {x: number, y: number}) => void}} handlers
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
            this._handlers.menu({x, y});
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

export class LyricsOverlay {
    /**
     * @param {{settings: Gio.Settings, onClick: () => void,
     *          onContextMenu: (point: {x: number, y: number}) => void}} options
     */
    constructor({settings, onClick, onContextMenu}) {
        this._settings = settings;
        this._measure = PangoCairo.FontMap.get_default().create_context();
        this._fontSizePreview = null;
        this._scrollCommitId = 0;
        this._line = {text: '', key: 'none'};
        this._shown = false;
        this._pitchShown = false;
        this._drag = null;
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
        this._pitch = new PitchView();
        this._outline = new BoxOutline();
        this._grip = new TextGrip({
            begin: (mode, press) => this._dragBegin(mode, press),
            motion: pointer => this._dragMotion(pointer),
            end: commit => this._dragEnd(commit),
            scroll: steps => this._scrollSize(steps),
            click: () => onClick(),
            menu: point => onContextMenu(point),
        });
        for (const child of [this._textArea, this._pitch, this._outline, this._grip])
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

    setPitchShown(shown) {
        if (shown === this._pitchShown)
            return;
        this._pitchShown = shown;
        if (!shown)
            this._pitch.clear();
        this._layoutRegions();
    }

    pushPitch(frames) {
        if (this._pitchShown)
            this._pitch.pushFrames(frames);
    }

    setPitchStatus(text) {
        this._pitch.setStatus(text);
    }

    /** @param {{text: string, key: string}} line */
    setLine(line) {
        const previous = this._line;
        this._line = line;
        if (line.key !== previous.key)
            this._crossTo(line.text);
        else if (line.text !== previous.text)
            this._fitLayer(this._layers[this._current], line.text);
        this._placeGrip();
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
            this._root.set_size(width, height);
            this._content.set_size(width, height);
            this._outline.set_size(width, height);
            this._layoutRegions();
        }
    }

    _layoutRegions() {
        const width = Math.round(this._box.width);
        const height = Math.round(this._box.height);
        const textHeight = this._pitchShown ? Math.round(height * (1 - PITCH_SHARE)) : height;
        this._textSize = {width, height: textHeight};
        this._textArea.set_size(width, textHeight);
        for (const layer of this._layers)
            layer.set_size(width, textHeight);
        this._pitch.set_position(0, textHeight);
        this._pitch.set_size(width, height - textHeight);
        this._pitch.visible = this._pitchShown;
        this._refitText();
    }

    _textParams() {
        const family = this._settings.get_string('font-family') ||
            Pango.FontDescription.from_string(St.Settings.get().font_name).get_family();
        return {
            fontSize: this.fontSize,
            family,
            bold: this._settings.get_boolean('font-bold'),
            color: this._settings.get_string('text-color'),
            border: this._settings.get_string('text-border'),
            align: this._settings.get_string('text-align'),
            width: this._textSize.width,
            height: this._textSize.height,
        };
    }

    _fitLayer(layer, text) {
        layer.setFitted(text, text ? fitLyric(this._measure, text, this._textParams()) : null);
    }

    _refitText() {
        for (const layer of this._layers)
            this._fitLayer(layer, layer.text);
        this._placeGrip();
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

    _syncVisible() {
        const visible = this._shown && !Main.overview.visible;
        if (!visible)
            this._grip.cancelDrag();
        this._content.visible = visible;
    }

    _onSettingChanged(key) {
        switch (key) {
        case 'box':
        case 'box-monitor':
            this._placeBox();
            break;
        case 'font-size':
        case 'font-family':
        case 'font-bold':
        case 'text-color':
        case 'text-border':
        case 'text-align':
            this._refitText();
            break;
        }
    }

    // ----- pointer

    _dragBegin(mode, press) {
        this._drag = {mode, press, start: {...this._box}, monitorIndex: this._monitorIndex};
        this._outline.visible = true;
        this._outline.queue_repaint();
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
            this._outline.queue_repaint();
        }
    }

    _dragEnd(commit) {
        const drag = this._drag;
        this._drag = null;
        this._outline.visible = false;
        const moved = ['x', 'y', 'width', 'height'].some(key => this._box[key] !== drag.start[key]);
        if (commit && moved) {
            const geometry = geometryFromBox(this._box, this._workArea(drag.monitorIndex));
            this._settings.set_int('box-monitor', drag.monitorIndex === Main.layoutManager.primaryIndex ? -1 : drag.monitorIndex);
            this._settings.set_value('box', new GLib.Variant('a{sd}', geometry));
        } else if (moved) {
            this._placeBox();
        }
        this._placeGrip();
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
