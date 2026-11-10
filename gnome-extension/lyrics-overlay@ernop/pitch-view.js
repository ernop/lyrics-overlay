// Sung-pitch trace under the lyric: the last few seconds of the voice on
// a semitone grid that follows the singer's range, plus the current note.

import Cairo from 'cairo';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';
import St from 'gi://St';

import {noteName, TRACE_BREAK_MS, VOICE_MAX_MIDI, VOICE_MIN_MIDI} from './shared/pitch-mpm.js';

const WINDOW_MS = 6000;
const SPAN_SEMITONES = 14;
const CENTER_WINDOW_MS = 1500;
const CENTER_EASING = 0.15;
const CURRENT_NOTE_MS = 400;
// Below this spacing a line per semitone turns the grid into a smear, so
// only the natural notes keep theirs.
const MIN_SEMITONE_PIXELS = 6;
const NATURAL_NOTES = new Set([0, 2, 4, 5, 7, 9, 11]);
const TRACE_COLOR = [0xfa / 255, 0xcc / 255, 0x15 / 255];

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

function roundedRectangle(cr, width, height, radius) {
    cr.newSubPath();
    cr.arc(width - radius, radius, radius, -Math.PI / 2, 0);
    cr.arc(width - radius, height - radius, radius, 0, Math.PI / 2);
    cr.arc(radius, height - radius, radius, Math.PI / 2, Math.PI);
    cr.arc(radius, radius, radius, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

function textLayout(cr, text, pixelSize, bold) {
    const layout = PangoCairo.create_layout(cr);
    const description = new Pango.FontDescription();
    description.set_family('Sans');
    description.set_weight(bold ? Pango.Weight.BOLD : Pango.Weight.NORMAL);
    description.set_absolute_size(pixelSize * Pango.SCALE);
    layout.set_font_description(description);
    layout.set_text(text, -1);
    return layout;
}

export const PitchView = GObject.registerClass(
class PitchView extends St.DrawingArea {
    _init() {
        super._init({reactive: false, visible: false});
        this._samples = [];
        this._now = 0;
        this._center = (VOICE_MIN_MIDI + VOICE_MAX_MIDI) / 2;
        this._status = '';
    }

    /** Text shown across the empty strip, such as why the microphone stopped. */
    setStatus(text) {
        if (text === this._status)
            return;
        this._status = text;
        this.queue_repaint();
    }

    /** @param {{at: number, voiced: boolean, samples: Array<{t: number, midi: number}>}} frames */
    pushFrames(frames) {
        this._now = frames.at;
        this._samples.push(...frames.samples);
        const oldest = this._now - WINDOW_MS;
        const firstKept = this._samples.findIndex(sample => sample.t >= oldest);
        this._samples.splice(0, firstKept < 0 ? this._samples.length : firstKept);
        const recent = this._samples.filter(sample => sample.t >= this._now - CENTER_WINDOW_MS);
        if (recent.length) {
            const half = SPAN_SEMITONES / 2;
            const target = Math.min(VOICE_MAX_MIDI - half, Math.max(VOICE_MIN_MIDI + half, median(recent.map(sample => sample.midi))));
            this._center += (target - this._center) * CENTER_EASING;
        }
        if (this.visible)
            this.queue_repaint();
    }

    clear() {
        this._samples = [];
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [width, height] = this.get_surface_size();
        this._paint(cr, width, height);
        cr.$dispose();
    }

    _paint(cr, width, height) {
        const radius = Math.min(10, height / 4);
        roundedRectangle(cr, width, height, radius);
        cr.setSourceRGBA(0, 0, 0, 0.62);
        cr.fill();

        const readoutWidth = Math.min(width * 0.28, height * 1.6);
        const plotLeft = radius;
        const plotRight = width - readoutWidth;
        const plotTop = height * 0.08;
        const plotHeight = height * 0.84;
        const low = this._center - SPAN_SEMITONES / 2;
        const high = this._center + SPAN_SEMITONES / 2;
        const yOf = midi => plotTop + (high - midi) / (high - low) * plotHeight;
        const xOf = t => plotRight - (this._now - t) / WINDOW_MS * (plotRight - plotLeft);

        const semitonePixels = plotHeight / SPAN_SEMITONES;
        const labelSize = Math.max(10, Math.min(16, semitonePixels * 1.6));
        for (let midi = Math.ceil(low); midi <= Math.floor(high); midi++) {
            const isC = midi % 12 === 0;
            if (semitonePixels < MIN_SEMITONE_PIXELS && !NATURAL_NOTES.has(midi % 12))
                continue;
            const y = Math.round(yOf(midi)) + 0.5;
            cr.setSourceRGBA(1, 1, 1, isC ? 0.55 : 0.16);
            cr.setLineWidth(1);
            cr.moveTo(plotLeft, y);
            cr.lineTo(plotRight, y);
            cr.stroke();
            if (isC) {
                const label = textLayout(cr, noteName(midi), labelSize, false);
                const [, logical] = label.get_pixel_extents();
                cr.setSourceRGBA(1, 1, 1, 1);
                cr.moveTo(plotLeft + 2, y - logical.height - 1);
                PangoCairo.show_layout(cr, label);
            }
        }

        cr.newPath();
        cr.setSourceRGBA(...TRACE_COLOR, 1);
        cr.setLineWidth(Math.max(2.5, height / 40));
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        let previous = null;
        for (const sample of this._samples) {
            const x = xOf(sample.t);
            const y = yOf(sample.midi);
            if (previous && sample.t - previous.t <= TRACE_BREAK_MS)
                cr.lineTo(x, y);
            else
                cr.moveTo(x, y);
            previous = sample;
        }
        cr.stroke();

        if (this._status && !this._samples.length) {
            const status = textLayout(cr, this._status, Math.max(12, Math.min(20, plotHeight * 0.3)), true);
            status.set_width((plotRight - plotLeft) * Pango.SCALE);
            status.set_ellipsize(Pango.EllipsizeMode.END);
            status.set_alignment(Pango.Alignment.CENTER);
            const [, statusBox] = status.get_pixel_extents();
            cr.setSourceRGBA(1, 1, 1, 1);
            cr.moveTo(plotLeft, plotTop + (plotHeight - statusBox.height) / 2);
            PangoCairo.show_layout(cr, status);
        }

        const latest = this._samples[this._samples.length - 1];
        if (latest && this._now - latest.t <= CURRENT_NOTE_MS) {
            const nearest = Math.round(latest.midi);
            const cents = Math.round((latest.midi - nearest) * 100);
            const note = textLayout(cr, noteName(nearest), Math.min(height * 0.42, readoutWidth * 0.34), true);
            const offset = textLayout(cr, `${cents >= 0 ? '+' : '\u2212'}${Math.abs(cents)}`, Math.min(height * 0.24, readoutWidth * 0.2), true);
            const [, noteBox] = note.get_pixel_extents();
            const [, offsetBox] = offset.get_pixel_extents();
            const totalWidth = noteBox.width + offsetBox.width + 6;
            const left = plotRight + (readoutWidth - totalWidth) / 2;
            cr.setSourceRGBA(1, 1, 1, 1);
            cr.moveTo(left, (height - noteBox.height) / 2);
            PangoCairo.show_layout(cr, note);
            cr.moveTo(left + noteBox.width + 6, (height - noteBox.height) / 2 + noteBox.height - offsetBox.height);
            PangoCairo.show_layout(cr, offset);
        }
    }
});
