// Pure Cairo/Pango pitch trace renderer shared between the standalone
// desktop app and the GNOME Shell extension.

import Cairo from 'cairo';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

import {labeledLines, noteLines, ReadoutNote, TraceClock} from './pitch-layout.js';
import {TRACE_BREAK_MS, VOICE_MAX_MIDI, VOICE_MIN_MIDI} from './pitch-mpm.js';
import {keyName, noteLabel, pitchClassNames, scalePitchClasses} from './scales.js';

const CENTER_WINDOW_MS = 1500;
const CENTER_EASING = 0.15;
// The newest point is marked while it is this fresh.
const HEAD_MS = 250;
const FONT_FAMILY = 'Sans';
const RADIUS = 10;

function parseHex(hex) {
    const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/iu.exec(hex);
    if (!match)
        throw new Error(`lyrics-overlay: pitch-line-color must be #rrggbb, not "${hex}"`);
    return match.slice(1).map(part => parseInt(part, 16) / 255);
}

function readLook(settings) {
    return {
        range: settings.get_string('pitch-range'),
        bottom: settings.get_int('pitch-range-bottom'),
        top: settings.get_int('pitch-range-top'),
        followSpan: settings.get_int('pitch-follow-span'),
        windowMs: settings.get_double('pitch-window-seconds') * 1000,
        timeInSilence: settings.get_boolean('pitch-time-in-silence'),
        lineWidth: settings.get_double('pitch-line-width'),
        lineColor: parseHex(settings.get_string('pitch-line-color')),
        backgroundOpacity: settings.get_double('pitch-background-opacity'),
        labels: settings.get_string('pitch-labels'),
        labelSize: settings.get_double('pitch-label-size'),
        scale: settings.get_string('pitch-scale'),
        scaleRoot: settings.get_int('pitch-scale-root'),
        scaleType: settings.get_string('pitch-scale-type'),
        showKey: settings.get_boolean('pitch-show-key'),
        readout: settings.get_string('pitch-readout'),
        readoutSize: settings.get_double('pitch-readout-size'),
        readoutCents: settings.get_boolean('pitch-readout-cents'),
    };
}

function median(values) {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

function roundedRectangle(cr, x, y, width, height, radius) {
    const r = Math.max(0, Math.min(radius, width / 2, height / 2));
    cr.newSubPath();
    cr.arc(x + width - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + width - r, y + height - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + height - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

export class PitchPainter {
    /**
     * @param {{settings: Gio.Settings, onRedraw: () => void}} options
     */
    constructor({settings, onRedraw}) {
        this._settings = settings;
        this._onRedraw = onRedraw;
        this._look = readLook(settings);
        this._songKey = null;
        this._samples = [];
        this._clock = new TraceClock(this._look.timeInSilence);
        this._readout = new ReadoutNote();
        this._realNow = 0;
        this._center = (this._look.bottom + this._look.top) / 2;
        this._status = '';
        this._layouts = new Map();
        this._changedId = settings.connect('changed', (_settings, key) => {
            if (key.startsWith('pitch-'))
                this._lookChanged(key);
        });
    }

    destroy() {
        if (this._changedId) {
            this._settings.disconnect(this._changedId);
            this._changedId = 0;
        }
        this._layouts.clear();
    }

    get look() {
        return this._look;
    }

    get status() {
        return this._status;
    }

    setSongKey(key) {
        if (key?.root === this._songKey?.root && key?.type === this._songKey?.type)
            return;
        this._songKey = key && {root: key.root, type: key.type};
        this._onRedraw();
    }

    setStatus(text) {
        if (text === this._status)
            return;
        this._status = text;
        this._onRedraw();
    }

    pushFrames(frames) {
        const now = this._clock.advance(frames.at, frames.voiced);
        this._realNow = frames.at;
        for (const sample of frames.samples) {
            this._samples.push({t: this._clock.traceTime(sample.t), midi: sample.midi});
            this._readout.hear(sample);
        }
        const oldest = now - this._look.windowMs;
        const firstKept = this._samples.findIndex(sample => sample.t >= oldest);
        this._samples.splice(0, firstKept < 0 ? this._samples.length : firstKept);
        if (this._look.range === 'follow') {
            const recent = this._samples.filter(sample => sample.t >= now - CENTER_WINDOW_MS);
            if (recent.length) {
                const half = this._look.followSpan / 2;
                const target = Math.min(VOICE_MAX_MIDI - half, Math.max(VOICE_MIN_MIDI + half, median(recent.map(sample => sample.midi))));
                this._center += (target - this._center) * CENTER_EASING;
            }
        }
        this._onRedraw();
    }

    clear() {
        this._samples = [];
        this._readout.clear();
        this._onRedraw();
    }

    _lookChanged(key) {
        this._look = readLook(this._settings);
        this._layouts.clear();
        if (key === 'pitch-time-in-silence') {
            this._samples = [];
            this._clock = new TraceClock(this._look.timeInSilence);
        }
        this._onRedraw();
    }

    _key() {
        switch (this._look.scale) {
        case 'detect':
            return this._songKey;
        case 'fixed':
            return {root: this._look.scaleRoot, type: this._look.scaleType};
        case 'none':
            return null;
        }
        throw new Error(`lyrics-overlay: unknown pitch-scale "${this._look.scale}"`);
    }

    _layout(cr, text, pixelSize, bold, tabular = false) {
        const id = `${text}\u0000${pixelSize}\u0000${bold}\u0000${tabular}`;
        let layout = this._layouts.get(id);
        if (!layout) {
            layout = PangoCairo.create_layout(cr);
            const description = new Pango.FontDescription();
            description.set_family(FONT_FAMILY);
            description.set_weight(bold ? Pango.Weight.BOLD : Pango.Weight.NORMAL);
            description.set_absolute_size(pixelSize * Pango.SCALE);
            layout.set_font_description(description);
            if (tabular) {
                const attributes = new Pango.AttrList();
                attributes.insert(Pango.attr_font_features_new('tnum'));
                layout.set_attributes(attributes);
            }
            layout.set_text(text, -1);
            this._layouts.set(id, layout);
        }
        return layout;
    }

    _width(cr, text, pixelSize, bold, tabular = false) {
        return this._layout(cr, text, pixelSize, bold, tabular).get_pixel_extents()[1].width;
    }

    _text(cr, text, pixelSize, bold, x, y, tabular = false) {
        cr.moveTo(x, y);
        PangoCairo.show_layout(cr, this._layout(cr, text, pixelSize, bold, tabular));
    }

    paint(cr, width, height) {
        const look = this._look;
        roundedRectangle(cr, 0, 0, width, height, Math.min(RADIUS, height / 4, width / 4));
        cr.setSourceRGBA(0, 0, 0, look.backgroundOpacity);
        cr.fill();

        const key = this._key();
        const names = pitchClassNames(key);
        const scale = key ? scalePitchClasses(key) : null;
        const pad = Math.max(3, Math.min(10, Math.round(height * 0.05)));

        const noteSize = Math.max(10, look.readoutSize * height * (look.readoutCents ? 0.58 : 0.8));
        const centsSize = Math.max(9, noteSize * 0.42);
        const slotWidth = Math.max(...names.map(name => this._width(cr, `${name}8`, noteSize, true)),
            look.readoutCents ? this._width(cr, '\u221250', centsSize, true, true) : 0);
        const slotHeight = noteSize * 1.25 + (look.readoutCents ? centsSize * 1.25 : 0);
        const column = look.readout === 'left' || look.readout === 'right' ? look.readout : null;
        const columnWidth = column ? slotWidth + 2 * pad : 0;

        const labelWidth = look.labels === 'none' ? 0
            : Math.max(...names.map(name => this._width(cr, `${name}8`, look.labelSize, true))) + pad;
        const plot = {
            left: (column === 'left' ? columnWidth : 0) + pad + labelWidth,
            right: width - pad - (column === 'right' ? columnWidth : 0),
            top: pad,
            bottom: height - pad,
        };
        plot.width = Math.max(1, plot.right - plot.left);
        plot.height = Math.max(1, plot.bottom - plot.top);

        const span = look.range === 'fixed'
            ? {low: look.bottom - 0.5, high: look.top + 0.5}
            : {low: this._center - look.followSpan / 2, high: this._center + look.followSpan / 2};
        const yOf = midi => plot.top + (span.high - midi) / (span.high - span.low) * plot.height;
        const now = this._clock.now;
        const xOf = t => plot.right - (now - t) / look.windowMs * plot.width;

        const lines = noteLines(span.low, span.high, scale, key ? key.root : null).map(line => ({...line, y: yOf(line.midi)}));
        for (const line of lines) {
            const y = Math.round(line.y) + 0.5;
            const [alpha, lineWidth] = line.root || (!key && line.c) ? [0.8, 2] : line.inScale ? [0.45, 1.5] : [0.16, 1];
            cr.setSourceRGBA(1, 1, 1, alpha);
            cr.setLineWidth(lineWidth);
            cr.moveTo(plot.left, y);
            cr.lineTo(plot.right, y);
            cr.stroke();
        }
        const labelHeight = this._layout(cr, 'C4', look.labelSize, true).get_pixel_extents()[1].height;
        cr.setSourceRGBA(1, 1, 1, 1);
        const named = labeledLines(lines, look.labels, labelHeight, Boolean(key));
        for (const line of lines) {
            if (!named.has(line.midi))
                continue;
            const text = noteLabel(line.midi, names);
            const bold = line.root || line.inScale || (!key && line.c);
            const textWidth = this._width(cr, text, look.labelSize, bold);
            this._text(cr, text, look.labelSize, bold, plot.left - pad / 2 - textWidth, line.y - labelHeight / 2);
        }

        this._paintTrace(cr, plot, xOf, yOf);

        const corner = column || look.readout === 'off' ? null : look.readout;
        if (look.showKey && key) {
            const keyCorner = corner === 'top-left' ? 'bottom-left' : 'top-left';
            this._paintTag(cr, keyName(key), look.labelSize * 1.1, plot, keyCorner);
        }

        if (this._status && !this._samples.length) {
            const status = this._layout(cr, this._status, Math.max(12, Math.min(20, plot.height * 0.3)), true);
            status.set_width(plot.width * Pango.SCALE);
            status.set_ellipsize(Pango.EllipsizeMode.END);
            status.set_alignment(Pango.Alignment.CENTER);
            const [, box] = status.get_pixel_extents();
            cr.setSourceRGBA(1, 1, 1, 1);
            cr.moveTo(plot.left, plot.top + (plot.height - box.height) / 2);
            PangoCairo.show_layout(cr, status);
        }

        const held = this._readout.at(this._realNow);
        if (look.readout === 'off' || held === null)
            return;
        let slot;
        if (column) {
            const left = column === 'left' ? pad : width - pad - slotWidth;
            slot = {x: left, y: (height - slotHeight) / 2, align: column};
        } else {
            const right = corner.endsWith('right');
            const top = corner.startsWith('top');
            slot = {
                x: right ? plot.right - slotWidth - pad : plot.left + pad,
                y: top ? plot.top : plot.bottom - slotHeight,
                align: right ? 'right' : 'left',
            };
            roundedRectangle(cr, slot.x - pad / 2, slot.y, slotWidth + pad, slotHeight, Math.min(6, pad));
            cr.setSourceRGBA(0, 0, 0, 0.6);
            cr.fill();
        }
        const flush = (text, size, tabular) => {
            const textWidth = this._width(cr, text, size, true, tabular);
            return slot.align === 'right' ? slot.x + slotWidth - textWidth : slot.x;
        };
        const note = noteLabel(held, names);
        cr.setSourceRGBA(1, 1, 1, 1);
        this._text(cr, note, noteSize, true, flush(note, noteSize, false), slot.y);
        if (look.readoutCents) {
            const cents = this._readout.cents;
            const text = `${cents >= 0 ? '+' : '\u2212'}${Math.abs(cents)}`;
            this._text(cr, text, centsSize, true, flush(text, centsSize, true), slot.y + noteSize * 1.25, true);
        }
    }

    _paintTrace(cr, plot, xOf, yOf) {
        const look = this._look;
        cr.save();
        cr.rectangle(plot.left, plot.top - look.lineWidth, plot.width, plot.height + 2 * look.lineWidth);
        cr.clip();
        cr.setSourceRGBA(...look.lineColor, 1);
        cr.setLineWidth(look.lineWidth);
        cr.setLineCap(Cairo.LineCap.ROUND);
        cr.setLineJoin(Cairo.LineJoin.ROUND);
        cr.newPath();
        let previous = null;
        let lastX = -Infinity;
        for (const sample of this._samples) {
            const x = xOf(sample.t);
            const joined = previous && sample.t - previous.t <= TRACE_BREAK_MS;
            if (joined && x - lastX < 0.5 && sample !== this._samples[this._samples.length - 1]) {
                previous = sample;
                continue;
            }
            if (joined)
                cr.lineTo(x, yOf(sample.midi));
            else
                cr.moveTo(x, yOf(sample.midi));
            lastX = x;
            previous = sample;
        }
        cr.stroke();
        const newest = this._samples[this._samples.length - 1];
        if (newest && this._clock.now - newest.t <= HEAD_MS) {
            cr.arc(xOf(newest.t), yOf(newest.midi), Math.max(3, look.lineWidth * 1.6), 0, 2 * Math.PI);
            cr.fill();
        }
        cr.restore();
    }

    _paintTag(cr, text, size, plot, corner) {
        const [, box] = this._layout(cr, text, size, true).get_pixel_extents();
        const x = corner.endsWith('right') ? plot.right - box.width - 6 : plot.left + 6;
        const y = corner.startsWith('top') ? plot.top + 2 : plot.bottom - box.height - 2;
        roundedRectangle(cr, x - 4, y, box.width + 8, box.height, Math.min(5, box.height / 2));
        cr.setSourceRGBA(0, 0, 0, 0.6);
        cr.fill();
        cr.setSourceRGBA(1, 1, 1, 1);
        this._text(cr, text, size, true, x, y);
    }
}
