// Monitor geometry and workarea helpers over GdkX11Display.

import Gdk from 'gi://Gdk?version=3.0';

function rectObj(rect) {
    return {x: rect.x, y: rect.y, width: rect.width, height: rect.height};
}

export class MonitorManager {
    constructor(display = Gdk.Display.get_default()) {
        this._display = display;
        this._screen = display.get_default_screen();
    }

    get count() {
        return Math.max(1, this._display.get_n_monitors());
    }

    get primaryIndex() {
        const n = this._display.get_n_monitors();
        for (let i = 0; i < n; i++) {
            const monitor = this._display.get_monitor(i);
            if (monitor?.is_primary())
                return i;
        }
        return 0;
    }

    indexForSetting(stored) {
        return stored >= 0 && stored < this.count ? stored : this.primaryIndex;
    }

    geometry(index) {
        const monitor = this._display.get_monitor(index) ?? this._display.get_monitor(0);
        return rectObj(monitor.get_geometry());
    }

    workArea(index) {
        const monitor = this._display.get_monitor(index) ?? this._display.get_monitor(0);
        const wa = rectObj(monitor.get_workarea());
        if (wa.width > 0 && wa.height > 0)
            return wa;
        return this.geometry(index);
    }

    indexAtPoint(x, y) {
        const n = this._display.get_n_monitors();
        for (let i = 0; i < n; i++) {
            const g = this.geometry(i);
            if (x >= g.x && x < g.x + g.width && y >= g.y && y < g.y + g.height)
                return i;
        }
        const monitor = this._display.get_monitor_at_point(Math.round(x), Math.round(y));
        if (monitor) {
            for (let i = 0; i < n; i++) {
                if (this._display.get_monitor(i) === monitor)
                    return i;
            }
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
