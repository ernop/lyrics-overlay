// Standard decorated GNOME desktop window for the White-Paper Piano Lead Sheet.
//
// Behaves like a normal OS window (native titlebar, drag, resize, snap/tile,
// Alt-Tab, optional Always-on-top toggle). Inside the window, a compact
// high-contrast top toolbar provides instant zoom (60%–350%), page flip,
// Always-on-top, Editor & MIDI, and live `⚙ Options` (anchored right beside
// the sheet). Resizing the window or zooming in automatically reflows bars/row
// and visible rows when set to Auto so deep zoom (up to 350%) is never clamped
// by a fixed bar count.

import Gdk from 'gi://Gdk?version=3.0';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk?version=3.0';

import {
    boxFromGeometry, geometryFromBox,
} from '../shared/overlay-geometry.js';
import {
    buildLeadSheet, findActiveLeadSheetPosition, planLeadSheetPage,
} from '../shared/score-layout.js';
import {
    paintLeadSheetPage,
} from '../shared/score-painter.js';
import {QuietMapGuard} from './desktop-actions.js';
import {ScoreConfigPanel} from './score-config-panel.js';

const PLAYHEAD_TICK_MS = 33; // ~30 fps while playing
const SAVE_DEBOUNCE_MS = 280;
const SCROLL_COMMIT_MS = 180;
const MIN_WIN_W = 360;
const MIN_WIN_H = 220;

const LOOK_KEYS = new Set([
    'score-scale-snap',
    'score-harmony',
    'score-voices',
    'score-note-names',
    'score-background-opacity',
    'score-bars-per-system',
    'score-scale',
    'score-spacing',
    'score-paging',
    'score-always-on-top',
    'score-show-header',
    'score-header-title',
    'score-header-key',
    'score-header-time',
    'score-header-bpm',
    'score-header-clef',
    'score-header-bars',
    'score-header-page',
    'score-show-measure-numbers',
    'score-show-chords',
    'score-show-lyrics',
    'score-show-playhead',
    'score-show-active-measure',
    'score-show-snap-moves',
    'pitch-scale',
    'pitch-scale-root',
    'pitch-scale-type',
]);

const REBUILD_KEYS = new Set([
    'score-scale-snap',
    'score-harmony',
    'score-voices',
    'score-bars-per-system',
    'score-scale',
    'score-spacing',
    'score-show-chords',
    'score-show-lyrics',
    'pitch-scale',
    'pitch-scale-root',
    'pitch-scale-type',
]);

const TOOLBAR_CSS = `
.score-win-toolbar {
    background-color: #111111;
    color: #ffffff;
    border-bottom: 2px solid #000000;
    padding: 4px 8px;
}
.score-win-label {
    color: #ffffff;
    font-size: 12px;
    font-weight: 700;
}
.score-win-val {
    color: #facc15;
    font-size: 13px;
    font-weight: 800;
}
button.score-tb-btn {
    background-image: none;
    background-color: #1e2433;
    color: #ffffff;
    border: 2px solid #ffffff;
    border-radius: 6px;
    padding: 2px 8px;
    font-size: 12px;
    font-weight: 800;
    min-height: 24px;
    min-width: 26px;
}
button.score-tb-btn:hover {
    background-color: #2c354a;
}
button.score-tb-btn.selected {
    background-color: #facc15;
    color: #000000;
    border: 3px solid #93c5fd;
    font-weight: 800;
}
`;

let toolbarCssInstalled = false;

function ensureToolbarCss() {
    if (toolbarCssInstalled)
        return;
    const screen = Gdk.Screen.get_default();
    if (!screen)
        return;
    const provider = new Gtk.CssProvider();
    provider.load_from_data(TOOLBAR_CSS);
    Gtk.StyleContext.add_provider_for_screen(screen, provider, Gtk.STYLE_PROVIDER_PRIORITY_APPLICATION);
    toolbarCssInstalled = true;
}

function clamp(v, lo, hi) {
    return Math.min(hi, Math.max(lo, v));
}

export class ScoreWindow {
    /**
     * @param {{
     *   settings: import('gi://Gio').Settings,
     *   monitors: import('./monitors.js').Monitors,
     *   onOpenEditor: () => void,
     *   onContextMenu: () => void,
     *   onEditScore: (patch: object) => void,
     * }} opts
     */
    constructor({settings, monitors, onOpenEditor, onContextMenu, onEditScore}) {
        ensureToolbarCss();
        this._settings = settings;
        this._monitors = monitors;
        this._onOpenEditor = onOpenEditor;
        this._onContextMenu = onContextMenu;
        this._onEditScore = onEditScore;

        this._shown = false;
        this._payload = null;
        this._songKey = null;
        this._leadSheet = null;
        this._builtCols = 0;
        this._manualSystemOffset = 0;
        this._box = null;
        this._canvasWidth = 1040;
        this._canvasHeight = 360;
        this._monitorIndex = 0;
        this._tickId = 0;
        this._saveTimerId = 0;
        this._scalePreview = null;
        this._scaleCommitId = 0;
        this._applyingStored = false;
        this._lastPainted = null;

        this._configPanel = new ScoreConfigPanel({
            settings,
            onOpenEditor: () => this._onOpenEditor?.(),
            onOpenSettings: () => this._onContextMenu?.(),
            onEditScore: patch => this._onEditScore?.(patch),
        });

        // Standard decorated OS window managed natively by GNOME.
        // Map quietly (accept_focus=false until after first paint) so a song
        // starting or toggling never steals focus or triggers GNOME Shell's
        // "window is ready" attention notification, while restoring full
        // click-to-focus, keyboard, and Alt-Tab behavior immediately after map.
        this._win = new Gtk.Window({
            type: Gtk.WindowType.TOPLEVEL,
            title: 'Piano Lead Sheet',
            decorated: true,
            resizable: true,
            skip_taskbar_hint: false,
            skip_pager_hint: false,
        });
        this._win.set_type_hint(Gdk.WindowTypeHint.NORMAL);
        this._win.set_size_request(MIN_WIN_W, MIN_WIN_H);
        this._win.set_keep_above(this._settings.get_boolean('score-always-on-top'));
        this._quietMap = new QuietMapGuard(this._win, {restoreSkipTaskbar: false});

        this._win.connect('map-event', () => {
            this._win.set_keep_above(this._settings.get_boolean('score-always-on-top'));
            if (this._box)
                this._win.move(Math.round(this._box.x), Math.round(this._box.y));
            return false;
        });

        this._win.connect('key-press-event', (_w, ev) => {
            const [, keyval] = ev.get_keyval();
            if (keyval === Gdk.KEY_Escape && this._configPanel.visible) {
                this._configPanel.hide();
                this._syncToolbar();
                return true;
            }
            return false;
        });

        this._win.connect('delete-event', () => {
            this._configPanel.hide();
            this._quietMap.prepareHide();
            this._win.hide();
            if (this._settings.get_boolean('score-enabled'))
                this._settings.set_boolean('score-enabled', false);
            return true;
        });

        this._win.connect('configure-event', () => {
            if (!this._win.get_visible() || this._applyingStored)
                return false;
            const [wx, wy] = this._win.get_position();
            const [ww, wh] = this._win.get_size();
            if (ww >= MIN_WIN_W && wh >= MIN_WIN_H) {
                this._box = {x: wx, y: wy, width: ww, height: wh};
                const under = this._monitors.indexAtPoint(wx + ww / 2, wy + wh / 2);
                if (under >= 0)
                    this._monitorIndex = under;
                this._scheduleSaveGeometry();
            }
            return false;
        });

        const vbox = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 0});
        vbox.pack_start(this._buildToolbar(), false, false, 0);

        this._area = new Gtk.DrawingArea();
        this._area.set_hexpand(true);
        this._area.set_vexpand(true);
        this._area.add_events(
            Gdk.EventMask.BUTTON_PRESS_MASK
            | Gdk.EventMask.SCROLL_MASK
            | Gdk.EventMask.SMOOTH_SCROLL_MASK,
        );
        this._area.connect('draw', (_a, cr) => this._onDraw(cr));
        this._area.connect('size-allocate', (_a, alloc) => {
            const w = Math.max(200, Math.round(alloc.width));
            const h = Math.max(120, Math.round(alloc.height));
            if (w !== this._canvasWidth || h !== this._canvasHeight) {
                this._canvasWidth = w;
                this._canvasHeight = h;
                const desiredCols = this._effectiveBarsPerSystem();
                if (desiredCols !== this._builtCols && this._payload?.score?.notes?.length)
                    this._rebuildLeadSheet();
                this._syncToolbar();
                this._area.queue_draw();
            }
        });
        this._area.connect('button-press-event', (_a, ev) => this._onCanvasClick(ev));
        this._area.connect('scroll-event', (_a, ev) => this._onScroll(ev));
        vbox.pack_start(this._area, true, true, 0);

        this._win.add(vbox);

        this._settingsId = this._settings.connect('changed', (_s, key) => this._onSettingChanged(key));
        this._disconnectMonitors = this._monitors.onChanged(() => this._restoreStoredGeometry());
        this._restoreStoredGeometry();
        this._syncToolbar();
    }

    destroy() {
        this._stopTick();
        if (this._saveTimerId) {
            GLib.source_remove(this._saveTimerId);
            this._saveTimerId = 0;
        }
        if (this._scaleCommitId) {
            GLib.source_remove(this._scaleCommitId);
            this._scaleCommitId = 0;
        }
        if (this._settingsId) {
            this._settings.disconnect(this._settingsId);
            this._settingsId = 0;
        }
        this._disconnectMonitors?.();
        this._configPanel.destroy();
        this._quietMap.destroy();
        this._win.destroy();
    }

    get visible() {
        return this._shown && this._win.get_visible();
    }

    get box() {
        return this._box ? {...this._box} : null;
    }

    get configVisible() {
        return this._configPanel.visible;
    }

    toggleConfigPanel() {
        this._configPanel.toggleNear(this._box, this._workArea(this._monitorIndex));
        this._syncToolbar();
    }

    setShown(shown) {
        const next = Boolean(shown);
        if (next === this._shown)
            return;
        this._shown = next;
        this._syncVisible();
        this._syncTick();
    }

    setSongKey(key) {
        const prev = JSON.stringify(this._songKey);
        const next = JSON.stringify(key ?? null);
        if (prev === next)
            return;
        this._songKey = key ?? null;
        this._rebuildLeadSheet();
        this._area.queue_draw();
    }

    setPayload(payload) {
        const prevVideo = this._payload?.videoId ?? null;
        const nextVideo = payload?.videoId ?? null;
        if (prevVideo !== nextVideo)
            this._manualSystemOffset = 0;
        const wasPlaying = Boolean(this._payload?.clock?.playing);
        const nowPlaying = Boolean(payload?.clock?.playing);
        if (!wasPlaying && nowPlaying)
            this._manualSystemOffset = 0;

        this._payload = payload ?? null;
        const title = this._payload?.title ? `Piano Lead Sheet \u2014 ${this._payload.title}` : 'Piano Lead Sheet';
        this._win.set_title(title);

        this._rebuildLeadSheet();
        this._syncVisible();
        this._syncTick();
        this._syncToolbar();
        this._area.queue_draw();
    }

    // ----- toolbar

    _buildToolbar() {
        const bar = new Gtk.Box({orientation: Gtk.Orientation.HORIZONTAL, spacing: 6});
        bar.get_style_context().add_class('score-win-toolbar');

        const zoomOut = new Gtk.Button({label: '\u2212'});
        zoomOut.get_style_context().add_class('score-tb-btn');
        zoomOut.set_tooltip_text('Zoom out (Ctrl+wheel)');
        zoomOut.connect('clicked', () => this._nudgeZoom(-0.15));
        bar.pack_start(zoomOut, false, false, 0);

        this._zoomBtn = new Gtk.Button({label: '100%'});
        this._zoomBtn.get_style_context().add_class('score-tb-btn');
        this._zoomBtn.set_tooltip_text('Reset zoom to 100%');
        this._zoomBtn.connect('clicked', () => this._settings.set_double('score-scale', 1.0));
        bar.pack_start(this._zoomBtn, false, false, 0);

        const zoomIn = new Gtk.Button({label: '+'});
        zoomIn.get_style_context().add_class('score-tb-btn');
        zoomIn.set_tooltip_text('Zoom in up to 350% (Ctrl+wheel)');
        zoomIn.connect('clicked', () => this._nudgeZoom(+0.15));
        bar.pack_start(zoomIn, false, false, 0);

        const prevBtn = new Gtk.Button({label: '\u25c0'});
        prevBtn.get_style_context().add_class('score-tb-btn');
        prevBtn.set_tooltip_text('Previous page');
        prevBtn.connect('clicked', () => this._flipPage(-1));
        bar.pack_start(prevBtn, false, false, 0);

        const nextBtn = new Gtk.Button({label: '\u25b6'});
        nextBtn.get_style_context().add_class('score-tb-btn');
        nextBtn.set_tooltip_text('Next page');
        nextBtn.connect('clicked', () => this._flipPage(+1));
        bar.pack_start(nextBtn, false, false, 0);

        this._liveBtn = new Gtk.Button({label: 'Live'});
        this._liveBtn.get_style_context().add_class('score-tb-btn');
        this._liveBtn.set_tooltip_text('Return to live playback position');
        this._liveBtn.connect('clicked', () => {
            this._manualSystemOffset = 0;
            this._syncToolbar();
            this._area.queue_draw();
        });
        bar.pack_start(this._liveBtn, false, false, 0);

        this._layoutLbl = new Gtk.Label({label: '', xalign: 0});
        this._layoutLbl.get_style_context().add_class('score-win-val');
        bar.pack_start(this._layoutLbl, true, true, 4);

        this._onTopBtn = new Gtk.Button({label: 'On top'});
        this._onTopBtn.get_style_context().add_class('score-tb-btn');
        this._onTopBtn.set_tooltip_text('Keep Piano Lead Sheet above other windows');
        this._onTopBtn.connect('clicked', () => {
            this._settings.set_boolean('score-always-on-top', !this._settings.get_boolean('score-always-on-top'));
        });
        bar.pack_end(this._onTopBtn, false, false, 0);

        this._optBtn = new Gtk.Button({label: '\u2699 Options'});
        this._optBtn.get_style_context().add_class('score-tb-btn');
        this._optBtn.connect('clicked', () => this.toggleConfigPanel());
        bar.pack_end(this._optBtn, false, false, 0);

        const edBtn = new Gtk.Button({label: 'Editor & MIDI'});
        edBtn.get_style_context().add_class('score-tb-btn');
        edBtn.connect('clicked', () => this._onOpenEditor?.());
        bar.pack_end(edBtn, false, false, 0);

        return bar;
    }

    _syncToolbar() {
        if (!this._zoomBtn)
            return;
        const plan = this._planPage();
        const effScale = this._lastPainted?.effectiveScale ?? plan.effectiveScale;
        const pct = Math.round(effScale * 100);
        this._zoomBtn.set_label(`${pct}%`);

        const onTop = this._settings.get_boolean('score-always-on-top');
        const onTopCtx = this._onTopBtn.get_style_context();
        if (onTop)
            onTopCtx.add_class('selected');
        else
            onTopCtx.remove_class('selected');

        const optCtx = this._optBtn.get_style_context();
        if (this._configPanel.visible)
            optCtx.add_class('selected');
        else
            optCtx.remove_class('selected');

        if (this._liveBtn) {
            const liveCtx = this._liveBtn.get_style_context();
            if (this._manualSystemOffset !== 0)
                liveCtx.add_class('selected');
            else
                liveCtx.remove_class('selected');
        }

        const barsVal = this._settings.get_int('score-bars-per-system');
        const shownBars = this._lastPainted?.barsPerSystem ?? plan.barsPerSystem;
        const shownRows = this._lastPainted?.visibleRows ?? plan.rows;
        const isAuto = barsVal === 0 || Boolean(this._lastPainted?.reflowed ?? plan.reflowed);
        const prefix = isAuto ? 'Auto \u00b7 ' : '';
        this._layoutLbl.set_label(`${prefix}${shownBars} bars \u00d7 ${shownRows} rows`);
    }

    _releasePinnedBarsIfNeeded(nextScale) {
        const pinned = this._settings.get_int('score-bars-per-system');
        if (pinned <= 0)
            return false;
        const plan = this._planPage(nextScale);
        if (plan.reflowed) {
            this._settings.set_int('score-bars-per-system', 0);
            return true;
        }
        return false;
    }

    _nudgeZoom(delta) {
        const cur = this._currentScale();
        const next = clamp(Math.round((cur + delta) * 20) / 20, 0.6, 3.5);
        this._scalePreview = null;
        this._releasePinnedBarsIfNeeded(next);
        this._settings.set_double('score-scale', next);
    }

    _flipPage(delta) {
        if (!this._leadSheet)
            return;
        const pos = findActiveLeadSheetPosition(this._leadSheet, this._currentMediaTime());
        const paging = this._settings.get_string('score-paging');
        const visRows = Math.max(1, this._lastPainted?.visibleRows || this._planPage().rows || 2);
        const total = this._leadSheet.systems.length;
        if (paging === 'scroll') {
            const maxSys = Math.max(0, total - 1);
            const nextSys = clamp(pos.systemIndex + this._manualSystemOffset + delta, 0, maxSys);
            this._manualSystemOffset = nextSys - pos.systemIndex;
        } else {
            const curPage = Math.floor(pos.systemIndex / visRows);
            const maxPage = Math.max(0, Math.floor((Math.max(1, total) - 1) / visRows));
            const nextPage = clamp(curPage + this._manualSystemOffset + delta, 0, maxPage);
            this._manualSystemOffset = nextPage - curPage;
        }
        this._syncToolbar();
        this._area.queue_draw();
    }

    // ----- geometry persistence

    _workArea(monitorIndex) {
        return this._monitors.workArea(monitorIndex);
    }

    _currentScale() {
        return this._scalePreview ?? this._settings.get_double('score-scale');
    }

    _planPage(scaleOverride = null, barsOverride = null) {
        const s = this._settings;
        return planLeadSheetPage(this._leadSheet, {
            width: Math.max(MIN_WIN_W, this._canvasWidth),
            height: Math.max(MIN_WIN_H - 40, this._canvasHeight),
            scale: scaleOverride ?? this._currentScale(),
            barsPerSystem: barsOverride !== null ? barsOverride : s.get_int('score-bars-per-system'),
            spacing: s.get_string('score-spacing'),
            showHeader: s.get_boolean('score-show-header'),
            showMeasureNumbers: s.get_boolean('score-show-measure-numbers'),
            showChords: s.get_boolean('score-show-chords'),
            showLyrics: s.get_boolean('score-show-lyrics'),
            noteNames: s.get_string('score-note-names'),
            showSnapMoves: s.get_boolean('score-show-snap-moves'),
        });
    }

    _effectiveBarsPerSystem() {
        return this._planPage().barsPerSystem;
    }

    _restoreStoredGeometry() {
        this._monitorIndex = this._monitors.indexForSetting(this._settings.get_int('score-box-monitor'));
        const area = this._workArea(this._monitorIndex);
        const geom = this._settings.get_value('score-box').deepUnpack();
        const rect = boxFromGeometry(geom, area);
        const width = clamp(Math.round(rect.width), MIN_WIN_W, area.width);
        const height = clamp(Math.round(rect.height), MIN_WIN_H, area.height);
        const x = clamp(Math.round(rect.x), area.x, area.x + area.width - width);
        const y = clamp(Math.round(rect.y), area.y, area.y + area.height - height);
        this._box = {x, y, width, height};
        this._applyingStored = true;
        try {
            this._win.set_default_size(width, height);
            this._win.resize(width, height);
            this._win.move(x, y);
        } finally {
            GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._applyingStored = false;
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    _scheduleSaveGeometry() {
        if (this._saveTimerId)
            GLib.source_remove(this._saveTimerId);
        this._saveTimerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DEBOUNCE_MS, () => {
            this._saveTimerId = 0;
            if (!this._box)
                return GLib.SOURCE_REMOVE;
            const area = this._workArea(this._monitorIndex);
            const geom = geometryFromBox(this._box, area);
            this._settings.set_value('score-box', new GLib.Variant('a{sd}', geom));
            this._settings.set_int('score-box-monitor', this._monitorIndex);
            return GLib.SOURCE_REMOVE;
        });
    }

    _syncVisible() {
        if (this._shown) {
            if (!this._win.get_visible()) {
                this._quietMap.prepareShow();
                this._win.show_all();
                this._win.set_keep_above(this._settings.get_boolean('score-always-on-top'));
                if (this._box)
                    this._win.move(Math.round(this._box.x), Math.round(this._box.y));
            }
        } else {
            this._configPanel.hide();
            if (this._win.get_visible()) {
                this._quietMap.prepareHide();
                this._win.hide();
            }
        }
    }

    _rebuildLeadSheet() {
        const score = this._payload?.score ?? null;
        if (!score || !Array.isArray(score.notes) || !score.notes.length) {
            this._leadSheet = null;
            this._builtCols = 0;
            this._configPanel.setSongInfo({hasScore: false});
            return;
        }
        const s = this._settings;
        const showChords = s.get_boolean('score-show-chords');
        const buildOpts = cols => ({
            lyricLines: this._payload?.lyricsLines ?? [],
            ...(fallbackKey ? {keyOverride: fallbackKey} : {}),
            scaleSnap: s.get_string('score-scale-snap'),
            harmony: s.get_string('score-harmony'),
            voiceMode: s.get_string('score-voices'),
            barsPerSystem: cols,
            showChords,
        });
        // Let the song's own detected key + per-song edits drive the lead sheet directly!
        // (Only fall back to live mic `this._songKey` if the score itself has no key.)
        const fallbackKey = !score.key && !score.edits?.keyOverride ? this._songKey : null;
        let barsPerSystem = this._effectiveBarsPerSystem();
        this._leadSheet = buildLeadSheet(score, buildOpts(barsPerSystem));
        // Re-check once with the song's real key signature & vocal density so systems match paintLeadSheetPage() on frame 1.
        const refinedCols = this._effectiveBarsPerSystem();
        if (refinedCols !== barsPerSystem) {
            barsPerSystem = refinedCols;
            this._leadSheet = buildLeadSheet(score, buildOpts(barsPerSystem));
        }
        this._builtCols = barsPerSystem;
        this._configPanel.setSongInfo({
            hasScore: true,
            key: this._leadSheet?.key ?? score.edits?.keyOverride ?? score.key ?? null,
            detectedKey: score.key ?? null,
            hasKeyOverride: Boolean(score.edits?.keyOverride),
            clef: score.edits?.clef || 'auto',
            actualClef: this._leadSheet?.clef ?? 'treble',
        });
    }

    _currentMediaTime() {
        const clock = this._payload?.clock;
        if (!clock || !Number.isFinite(clock.mediaTime))
            return 0;
        const elapsed = clock.playing ? Math.max(0, (Date.now() - clock.sentAtMs) / 1000) : 0;
        return clock.mediaTime + elapsed * (clock.rate || 1);
    }

    _syncTick() {
        const want = this._shown && Boolean(this._leadSheet) && Boolean(this._payload?.clock?.playing);
        if (!want) {
            this._stopTick();
            return;
        }
        if (this._tickId)
            return;
        this._tickId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, PLAYHEAD_TICK_MS, () => {
            if (!this._shown || !this._leadSheet || !this._payload?.clock?.playing) {
                this._tickId = 0;
                return GLib.SOURCE_REMOVE;
            }
            this._area.queue_draw();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTick() {
        if (this._tickId) {
            GLib.source_remove(this._tickId);
            this._tickId = 0;
        }
    }

    // ----- drawing

    _headerFields() {
        const s = this._settings;
        return {
            title: s.get_boolean('score-header-title'),
            key: s.get_boolean('score-header-key'),
            time: s.get_boolean('score-header-time'),
            bpm: s.get_boolean('score-header-bpm'),
            clef: s.get_boolean('score-header-clef'),
            bars: s.get_boolean('score-header-bars'),
            page: s.get_boolean('score-header-page'),
        };
    }

    _onDraw(cr) {
        const alloc = this._area.get_allocation();
        const width = Math.max(1, Math.round(alloc.width));
        const height = Math.max(1, Math.round(alloc.height));

        const title = this._payload?.title || 'Piano Lead Sheet';
        const statusMsg = this._payload?.status === 'running'
            ? (this._payload.message || 'Extracting piano lead sheet\u2026')
            : (this._payload?.status === 'error' || this._payload?.status === 'skipped'
                ? (this._payload.message || 'Lead sheet unavailable for this track')
                : 'Play a song to view its piano lead sheet');

        let currentSystemIndex = 0;
        let activeMeasureIndex = -1;
        let activeNoteId = null;
        let activeItemId = null;
        let measureProgress = 0;

        if (this._leadSheet) {
            const pos = findActiveLeadSheetPosition(this._leadSheet, this._currentMediaTime());
            currentSystemIndex = pos.systemIndex;
            if (this._manualSystemOffset === 0) {
                activeMeasureIndex = pos.measureIndex;
                activeNoteId = pos.activeNoteId;
                activeItemId = pos.activeItemId;
                measureProgress = pos.measureProgress;
            }
        }

        const s = this._settings;
        const painted = paintLeadSheetPage(cr, this._leadSheet, {
            width,
            height,
            title,
            statusMessage: statusMsg,
            currentSystemIndex,
            manualSystemOffset: this._manualSystemOffset,
            activeMeasureIndex,
            activeNoteId,
            activeItemId,
            measureProgress,
            noteNames: s.get_string('score-note-names'),
            paperOpacity: s.get_double('score-background-opacity'),
            scale: this._currentScale(),
            spacing: s.get_string('score-spacing'),
            barsPerSystem: s.get_int('score-bars-per-system'),
            paging: s.get_string('score-paging'),
            showHeader: s.get_boolean('score-show-header'),
            headerFields: this._headerFields(),
            showMeasureNumbers: s.get_boolean('score-show-measure-numbers'),
            showChords: s.get_boolean('score-show-chords'),
            showLyrics: s.get_boolean('score-show-lyrics'),
            showPlayhead: s.get_boolean('score-show-playhead'),
            showActiveMeasure: s.get_boolean('score-show-active-measure'),
            showSnapMoves: s.get_boolean('score-show-snap-moves'),
            showConfigButton: false,
            framelessPaper: true,
        });
        const prevPainted = this._lastPainted;
        this._lastPainted = painted;
        if (painted && (
            painted.barsPerSystem !== prevPainted?.barsPerSystem
            || painted.visibleRows !== prevPainted?.visibleRows
            || Math.abs((painted.effectiveScale ?? 1) - (prevPainted?.effectiveScale ?? 1)) > 0.005
            || painted.reflowed !== prevPainted?.reflowed
        ))
            this._syncToolbar();
        return false;
    }

    // ----- input

    _onCanvasClick(ev) {
        if (ev.get_event_type() !== Gdk.EventType.BUTTON_PRESS)
            return false;
        const [, button] = ev.get_button();
        if (button === 3) {
            this.toggleConfigPanel();
            return true;
        }
        // Plain left-click simply focuses/keeps the standard Lead Sheet window.
        return false;
    }

    _onScroll(ev) {
        const [, state] = ev.get_state();
        const ctrl = Boolean(state & Gdk.ModifierType.CONTROL_MASK);
        const [, dir] = ev.get_scroll_direction();
        let delta = 0;
        if (dir === Gdk.ScrollDirection.UP) {
            delta = -1;
        } else if (dir === Gdk.ScrollDirection.DOWN) {
            delta = 1;
        } else if (dir === Gdk.ScrollDirection.SMOOTH) {
            const [, , dy] = ev.get_scroll_deltas();
            if (Math.abs(dy) > 0.1)
                delta = dy > 0 ? 1 : -1;
        }
        if (!delta)
            return false;

        // Ctrl+wheel zooms smoothly 60%..350% and auto-reflows immediately!
        if (ctrl) {
            const step = this._currentScale() >= 2.0 ? 0.12 : 0.08;
            const nextScale = clamp(Math.round((this._currentScale() - delta * step) * 100) / 100, 0.6, 3.5);
            this._scalePreview = nextScale;
            this._releasePinnedBarsIfNeeded(nextScale);
            if (this._effectiveBarsPerSystem() !== this._builtCols)
                this._rebuildLeadSheet();
            this._syncToolbar();
            this._area.queue_draw();
            if (this._scaleCommitId)
                GLib.source_remove(this._scaleCommitId);
            this._scaleCommitId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SCROLL_COMMIT_MS, () => {
                this._scaleCommitId = 0;
                if (this._scalePreview !== null) {
                    const v = this._scalePreview;
                    this._scalePreview = null;
                    this._releasePinnedBarsIfNeeded(v);
                    this._settings.set_double('score-scale', v);
                }
                return GLib.SOURCE_REMOVE;
            });
            return true;
        }

        // Plain wheel flips pages/rows.
        this._flipPage(delta);
        return true;
    }

    _onSettingChanged(key) {
        if (key === 'score-always-on-top') {
            this._win.set_keep_above(this._settings.get_boolean('score-always-on-top'));
            this._syncToolbar();
            return;
        }
        if (key === 'score-box' || key === 'score-box-monitor') {
            if (!this._saveTimerId)
                this._restoreStoredGeometry();
            return;
        }
        if (key === 'score-scale')
            this._releasePinnedBarsIfNeeded(this._currentScale());
        if (REBUILD_KEYS.has(key))
            this._rebuildLeadSheet();
        if (LOOK_KEYS.has(key)) {
            this._syncToolbar();
            this._area.queue_draw();
        }
    }
}
