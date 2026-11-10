// Text-size slider: logarithmic travel, a notch per half octave, labeled
// sizes at every octave including both ends. Pressing sets the size where
// the pointer is; dragging follows it.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import St from 'gi://St';

import {
    FONT_SIZE_LABELS, FONT_SIZE_NOTCHES, clampFontSize, fontSizeAt, positionOfFontSize,
} from './shared/overlay-geometry.js';

const SIDE_PADDING = 14;
const TRACK_Y = 12;
const HANDLE_RADIUS = 8;
const LABEL_PIXELS = 12;
const STEP_RATIO = 1.06;
const STEP_COMMIT_MS = 500;

export const SizeSlider = GObject.registerClass({
    Signals: {
        'preview': {param_types: [GObject.TYPE_DOUBLE]},
        'commit': {},
    },
}, class SizeSlider extends St.DrawingArea {
    _init() {
        super._init({
            style_class: 'lyrics-overlay-size-slider',
            reactive: true,
            can_focus: true,
            track_hover: true,
            x_expand: true,
        });
        this._size = 48;
        this._grab = null;
        this._commitId = 0;
    }

    get size() {
        return this._size;
    }

    set size(size) {
        this._size = clampFontSize(size);
        this.queue_repaint();
    }

    _trackSpan() {
        const [width] = this.get_surface_size();
        return {left: SIDE_PADDING, right: width - SIDE_PADDING};
    }

    _xOf(size) {
        const {left, right} = this._trackSpan();
        return left + positionOfFontSize(size) * (right - left);
    }

    _setFromPointer(event) {
        const [stageX, stageY] = event.get_coords();
        const [, localX] = this.transform_stage_point(stageX, stageY);
        const {left, right} = this._trackSpan();
        this._change(fontSizeAt((localX - left) / (right - left)));
    }

    _change(size) {
        this.size = size;
        this.emit('preview', this._size);
    }

    _step(steps) {
        this._change(this._size * STEP_RATIO ** steps);
        if (this._commitId)
            GLib.source_remove(this._commitId);
        this._commitId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, STEP_COMMIT_MS, () => {
            this._commitId = 0;
            this.emit('commit');
            return GLib.SOURCE_REMOVE;
        });
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width] = this.get_surface_size();
        const color = this.get_theme_node().get_foreground_color();
        const ink = [color.red / 255, color.green / 255, color.blue / 255];
        const {left, right} = this._trackSpan();
        const handleX = this._xOf(this._size);

        cr.setSourceRGBA(...ink, 1);
        cr.setLineWidth(2);
        cr.moveTo(left, TRACK_Y);
        cr.lineTo(right, TRACK_Y);
        cr.stroke();
        cr.setLineWidth(5);
        cr.moveTo(left, TRACK_Y);
        cr.lineTo(handleX, TRACK_Y);
        cr.stroke();

        cr.setLineWidth(1.5);
        for (const notch of FONT_SIZE_NOTCHES) {
            const x = Math.round(this._xOf(notch)) + 0.5;
            const labeled = FONT_SIZE_LABELS.includes(notch);
            cr.moveTo(x, TRACK_Y + HANDLE_RADIUS + 1);
            cr.lineTo(x, TRACK_Y + HANDLE_RADIUS + (labeled ? 8 : 5));
        }
        cr.stroke();

        const description = new Pango.FontDescription();
        description.set_family('Sans');
        description.set_absolute_size(LABEL_PIXELS * Pango.SCALE);
        for (const label of FONT_SIZE_LABELS) {
            const layout = PangoCairo.create_layout(cr);
            layout.set_font_description(description);
            layout.set_text(String(label), -1);
            const [, logical] = layout.get_pixel_extents();
            const x = Math.min(width - logical.width, Math.max(0, this._xOf(label) - logical.width / 2));
            cr.moveTo(x, TRACK_Y + HANDLE_RADIUS + 9);
            PangoCairo.show_layout(cr, layout);
        }

        cr.newPath();
        cr.arc(handleX, TRACK_Y, HANDLE_RADIUS, 0, 2 * Math.PI);
        cr.setSourceRGBA(...ink, 1);
        cr.fillPreserve();
        cr.setSourceRGBA(1 - ink[0], 1 - ink[1], 1 - ink[2], 1);
        cr.setLineWidth(2);
        cr.stroke();
        cr.$dispose();
    }

    vfunc_get_preferred_height(_forWidth) {
        const height = TRACK_Y + HANDLE_RADIUS + 9 + LABEL_PIXELS + 6;
        return [height, height];
    }

    vfunc_get_preferred_width(_forHeight) {
        return [220, 280];
    }

    vfunc_button_press_event(event) {
        if (this._grab || event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        this._grab = global.stage.grab(this);
        this._setFromPointer(event);
        return Clutter.EVENT_STOP;
    }

    vfunc_motion_event(event) {
        if (!this._grab)
            return Clutter.EVENT_PROPAGATE;
        this._setFromPointer(event);
        return Clutter.EVENT_STOP;
    }

    vfunc_button_release_event(event) {
        if (!this._grab || event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        this._grab.dismiss();
        this._grab = null;
        this.emit('commit');
        return Clutter.EVENT_STOP;
    }

    vfunc_scroll_event(event) {
        // A wheel notch arrives twice, once as an emulated copy.
        if (event.get_flags() & Clutter.EventFlags.FLAG_POINTER_EMULATED)
            return Clutter.EVENT_STOP;
        let steps = 0;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
        case Clutter.ScrollDirection.RIGHT:
            steps = 1;
            break;
        case Clutter.ScrollDirection.DOWN:
        case Clutter.ScrollDirection.LEFT:
            steps = -1;
            break;
        case Clutter.ScrollDirection.SMOOTH: {
            const [dx, dy] = event.get_scroll_delta();
            steps = dx - dy;
            break;
        }
        }
        if (!steps)
            return Clutter.EVENT_PROPAGATE;
        this._step(steps);
        return Clutter.EVENT_STOP;
    }

    vfunc_key_press_event(event) {
        const symbol = event.get_key_symbol();
        let steps = 0;
        if (symbol === Clutter.KEY_Right || symbol === Clutter.KEY_Up)
            steps = 1;
        else if (symbol === Clutter.KEY_Left || symbol === Clutter.KEY_Down)
            steps = -1;
        if (!steps)
            return super.vfunc_key_press_event(event);
        this._step(steps);
        return Clutter.EVENT_STOP;
    }

    /** Ends a drag or pending step and commits whatever is showing. */
    finish() {
        if (this._commitId) {
            GLib.source_remove(this._commitId);
            this._commitId = 0;
        }
        if (this._grab) {
            this._grab.dismiss();
            this._grab = null;
        }
        this.emit('commit');
    }
});
