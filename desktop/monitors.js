// Monitor geometry and workarea helpers over GdkX11Display.
// Uses canonical left-to-right, top-to-bottom ordering shared with
// service/monitors.js so monitor indices agree between desktop and settings.

import Gdk from 'gi://Gdk?version=3.0';

import {orderMonitors} from '../shared/overlay-geometry.js';

function rectObj(rect) {
    return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
}

export class MonitorManager {
    constructor(display = Gdk.Display.get_default()) {
        this._display = display;
        this._screen = display.get_default_screen();
    }

    _ordered() {
        const n = this._display.get_n_monitors();
        const list = [];
        for (let i = 0; i < n; i++) {
            const monitor = this._display.get_monitor(i);
            if (!monitor)
                continue;
            const geom = rectObj(monitor.get_geometry());
            const rawWa = rectObj(monitor.get_workarea());
            const workArea = rawWa.width > 0 && rawWa.height > 0 ? rawWa : geom;
            list.push({
                monitor,
                x: geom.x,
                y: geom.y,
                geom,
                workArea,
                primary: Boolean(monitor.is_primary()),
            });
        }
        return orderMonitors(list);
    }

    get count() {
        return Math.max(1, this._ordered().length);
    }

    get primaryIndex() {
        const idx = this._ordered().findIndex(entry => entry.primary);
        return idx >= 0 ? idx : 0;
    }

    indexForSetting(stored) {
        return stored >= 0 && stored < this.count ? stored : this.primaryIndex;
    }

    geometry(index) {
        const list = this._ordered();
        const entry = list[index] ?? list[0];
        return entry ? {...entry.geom} : {x: 0, y: 0, width: 1920, height: 1080};
    }

    workArea(index) {
        const list = this._ordered();
        const entry = list[index] ?? list[0];
        return entry ? {...entry.workArea} : {x: 0, y: 0, width: 1920, height: 1080};
    }

    indexAtPoint(x, y) {
        const list = this._ordered();
        for (let i = 0; i < list.length; i++) {
            const g = list[i].geom;
            if (x >= g.x && x < g.x + g.width && y >= g.y && y < g.y + g.height)
                return i;
        }
        const monitor = this._display.get_monitor_at_point(Math.round(x), Math.round(y));
        if (monitor) {
            const idx = list.findIndex(entry => entry.monitor === monitor);
            if (idx >= 0)
                return idx;
        }
        return this.primaryIndex;
    }

    /** @returns {() => void} disconnect function */
    onChanged(callback) {
        const ids = [
            [this._display, this._display.connect('monitor-added', callback)],
            [this._display, this._display.connect('monitor-removed', callback)],
            [this._screen, this._screen.connect('monitors-changed', callback)],
            [this._screen, this._screen.connect('size-changed', callback)],
        ];
        return () => {
            for (const [obj, id] of ids)
                obj.disconnect(id);
        };
    }
}
