// Thin GNOME Shell St.DrawingArea wrapper around shared/pitch-painter.js.

import GObject from 'gi://GObject';
import St from 'gi://St';

import {PitchPainter} from './shared/pitch-painter.js';

export const PitchView = GObject.registerClass(
class PitchView extends St.DrawingArea {
    _init(settings) {
        super._init({reactive: false});
        this._painter = new PitchPainter({
            settings,
            onRedraw: () => {
                if (this.visible)
                    this.queue_repaint();
            },
        });
        this.connect('destroy', () => this._painter.destroy());
    }

    get _status() {
        return this._painter.status;
    }

    get _look() {
        return this._painter.look;
    }

    setSongKey(key) {
        this._painter.setSongKey(key);
    }

    setStatus(text) {
        this._painter.setStatus(text);
    }

    pushFrames(frames) {
        this._painter.pushFrames(frames);
    }

    clear() {
        this._painter.clear();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        this._painter.paint(cr, width, height);
        cr.$dispose();
    }
});
