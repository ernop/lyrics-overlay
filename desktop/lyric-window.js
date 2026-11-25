// Standalone XWayland lyric overlay window.
// Uses Gtk.Window(TOPLEVEL) + WindowTypeHint.NOTIFICATION on GdkX11Display:
// - ARGB 32-bit transparent surface with per-pixel click-through via
//   input_shape_combine_region (tight to painted ink or timing status pill);
// - absent from taskbar, Alt+Tab, and window-border extensions;
// - never steals focus on map or update;
// - delivers synchronous Ctrl/Shift/Escape state during Ctrl+drag even when a
//   native Wayland window previously held keyboard focus.
//
// Pointer rules:
// - Hover: nothing visually, no cursor change; empty space stays click-through.
// - Plain primary press: fires onClick() immediately on press; never drags.
// - Secondary press: fires onContextMenu() immediately on press.
// - Ctrl+drag on the body: moves a frozen, steady frame 1:1 across monitors
//   with magnetic center/edge snap (Shift bypasses snap; Escape cancels;
//   Ctrl+press without movement does nothing). Incoming line updates and gaps
//   queue until release so the frame never pops or cancels mid-drag.
// - Ctrl+drag on the left or right edge of the lyric: resizes max wrap width
//   live while holding the opposite edge steady (Escape cancels).
// - Ctrl+scroll: resizes font size with debounced commit.

import Cairo from 'cairo';
import Gdk from 'gi://Gdk?version=3.0';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=3.0';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

import {
    MIN_BOX_WIDTH, clampFontSize, commitLyricGeometry, edgeResizedBox,
    expandedRenderBox, normalizedLyricBox, snapBox, verticalAnchorFor,
} from '../shared/overlay-geometry.js';
import {fitLyric, paintLyric, singleLineHeight} from '../shared/text-layout.js';

const GRIP_MARGIN = 6;
const EDGE_ZONE = 14;
const MIN_EDGE_INK_WIDTH = 96;
const SNAP_THRESHOLD = 12;
const SCROLL_STEP_RATIO = 1.06;
const SCROLL_COMMIT_MS = 500;
const FADE_DURATION_MS = 150;
const FADE_FRAME_MS = 16;

const GEOMETRY_KEYS = ['cx', 'cy', 'width', 'height'];

const LOOK_KEYS = new Set([
    'font-size', 'font-family', 'font-bold', 'font-italic', 'text-furigana',
    'text-color', 'text-custom-color', 'text-border', 'text-border-cloud',
    'text-border-1-color', 'text-border-1-width',
    'text-border-2-color', 'text-border-2-width',
    'text-border-3-color', 'text-border-3-width',
    'text-border-4-color', 'text-border-4-width',
    'text-backdrop', 'text-backdrop-color', 'text-backdrop-opacity',
    'text-align', 'lyric-max-lines', 'pitch-dock', 'pitch-enabled',
]);

function readGeometry(settings) {
    const geometry = settings.get_value('box').deepUnpack();
    for (const key of GEOMETRY_KEYS) {
        if (typeof geometry[key] !== 'number')
            throw new Error(`lyrics-overlay: setting "box" lacks ${key}`);
    }
    return geometry;
}

function clamp(value, low, high) {
    return Math.min(high, Math.max(low, value));
}

function roundedRect(cr, x, y, w, h, r) {
    const radius = Math.max(0, Math.min(r, w / 2, h / 2));
    cr.newSubPath();
    cr.arc(x + w - radius, y + radius, radius, -Math.PI / 2, 0);
    cr.arc(x + w - radius, y + h - radius, radius, 0, Math.PI / 2);
    cr.arc(x + radius, y + h - radius, radius, Math.PI / 2, Math.PI);
    cr.arc(x + radius, y + radius, radius, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

function easeOutQuad(t) {
    const inv = 1 - Math.max(0, Math.min(1, t));
    return 1 - inv * inv;
}

function defaultDesktopFontFamily(interfaceSettings) {
    try {
        const fontName = interfaceSettings?.get_string('font-name');
        if (fontName) {
            const fam = Pango.FontDescription.from_string(fontName).get_family();
            if (fam)
                return fam;
        }
    } catch {
        // Fallback below.
    }
    return 'Sans';
}

export class LyricWindow {
    /**
     * @param {{settings: Gio.Settings, monitors: import('./monitors.js').MonitorManager,
     *          onClick: () => void, onContextMenu: () => void,
     *          onBoxChanged: (box: {x: number, y: number, width: number, height: number}, monitorIndex: number) => void}} options
     */
    constructor({settings, monitors, onClick, onContextMenu, onBoxChanged}) {
        this._settings = settings;
        this._monitors = monitors;
        this._onClick = onClick;
        this._onContextMenu = onContextMenu;
        this._onBoxChanged = onBoxChanged;

        this._measure = PangoCairo.FontMap.get_default().create_context();
        this._interfaceSettings = null;
        this._interfaceFontId = 0;
        try {
            const schema = Gio.SettingsSchemaSource.get_default()?.lookup('org.gnome.desktop.interface', true);
            if (schema) {
                this._interfaceSettings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
                this._interfaceFontId = this._interfaceSettings.connect('changed::font-name', () => this._placeBox());
            }
        } catch {
            // Optional desktop schema; falls back to 'Sans'.
        }

        this._fontSizePreview = null;
        this._scrollCommitId = 0;
        this._fadeTimerId = 0;
        this._fadeAlpha = 1;
        this._fadeStartUs = 0;

        this._line = {text: '', key: 'none'};
        this._pendingLine = null;
        this._text = '';
        this._fitted = null;
        this._statusText = '';
        this._pillBox = null;
        this._shown = false;

        this._dragMode = null; // null | 'pending-move' | 'move' | 'pending-resize' | 'resize'
        this._drag = null;
        this._snapGuides = {x: [], y: []};
        this._box = null;
        this._renderBox = null;
        this._monitorIndex = monitors.primaryIndex;

        this._win = new Gtk.Window({type: Gtk.WindowType.TOPLEVEL});
        this._win.set_title('Lyrics overlay');
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
        if (!visual || !this._win.get_screen().is_composited())
            throw new Error('lyrics-overlay-desktop: composited ARGB visual is unavailable on XWayland');
        this._win.set_visual(visual);

        this._area = new Gtk.DrawingArea();
        this._area.add_events(
            Gdk.EventMask.BUTTON_PRESS_MASK
            | Gdk.EventMask.BUTTON_RELEASE_MASK
            | Gdk.EventMask.POINTER_MOTION_MASK
            | Gdk.EventMask.LEAVE_NOTIFY_MASK
            | Gdk.EventMask.SCROLL_MASK
            | Gdk.EventMask.SMOOTH_SCROLL_MASK,
        );
        this._win.add_events(Gdk.EventMask.KEY_PRESS_MASK);
        this._win.add(this._area);

        this._area.connect('draw', (_w, cr) => this._onDraw(cr));
        this._area.connect('button-press-event', (_w, ev) => this._onButtonPress(ev));
        this._area.connect('motion-notify-event', (_w, ev) => this._onMotion(ev));
        this._area.connect('button-release-event', (_w, ev) => this._onButtonRelease(ev));
        this._area.connect('leave-notify-event', () => {
            if (!this._dragMode)
                this._setCursor(null);
            return false;
        });
        this._area.connect('grab-broken-event', () => {
            this._cancelDrag();
            return false;
        });
        this._area.connect('scroll-event', (_w, ev) => this._onScroll(ev));
        this._win.connect('key-press-event', (_w, ev) => this._onKeyPress(ev));
        this._win.connect('map-event', () => {
            if (this._renderBox)
                this._win.move(Math.round(this._renderBox.x), Math.round(this._renderBox.y));
            this._applyInputShape();
            return false;
        });
        this._win.connect('configure-event', () => {
            this._applyInputShape();
            return false;
        });

        this._settingsId = settings.connect('changed', (_s, key) => this._onSettingChanged(key));
        this._disconnectMonitors = monitors.onChanged(() => this._placeBox());
        this._placeBox();
    }

    destroy() {
        this._cancelDrag();
        this._stopFade();
        if (this._scrollCommitId) {
            GLib.source_remove(this._scrollCommitId);
            this._scrollCommitId = 0;
        }
        this.commitFontSize();
        if (this._settingsId) {
            this._settings.disconnect(this._settingsId);
            this._settingsId = 0;
        }
        if (this._interfaceSettings && this._interfaceFontId) {
            this._interfaceSettings.disconnect(this._interfaceFontId);
            this._interfaceFontId = 0;
        }
        this._disconnectMonitors?.();
        this._win.destroy();
    }

    get visible() {
        if (this._dragMode)
            return this._shown;
        return this._shown && (Boolean(this._fitted) || Boolean(this._pillBox));
    }

    get box() {
        return this._box ? {...this._box} : null;
    }

    get renderBox() {
        return this._renderBox ? {...this._renderBox} : null;
    }

    get inkBox() {
        if (this._fitted)
            return {...this._fitted.inkBox};
        if (this._pillBox)
            return {x: this._pillBox.x, y: this._pillBox.y, width: this._pillBox.width, height: this._pillBox.height};
        return null;
    }

    get statusVisible() {
        return Boolean(this._pillBox) && !this._fitted;
    }

    get monitorIndex() {
        return this._monitorIndex;
    }

    get fontSize() {
        return this._fontSizePreview ?? this._settings.get_double('font-size');
    }

    setShown(shown) {
        const next = Boolean(shown);
        if (next === this._shown)
            return;
        this._shown = next;
        this._syncWindowVisible();
    }

    /** @param {{text: string, key: string, ruby?: Array<[string, string]>}} line */
    setLine(line) {
        if (this._dragMode) {
            this._pendingLine = line;
            return;
        }
        const previous = this._line;
        this._line = line;
        if (line.key !== previous.key) {
            this._crossTo(line.text);
        } else if (line.text !== this._text
            || JSON.stringify(line.ruby ?? null) !== JSON.stringify(previous.ruby ?? null)) {
            this._fitAndResize(line.text);
        }
        this._computeStatusPill();
        this._syncWindowVisible();
        this._applyInputShape();
        this._area.queue_draw();
    }

    setStatus(text) {
        const next = String(text ?? '');
        if (next === this._statusText)
            return;
        this._statusText = next;
        this._computeStatusPill();
        this._syncWindowVisible();
        this._applyInputShape();
        this._area.queue_draw();
    }

    previewFontSize(size) {
        this._fontSizePreview = clampFontSize(size);
        this._placeBox();
    }

    commitFontSize() {
        if (this._fontSizePreview === null)
            return;
        const size = this._fontSizePreview;
        this._fontSizePreview = null;
        this._settings.set_double('font-size', size);
    }

    // ----- layout

    _isActiveDrag() {
        return this._dragMode === 'move' || this._dragMode === 'resize';
    }

    _monitorIndexSetting() {
        return this._monitors.indexForSetting(this._settings.get_int('box-monitor'));
    }

    _workArea(monitorIndex) {
        return this._monitors.workArea(monitorIndex);
    }

    _anchorFor(box = this._box, monitorIndex = this._monitorIndex) {
        const area = this._workArea(monitorIndex);
        const cy = (box.y + box.height / 2 - area.y) / area.height;
        const pitchDock = this._settings.get_string('pitch-dock');
        const pitchEnabled = this._settings.get_boolean('pitch-enabled');
        return verticalAnchorFor(cy, pitchDock, pitchEnabled);
    }

    _anchor() {
        return this._anchorFor(this._box, this._monitorIndex);
    }

    _singleLineHeight(width = 600) {
        return singleLineHeight(this._measure, this._textParams(Math.max(160, Math.round(width)), 1));
    }

    _placeBox() {
        if (this._dragMode)
            return;
        const monitorIndex = this._monitorIndexSetting();
        const area = this._workArea(monitorIndex);
        const geometry = readGeometry(this._settings);
        const pitchDock = this._settings.get_string('pitch-dock');
        const pitchEnabled = this._settings.get_boolean('pitch-enabled');
        const anchor = verticalAnchorFor(geometry.cy, pitchDock, pitchEnabled);
        const baseH = this._singleLineHeight(geometry.width * area.width);
        const box = normalizedLyricBox(geometry, area, baseH, anchor);
        this._setBox(box, monitorIndex);
    }

    _setBox(box, monitorIndex) {
        this._box = box;
        this._monitorIndex = monitorIndex;
        this._refitText();
    }

    _notifyDockBox() {
        const rb = this._renderBox ?? this._box;
        if (!rb)
            return;
        this._onBoxChanged({...rb}, this._monitorIndex);
    }

    _applyRenderBox(renderBox) {
        const prev = this._renderBox;
        this._renderBox = renderBox;
        const x = Math.round(renderBox.x);
        const y = Math.round(renderBox.y);
        const width = Math.max(1, Math.round(renderBox.width));
        const height = Math.max(1, Math.round(renderBox.height));
        const sizeChanged = !prev || Math.round(prev.width) !== width || Math.round(prev.height) !== height;
        if (sizeChanged) {
            this._area.set_size_request(width, height);
            this._win.set_size_request(width, height);
            this._win.resize(width, height);
        }
        this._win.move(x, y);
        this._computeStatusPill();
        this._applyInputShape();
        if (this._isActiveDrag())
            this._area.queue_draw();
    }

    _textParams(width, height, overrides = {}) {
        const s = this._settings;
        const family = s.get_string('font-family') || defaultDesktopFontFamily(this._interfaceSettings);
        return {
            fontSize: this.fontSize,
            family,
            bold: s.get_boolean('font-bold'),
            italic: s.get_boolean('font-italic'),
            color: s.get_string('text-color'),
            customColor: s.get_string('text-custom-color'),
            border: s.get_string('text-border'),
            borderCloud: s.get_boolean('text-border-cloud'),
            ringColors: [1, 2, 3, 4].map(i => s.get_string(`text-border-${i}-color`)),
            ringWidths: [1, 2, 3, 4].map(i => s.get_double(`text-border-${i}-width`)),
            backdrop: s.get_string('text-backdrop'),
            backdropColor: s.get_string('text-backdrop-color'),
            backdropOpacity: s.get_double('text-backdrop-opacity'),
            align: s.get_string('text-align'),
            anchor: this._box ? this._anchor() : 'bottom',
            ruby: s.get_boolean('text-furigana') ? (this._line.ruby ?? null) : null,
            maxLines: s.get_int('lyric-max-lines'),
            contentFit: false,
            width,
            height,
            ...overrides,
        };
    }

    _fitAndResize(text) {
        this._text = text;
        const anchor = this._anchor();
        const area = this._workArea(this._monitorIndex);
        if (!text) {
            this._fitted = null;
            this._applyRenderBox(this._box);
            this._notifyDockBox();
            return;
        }
        const width = Math.max(1, Math.round(this._box.width));
        let fitted = fitLyric(this._measure, text, this._textParams(width, 1, {anchor}));
        const renderBox = expandedRenderBox(this._box, fitted.requiredHeight, anchor, area);
        if (Math.round(renderBox.height) !== Math.round(fitted.surfaceHeight))
            fitted = fitLyric(this._measure, text, this._textParams(width, Math.round(renderBox.height), {anchor}));
        this._fitted = fitted;
        this._applyRenderBox(renderBox);
        this._notifyDockBox();
    }

    _refitText() {
        this._fitAndResize(this._text);
        this._computeStatusPill();
        this._syncWindowVisible();
        this._applyInputShape();
        this._area.queue_draw();
    }

    _crossTo(text) {
        this._stopFade();
        const choice = this._settings.get_string('transition');
        const animate = this._shown && choice !== 'instant' && Boolean(text);
        this._fitAndResize(text);
        if (!animate) {
            this._fadeAlpha = 1;
            return;
        }
        this._fadeAlpha = 0;
        this._fadeStartUs = GLib.get_monotonic_time();
        this._fadeTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, FADE_FRAME_MS, () => {
            const elapsedMs = (GLib.get_monotonic_time() - this._fadeStartUs) / 1000;
            const progress = elapsedMs / FADE_DURATION_MS;
            if (progress >= 1) {
                this._fadeAlpha = 1;
                this._fadeTimerId = 0;
                this._area.queue_draw();
                return GLib.SOURCE_REMOVE;
            }
            this._fadeAlpha = easeOutQuad(progress);
            this._area.queue_draw();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopFade() {
        if (this._fadeTimerId) {
            GLib.source_remove(this._fadeTimerId);
            this._fadeTimerId = 0;
        }
        this._fadeAlpha = 1;
    }

    _statusFontDesc() {
        const desc = new Pango.FontDescription();
        desc.set_family('Sans');
        desc.set_weight(Pango.Weight.BOLD);
        desc.set_absolute_size(15 * Pango.SCALE);
        return desc;
    }

    _computeStatusPill() {
        const box = this._renderBox ?? this._box;
        if (!this._statusText || this._fitted || !box || box.width < 40 || box.height < 24) {
            this._pillBox = null;
            return;
        }
        const width = Math.round(box.width);
        const height = Math.round(box.height);
        const layout = Pango.Layout.new(this._measure);
        layout.set_font_description(this._statusFontDesc());
        layout.set_text(this._statusText, -1);
        const [, logical] = layout.get_pixel_extents();
        const padX = 14;
        const padY = 6;
        const margin = 6;
        const pillW = Math.min(Math.max(40, width - margin * 2), logical.width + padX * 2);
        const pillH = Math.min(Math.max(24, height - margin * 2), logical.height + padY * 2);
        const align = this._settings.get_string('text-align');
        const anchor = this._anchor();
        let px;
        if (align === 'left')
            px = margin;
        else if (align === 'right')
            px = Math.max(margin, width - margin - pillW);
        else
            px = Math.round((width - pillW) / 2);
        let py;
        if (anchor === 'top')
            py = margin;
        else if (anchor === 'bottom')
            py = Math.max(margin, height - margin - pillH);
        else
            py = Math.round((height - pillH) / 2);
        this._pillBox = {x: px, y: py, width: pillW, height: pillH, padX, padY};
    }

    _syncWindowVisible() {
        if (this.visible) {
            if (!this._win.get_visible()) {
                this._win.show_all();
                if (this._renderBox)
                    this._win.move(Math.round(this._renderBox.x), Math.round(this._renderBox.y));
                this._applyInputShape();
            }
        } else {
            this._cancelDrag();
            if (this._win.get_visible())
                this._win.hide();
        }
    }

    _applyInputShape() {
        const gdkWin = this._win.get_window();
        if (!gdkWin || !this._renderBox)
            return;
        const rw = Math.max(1, Math.round(this._renderBox.width));
        const rh = Math.max(1, Math.round(this._renderBox.height));
        const region = new Cairo.Region();
        if (this._isActiveDrag()) {
            region.unionRectangle({x: 0, y: 0, width: rw, height: rh});
        } else {
            const target = this._fitted ? this._fitted.inkBox : this._pillBox;
            if (target) {
                const left = Math.max(0, Math.floor(target.x - GRIP_MARGIN));
                const top = Math.max(0, Math.floor(target.y - GRIP_MARGIN));
                const right = Math.min(rw, Math.ceil(target.x + target.width + GRIP_MARGIN));
                const bottom = Math.min(rh, Math.ceil(target.y + target.height + GRIP_MARGIN));
                if (right > left && bottom > top)
                    region.unionRectangle({x: left, y: top, width: right - left, height: bottom - top});
            }
        }
        gdkWin.input_shape_combine_region(region, 0, 0);
    }

    _onSettingChanged(key) {
        if (key === 'box' || key === 'box-monitor' || LOOK_KEYS.has(key))
            this._placeBox();
    }

    // ----- drawing

    _hudSummary() {
        if (!this._isActiveDrag() || !this._renderBox)
            return '';
        const area = this._workArea(this._monitorIndex);
        const w = Math.round(this._renderBox.width);
        const wp = Math.round(this._renderBox.width / Math.max(1, area.width) * 100);
        const prefix = this._dragMode === 'resize' ? 'Width ' : '';
        return `${prefix}${w} px (${wp}%) \u00b7 ${Math.round(this.fontSize)} px`;
    }

    _onDraw(cr) {
        cr.setOperator(Cairo.Operator.SOURCE);
        cr.setSourceRGBA(0, 0, 0, 0);
        cr.paint();
        cr.setOperator(Cairo.Operator.OVER);

        if (this._fitted) {
            if (this._fadeAlpha < 0.999) {
                cr.pushGroup();
                paintLyric(cr, this._fitted);
                cr.popGroupToSource();
                cr.paintWithAlpha(this._fadeAlpha);
            } else {
                paintLyric(cr, this._fitted);
            }
        } else if (this._pillBox && this._statusText) {
            this._paintStatusPill(cr);
        }

        if (this._isActiveDrag() && this._renderBox)
            this._paintOutline(cr, Math.round(this._renderBox.width), Math.round(this._renderBox.height));

        return false;
    }

    _paintStatusPill(cr) {
        const {x, y, width, height, padX, padY} = this._pillBox;
        roundedRect(cr, x + 0.5, y + 0.5, width - 1, height - 1, Math.min(10, height / 2));
        cr.setSourceRGBA(0, 0, 0, 0.78);
        cr.fillPreserve();
        cr.setSourceRGBA(1, 1, 1, 0.38);
        cr.setLineWidth(1);
        cr.stroke();

        const layout = PangoCairo.create_layout(cr);
        layout.set_font_description(this._statusFontDesc());
        layout.set_text(this._statusText, -1);
        const [, logical] = layout.get_pixel_extents();
        const tx = x + Math.max(padX, Math.round((width - logical.width) / 2));
        const ty = y + Math.max(padY, Math.round((height - logical.height) / 2));
        cr.save();
        cr.rectangle(x + padX / 2, y, Math.max(1, width - padX), height);
        cr.clip();
        cr.setSourceRGBA(1, 1, 1, 1);
        cr.moveTo(tx, ty);
        PangoCairo.show_layout(cr, layout);
        cr.restore();
    }

    _paintOutline(cr, width, height) {
        if (width < 6 || height < 6)
            return;
        roundedRect(cr, 2, 2, width - 4, height - 4, 5);
        cr.setSourceRGBA(0, 0, 0, 0.85);
        cr.setLineWidth(3.5);
        cr.strokePreserve();
        cr.setSourceRGBA(1, 1, 1, 0.92);
        cr.setLineWidth(1.5);
        cr.stroke();

        // Left/right wrap-width edge grip bars (active edge highlights yellow during resize).
        const gripH = Math.max(14, Math.min(34, Math.round(height * 0.45)));
        const gripY = Math.round((height - gripH) / 2);
        const activeEdges = this._dragMode === 'resize' ? (this._drag?.zone?.edges ?? {}) : {};
        for (const [side, gx] of [['left', 3.5], ['right', width - 3.5]]) {
            const active = Boolean(activeEdges[side]);
            cr.setSourceRGBA(0, 0, 0, 0.85);
            cr.setLineWidth(active ? 6 : 5);
            cr.setLineCap(Cairo.LineCap.ROUND);
            cr.moveTo(gx, gripY);
            cr.lineTo(gx, gripY + gripH);
            cr.stroke();
            if (active)
                cr.setSourceRGBA(0.98, 0.8, 0.08, 0.98);
            else
                cr.setSourceRGBA(1, 1, 1, 0.95);
            cr.setLineWidth(active ? 3 : 2.2);
            cr.moveTo(gx, gripY);
            cr.lineTo(gx, gripY + gripH);
            cr.stroke();
        }
        cr.setLineCap(Cairo.LineCap.BUTT);

        const area = this._workArea(this._monitorIndex);
        const centerX = area.x + area.width / 2;
        const centerY = area.y + area.height / 2;
        cr.setSourceRGBA(0.98, 0.8, 0.08, 0.95);
        cr.setLineWidth(2.5);
        if (this._snapGuides.x.some(gx => Math.abs(gx - centerX) <= 1)) {
            cr.moveTo(Math.round(width / 2) + 0.5, 4);
            cr.lineTo(Math.round(width / 2) + 0.5, height - 4);
            cr.stroke();
        }
        if (this._snapGuides.x.some(gx => Math.abs(gx - area.x) <= 1)) {
            cr.moveTo(2.5, 4);
            cr.lineTo(2.5, height - 4);
            cr.stroke();
        }
        if (this._snapGuides.x.some(gx => Math.abs(gx - (area.x + area.width)) <= 1)) {
            cr.moveTo(width - 2.5, 4);
            cr.lineTo(width - 2.5, height - 4);
            cr.stroke();
        }
        if (this._snapGuides.y.some(gy => Math.abs(gy - centerY) <= 1)) {
            cr.moveTo(4, Math.round(height / 2) + 0.5);
            cr.lineTo(width - 4, Math.round(height / 2) + 0.5);
            cr.stroke();
        }
        if (this._snapGuides.y.some(gy => Math.abs(gy - area.y) <= 1)) {
            cr.moveTo(4, 2.5);
            cr.lineTo(width - 4, 2.5);
            cr.stroke();
        }
        if (this._snapGuides.y.some(gy => Math.abs(gy - (area.y + area.height)) <= 1)) {
            cr.moveTo(4, height - 2.5);
            cr.lineTo(width - 4, height - 2.5);
            cr.stroke();
        }

        const hudText = this._hudSummary();
        if (hudText && height >= 34 && width >= 150) {
            const layout = PangoCairo.create_layout(cr);
            const desc = new Pango.FontDescription();
            desc.set_family('Sans');
            desc.set_weight(Pango.Weight.BOLD);
            desc.set_absolute_size(12 * Pango.SCALE);
            layout.set_font_description(desc);
            layout.set_text(hudText, -1);
            const [, logical] = layout.get_pixel_extents();
            const padX = 8;
            const padY = 3;
            const pillW = Math.min(width - 24, logical.width + padX * 2);
            const pillH = logical.height + padY * 2;
            const px = 14;
            const py = Math.max(4, Math.min(10, Math.round((height - pillH) / 2)));
            roundedRect(cr, px, py, pillW, pillH, 5);
            cr.setSourceRGBA(0, 0, 0, 0.9);
            cr.fillPreserve();
            cr.setSourceRGBA(1, 1, 1, 0.9);
            cr.setLineWidth(1);
            cr.stroke();
            cr.save();
            cr.rectangle(px + padX, py + padY, Math.max(1, pillW - padX * 2), pillH);
            cr.clip();
            cr.setSourceRGBA(1, 1, 1, 1);
            cr.moveTo(px + padX, py + padY);
            PangoCairo.show_layout(cr, layout);
            cr.restore();
        }
    }

    // ----- pointer interaction

    _setCursor(name) {
        const gdkWin = this._win.get_window();
        if (!gdkWin)
            return;
        const cursor = name ? Gdk.Cursor.new_from_name(gdkWin.get_display(), name) : null;
        gdkWin.set_cursor(cursor);
    }

    _zoneAt(localX) {
        if (!this._fitted || !this._renderBox)
            return 'move';
        const ink = this._fitted.inkBox;
        if (!ink || ink.width < MIN_EDGE_INK_WIDTH)
            return 'move';
        const zone = Math.min(EDGE_ZONE, Math.floor(ink.width * 0.16));
        if (localX <= ink.x + zone)
            return {edges: {left: true}};
        if (localX >= ink.x + ink.width - zone)
            return {edges: {right: true}};
        return 'move';
    }

    _onButtonPress(ev) {
        if (ev.get_event_type() !== Gdk.EventType.BUTTON_PRESS)
            return true;
        const [, button] = ev.get_button();
        if (this._dragMode)
            return true;
        if (button === 3) {
            this._onContextMenu();
            return true;
        }
        if (button !== 1)
            return true;

        const [, state] = ev.get_state();
        const ctrl = Boolean(state & Gdk.ModifierType.CONTROL_MASK);
        if (!ctrl) {
            this._onClick();
            return true;
        }

        const [, lx] = ev.get_coords();
        const [, rx, ry] = ev.get_root_coords();
        const zone = this._zoneAt(lx);
        const startBox = {...(this._renderBox ?? this._box)};
        const startArea = this._workArea(this._monitorIndex);
        this._stopFade();
        this._dragMode = zone === 'move' ? 'pending-move' : 'pending-resize';
        this._drag = {
            zone,
            press: {x: rx, y: ry},
            startBox,
            currentH: startBox.height,
            startMonitorIndex: this._monitorIndex,
            startArea,
            startFracW: startBox.width / Math.max(1, startArea.width),
            grabFracX: clamp((rx - startBox.x) / Math.max(1, startBox.width), 0, 1),
            grabOffsetY: ry - startBox.y,
            monitorIndex: this._monitorIndex,
            anchor: this._anchorFor(startBox, this._monitorIndex),
        };
        this._snapGuides = {x: [], y: []};
        return true;
    }

    _onMotion(ev) {
        if (!this._dragMode || !this._drag) {
            const [, state] = ev.get_state();
            const ctrl = Boolean(state & Gdk.ModifierType.CONTROL_MASK);
            if (!ctrl) {
                this._setCursor(null);
                return false;
            }
            const [, lx] = ev.get_coords();
            const zone = this._zoneAt(lx);
            this._setCursor(zone === 'move' ? 'move' : zone.edges.left ? 'w-resize' : 'e-resize');
            return false;
        }
        const drag = this._drag;
        const [, rx, ry] = ev.get_root_coords();
        const [, state] = ev.get_state();
        const noSnap = Boolean(state & Gdk.ModifierType.SHIFT_MASK);
        const dx = rx - drag.press.x;
        const dy = ry - drag.press.y;

        if (this._dragMode === 'pending-move' || this._dragMode === 'pending-resize') {
            const threshold = Gtk.Settings.get_default()?.gtk_drag_threshold ?? 8;
            if (Math.abs(dx) <= threshold && Math.abs(dy) <= threshold)
                return true;
            if (this._dragMode === 'pending-move') {
                this._dragMode = 'move';
                this._setCursor('grabbing');
            } else {
                this._dragMode = 'resize';
                this._setCursor(drag.zone.edges.left ? 'w-resize' : 'e-resize');
            }
            this._applyInputShape();
        }

        if (this._dragMode === 'resize') {
            const area = this._workArea(drag.monitorIndex);
            const resized = edgeResizedBox(drag.startBox, drag.zone.edges, dx, 0, area);
            const nextW = Math.max(1, Math.round(resized.width));
            let nextH = drag.startBox.height;
            if (this._text) {
                const fitted = fitLyric(this._measure, this._text, this._textParams(nextW, 1, {anchor: drag.anchor}));
                nextH = Math.min(area.height, Math.max(1, Math.round(fitted.requiredHeight)));
                this._fitted = fitted;
            }
            let nextY;
            if (drag.anchor === 'bottom')
                nextY = drag.startBox.y + drag.startBox.height - nextH;
            else if (drag.anchor === 'top')
                nextY = drag.startBox.y;
            else
                nextY = drag.startBox.y + (drag.startBox.height - nextH) / 2;
            nextY = clamp(nextY, area.y, area.y + area.height - nextH);
            this._snapGuides = {x: [], y: []};
            this._applyRenderBox({x: resized.x, y: nextY, width: nextW, height: nextH});
            this._notifyDockBox();
            this._area.queue_draw();
            return true;
        }

        // Active body move: keep drag frame steady (zero refits or resizes on same monitor).
        const under = this._monitors.indexAtPoint(rx, ry);
        if (under >= 0)
            drag.monitorIndex = under;
        const area = this._workArea(drag.monitorIndex);
        let rawW;
        let rawH;
        let rawX;
        let rawY;
        if (drag.monitorIndex === drag.startMonitorIndex) {
            rawW = drag.startBox.width;
            rawH = Math.min(drag.currentH, area.height);
            rawX = drag.startBox.x + dx;
            rawY = drag.startBox.y + dy;
        } else {
            rawW = clamp(Math.round(drag.startFracW * area.width), Math.min(MIN_BOX_WIDTH, area.width), area.width);
            rawH = Math.min(drag.currentH, area.height);
            rawX = rx - drag.grabFracX * rawW;
            rawY = ry - drag.grabOffsetY;
        }
        // Only refit frozen text if crossing onto a monitor with a different width.
        if (this._text && Math.round(rawW) !== Math.round(this._renderBox.width)) {
            const fitted = fitLyric(this._measure, this._text, this._textParams(Math.round(rawW), 1, {anchor: drag.anchor}));
            this._fitted = fitted;
            drag.currentH = Math.min(area.height, Math.max(1, Math.round(fitted.requiredHeight)));
            rawH = drag.currentH;
        }
        const clamped = {
            x: clamp(rawX, area.x, area.x + area.width - rawW),
            y: clamp(rawY, area.y, area.y + area.height - rawH),
            width: rawW,
            height: rawH,
        };
        let nextBox;
        if (noSnap) {
            this._snapGuides = {x: [], y: []};
            nextBox = clamped;
        } else {
            const snapped = snapBox(clamped, area, SNAP_THRESHOLD);
            this._snapGuides = snapped.guides;
            nextBox = snapped.box;
        }
        this._monitorIndex = drag.monitorIndex;
        this._applyRenderBox(nextBox);
        this._notifyDockBox();
        this._area.queue_draw();
        return true;
    }

    _onButtonRelease(ev) {
        const [, button] = ev.get_button();
        if (button !== 1 || !this._dragMode)
            return true;
        if (this._isActiveDrag())
            this._onMotion(ev);
        this._finishDrag(true);
        return true;
    }

    _onKeyPress(ev) {
        const [, keyval] = ev.get_keyval();
        if (this._dragMode && keyval === Gdk.KEY_Escape) {
            this._finishDrag(false);
            return true;
        }
        return false;
    }

    _cancelDrag() {
        if (this._dragMode)
            this._finishDrag(false);
    }

    _finishDrag(commit) {
        const wasActive = this._isActiveDrag();
        const drag = this._drag;
        const pendingLine = this._pendingLine;
        this._dragMode = null;
        this._drag = null;
        this._pendingLine = null;
        this._snapGuides = {x: [], y: []};
        this._setCursor(null);
        if (wasActive && drag && this._renderBox) {
            const changed = this._monitorIndex !== drag.startMonitorIndex
                || ['x', 'y', 'width', 'height'].some(k => Math.round(this._renderBox[k]) !== Math.round(drag.startBox[k]));
            if (commit && changed) {
                const area = this._workArea(this._monitorIndex);
                const geometry = commitLyricGeometry(
                    this._renderBox,
                    area,
                    this._singleLineHeight(this._renderBox.width),
                    this._settings.get_string('pitch-dock'),
                    this._settings.get_boolean('pitch-enabled'),
                );
                this._settings.set_int('box-monitor', this._monitorIndex === this._monitors.primaryIndex ? -1 : this._monitorIndex);
                this._settings.set_value('box', new GLib.Variant('a{sd}', geometry));
            }
            this._placeBox();
        }
        if (pendingLine)
            this.setLine(pendingLine);
        this._syncWindowVisible();
        this._applyInputShape();
        this._area.queue_draw();
    }

    _onScroll(ev) {
        if (this._dragMode)
            return true;
        const [, state] = ev.get_state();
        if (!(state & Gdk.ModifierType.CONTROL_MASK))
            return false;
        let steps = 0;
        const [hasDir, dir] = ev.get_scroll_direction();
        if (hasDir) {
            if (dir === Gdk.ScrollDirection.UP)
                steps = 1;
            else if (dir === Gdk.ScrollDirection.DOWN)
                steps = -1;
        }
        if (!steps) {
            const [hasDeltas, , dy] = ev.get_scroll_deltas();
            if (hasDeltas && dy !== 0)
                steps = -dy;
        }
        if (!steps)
            return true;
        this.previewFontSize(this.fontSize * SCROLL_STEP_RATIO ** steps);
        if (this._scrollCommitId)
            GLib.source_remove(this._scrollCommitId);
        this._scrollCommitId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SCROLL_COMMIT_MS, () => {
            this._scrollCommitId = 0;
            this.commitFontSize();
            return GLib.SOURCE_REMOVE;
        });
        return true;
    }
}
