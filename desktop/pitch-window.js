// Standalone XWayland pitch panel window.
// Shares the exact Cairo/Pango rendering from shared/pitch-painter.js and
// matches gnome-extension/lyrics-overlay@ernop/pitch-panel.js interaction:
// - Docks against any side of the lyric box or stands separate on any monitor.
// - Plain clicks and drags never move or resize it.
// - Ctrl+drag on an edge resizes (outer edge only when docked, all 8 edges
//   when separate); Ctrl+drag on the body moves, docks, or detaches; Escape
//   cancels; Ctrl+press without movement does nothing.
// - Secondary press opens the settings page.

import Cairo from 'cairo';
import Gdk from 'gi://Gdk?version=3.0';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=3.0';

import {
    OUTER_EDGE, boxFromGeometry, dockedPanelBox, edgeResizedBox, geometryFromBox, movedBox, snappedDock,
} from '../shared/overlay-geometry.js';
import {PitchPainter} from '../shared/pitch-painter.js';

const EDGE_ZONE = 8;
const SNAP_DISTANCE = 24;
const GEOMETRY_KEYS = ['cx', 'cy', 'width', 'height'];
const DOCKED_HEIGHT_RANGE = [0.03, 0.6];
const DOCKED_WIDTH_RANGE = [0.05, 0.6];
const PLACEMENT_KEYS = new Set(['pitch-dock', 'pitch-docked-height', 'pitch-docked-width', 'pitch-box', 'pitch-box-monitor']);

const RESIZE_CURSORS = {
    'top': 'n-resize',
    'bottom': 's-resize',
    'left': 'w-resize',
    'right': 'e-resize',
    'top-left': 'nw-resize',
    'top-right': 'ne-resize',
    'bottom-left': 'sw-resize',
    'bottom-right': 'se-resize',
};

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

function cursorFor(zone) {
    if (zone === null)
        return null;
    if (zone === 'move')
        return 'move';
    const vertical = ['top', 'bottom'].find(edge => zone.edges[edge]);
    const horizontal = ['left', 'right'].find(edge => zone.edges[edge]);
    return RESIZE_CURSORS[[vertical, horizontal].filter(Boolean).join('-')] ?? null;
}

export class PitchWindow {
    /**
     * @param {{settings: Gio.Settings, monitors: import('./monitors.js').MonitorManager,
     *          onContextMenu: () => void}} options
     */
    constructor({settings, monitors, onContextMenu}) {
        this._settings = settings;
        this._monitors = monitors;
        this._onContextMenu = onContextMenu;
        this._lyric = null;
        this._shown = false;
        this._drag = null;
        this._box = null;
        this._monitorIndex = monitors.primaryIndex;

        this._win = new Gtk.Window({type: Gtk.WindowType.TOPLEVEL});
        this._win.set_title('Lyrics overlay pitch panel');
        this._win.set_type_hint(Gdk.WindowTypeHint.NOTIFICATION);
        this._win.set_decorated(false);
        this._win.set_app_paintable(true);
        this._win.set_focus_on_map(false);
        this._win.set_accept_focus(true);
        this._win.set_skip_taskbar_hint(true);
        this._win.set_skip_pager_hint(true);
        this._win.set_keep_above(true);
        this._win.stick();

        const visual = this._win.get_screen().get_rgba_visual();
        if (visual)
            this._win.set_visual(visual);

        this._area = new Gtk.DrawingArea();
        this._area.add_events(
            Gdk.EventMask.BUTTON_PRESS_MASK
            | Gdk.EventMask.BUTTON_RELEASE_MASK
            | Gdk.EventMask.POINTER_MOTION_MASK
            | Gdk.EventMask.LEAVE_NOTIFY_MASK,
        );
        this._win.add_events(Gdk.EventMask.KEY_PRESS_MASK);
        this._win.add(this._area);

        this._painter = new PitchPainter({
            settings,
            onRedraw: () => {
                if (this._shown && this._win.get_visible())
                    this._area.queue_draw();
            },
        });

        this._area.connect('draw', (_w, cr) => this._onDraw(cr));
        this._area.connect('button-press-event', (_w, ev) => this._onButtonPress(ev));
        this._area.connect('motion-notify-event', (_w, ev) => this._onMotion(ev));
        this._area.connect('button-release-event', (_w, ev) => this._onButtonRelease(ev));
        this._area.connect('leave-notify-event', () => {
            if (!this._drag)
                this._setCursor(null);
            return false;
        });
        this._win.connect('key-press-event', (_w, ev) => this._onKeyPress(ev));
        this._win.connect('map-event', () => {
            if (this._box)
                this._win.move(Math.round(this._box.x), Math.round(this._box.y));
            return false;
        });

        this._settingsId = settings.connect('changed', (_s, key) => {
            if (PLACEMENT_KEYS.has(key))
                this._place();
        });
        this._disconnectMonitors = monitors.onChanged(() => this._place());
    }

    destroy() {
        this._cancelDrag();
        this._painter.destroy();
        if (this._settingsId) {
            this._settings.disconnect(this._settingsId);
            this._settingsId = 0;
        }
        this._disconnectMonitors?.();
        this._win.destroy();
    }

    get visible() {
        return this._shown && this._box !== null;
    }

    get box() {
        return this._box ? {...this._box} : null;
    }

    setLyricBox(box, monitorIndex) {
        this._lyric = {box: {...box}, monitorIndex};
        this._place();
    }

    setShown(shown) {
        const next = Boolean(shown);
        if (next === this._shown)
            return;
        this._shown = next;
        if (!next)
            this._painter.clear();
        this._syncVisible();
    }

    pushFrames(frames) {
        if (this._shown)
            this._painter.pushFrames(frames);
    }

    setStatus(text) {
        this._painter.setStatus(text);
    }

    setSongKey(key) {
        this._painter.setSongKey(key);
    }

    // ----- layout

    _monitorIndexSetting() {
        return this._monitors.indexForSetting(this._settings.get_int('pitch-box-monitor'));
    }

    _workArea(monitorIndex) {
        return this._monitors.workArea(monitorIndex);
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
        const prev = this._box;
        this._box = box;
        this._monitorIndex = monitorIndex;
        const x = Math.round(box.x);
        const y = Math.round(box.y);
        const width = Math.max(1, Math.round(box.width));
        const height = Math.max(1, Math.round(box.height));
        const sizeChanged = !prev || Math.round(prev.width) !== width || Math.round(prev.height) !== height;
        if (sizeChanged) {
            this._area.set_size_request(width, height);
            this._win.set_size_request(width, height);
            this._win.resize(width, height);
        }
        this._win.move(x, y);
        if (this._win.get_visible())
            this._area.queue_draw();
    }

    _syncVisible() {
        if (this.visible) {
            if (!this._win.get_visible()) {
                this._win.show_all();
                this._win.move(Math.round(this._box.x), Math.round(this._box.y));
            }
        } else {
            this._cancelDrag();
            if (this._win.get_visible())
                this._win.hide();
        }
    }

    // ----- drawing

    _onDraw(cr) {
        cr.setOperator(Cairo.Operator.SOURCE);
        cr.setSourceRGBA(0, 0, 0, 0);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);
        if (this._box)
            this._painter.paint(cr, Math.max(1, Math.round(this._box.width)), Math.max(1, Math.round(this._box.height)));
        return false;
    }

    // ----- pointer

    _setCursor(name) {
        const gdkWin = this._win.get_window();
        if (!gdkWin)
            return;
        const cursor = name ? Gdk.Cursor.new_from_name(gdkWin.get_display(), name) : null;
        gdkWin.set_cursor(cursor);
    }

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

    _onButtonPress(ev) {
        if (ev.get_event_type() !== Gdk.EventType.BUTTON_PRESS)
            return true;
        if (this._drag)
            return true;
        const [, button] = ev.get_button();
        if (button === 3) {
            this._onContextMenu();
            return true;
        }
        if (button !== 1)
            return true;
        const [, state] = ev.get_state();
        if (!(state & Gdk.ModifierType.CONTROL_MASK))
            return true;
        const [, rx, ry] = ev.get_root_coords();
        const zone = this._zoneAt({x: rx, y: ry});
        this._setCursor(zone === 'move' ? 'grabbing' : cursorFor(zone));
        this._drag = {
            zone,
            press: {x: rx, y: ry},
            start: {...this._box},
            monitorIndex: this._monitorIndex,
            moved: false,
            snap: null,
            dock: this._settings.get_string('pitch-dock'),
        };
        return true;
    }

    _onMotion(ev) {
        const [, rx, ry] = ev.get_root_coords();
        if (!this._drag) {
            const [, state] = ev.get_state();
            const ctrl = Boolean(state & Gdk.ModifierType.CONTROL_MASK);
            this._setCursor(ctrl && this._box ? cursorFor(this._zoneAt({x: rx, y: ry})) : null);
            return false;
        }
        const drag = this._drag;
        const dx = rx - drag.press.x;
        const dy = ry - drag.press.y;
        if (!drag.moved) {
            const threshold = Gtk.Settings.get_default()?.gtk_drag_threshold ?? 8;
            if (Math.abs(dx) <= threshold && Math.abs(dy) <= threshold)
                return true;
            drag.moved = true;
        }
        if (drag.zone !== 'move') {
            this._setBox(edgeResizedBox(drag.start, drag.zone.edges, dx, dy, this._workArea(drag.monitorIndex)), drag.monitorIndex);
            return true;
        }
        const under = this._monitors.indexAtPoint(rx, ry);
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
        return true;
    }

    _onButtonRelease(ev) {
        const [, button] = ev.get_button();
        if (button !== 1 || !this._drag)
            return true;
        if (this._drag.moved)
            this._onMotion(ev);
        this._finishDrag(true);
        return true;
    }

    _onKeyPress(ev) {
        const [, keyval] = ev.get_keyval();
        if (this._drag && keyval === Gdk.KEY_Escape) {
            this._finishDrag(false);
            return true;
        }
        return false;
    }

    _cancelDrag() {
        if (this._drag)
            this._finishDrag(false);
    }

    _finishDrag(commit) {
        const drag = this._drag;
        this._drag = null;
        this._setCursor(null);
        if (!commit || !drag.moved) {
            this._place();
            return;
        }
        const settings = this._settings;
        const box = this._box;
        const area = this._workArea(this._monitorIndex);
        if (drag.zone === 'move' && drag.snap) {
            settings.set_string('pitch-dock', drag.snap);
        } else if (drag.zone === 'move' || drag.dock === 'separate') {
            settings.set_value('pitch-box', new GLib.Variant('a{sd}', geometryFromBox(box, area)));
            settings.set_int('pitch-box-monitor', this._monitorIndex === this._monitors.primaryIndex ? -1 : this._monitorIndex);
            settings.set_string('pitch-dock', 'separate');
        } else if (drag.dock === 'below' || drag.dock === 'above') {
            settings.set_double('pitch-docked-height', clamp(box.height / area.height, DOCKED_HEIGHT_RANGE));
        } else {
            settings.set_double('pitch-docked-width', clamp(box.width / area.width, DOCKED_WIDTH_RANGE));
        }
        this._place();
    }
}
