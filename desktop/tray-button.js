// Standalone panel-strip status button for desktops whose panel hides
// AppIndicators (such as Dash to Panel with rightBox hidden) or compositors
// without a StatusNotifierWatcher.
//
// Uses an override_redirect XWayland popup so it sits cleanly inside the
// monitor's panel strip (exact panel height, transparent background so it
// blends onto light or dark panels, never steals focus, never appears in
// Alt+Tab or taskbar).
//
// Pointer rules:
// - Primary press: toggles overlay-enabled immediately on press.
// - Secondary press: opens the settings page immediately on press.
// - Middle-drag: slides horizontally along the panel and saves
//   tray-button-right-offset in GSettings.
// - Hover: no popup, no frame, no flicker.

import Cairo from 'cairo';
import Gdk from 'gi://Gdk?version=3.0';
import Gtk from 'gi://Gtk?version=3.0';

const DEFAULT_AUTO_RIGHT_OFFSET = 454;

/**
 * Draws the lyrics musical-note icon directly with Cairo vectors (exact
 * geometry of lyrics-on-symbolic.svg / lyrics-off-symbolic.svg) so it scales
 * cleanly with crisp black ink and a subtle white contrast edge on both light
 * and dark panels.
 */
function paintNoteIcon(cr, cx, cy, size, enabled) {
    const scale = size / 16;
    cr.save();
    cr.translate(cx - size / 2, cy - size / 2);
    cr.scale(scale, scale);

    const drawShape = () => {
        // Oval notehead rotated -20 deg around (5, 12.3)
        cr.save();
        cr.translate(5, 12.3);
        cr.rotate(-20 * Math.PI / 180);
        cr.scale(3.1, 2.3);
        cr.arc(0, 0, 1, 0, 2 * Math.PI);
        cr.restore();
        cr.closePath();

        // Stem (split when off so the diagonal slash stays clean)
        if (enabled) {
            cr.rectangle(6.9, 1.5, 1.7, 10.8);
        } else {
            cr.rectangle(6.9, 1.5, 1.7, 3.6);
            cr.rectangle(6.9, 10.4, 1.7, 1.9);
        }

        // Flag
        cr.moveTo(8.3, 1.5);
        cr.lineTo(8.6, 1.5);
        cr.curveTo(8.9, 3.4, 10.5, 4.2, 11.7, 5.1);
        cr.curveTo(13.0, 6.1, 13.4, 7.7, 12.6, 9.4);
        cr.curveTo(12.8, 7.8, 12.0, 6.8, 10.5, 6.1);
        cr.curveTo(9.9, 5.8, 9.2, 5.6, 8.6, 5.5);
        cr.lineTo(8.3, 5.5);
        cr.closePath();

        // Slash when off
        if (!enabled) {
            cr.save();
            cr.translate(1.5, 1.5);
            cr.rotate(-45 * Math.PI / 180);
            cr.rectangle(-0.8, 0, 1.6, 18.4);
            cr.restore();
        }
    };

    // Crisp white rim + pure-black core keeps the note sharply legible on
    // both light panels (e.g. classic grey taskbar) and dark panels.
    cr.newPath();
    drawShape();
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    cr.setLineCap(Cairo.LineCap.ROUND);
    cr.setSourceRGBA(1, 1, 1, 0.9);
    cr.setLineWidth(1.5);
    cr.strokePreserve();
    cr.setSourceRGBA(0, 0, 0, 1);
    cr.fill();
    cr.restore();
}

export class TrayButton {
    /**
     * @param {{settings: Gio.Settings, monitors: import('./monitors.js').MonitorManager,
     *          onOpenSettings: () => void}} options
     */
    constructor({settings, monitors, onOpenSettings}) {
        this._settings = settings;
        this._monitors = monitors;
        this._onOpenSettings = onOpenSettings;
        this._enabled = false;
        this._active = false;
        this._box = {x: 0, y: 0, width: 40, height: 42};
        this._drag = null;

        this._win = new Gtk.Window({type: Gtk.WindowType.POPUP});
        this._win.set_title('Lyrics overlay status');
        this._win.set_decorated(false);
        this._win.set_app_paintable(true);
        this._win.set_accept_focus(false);
        this._win.set_skip_taskbar_hint(true);
        this._win.set_skip_pager_hint(true);
        this._win.set_keep_above(true);
        const visual = this._win.get_screen().get_rgba_visual();
        if (visual)
            this._win.set_visual(visual);

        this._area = new Gtk.DrawingArea();
        this._area.add_events(
            Gdk.EventMask.BUTTON_PRESS_MASK
            | Gdk.EventMask.BUTTON_RELEASE_MASK
            | Gdk.EventMask.POINTER_MOTION_MASK,
        );
        this._area.connect('draw', (_widget, cr) => this._onDraw(cr));
        this._area.connect('button-press-event', (_w, ev) => this._onButtonPress(ev));
        this._area.connect('motion-notify-event', (_w, ev) => this._onMotion(ev));
        this._area.connect('button-release-event', (_w, ev) => this._onButtonRelease(ev));
        this._win.connect('map-event', () => {
            this._win.move(this._box.x, this._box.y);
            this._redraw();
            return false;
        });
        this._win.add(this._area);

        this._settingsIds = [
            settings.connect('changed::overlay-enabled', () => this._redraw()),
            settings.connect('changed::tray-button-right-offset', () => this._place()),
        ];
        this._disconnectMonitors = monitors.onChanged(() => this._place());
        this._place();
    }

    get visible() {
        return this._enabled && this._active;
    }

    get box() {
        return {...this._box};
    }

    setEnabled(enabled) {
        const next = Boolean(enabled);
        if (this._enabled === next)
            return;
        this._enabled = next;
        this._syncVisible();
    }

    setActive(active) {
        const next = Boolean(active);
        if (this._active === next)
            return;
        this._active = next;
        this._syncVisible();
    }

    destroy() {
        for (const id of this._settingsIds)
            this._settings.disconnect(id);
        this._settingsIds = [];
        this._disconnectMonitors?.();
        this._win.destroy();
    }

    _panelStrip() {
        const idx = this._monitors.primaryIndex;
        const g = this._monitors.geometry(idx);
        const wa = this._monitors.workArea(idx);
        // Bottom panel (e.g., Dash to Panel at bottom)
        const bottomStrip = (g.y + g.height) - (wa.y + wa.height);
        if (bottomStrip >= 20 && bottomStrip <= 120)
            return {x: g.x, y: wa.y + wa.height, width: g.width, height: bottomStrip};
        // Top panel (e.g., stock GNOME top bar)
        const topStrip = wa.y - g.y;
        if (topStrip >= 20 && topStrip <= 120)
            return {x: g.x, y: g.y, width: g.width, height: topStrip};
        // Fallback when panel auto-hides or has no strut
        return {x: g.x, y: g.y + g.height - 36, width: g.width, height: 36};
    }

    _place() {
        const strip = this._panelStrip();
        const height = strip.height;
        const width = Math.max(36, Math.min(48, Math.round(height * 0.95)));
        const storedOffset = this._settings.get_int('tray-button-right-offset');
        const rightOffset = storedOffset >= 0 ? storedOffset : DEFAULT_AUTO_RIGHT_OFFSET;
        const clampedOffset = Math.max(0, Math.min(strip.width - width, rightOffset));
        const x = strip.x + strip.width - width - clampedOffset;
        const y = strip.y;
        this._box = {x, y, width, height};
        this._win.set_size_request(width, height);
        this._win.resize(width, height);
        this._win.move(x, y);
        this._redraw();
    }

    _redraw() {
        this._area.queue_draw();
        const gw = this._win.get_window();
        if (gw) {
            gw.invalidate_rect(null, true);
            gw.process_updates(true);
        }
        Gdk.flush();
    }

    _syncVisible() {
        if (this.visible) {
            this._place();
            this._win.show_all();
            this._win.move(this._box.x, this._box.y);
            this._redraw();
        } else {
            this._drag = null;
            this._win.hide();
        }
    }

    _onDraw(cr) {
        cr.setOperator(Cairo.Operator.SOURCE);
        cr.setSourceRGBA(0, 0, 0, 0);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);

        const iconSize = Math.max(16, Math.min(28, Math.round(this._box.height * 0.58)));
        const enabled = this._settings.get_boolean('overlay-enabled');
        paintNoteIcon(cr, this._box.width / 2, this._box.height / 2, iconSize, enabled);
        return false;
    }

    _onButtonPress(ev) {
        if (ev.get_event_type() !== Gdk.EventType.BUTTON_PRESS)
            return true;
        const [, button] = ev.get_button();
        if (button === 1) {
            this._settings.set_boolean('overlay-enabled', !this._settings.get_boolean('overlay-enabled'));
            return true;
        }
        if (button === 3) {
            this._onOpenSettings();
            return true;
        }
        if (button === 2) {
            const [, rx] = ev.get_root_coords();
            this._drag = {startRootX: rx, startX: this._box.x, moved: false};
            return true;
        }
        return true;
    }

    _onMotion(ev) {
        if (!this._drag)
            return false;
        const [, rx] = ev.get_root_coords();
        const dx = rx - this._drag.startRootX;
        if (!this._drag.moved && Math.abs(dx) < 4)
            return true;
        this._drag.moved = true;
        const strip = this._panelStrip();
        const x = Math.max(strip.x, Math.min(strip.x + strip.width - this._box.width, Math.round(this._drag.startX + dx)));
        this._box.x = x;
        this._win.move(x, this._box.y);
        return true;
    }

    _onButtonRelease(ev) {
        const [, button] = ev.get_button();
        if (button !== 2 || !this._drag)
            return true;
        const moved = this._drag.moved;
        this._drag = null;
        if (moved) {
            const strip = this._panelStrip();
            const offset = Math.max(0, Math.round(strip.x + strip.width - this._box.width - this._box.x));
            this._settings.set_int('tray-button-right-offset', offset);
        }
        return true;
    }
}
