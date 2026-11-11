// The pitch panel: its own box on the desktop, docked against a side of the
// lyric box or separate (pitch-dock), above normal windows and hidden over
// fullscreen windows and in the overview. Dragging an edge resizes it (a
// docked panel only from its edge away from the lyric); dragging it
// elsewhere moves it, and dropping it against a side of the lyric docks it
// there, while dragging a docked one away makes it separate. A right
// press opens the settings page.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Mtk from 'gi://Mtk';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {PitchView} from './pitch-view.js';
import {
    OUTER_EDGE, boxFromGeometry, dockedPanelBox, edgeResizedBox, geometryFromBox, movedBox, snappedDock,
} from './shared/overlay-geometry.js';

const EDGE_ZONE = 8;
const SNAP_DISTANCE = 24;
const GEOMETRY_KEYS = ['cx', 'cy', 'width', 'height'];
// The settings' ranges for the docked panel's thickness.
const DOCKED_HEIGHT_RANGE = [0.03, 0.6];
const DOCKED_WIDTH_RANGE = [0.05, 0.6];
const PLACEMENT_KEYS = new Set(['pitch-dock', 'pitch-docked-height', 'pitch-docked-width', 'pitch-box', 'pitch-box-monitor']);

function readBox(settings) {
    const geometry = settings.get_value('pitch-box').deepUnpack();
    for (const key of GEOMETRY_KEYS) {
        if (typeof geometry[key] !== 'number')
            throw new Error(`lyrics-overlay: setting "pitch-box" lacks ${key}`);
    }
    return geometry;
}

function clamp(value, [low, high]) {
    return Math.min(high, Math.max(low, value));
}

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

/** @param {'move'|{edges: Record<string, boolean>}|null} zone */
function cursorFor(zone) {
    if (zone === null)
        return Clutter.CursorType.INHERIT;
    if (zone === 'move')
        return Clutter.CursorType.MOVE;
    const vertical = ['top', 'bottom'].find(edge => zone.edges[edge]);
    const horizontal = ['left', 'right'].find(edge => zone.edges[edge]);
    return RESIZE_CURSORS[[vertical, horizontal].filter(Boolean).join('-')];
}

const PanelFrame = GObject.registerClass(
class PanelFrame extends St.Widget {
    /**
     * @param {{zoneAt: (point: {x: number, y: number}) => ('move'|{edges: object}),
     *          begin: Function, motion: Function, end: (commit: boolean) => void, menu: () => void}} handlers
     */
    _init(handlers) {
        super._init({reactive: true, visible: false, accessible_name: 'Pitch panel'});
        this._handlers = handlers;
        this._grab = null;
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
        this.set_cursor_type(zone === 'move' ? Clutter.CursorType.GRABBING : cursorFor(zone));
        this._handlers.begin(zone, {x, y});
        return Clutter.EVENT_STOP;
    }

    vfunc_motion_event(event) {
        const [x, y] = event.get_coords();
        if (!this._grab) {
            this.set_cursor_type(cursorFor(this._handlers.zoneAt({x, y})));
            return Clutter.EVENT_PROPAGATE;
        }
        this._handlers.motion({x, y});
        return Clutter.EVENT_STOP;
    }

    vfunc_button_release_event(event) {
        if (!this._grab || event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_STOP;
        this._finish(true);
        const [x, y] = event.get_coords();
        this.set_cursor_type(cursorFor(this._handlers.zoneAt({x, y})));
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
        this._grab.dismiss();
        this._grab = null;
        this.set_cursor_type(Clutter.CursorType.INHERIT);
        this._handlers.end(commit);
    }
});

export class PitchPanel {
    /**
     * @param {{settings: Gio.Settings, onContextMenu: () => void}} options
     */
    constructor({settings, onContextMenu}) {
        this._settings = settings;
        this._lyric = null;
        this._shown = false;
        this._drag = null;
        this._box = null;
        this._monitorIndex = Main.layoutManager.primaryIndex;

        // The layout manager owns the root's visibility (fullscreen
        // tracking); the panel's own visibility lives on the frame.
        this._root = new St.Widget({name: 'lyricsPitchPanel', reactive: false});
        this._frame = new PanelFrame({
            zoneAt: point => this._zoneAt(point),
            begin: (zone, press) => this._dragBegin(zone, press),
            motion: pointer => this._dragMotion(pointer),
            end: commit => this._dragEnd(commit),
            menu: () => onContextMenu(),
        });
        this._view = new PitchView(settings);
        this._frame.add_child(this._view);
        this._root.add_child(this._frame);
        Main.layoutManager.addChrome(this._root, {trackFullscreen: true});

        settings.connectObject('changed', (_settings, key) => {
            if (PLACEMENT_KEYS.has(key))
                this._place();
        }, this);
        Main.layoutManager.connectObject('monitors-changed', () => this._place(), this);
        global.display.connectObject('workareas-changed', () => this._place(), this);
        Main.overview.connectObject(
            'showing', () => this._syncVisible(),
            'hidden', () => this._syncVisible(), this);
    }

    destroy() {
        this._frame.cancelDrag();
        this._settings.disconnectObject(this);
        Main.layoutManager.disconnectObject(this);
        global.display.disconnectObject(this);
        Main.overview.disconnectObject(this);
        this._root.destroy();
    }

    /** Where the lyric box is; a docked panel follows it. */
    setLyricBox(box, monitorIndex) {
        this._lyric = {box: {...box}, monitorIndex};
        this._place();
    }

    setShown(shown) {
        if (shown === this._shown)
            return;
        this._shown = shown;
        if (!shown)
            this._view.clear();
        this._syncVisible();
    }

    pushFrames(frames) {
        if (this._shown)
            this._view.pushFrames(frames);
    }

    setStatus(text) {
        this._view.setStatus(text);
    }

    setSongKey(key) {
        this._view.setSongKey(key);
    }

    /** Stage box of the panel, for tests. */
    get box() {
        return this._box && {...this._box};
    }

    // ----- layout

    _monitorIndexSetting() {
        const stored = this._settings.get_int('pitch-box-monitor');
        return stored >= 0 && stored < Main.layoutManager.monitors.length ? stored : Main.layoutManager.primaryIndex;
    }

    _workArea(monitorIndex) {
        const area = Main.layoutManager.getWorkAreaForMonitor(monitorIndex);
        return {x: area.x, y: area.y, width: area.width, height: area.height};
    }

    _dockedThickness(dock, area) {
        return dock === 'below' || dock === 'above'
            ? this._settings.get_double('pitch-docked-height') * area.height
            : this._settings.get_double('pitch-docked-width') * area.width;
    }

    _place() {
        if (this._drag)
            return;
        const dock = this._settings.get_string('pitch-dock');
        if (dock === 'separate') {
            const monitorIndex = this._monitorIndexSetting();
            this._setBox(boxFromGeometry(readBox(this._settings), this._workArea(monitorIndex)), monitorIndex);
        } else if (this._lyric) {
            const area = this._workArea(this._lyric.monitorIndex);
            this._setBox(dockedPanelBox(this._lyric.box, dock, this._dockedThickness(dock, area), area), this._lyric.monitorIndex);
        }
        this._syncVisible();
    }

    _setBox(box, monitorIndex) {
        this._box = box;
        this._monitorIndex = monitorIndex;
        const width = Math.round(box.width);
        const height = Math.round(box.height);
        this._root.set_position(Math.round(box.x), Math.round(box.y));
        if (width !== this._root.width || height !== this._root.height) {
            for (const actor of [this._root, this._frame, this._view])
                actor.set_size(width, height);
        }
    }

    _syncVisible() {
        const visible = this._shown && this._box !== null && !Main.overview.visible;
        if (!visible)
            this._frame.cancelDrag();
        this._frame.visible = visible;
        this._view.visible = visible;
    }

    // ----- pointer

    _zoneAt(point) {
        const box = this._box;
        const near = {
            left: point.x - box.x < EDGE_ZONE,
            right: box.x + box.width - point.x <= EDGE_ZONE,
            top: point.y - box.y < EDGE_ZONE,
            bottom: box.y + box.height - point.y <= EDGE_ZONE,
        };
        const dock = this._settings.get_string('pitch-dock');
        if (dock !== 'separate') {
            const outer = OUTER_EDGE[dock];
            return near[outer] ? {edges: {[outer]: true}} : 'move';
        }
        const edges = Object.fromEntries(Object.entries(near).filter(([, isNear]) => isNear));
        return Object.keys(edges).length ? {edges} : 'move';
    }

    _dragBegin(zone, press) {
        this._drag = {zone, press, start: {...this._box}, monitorIndex: this._monitorIndex, moved: false, snap: null,
            dock: this._settings.get_string('pitch-dock')};
    }

    _dragMotion(pointer) {
        const drag = this._drag;
        const dx = pointer.x - drag.press.x;
        const dy = pointer.y - drag.press.y;
        if (!drag.moved) {
            const threshold = St.Settings.get().drag_threshold;
            if (Math.abs(dx) <= threshold && Math.abs(dy) <= threshold)
                return;
            drag.moved = true;
        }
        if (drag.zone !== 'move') {
            this._setBox(edgeResizedBox(drag.start, drag.zone.edges, dx, dy, this._workArea(drag.monitorIndex)), drag.monitorIndex);
            return;
        }
        const under = global.display.get_monitor_index_for_rect(
            new Mtk.Rectangle({x: Math.round(pointer.x), y: Math.round(pointer.y), width: 1, height: 1}));
        if (under >= 0)
            drag.monitorIndex = under;
        const moved = movedBox(drag.start, dx, dy, this._workArea(drag.monitorIndex));
        drag.snap = this._lyric ? snappedDock(moved, this._lyric.box, SNAP_DISTANCE) : null;
        if (drag.snap) {
            const area = this._workArea(this._lyric.monitorIndex);
            this._setBox(dockedPanelBox(this._lyric.box, drag.snap, this._dockedThickness(drag.snap, area), area), this._lyric.monitorIndex);
        } else {
            this._setBox(moved, drag.monitorIndex);
        }
    }

    _dragEnd(commit) {
        const drag = this._drag;
        this._drag = null;
        if (!commit || !drag.moved) {
            this._place();
            return;
        }
        // Each write re-places the panel, so the dock is written last: the
        // geometry it switches to is stored by then. (The settings object is
        // the whole extension's; delay() would hold back its writes for good.)
        const settings = this._settings;
        const box = this._box;
        const area = this._workArea(this._monitorIndex);
        if (drag.zone === 'move' && drag.snap) {
            settings.set_string('pitch-dock', drag.snap);
        } else if (drag.zone === 'move' || drag.dock === 'separate') {
            settings.set_value('pitch-box', new GLib.Variant('a{sd}', geometryFromBox(box, area)));
            settings.set_int('pitch-box-monitor', this._monitorIndex === Main.layoutManager.primaryIndex ? -1 : this._monitorIndex);
            settings.set_string('pitch-dock', 'separate');
        } else if (drag.dock === 'below' || drag.dock === 'above') {
            settings.set_double('pitch-docked-height', clamp(box.height / area.height, DOCKED_HEIGHT_RANGE));
        } else {
            settings.set_double('pitch-docked-width', clamp(box.width / area.width, DOCKED_WIDTH_RANGE));
        }
        this._place();
    }
}
