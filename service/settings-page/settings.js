// Lyrics overlay settings page (http://localhost:8792/settings):
// Dense two-column studio layout: a sticky left stage holding the live
// preview / screen map plus pinned active-song timing, actions, and lyric
// sets, beside a compact 2-column Lyrics & Pitch control deck.

import {LYRICS_STATUS_TEXT} from '/shared/lyrics-status.js';
import {BORDER_DEFAULTS, PLACEMENT_PRESETS, borderSpec} from '/shared/overlay-geometry.js';
import {keyName, noteLabel, pitchClassNames, SCALES} from '/shared/scales.js';
import {TEXT_COLORS, hexColor, nearestNamedColor, parseHexColor, resolveRingColors, resolveTextColor} from '/shared/text-ink.js';
import {LyricPreviewCanvas, PitchPreviewCanvas, ScreenPlacementMap} from '/preview.js';

const POLL_MS = 1000;
const MICROPHONE_POLL_MS = 10_000;
// The newest release's signed add-on; GitHub serves it as an install, so
// Firefox asks to add it (tests/update-manifest.test.mjs keeps it at the
// manifest's update_url).
const ADDON_DOWNLOAD = 'https://github.com/ernop/lyrics-overlay/releases/latest/download/lyrics-overlay.xpi';
const ADDON_TEXT = {
    unheard: () => 'Not heard from yet',
    unnamed: () => 'Older than 1.3.0',
    current: addon => addon.version,
    older: addon => `${addon.version}, older than ${addon.current}`,
    newer: addon => `${addon.version}, newer than the service`,
};
const SLIDER_STEPS = 1000;
const MIN_FIXED_SPAN = 6;
const SHARPS = pitchClassNames(null);
const DEFAULT_SAMPLE = 'Amazing grace, how sweet the sound';
const KANJI_RE = /[\u4e00-\u9fff\u3400-\u4dbf\u3005]/u;

const LINE_COLORS = [
    ['#facc15', 'Yellow'], ['#ffffff', 'White'], ['#fb923c', 'Orange'], ['#ef4444', 'Red'], ['#f472b6', 'Pink'],
    ['#e879f9', 'Magenta'], ['#a78bfa', 'Purple'], ['#60a5fa', 'Blue'], ['#22d3ee', 'Cyan'], ['#4ade80', 'Green'],
];

const BACKDROP_SWATCHES = [
    ['#000000', 'Black'], ['#141824', 'Midnight'], ['#1f2937', 'Slate'], ['#2b1429', 'Plum'], ['#ffffff', 'White'],
];

const DEFAULT_MONITOR = {index: 0, x: 0, y: 0, width: 1920, height: 1080, scale: 1, primary: true, label: 'Primary (1920\u00d71080)'};

const model = {
    schema: null,
    values: null,
    monitors: [DEFAULT_MONITOR],
    state: null,
    line: {text: '', key: 'none'},
    addon: null,
    furigana: {available: true, dict: '', error: ''},
    furiganaCache: new Map(),
    furiganaPending: new Set(),
    pending: new Map(),
    sending: false,
    held: new Set(),
    views: [],
    stateViews: [],
    stageMode: 'lyric', // 'lyric' | 'pitch' | 'map'
    previewScene: 'video',
    customSample: '',
    lyricPreview: null,
    placementMap: null,
    pitchPreview: null,
    stageSync: null,
    lyricsModal: null,
    actionError: '',
    connectionError: '',
};

// ----- service

async function call(method, path, body) {
    const response = await fetch(path, {
        method,
        cache: 'no-store',
        headers: body === undefined ? {} : {'Content-Type': 'application/json'},
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const json = response.status === 204 ? null : await response.json();
    if (!response.ok)
        throw new Error(json?.error ?? `the service answered ${response.status}`);
    return json;
}

function syncBanner() {
    const banner = document.getElementById('banner');
    const text = model.connectionError || model.actionError;
    banner.hidden = !text;
    if (!text) {
        banner.replaceChildren();
        return;
    }
    const dismiss = model.actionError && !model.connectionError
        ? [pressButton('Dismiss', () => showBanner(''), {class: 'compact'})]
        : [];
    banner.replaceChildren(el('span', {}, text), ...dismiss);
}

function showBanner(text) {
    model.actionError = text;
    syncBanner();
}

function showConnectionBanner(text) {
    model.connectionError = text;
    syncBanner();
}

function activeMonitor(monitorKey = 'box-monitor') {
    const stored = model.values?.[monitorKey] ?? -1;
    if (stored >= 0 && stored < model.monitors.length)
        return model.monitors[stored];
    return model.monitors.find(m => m.primary) ?? model.monitors[0] ?? DEFAULT_MONITOR;
}

function activeSampleText() {
    if (model.customSample.trim())
        return model.customSample;
    if (model.line?.text)
        return model.line.text;
    return DEFAULT_SAMPLE;
}

function rubyForPreview(text) {
    if (!model.values?.['text-furigana'] || !KANJI_RE.test(text))
        return null;
    if (model.line?.text === text && Array.isArray(model.line.ruby))
        return model.line.ruby;
    if (model.furiganaCache.has(text))
        return model.furiganaCache.get(text);
    if (!model.furiganaPending.has(text)) {
        model.furiganaPending.add(text);
        call('GET', `/api/furigana?text=${encodeURIComponent(text)}`).then(answer => {
            if (answer?.status)
                model.furigana = answer.status;
            model.furiganaCache.set(text, Array.isArray(answer?.segments) ? answer.segments : null);
            render();
        }).catch(() => {
            // Keep preview rendering without furigana; pollState reports service errors.
        }).finally(() => {
            model.furiganaPending.delete(text);
        });
    }
    return null;
}

function render() {
    if (!model.values)
        return;
    for (const view of model.views)
        view(model.values);
    const monitor = activeMonitor('box-monitor');
    const text = activeSampleText();
    const ruby = rubyForPreview(text);
    model.lyricPreview?.render(model.values, monitor, text, model.previewScene, ruby);
    model.placementMap?.update(model.values, monitor, text);
    model.pitchPreview?.render(model.values, model.state?.key ?? null);
}

function absorb(values) {
    for (const [key, value] of Object.entries(values)) {
        if (!model.pending.has(key) && !model.held.has(key))
            model.values[key] = value;
    }
    render();
}

function setMany(changes) {
    for (const [key, value] of Object.entries(changes)) {
        model.values[key] = value;
        model.pending.set(key, value);
    }
    render();
    flush();
}

function set(key, value) {
    setMany({[key]: value});
}

async function flush() {
    if (model.sending || !model.pending.size)
        return;
    const changes = Object.fromEntries(model.pending);
    model.pending.clear();
    model.sending = true;
    try {
        absorb((await call('POST', '/api/settings', {changes})).values);
        showBanner('');
    } catch (error) {
        showBanner(`Not saved: ${error.message}`);
    } finally {
        model.sending = false;
    }
    flush();
}

async function post(path, body) {
    try {
        const answer = await call('POST', path, body);
        if (answer?.ok === false && answer.error)
            showBanner(answer.error);
        else
            showBanner('');
        if (answer?.values)
            absorb(answer.values);
        await pollState();
    } catch (error) {
        showBanner(error.message);
    }
}

async function pollSettings() {
    if (model.sending || model.pending.size)
        return;
    try {
        absorb((await call('GET', '/api/settings')).values);
    } catch {
        // pollState reports a stopped service.
    }
}

async function pollState() {
    try {
        const answer = await call('GET', '/api/state');
        model.state = answer.state;
        model.addon = answer.addon;
        if (answer.furigana)
            model.furigana = answer.furigana;
        const nextLine = answer.line ?? {text: '', key: 'none'};
        const lineChanged = nextLine.text !== model.line.text
            || nextLine.key !== model.line.key
            || JSON.stringify(nextLine.ruby ?? null) !== JSON.stringify(model.line.ruby ?? null);
        model.line = nextLine;
        for (const fn of model.stateViews)
            fn(model.state, model.addon, model.line);
        if (lineChanged)
            render();
        showConnectionBanner('');
    } catch (error) {
        showConnectionBanner(`Could not reach the service: ${error.message}`);
    }
}

// ----- DOM helpers

function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attrs)) {
        if (value === null || value === undefined || value === false)
            continue;
        if (name === 'style')
            Object.assign(node.style, value);
        else
            node.setAttribute(name, value === true ? '' : String(value));
    }
    node.append(...children);
    return node;
}

function view(fn) {
    model.views.push(fn);
}

function pageSection(id, title, panel) {
    return el('section', {id, class: 'settings-group'},
        el('h2', {class: 'settings-group-title'}, title),
        panel);
}

function cell(label, {span = false} = {}, ...controls) {
    return el('div', {class: span ? 'cell span-2' : 'cell'},
        el('div', {class: 'label'}, label),
        el('div', {class: 'controls'}, ...controls));
}

function whenVisible(node, predicate) {
    view(values => {
        node.hidden = !predicate(values);
    });
    return node;
}

function pressButton(text, onClick, attrs = {}) {
    const button = el('button', {type: 'button', ...attrs}, text);
    button.addEventListener('click', onClick);
    return button;
}

function segmentedCell(key, label, choices, {span = false, compact = false, extra = []} = {}) {
    const buttons = Object.entries(choices).map(([value, text]) => {
        const button = pressButton(text, () => set(key, value));
        view(values => button.setAttribute('aria-pressed', String(values[key] === value)));
        return button;
    });
    return cell(label, {span}, el('div', {class: compact ? 'seg compact' : 'seg'}, ...buttons), ...extra);
}

function switchCell(key, label, {span = false, extra = []} = {}) {
    const button = pressButton('', () => set(key, !model.values[key]), {class: 'switch'});
    view(values => {
        button.setAttribute('aria-pressed', String(values[key]));
        button.textContent = values[key] ? 'On' : 'Off';
    });
    return cell(label, {span}, button, ...extra);
}

function sliderCell(key, label, {ticks, format, log = false, integer = false, stepBy = null, span = false}) {
    const {min, max} = model.schema[key];
    const toPosition = value => (log ? Math.log(value / min) / Math.log(max / min) : (value - min) / (max - min));
    const fromPosition = position => {
        const raw = log ? min * (max / min) ** position : min + position * (max - min);
        return Math.min(max, Math.max(min, integer ? Math.round(raw) : raw));
    };
    const shown = el('span', {class: 'value'});
    const input = el('input', {type: 'range', min: 0, max: SLIDER_STEPS, step: 1, 'aria-label': label});
    const nudge = direction => {
        const current = model.values[key];
        let next;
        if (stepBy !== null)
            next = current + direction * stepBy;
        else if (log)
            next = current * (1.06 ** direction);
        else
            next = current + direction * (max - min) / 20;
        next = Math.min(max, Math.max(min, integer ? Math.round(next) : Math.round(next * 1000) / 1000));
        set(key, next);
    };
    const minus = pressButton('\u2212', () => nudge(-1), {class: 'step', 'aria-label': `Decrease ${label}`});
    const plus = pressButton('+', () => nudge(1), {class: 'step', 'aria-label': `Increase ${label}`});

    const release = () => {
        model.held.delete(key);
    };
    input.addEventListener('pointerdown', () => model.held.add(key));
    input.addEventListener('pointerup', release);
    input.addEventListener('pointercancel', release);
    input.addEventListener('blur', release);
    input.addEventListener('input', () => set(key, fromPosition(Number(input.value) / SLIDER_STEPS)));
    const tickMarks = el('div', {class: 'ticks', 'aria-hidden': 'true'}, ...ticks.map(value =>
        el('span', {class: 'tick', style: {left: `${toPosition(value) * 100}%`}}, format(value))));
    view(values => {
        const value = values[key];
        shown.textContent = format(value);
        if (!model.held.has(key))
            input.value = String(Math.round(toPosition(value) * SLIDER_STEPS));
        input.setAttribute('aria-valuetext', format(value));
    });
    return el('div', {class: span ? 'cell cell-slider span-2' : 'cell cell-slider'},
        el('div', {class: 'slider-head'},
            el('div', {class: 'label'}, label),
            shown,
            el('div', {class: 'slider-steppers'}, minus, plus)),
        el('div', {class: 'track'}, input, tickMarks));
}

const unit = (suffix, decimals = 0) => value => `${decimals ? Number(value).toFixed(decimals).replace(/\.0$/u, '') : Math.round(value)} ${suffix}`;
const percent = value => `${Math.round(value * 100)}%`;

// ----- Top bar

function buildTopBar() {
    const songTitle = el('span', {class: 'topbar-title'}, 'No song playing');
    const statusPill = el('span', {class: 'pill'}, 'Idle');
    const markMusicBtn = pressButton('This is a music video', () => post('/api/command', {op: 'lookUp'}), {
        class: 'primary compact',
        hidden: 'hidden',
    });

    const fullLyricsBtn = pressButton('Full lyrics', () => model.lyricsModal?.open('read'), {
        class: 'compact',
        disabled: 'disabled',
    });
    const overlayBtn = pressButton('', () => set('overlay-enabled', !model.values['overlay-enabled']), {class: 'switch'});
    const pitchBtn = pressButton('', () => set('pitch-enabled', !model.values['pitch-enabled']), {class: 'switch'});

    view(values => {
        overlayBtn.setAttribute('aria-pressed', String(values['overlay-enabled']));
        overlayBtn.textContent = values['overlay-enabled'] ? 'Lyrics: On' : 'Lyrics: Off';
        pitchBtn.setAttribute('aria-pressed', String(values['pitch-enabled']));
        pitchBtn.textContent = values['pitch-enabled'] ? 'Pitch: On' : 'Pitch: Off';
    });

    model.stateViews.push(state => {
        const bgGen = state.generation?.background ?? null;
        songTitle.textContent = state.active ? (state.identityText || state.videoId) : 'No song playing';
        const statusText = state.lyrics === 'generating' && state.generation?.message
            ? state.generation.message
            : (!state.active && bgGen?.message)
                ? bgGen.message
                : (LYRICS_STATUS_TEXT[state.lyrics] ?? state.lyrics);
        statusPill.textContent = statusText;
        statusPill.className = 'pill';
        if (state.lyrics === 'timed')
            statusPill.classList.add('pill-good');
        else if (state.lyrics === 'searching' || state.lyrics === 'waiting' || state.lyrics === 'plain'
            || state.lyrics === 'generating' || (!state.active && bgGen))
            statusPill.classList.add('pill-warn');
        else if (state.lyrics === 'error')
            statusPill.classList.add('pill-alert');
        markMusicBtn.hidden = !(state.active && state.lyrics === 'not-music');
        fullLyricsBtn.disabled = !(state.active && state.chosen);
    });

    const header = document.getElementById('topbar');
    header.replaceChildren(
        el('div', {class: 'topbar-left'},
            el('h1', {}, 'Lyrics overlay'),
            el('span', {class: 'topbar-sep', 'aria-hidden': 'true'}),
            el('div', {class: 'topbar-song'}, songTitle, statusPill, markMusicBtn),
        ),
        el('div', {class: 'topbar-actions'}, fullLyricsBtn, overlayBtn, pitchBtn),
    );
}

// ----- Left sticky Live Stage (Preview / Screen Map + Pinned Song Deck)

function buildStage() {
    const stage = document.getElementById('stage');

    const lyricModeBtn = pressButton('Lyrics', () => {
        model.stageMode = 'lyric';
        model.stageSync();
    });
    const pitchModeBtn = pressButton('Pitch', () => {
        model.stageMode = 'pitch';
        model.stageSync();
    });
    const mapModeBtn = pressButton('Screen map', () => {
        model.stageMode = 'map';
        model.stageSync();
    });
    const modeSeg = el('div', {class: 'seg compact'}, lyricModeBtn, pitchModeBtn, mapModeBtn);

    // Scene toggle (Video / Dark / Light) for lyric preview
    const sceneButtons = {};
    const sceneSeg = el('div', {class: 'seg compact'}, ...[
        ['video', 'Video'],
        ['dark', 'Dark'],
        ['light', 'Light'],
    ].map(([id, label]) => {
        const btn = pressButton(label, () => {
            model.previewScene = id;
            for (const [sid, b] of Object.entries(sceneButtons))
                b.setAttribute('aria-pressed', String(sid === id));
            render();
        });
        btn.setAttribute('aria-pressed', String(id === model.previewScene));
        sceneButtons[id] = btn;
        return btn;
    }));

    // 1. Lyric preview pane
    const lyricCanvas = el('canvas', {'aria-label': 'Live lyric preview'});
    const telemetryLine = el('span', {class: 'metric-value'}, '48 px');
    model.lyricPreview = new LyricPreviewCanvas(lyricCanvas, layout => {
        telemetryLine.textContent = `${Math.round(layout.fontSize)} px \u00b7 ${layout.lines.length} ${layout.lines.length === 1 ? 'line' : 'lines'} \u00b7 ${layout.boxW}\u00d7${layout.boxH}`;
    });

    const sampleInput = el('input', {
        id: 'sample-input',
        type: 'text',
        class: 'sample-input',
        placeholder: 'Auto (live song line or default)',
        'aria-label': 'Preview lyric text',
    });
    const clearSampleBtn = pressButton('Auto', () => {
        model.customSample = '';
        sampleInput.value = '';
        clearSampleBtn.hidden = true;
        render();
    }, {class: 'compact', hidden: 'hidden'});
    sampleInput.addEventListener('input', () => {
        model.customSample = sampleInput.value;
        clearSampleBtn.hidden = !model.customSample.trim();
        render();
    });

    const lyricPane = el('div', {class: 'stage-pane'},
        el('div', {class: 'stage-canvas-frame'}, lyricCanvas),
        el('div', {class: 'sample-row'},
            el('label', {class: 'sample-label', for: 'sample-input'}, 'Sample'),
            sampleInput,
            clearSampleBtn),
        el('div', {class: 'stage-meta'},
            telemetryLine,
            el('span', {class: 'hint-line'}, 'Ctrl+drag on desktop to move'),
        ),
    );

    // 2. Pitch preview pane
    const pitchCanvas = el('canvas', {'aria-label': 'Live pitch panel preview'});
    model.pitchPreview = new PitchPreviewCanvas(pitchCanvas);
    const pitchMeta = el('span', {class: 'metric-value'});
    view(values => {
        const rangeText = values['pitch-range'] === 'fixed'
            ? `${noteLabel(values['pitch-range-bottom'], SHARPS)}\u2013${noteLabel(values['pitch-range-top'], SHARPS)}`
            : `${values['pitch-follow-span']} st follow`;
        pitchMeta.textContent = `${rangeText} \u00b7 ${Number(values['pitch-window-seconds']).toFixed(1).replace(/\.0$/u, '')} s \u00b7 ${values['pitch-dock']}`;
    });
    const pitchPane = el('div', {class: 'stage-pane', hidden: 'hidden'},
        el('div', {class: 'pitch-stage-frame'}, pitchCanvas),
        el('div', {class: 'stage-meta'},
            pitchMeta,
            el('span', {class: 'hint-line'}, 'Ctrl+drag panel edges on desktop to resize or dock'),
        ),
    );

    // 3. Interactive Screen Map pane
    const mapStage = el('div', {class: 'placement-stage'});
    const mapCanvas = el('canvas', {'aria-label': 'Interactive screen placement map'});
    mapStage.append(mapCanvas);
    model.placementMap = new ScreenPlacementMap({
        stage: mapStage,
        canvas: mapCanvas,
        onChange: changes => setMany(changes),
        onHold: (keys, held) => {
            for (const key of keys) {
                if (held) model.held.add(key);
                else model.held.delete(key);
            }
        },
    });

    const monitorBar = el('div', {class: 'seg compact', hidden: 'hidden'});
    const rebuildMonitors = () => {
        monitorBar.hidden = model.monitors.length <= 1;
        monitorBar.replaceChildren(...model.monitors.map(mon => {
            const btn = pressButton(mon.label, () => set('box-monitor', mon.primary ? -1 : mon.index));
            btn.setAttribute('aria-pressed', String(activeMonitor('box-monitor').index === mon.index));
            return btn;
        }));
    };
    view(rebuildMonitors);
    call('GET', '/api/monitors').then(answer => {
        if (Array.isArray(answer?.monitors) && answer.monitors.length) {
            model.monitors = answer.monitors;
            rebuildMonitors();
            render();
        }
    }).catch(() => {});

    const mapMetrics = el('span', {class: 'metric-value'});
    view(values => {
        const mon = activeMonitor('box-monitor');
        const pxW = Math.round(values.box.width * mon.width);
        const pxH = Math.round(values.box.height * mon.height);
        mapMetrics.textContent = `${pxW}\u00d7${pxH} px (${Math.round(values.box.width * 100)}%\u00d7${Math.round(values.box.height * 100)}%)`;
    });

    const snapBar = el('div', {class: 'controls'},
        el('div', {class: 'seg compact'}, ...PLACEMENT_PRESETS.map(preset =>
            pressButton(preset.label, () => set('box', {...preset.box})))),
        pressButton('Reset', () => post('/api/settings/reset', {keys: ['box', 'box-monitor']}), {class: 'compact'}),
    );

    const mapPane = el('div', {class: 'map-stage-wrap', hidden: 'hidden'},
        monitorBar,
        mapStage,
        el('div', {class: 'stage-meta'}, mapMetrics, el('span', {class: 'hint-line'}, 'Drag box or edge; Shift disables snap')),
        snapBar,
    );

    model.stageSync = () => {
        const isMap = model.stageMode === 'map';
        const isPitch = model.stageMode === 'pitch';
        const isLyric = model.stageMode === 'lyric';
        lyricModeBtn.setAttribute('aria-pressed', String(isLyric));
        pitchModeBtn.setAttribute('aria-pressed', String(isPitch));
        mapModeBtn.setAttribute('aria-pressed', String(isMap));
        sceneSeg.hidden = !isLyric;
        lyricPane.hidden = !isLyric;
        pitchPane.hidden = !isPitch;
        mapPane.hidden = !isMap;
        requestAnimationFrame(() => render());
    };

    stage.replaceChildren(
        el('div', {class: 'stage-bar'}, modeSeg, sceneSeg),
        lyricPane,
        pitchPane,
        mapPane,
        buildSongDeck(),
    );
    model.stageSync();
}

// ----- Lyrics (compact 2-column inspector)

function classifyFont(family) {
    const lower = family.toLowerCase();
    if (/mono|code|console|courier|terminal|fixed|hack|fira code|jetbrains|agave|inconsolata/u.test(lower))
        return 'mono';
    if (/serif|georgia|times|garamond|palatino|baskerville|crimson|playfair|merriweather|lora|eb |book|charter|cambria/u.test(lower) && !/sans/u.test(lower))
        return 'serif';
    if (/display|script|hand|brush|comic|impact|lobster|pacifico|bebas|anton|bangers|marker|chalk|stencil|black|condensed|poster|retro/u.test(lower))
        return 'display';
    return 'sans';
}

function fontPickerCells() {
    let families = [];
    let category = 'all';
    let expanded = false;

    const current = el('span', {class: 'font-current-name'});
    const toggleBtn = pressButton('Choose', () => {
        expanded = !expanded;
        browser.hidden = !expanded;
        toggleBtn.setAttribute('aria-pressed', String(expanded));
        toggleBtn.textContent = expanded ? 'Close' : 'Choose';
        if (expanded)
            search.focus();
    }, {class: 'compact', 'aria-label': 'Choose font'});
    const defaultBtn = pressButton('Default', () => set('font-family', ''), {class: 'compact'});

    const search = el('input', {type: 'search', placeholder: 'Filter fonts...', 'aria-label': 'Filter fonts'});
    const countPill = el('span', {class: 'pill'}, 'Loading...');
    const list = el('div', {class: 'list fonts', role: 'listbox', 'aria-label': 'Fonts'});

    const catButtons = {};
    const catSeg = el('div', {class: 'seg compact'}, ...[
        ['all', 'All'], ['sans', 'Sans'], ['serif', 'Serif'], ['display', 'Display'], ['mono', 'Mono'],
    ].map(([id, label]) => {
        const btn = pressButton(label, () => {
            category = id;
            for (const [cid, b] of Object.entries(catButtons))
                b.setAttribute('aria-pressed', String(cid === id));
            buildList();
        });
        btn.setAttribute('aria-pressed', String(id === category));
        catButtons[id] = btn;
        return btn;
    }));

    const buildList = () => {
        const chosen = model.values['font-family'];
        const query = search.value.trim().toLowerCase();
        const filtered = families.filter(family => {
            if (category !== 'all' && classifyFont(family) !== category)
                return false;
            return !query || family.toLowerCase().includes(query);
        });
        const items = [];
        if ((!query || 'desktop default'.includes(query)) && category === 'all')
            items.push(['', 'Desktop default']);
        for (const family of filtered)
            items.push([family, family]);
        if (chosen && !families.includes(chosen) && !query)
            items.push([chosen, `${chosen} (not installed)`]);

        countPill.textContent = `${filtered.length} fonts`;
        list.replaceChildren(...items.map(([value, label]) => {
            const btn = pressButton(label, () => set('font-family', value), {
                style: value ? {fontFamily: `"${value.replaceAll('"', '\\"')}", sans-serif`} : {},
            });
            btn.setAttribute('aria-pressed', String(value === chosen));
            return btn;
        }));
    };

    search.addEventListener('input', buildList);

    view(values => {
        const fam = values['font-family'];
        current.textContent = fam || 'Desktop default';
        current.style.fontFamily = fam ? `"${fam.replaceAll('"', '\\"')}", system-ui, sans-serif` : 'system-ui, sans-serif';
        current.style.fontWeight = values['font-bold'] ? '700' : '400';
        current.style.fontStyle = values['font-italic'] ? 'italic' : 'normal';
        defaultBtn.hidden = !fam;
        buildList();
    });

    call('GET', '/api/fonts').then(answer => {
        families = answer.families ?? [];
        buildList();
    }, error => showBanner(`Could not list the fonts: ${error.message}`));

    const browser = el('div', {class: 'font-browser', hidden: 'hidden'},
        el('div', {class: 'font-browser-bar'}, search, catSeg, countPill),
        list,
    );

    const summaryCell = cell('Font', {},
        el('div', {class: 'font-summary-row'}, current, toggleBtn, defaultBtn));
    return [summaryCell, browser];
}

function textColorCell() {
    const swatches = Object.entries(TEXT_COLORS).map(([name, rgb]) => {
        const hex = hexColor(rgb);
        const label = name[0].toUpperCase() + name.slice(1);
        const btn = pressButton('', () => setMany({'text-color': name, 'text-custom-color': ''}), {
            class: 'dot-swatch',
            title: label,
            'aria-label': label,
            style: {background: hex},
        });
        view(values => btn.setAttribute('aria-pressed', String(!values['text-custom-color'] && values['text-color'] === name)));
        return btn;
    });

    const picker = el('input', {type: 'color', 'aria-label': 'Custom text color'});
    const hexOut = el('span', {class: 'hex-readout'});
    picker.addEventListener('input', () => {
        const hex = picker.value.toLowerCase();
        const rgb = parseHexColor(hex);
        const named = rgb ? nearestNamedColor(rgb) : model.values['text-color'];
        setMany({'text-color': named, 'text-custom-color': hex});
    });

    view(values => {
        const rgb = resolveTextColor(values['text-color'], values['text-custom-color'] ?? '');
        const hex = hexColor(rgb);
        picker.value = hex;
        hexOut.textContent = hex.toUpperCase();
    });

    return cell('Color', {span: true}, el('div', {class: 'swatch-strip'},
        ...swatches,
        el('span', {class: 'color-custom-wrap'}, picker, hexOut),
    ));
}

function backdropColorCell() {
    const swatches = BACKDROP_SWATCHES.map(([hex, label]) => {
        const btn = pressButton('', () => set('text-backdrop-color', hex), {
            class: 'dot-swatch',
            title: label,
            'aria-label': `Backdrop ${label}`,
            style: {background: hex},
        });
        view(values => btn.setAttribute('aria-pressed', String((values['text-backdrop-color'] ?? '#000000').toLowerCase() === hex)));
        return btn;
    });
    const picker = el('input', {type: 'color', 'aria-label': 'Custom backdrop color'});
    const hexOut = el('span', {class: 'hex-readout'});
    picker.addEventListener('input', () => set('text-backdrop-color', picker.value.toLowerCase()));
    view(values => {
        const hex = (values['text-backdrop-color'] ?? '#000000').toLowerCase();
        picker.value = hex;
        hexOut.textContent = hex.toUpperCase();
    });
    return whenVisible(
        cell('Backdrop color', {span: true}, el('div', {class: 'swatch-strip'},
            ...swatches,
            el('span', {class: 'color-custom-wrap'}, picker, hexOut),
        )),
        v => v['text-backdrop'] !== 'none',
    );
}

const RING_TICKS = [0.02, 0.12, 0.24, 0.35];
const RING_MIN = 0.02;
const RING_MAX = 0.35;
const RING_RESET_KEYS = [
    'text-border-cloud',
    'text-border-1-color', 'text-border-1-width',
    'text-border-2-color', 'text-border-2-width',
    'text-border-3-color', 'text-border-3-width',
    'text-border-4-color', 'text-border-4-width',
];

function borderCells() {
    let activeIdx = 0;

    const cloudBtn = pressButton('', () => set('text-border-cloud', !model.values['text-border-cloud']), {class: 'compact'});
    const resetBtn = pressButton('Reset rings', () => post('/api/settings/reset', {keys: RING_RESET_KEYS}), {
        class: 'compact',
        hidden: 'hidden',
    });
    const borderModeCell = segmentedCell('text-border', 'Border',
        {none: 'None', single: 'Single', double: 'Double', triple: 'Triple', quad: 'Quad', glow: 'Glow'},
        {span: true, extra: [cloudBtn, resetBtn]});

    const ringChipsWrap = el('div', {class: 'ring-chips'});
    const chipsCell = cell('Rings', {}, ringChipsWrap);

    const widthLabel = el('div', {class: 'label'}, 'Ring 1 width');
    const widthVal = el('span', {class: 'value'});
    const widthInput = el('input', {type: 'range', min: '0', max: String(SLIDER_STEPS), step: '1', 'aria-label': 'Ring width'});
    const toPos = v => Math.round(((v - RING_MIN) / (RING_MAX - RING_MIN)) * SLIDER_STEPS);
    const fromPos = p => Number((RING_MIN + (p / SLIDER_STEPS) * (RING_MAX - RING_MIN)).toFixed(3));
    const widthTicks = el('div', {class: 'ticks', 'aria-hidden': 'true'}, ...RING_TICKS.map(tick => el('span', {
        class: 'tick',
        style: {left: `${((tick - RING_MIN) / (RING_MAX - RING_MIN)) * 100}%`},
    }, `${Math.round(tick * 100)}%`)));
    const currentEm = () => {
        const border = model.values['text-border'];
        const defs = BORDER_DEFAULTS[border] ?? [];
        const custom = Number(model.values[`text-border-${activeIdx + 1}-width`]) || 0;
        return custom > 0 ? custom : (defs[activeIdx]?.em ?? 0.1);
    };
    const nudgeWidth = delta => {
        const next = Math.min(RING_MAX, Math.max(RING_MIN, Number((currentEm() + delta).toFixed(3))));
        set(`text-border-${activeIdx + 1}-width`, next);
    };
    const downBtn = pressButton('\u2212', () => nudgeWidth(-0.01), {class: 'step', 'aria-label': 'Thinner ring'});
    const upBtn = pressButton('+', () => nudgeWidth(0.01), {class: 'step', 'aria-label': 'Thicker ring'});
    const autoWidthBtn = pressButton('Auto', () => set(`text-border-${activeIdx + 1}-width`, 0), {
        class: 'compact',
        hidden: 'hidden',
    });
    let heldWidthKey = '';
    const releaseWidth = () => {
        if (heldWidthKey) {
            model.held.delete(heldWidthKey);
            heldWidthKey = '';
        }
    };
    widthInput.addEventListener('pointerdown', () => {
        heldWidthKey = `text-border-${activeIdx + 1}-width`;
        model.held.add(heldWidthKey);
    });
    widthInput.addEventListener('pointerup', releaseWidth);
    widthInput.addEventListener('pointercancel', releaseWidth);
    widthInput.addEventListener('blur', releaseWidth);
    widthInput.addEventListener('input', () => set(`text-border-${activeIdx + 1}-width`, fromPos(Number(widthInput.value))));
    const widthCell = el('div', {class: 'cell cell-slider'},
        el('div', {class: 'slider-head'},
            widthLabel,
            widthVal,
            el('div', {class: 'slider-steppers'}, downBtn, upBtn, autoWidthBtn)),
        el('div', {class: 'track'}, widthInput, widthTicks));

    const colorLabel = el('div', {class: 'label'}, 'Ring 1 color');
    const autoColorBtn = pressButton('Auto', () => set(`text-border-${activeIdx + 1}-color`, ''), {class: 'compact'});
    const ringSwatches = [
        ['#000000', 'Black'],
        ['#ffffff', 'White'],
        ...Object.entries(TEXT_COLORS)
            .filter(([name]) => name !== 'black' && name !== 'white')
            .map(([name, rgb]) => [hexColor(rgb), name[0].toUpperCase() + name.slice(1)]),
    ].map(([hex, label]) => {
        const btn = pressButton('', () => set(`text-border-${activeIdx + 1}-color`, hex), {
            class: 'dot-swatch',
            title: label,
            'aria-label': `Ring color ${label}`,
            style: {background: hex},
        });
        return {hex, btn};
    });
    const colorPicker = el('input', {type: 'color', 'aria-label': 'Custom ring color'});
    const colorHex = el('span', {class: 'hex-readout'});
    colorPicker.addEventListener('input', () => set(`text-border-${activeIdx + 1}-color`, colorPicker.value.toLowerCase()));
    const colorCell = el('div', {class: 'cell span-2'},
        colorLabel,
        el('div', {class: 'controls'},
            el('div', {class: 'swatch-strip'},
                autoColorBtn,
                ...ringSwatches.map(s => s.btn),
                el('span', {class: 'color-custom-wrap'}, colorPicker, colorHex),
            )));

    const ringName = (border, idx) => (border === 'glow' && idx === 1 ? 'Halo' : `Ring ${idx + 1}`);

    const syncUI = values => {
        const border = values['text-border'] ?? 'triple';
        const defs = BORDER_DEFAULTS[border] ?? [];
        const count = defs.length;
        const hidden = count === 0;
        cloudBtn.hidden = hidden;
        chipsCell.hidden = hidden;
        widthCell.hidden = hidden;
        colorCell.hidden = hidden;
        if (hidden) {
            resetBtn.hidden = true;
            return;
        }
        if (activeIdx >= count)
            activeIdx = count - 1;

        const fontSize = values['font-size'] ?? 48;
        const fill = resolveTextColor(values['text-color'], values['text-custom-color'] ?? '');
        const customHexes = [1, 2, 3, 4].map(i => values[`text-border-${i}-color`] ?? '');
        const customWidths = [1, 2, 3, 4].map(i => Number(values[`text-border-${i}-width`]) || 0);
        const palette = resolveRingColors(fill, count, customHexes);
        const spec = borderSpec(border, fontSize, {ringWidths: customWidths, cloud: Boolean(values['text-border-cloud'])});

        const hasCustom = Boolean(values['text-border-cloud'])
            || customHexes.slice(0, count).some(Boolean)
            || customWidths.slice(0, count).some(w => w > 0);
        cloudBtn.setAttribute('aria-pressed', String(Boolean(values['text-border-cloud'])));
        cloudBtn.textContent = values['text-border-cloud'] ? 'Soft cloud: On' : 'Soft cloud: Off';
        resetBtn.hidden = !hasCustom;

        ringChipsWrap.replaceChildren(...spec.rings.map((entry, idx) => {
            const hex = hexColor(palette[idx]);
            const chip = pressButton('', () => {
                activeIdx = idx;
                syncUI(model.values);
            }, {class: 'ring-chip compact'});
            chip.setAttribute('aria-pressed', String(idx === activeIdx));
            chip.append(
                el('span', {class: 'ring-chip-dot', style: {background: hex}}),
                el('span', {}, `${ringName(border, idx)} \u00b7 ${Math.round(entry.em * 100)}%`),
            );
            return chip;
        }));

        const name = ringName(border, activeIdx);
        colorLabel.textContent = `${name} color`;
        const customHex = (customHexes[activeIdx] ?? '').toLowerCase();
        const resolvedHex = hexColor(palette[activeIdx]).toLowerCase();
        autoColorBtn.setAttribute('aria-pressed', String(!customHex));
        for (const swatch of ringSwatches)
            swatch.btn.setAttribute('aria-pressed', String(Boolean(customHex) && customHex === swatch.hex));
        colorPicker.value = resolvedHex;
        colorHex.textContent = resolvedHex.toUpperCase();

        widthLabel.textContent = `${name} width`;
        const activeRing = spec.rings[activeIdx];
        const em = activeRing.em;
        const px = Math.round(activeRing.width);
        widthVal.textContent = `${Math.round(em * 100)}% \u00b7 ${px} px`;
        if (!model.held.has(`text-border-${activeIdx + 1}-width`))
            widthInput.value = String(toPos(Math.min(RING_MAX, Math.max(RING_MIN, em))));
        autoWidthBtn.hidden = !(customWidths[activeIdx] > 0);
    };

    view(syncUI);
    return [borderModeCell, chipsCell, widthCell, colorCell];
}

function furiganaCell() {
    const toggle = pressButton('', () => set('text-furigana', !model.values['text-furigana']), {class: 'switch'});
    const statusPill = el('span', {class: 'pill pill-alert', hidden: 'hidden'});
    const syncStatus = () => {
        const showError = Boolean(model.values?.['text-furigana']) && model.furigana && !model.furigana.available;
        statusPill.hidden = !showError;
        statusPill.textContent = showError ? (model.furigana.error || 'Japanese dictionary unavailable') : '';
    };
    view(values => {
        toggle.setAttribute('aria-pressed', String(values['text-furigana']));
        toggle.textContent = values['text-furigana'] ? 'On' : 'Off';
        syncStatus();
    });
    model.stateViews.push(syncStatus);
    return cell('Furigana', {}, toggle, statusPill);
}

function buildLyricsGrid() {
    const boldBtn = pressButton('Bold', () => set('font-bold', !model.values['font-bold']));
    const italicBtn = pressButton('Italic', () => set('font-italic', !model.values['font-italic']));
    view(v => {
        boldBtn.setAttribute('aria-pressed', String(v['font-bold']));
        italicBtn.setAttribute('aria-pressed', String(v['font-italic']));
    });
    const [fontCell, fontBrowser] = fontPickerCells();

    return el('div', {class: 'grid-2'},
        fontCell,
        sliderCell('font-size', 'Size', {ticks: [16, 48, 128, 256], format: unit('px'), log: true}),
        fontBrowser,
        textColorCell(),
        ...borderCells(),
        cell('Style', {}, el('div', {class: 'seg'}, boldBtn, italicBtn)),
        furiganaCell(),
        segmentedCell('text-align', 'Alignment', {left: 'Left', center: 'Center', right: 'Right'}),
        segmentedCell('transition', 'Transition', {'fade-in': 'Fade (0.15 s)', instant: 'Instant'}),
        segmentedCell('text-backdrop', 'Backdrop', {none: 'None', pill: 'Behind text', box: 'Full bar'}),
        whenVisible(sliderCell('text-backdrop-opacity', 'Backdrop opacity', {
            ticks: [0, 0.25, 0.5, 0.75, 1], format: percent, stepBy: 0.05,
        }), v => v['text-backdrop'] !== 'none'),
        backdropColorCell(),
    );
}

// ----- Pitch (compact 2-column inspector)

function lineColorCell() {
    const swatches = LINE_COLORS.map(([hex, label]) => {
        const btn = pressButton('', () => set('pitch-line-color', hex), {
            class: 'dot-swatch',
            title: label,
            'aria-label': `Line color ${label}`,
            style: {background: hex},
        });
        view(values => btn.setAttribute('aria-pressed', String(values['pitch-line-color'].toLowerCase() === hex)));
        return btn;
    });
    const custom = el('input', {type: 'color', 'aria-label': 'Custom pitch line color'});
    const hexOut = el('span', {class: 'hex-readout'});
    custom.addEventListener('input', () => set('pitch-line-color', custom.value));
    view(values => {
        const hex = values['pitch-line-color'].toLowerCase();
        custom.value = hex;
        hexOut.textContent = hex.toUpperCase();
    });
    return cell('Line color', {span: true}, el('div', {class: 'swatch-strip'},
        ...swatches,
        el('span', {class: 'color-custom-wrap'}, custom, hexOut),
    ));
}

function noteCell(key, label) {
    const {min, max} = model.schema[key];
    const shown = el('span', {class: 'value'});
    const other = key === 'pitch-range-bottom' ? 'pitch-range-top' : 'pitch-range-bottom';
    const allowed = value => value >= min && value <= max &&
        Math.abs(value - model.values[other]) >= MIN_FIXED_SPAN && (key === 'pitch-range-bottom') === (value < model.values[other]);
    const steps = [[-12, '\u2212oct'], [-1, '\u2212'], [1, '+'], [12, '+oct']].map(([delta, text]) => {
        const button = pressButton(text, () => set(key, model.values[key] + delta), {
            class: 'big',
            'aria-label': `${label} ${delta > 0 ? 'up' : 'down'} ${Math.abs(delta) === 12 ? 'an octave' : 'a semitone'}`,
        });
        view(values => {
            button.disabled = !allowed(values[key] + delta);
        });
        return button;
    });
    view(values => {
        shown.textContent = noteLabel(values[key], SHARPS);
    });
    return cell(label, {}, steps[0], steps[1], shown, steps[2], steps[3]);
}

function rootCell() {
    const buttons = Array.from({length: 12}, (_, root) => {
        const button = pressButton('', () => set('pitch-scale-root', root), {class: 'compact'});
        view(values => {
            button.textContent = pitchClassNames({root, type: values['pitch-scale-type']})[root];
            button.setAttribute('aria-pressed', String(values['pitch-scale-root'] === root));
        });
        return button;
    });
    return whenVisible(cell('Scale root', {span: true}, el('div', {class: 'seg compact'}, ...buttons)), values => values['pitch-scale'] === 'fixed');
}

function microphoneBand() {
    const list = el('div', {class: 'list short', role: 'listbox', 'aria-label': 'Microphones', style: {width: '100%'}});
    let found = {microphones: [], defaultName: ''};
    const buildList = () => {
        const chosen = model.values['pitch-microphone'];
        const describe = name => found.microphones.find(m => m.name === name)?.description;
        const options = [['', `System default${found.defaultName ? `: ${describe(found.defaultName) ?? found.defaultName}` : ''}`],
            ...found.microphones.map(m => [m.name, m.description])];
        if (chosen && !describe(chosen))
            options.push([chosen, `${chosen} (not connected)`]);
        list.replaceChildren(...options.map(([name, text]) => {
            const button = pressButton(text, () => set('pitch-microphone', name));
            button.setAttribute('aria-pressed', String(name === chosen));
            return button;
        }));
    };
    const refresh = () => call('GET', '/api/microphones').then(answer => {
        found = answer;
        buildList();
    }, error => showBanner(`Could not list the microphones: ${error.message}`));
    view(buildList);
    refresh();
    setInterval(refresh, MICROPHONE_POLL_MS);

    const echoBtn = pressButton('', () => set('pitch-echo-cancel', !model.values['pitch-echo-cancel']), {class: 'switch'});
    view(values => {
        echoBtn.setAttribute('aria-pressed', String(values['pitch-echo-cancel']));
        echoBtn.textContent = values['pitch-echo-cancel'] ? 'On' : 'Off';
    });

    return el('div', {class: 'mic-band'},
        el('div', {class: 'mic-col'}, el('div', {class: 'label'}, 'Microphone'), list),
        el('div', {class: 'mic-col'}, el('div', {class: 'label'}, 'Echo cancel'), echoBtn),
    );
}

function buildPitchGrid() {
    const scaleTypes = Object.fromEntries(Object.entries(SCALES).map(([type, scale]) => [type, scale.name[0].toUpperCase() + scale.name.slice(1)]));
    const centsBtn = pressButton('', () => set('pitch-readout-cents', !model.values['pitch-readout-cents']), {class: 'compact'});
    view(values => {
        centsBtn.hidden = values['pitch-readout'] === 'off';
        centsBtn.setAttribute('aria-pressed', String(values['pitch-readout-cents']));
        centsBtn.textContent = values['pitch-readout-cents'] ? 'Cents: On' : 'Cents: Off';
    });

    return el('div', {class: 'grid-2'},
        segmentedCell('pitch-dock', 'Dock', {below: 'Below', above: 'Above', left: 'Left', right: 'Right', separate: 'Separate'}),
        whenVisible(sliderCell('pitch-docked-height', 'Docked height', {
            ticks: [0.03, 0.2, 0.4, 0.6], format: percent, stepBy: 0.02,
        }), v => v['pitch-dock'] === 'below' || v['pitch-dock'] === 'above'),
        whenVisible(sliderCell('pitch-docked-width', 'Docked width', {
            ticks: [0.05, 0.2, 0.4, 0.6], format: percent, stepBy: 0.02,
        }), v => v['pitch-dock'] === 'left' || v['pitch-dock'] === 'right'),
        whenVisible(cell('Separate box', {},
            pressButton('Place on Screen map', () => {
                model.stageMode = 'map';
                model.stageSync();
            }, {class: 'compact'}),
            pressButton('Reset box', () => post('/api/settings/reset', {keys: ['pitch-box', 'pitch-box-monitor']}), {class: 'compact'}),
        ), v => v['pitch-dock'] === 'separate'),

        segmentedCell('pitch-range', 'Notes', {fixed: 'Fixed', follow: 'Follow voice'}),
        whenVisible(cell('Auto-fit', {},
            pressButton('Fit to last 30 s', () => post('/api/pitch/fit', {}), {class: 'compact'}),
        ), v => v['pitch-range'] === 'fixed'),
        whenVisible(sliderCell('pitch-follow-span', 'Voice span', {
            ticks: [6, 12, 24, 36], format: unit('st'), integer: true, stepBy: 1,
        }), v => v['pitch-range'] === 'follow'),
        whenVisible(noteCell('pitch-range-top', 'Highest'), v => v['pitch-range'] === 'fixed'),
        whenVisible(noteCell('pitch-range-bottom', 'Lowest'), v => v['pitch-range'] === 'fixed'),

        sliderCell('pitch-window-seconds', 'Time across', {ticks: [2, 5, 15, 45, 120], format: unit('s', 1), log: true}),
        sliderCell('pitch-rate', 'Analyses', {ticks: [10, 40, 70, 100], format: v => `${Math.round(v)}/s`, integer: true, stepBy: 5}),

        sliderCell('pitch-line-width', 'Line width', {ticks: [0.5, 1.5, 4, 12], format: unit('px', 1), log: true}),
        sliderCell('pitch-background-opacity', 'Background', {ticks: [0, 0.25, 0.5, 0.75, 1], format: percent, stepBy: 0.05}),
        lineColorCell(),

        segmentedCell('pitch-labels', 'Note names', {all: 'All', scale: 'Scale', c: 'C only', none: 'None'}),
        whenVisible(sliderCell('pitch-label-size', 'Name size', {
            ticks: [8, 16, 24, 32], format: unit('px'), stepBy: 1,
        }), v => v['pitch-labels'] !== 'none'),

        segmentedCell('pitch-readout', 'Current note', {
            'right': 'Right', 'left': 'Left', 'top-right': 'Top R',
            'top-left': 'Top L', 'bottom-right': 'Bot R', 'bottom-left': 'Bot L', 'off': 'Off',
        }, {span: true, compact: true, extra: [centsBtn]}),
        whenVisible(sliderCell('pitch-readout-size', 'Readout size', {
            ticks: [0.15, 0.4, 0.7, 1], format: percent, stepBy: 0.05,
        }), v => v['pitch-readout'] !== 'off'),
        switchCell('pitch-time-in-silence', 'Scroll in silence'),

        segmentedCell('pitch-scale', 'Scale', {detect: 'Detect', fixed: 'Fixed', none: 'None'}),
        whenVisible(switchCell('pitch-show-key', 'Name scale'), v => v['pitch-scale'] !== 'none'),
        rootCell(),
        whenVisible(segmentedCell('pitch-scale-type', 'Scale type', scaleTypes, {span: true, compact: true}), v => v['pitch-scale'] === 'fixed'),
        microphoneBand(),
    );
}

// ----- Pinned Song & Lyric Sets Deck (lives in sticky left stage)

function buildSongDeck() {
    const timing = el('span', {class: 'value'});
    const statusNote = el('div', {class: 'song-status-note', hidden: 'hidden'});
    const microphone = el('span', {class: 'foot-stat-value'});
    const heardKey = el('span', {class: 'foot-stat-value'});
    const addonVersion = el('span', {class: 'foot-stat-value'});
    const install = el('a', {class: 'button primary compact', href: ADDON_DOWNLOAD, hidden: 'hidden'});
    const updateService = el('span', {class: 'note', hidden: 'hidden'}, 'Update service: ', el('kbd', {}, 'git pull && scripts/install.sh'));
    const sets = el('div', {class: 'list deck-sets-list', role: 'listbox', 'aria-label': 'Lyric sets'});
    const setsCount = el('span', {class: 'pill'}, '0 sets');
    const emptySets = el('p', {class: 'note'}, 'No lyric candidates loaded for the current video.');

    const command = body => post('/api/command', body);
    const markMusic = pressButton('This is a music video', () => command({op: 'lookUp'}), {class: 'primary compact', hidden: 'hidden'});
    const publishBtn = pressButton('Edit & publish', () => model.lyricsModal?.open('edit'), {
        class: 'compact',
        title: 'Edit & publish to LRCLIB',
    });
    const wrong = pressButton('Hide wrong set', () => command({op: 'reject'}), {
        class: 'compact',
        title: 'Wrong lyrics: hide this set',
    });
    const again = pressButton('Search again', () => command({op: 'searchAgain'}), {class: 'compact'});
    const generate = pressButton('Generate timed', () => command({op: 'generate'}), {class: 'compact', hidden: 'hidden'});
    const generateFresh = pressButton('Generate from scratch', () => command({op: 'generateFromScratch'}), {class: 'compact', hidden: 'hidden'});
    const cancelGenerate = pressButton('Cancel timing', () => command({op: 'cancelGenerate'}), {class: 'compact', hidden: 'hidden'});
    const timingButtons = [
        pressButton('Too fast (\u22120.5 s)', () => command({op: 'tooFast'}), {class: 'compact'}),
        pressButton('Too slow (+0.5 s)', () => command({op: 'tooSlow'}), {class: 'compact'}),
        pressButton('Reset', () => command({op: 'resetOffset'}), {class: 'compact'}),
    ];

    const fileInput = el('input', {type: 'file', accept: '.lrc,.txt,text/plain', hidden: 'hidden'});
    const loadFileBtn = pressButton('Load .lrc / .txt', () => fileInput.click(), {class: 'compact'});
    fileInput.addEventListener('change', async () => {
        const file = fileInput.files?.[0];
        fileInput.value = '';
        if (!file)
            return;
        try {
            const text = await file.text();
            await command({op: 'importLyrics', filename: file.name, text});
        } catch (error) {
            showBanner(`Could not read ${file.name}: ${error.message}`);
        }
    });

    const artistInput = el('input', {type: 'text', class: 'search-input', 'aria-label': 'LRCLIB artist'});
    const titleInput = el('input', {type: 'text', class: 'search-input', 'aria-label': 'LRCLIB song title'});
    const manualSearchBtn = el('button', {type: 'submit', class: 'compact'}, 'Search');
    const manualSearchForm = el('form', {class: 'manual-search-bar'},
        el('span', {class: 'manual-search-label'}, 'Artist'), artistInput,
        el('span', {class: 'manual-search-label'}, 'Title'), titleInput,
        manualSearchBtn);
    manualSearchForm.addEventListener('submit', event => {
        event.preventDefault();
        command({op: 'searchQuery', artist: artistInput.value, title: titleInput.value});
    });
    let lastVideoId = null;

    model.stateViews.push((state, addon) => {
        addonVersion.textContent = ADDON_TEXT[addon.status](addon);
        install.textContent = `Install ${addon.current}`;
        install.hidden = addon.status !== 'unnamed' && addon.status !== 'older';
        updateService.hidden = addon.status !== 'newer';
        if (state.videoId !== lastVideoId) {
            lastVideoId = state.videoId;
            artistInput.value = '';
            titleInput.value = '';
        }
        const gen = state.generation;
        const bgGen = gen?.background ?? null;
        let detail = '';
        if (state.lyrics === 'generating' && gen?.message)
            detail = gen.previewing ? `${gen.message} \u00b7 showing early subtitles` : gen.message;
        else if ((gen?.status === 'error' || gen?.status === 'skipped') && gen.message && state.lyrics !== 'timed')
            detail = `${LYRICS_STATUS_TEXT[state.lyrics]} (${gen.message})`;
        if (bgGen?.message) {
            detail = detail
                ? `${detail} \u00b7 Background: ${bgGen.message} (${bgGen.label})`
                : `Background: ${bgGen.message} (${bgGen.label})`;
        }
        statusNote.textContent = detail;
        statusNote.hidden = !detail;

        timing.textContent = `${state.offsetSeconds > 0 ? '+' : ''}${state.offsetSeconds.toFixed(1)} s`;
        for (const button of timingButtons)
            button.disabled = !state.active;
        const notMusic = state.active && state.lyrics === 'not-music';
        markMusic.hidden = !notMusic;
        markMusic.disabled = !notMusic;
        publishBtn.disabled = !(state.active && state.chosen);
        publishBtn.hidden = state.publishAvailable === false;
        publishBtn.textContent = state.publishedAt ? 'Edit & publish (published)' : 'Edit & publish';
        wrong.disabled = !state.chosen;
        again.disabled = !state.active;
        loadFileBtn.disabled = !state.active;
        artistInput.disabled = !state.active;
        titleInput.disabled = !state.active;
        manualSearchBtn.disabled = !state.active;

        const canGenerate = Boolean(gen?.available);
        const timingActive = state.lyrics === 'generating' || Boolean(bgGen);
        const transcribingNow = state.lyrics === 'generating' && gen?.mode === 'transcribed';
        generate.hidden = !canGenerate;
        generate.disabled = !state.active || state.lyrics === 'generating';
        generateFresh.hidden = !canGenerate;
        generateFresh.disabled = !state.active || transcribingNow;
        cancelGenerate.hidden = !canGenerate || !timingActive;
        cancelGenerate.disabled = !timingActive;

        if (state.lyrics === 'generating' && !transcribingNow)
            generate.textContent = 'Timing\u2026';
        else if (state.lyrics === 'plain')
            generate.textContent = 'Time existing';
        else if (gen?.status === 'error')
            generate.textContent = 'Retry timing';
        else if (state.candidates.some(c => c.generated))
            generate.textContent = 'Regenerate';
        else
            generate.textContent = 'Generate timed';
        generateFresh.textContent = transcribingNow ? 'Generating from scratch\u2026' : 'Generate from scratch';

        microphone.textContent = state.pitch.error ? `Stopped: ${state.pitch.error}`
            : state.pitch.capturing ? state.pitch.microphone || 'On' : 'Off';
        const scale = model.values['pitch-scale'];
        if (scale === 'detect')
            heardKey.textContent = state.key ? keyName(state.key) : 'Not heard';
        else if (scale === 'fixed')
            heardKey.textContent = `${keyName({root: model.values['pitch-scale-root'], type: model.values['pitch-scale-type']})} (fixed)`;
        else
            heardKey.textContent = 'Off';

        const timedCount = state.candidates.filter(c => c.timed).length;
        const n = state.candidates.length;
        setsCount.textContent = `${n} ${n === 1 ? 'set' : 'sets'} (${timedCount} timed)`;
        sets.replaceChildren(...state.candidates.map(candidate => {
            const timedText = candidate.timed
                ? (candidate.lineCount ? `Timed \u00b7 ${candidate.lineCount} lines` : 'Timed')
                : 'Untimed';
            const tags = [
                el('span', {class: candidate.timed ? 'pill pill-good' : 'pill pill-warn'}, timedText),
                ...(candidate.custom ? [el('span', {class: 'pill'}, 'Local file')] : []),
                ...(candidate.generated ? [el('span', {class: 'pill'}, candidate.generated === 'aligned' ? 'Aligned' : 'Transcribed')] : []),
                ...(!candidate.matches ? [el('span', {class: 'pill pill-warn'}, 'Weak match')] : []),
                ...(candidate.rejected ? [el('span', {class: 'pill pill-alert'}, 'Hidden')] : []),
            ];
            const button = pressButton('', () => command({op: 'choose', id: candidate.id}));
            button.setAttribute('aria-pressed', String(candidate.current));
            button.append(el('span', {class: 'candidate-row'},
                el('span', {class: 'candidate-label'}, candidate.label),
                el('span', {class: 'candidate-tags'}, ...tags)));
            return button;
        }));
        sets.hidden = !state.candidates.length;
        emptySets.hidden = Boolean(state.candidates.length);
    });

    const offsetRow = el('div', {class: 'deck-offset-row'},
        el('span', {class: 'deck-label'}, 'Offset'),
        timing,
        ...timingButtons);

    const actionsBar = el('div', {class: 'deck-actions'},
        markMusic, publishBtn, wrong, again, generate, generateFresh, cancelGenerate);

    const setsBlock = el('div', {class: 'deck-sets'},
        el('div', {class: 'deck-sets-head'},
            el('h3', {class: 'deck-sets-title'}, 'Lyric sets'),
            el('div', {class: 'section-head-actions'}, setsCount, loadFileBtn, fileInput)),
        manualSearchForm,
        emptySets,
        sets);

    const foot = el('div', {class: 'deck-foot'},
        el('span', {class: 'foot-stat'}, el('span', {class: 'foot-stat-label'}, 'Mic:'), microphone),
        el('span', {class: 'foot-stat'}, el('span', {class: 'foot-stat-label'}, 'Scale:'), heardKey),
        el('span', {class: 'foot-stat'}, el('span', {class: 'foot-stat-label'}, 'Add-on:'), addonVersion),
        install,
        updateService);

    return el('div', {class: 'song-deck', id: 'song'},
        offsetRow,
        actionsBar,
        statusNote,
        setsBlock,
        foot);
}

// ----- Full Lyrics Reader & Review/Publish to LRCLIB Modal

function formatClock(seconds) {
    if (!Number.isFinite(seconds) || seconds < 0)
        return '';
    const whole = Math.floor(seconds);
    return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}

function buildRubyFragment(text, ruby) {
    if (!Array.isArray(ruby) || !ruby.length)
        return document.createTextNode(text);
    const frag = document.createDocumentFragment();
    for (const [surface, reading] of ruby) {
        if (reading) {
            const r = document.createElement('ruby');
            r.append(document.createTextNode(surface), el('rt', {}, reading));
            frag.append(r);
        } else {
            frag.append(document.createTextNode(surface));
        }
    }
    return frag;
}

function buildLyricsModal() {
    const backdrop = document.getElementById('lyrics-modal-backdrop');
    let open = false;
    let mode = 'read'; // 'read' | 'edit'
    let autoScroll = true;
    let readerPx = 32;
    let loadedKey = '';
    let loading = false;
    let payload = null;
    let editorDirty = false;
    let publishing = false;
    let rowEls = new Map();
    let currentRowIndex = -1;

    const modalTitle = el('h2', {class: 'modal-title'}, 'Full lyrics');
    const metaPill = el('span', {class: 'pill'}, '');
    const publishedPill = el('span', {class: 'pill pill-good', hidden: 'hidden'}, 'Published to LRCLIB');

    const readTabBtn = pressButton('Read', () => setMode('read'));
    const editTabBtn = pressButton('Edit & publish', () => setMode('edit'));
    const modeSeg = el('div', {class: 'seg compact'}, readTabBtn, editTabBtn);
    const closeBtn = pressButton('Close', () => close(), {class: 'compact'});

    // Read mode toolbar
    const autoScrollBtn = pressButton('Auto-scroll: On', () => {
        autoScroll = !autoScroll;
        syncToolbar();
        if (autoScroll)
            scrollToCurrent(true);
    }, {class: 'compact'});
    const jumpBtn = pressButton('Jump to current', () => {
        autoScroll = true;
        syncToolbar();
        scrollToCurrent(true);
    }, {class: 'compact', hidden: 'hidden'});
    const sizeReadout = el('span', {class: 'metric-value'}, `${readerPx} px`);
    const sizeDownBtn = pressButton('A\u2212', () => {
        readerPx = Math.max(18, readerPx - 2);
        reader.style.setProperty('--reader-size', `${readerPx}px`);
        sizeReadout.textContent = `${readerPx} px`;
    }, {class: 'compact', 'aria-label': 'Smaller lyrics text'});
    const sizeUpBtn = pressButton('A+', () => {
        readerPx = Math.min(64, readerPx + 2);
        reader.style.setProperty('--reader-size', `${readerPx}px`);
        sizeReadout.textContent = `${readerPx} px`;
    }, {class: 'compact', 'aria-label': 'Larger lyrics text'});
    const nudgeFastBtn = pressButton('\u22120.5 s', () => post('/api/command', {op: 'tooFast'}), {class: 'compact', title: 'Lyrics too fast'});
    const nudgeSlowBtn = pressButton('+0.5 s', () => post('/api/command', {op: 'tooSlow'}), {class: 'compact', title: 'Lyrics too slow'});
    const offsetReadout = el('span', {class: 'pill'}, '0.0 s');
    const timingGroup = el('div', {class: 'modal-toolbar-group'}, offsetReadout, nudgeFastBtn, nudgeSlowBtn);
    const readToolbar = el('div', {class: 'modal-toolbar'},
        el('div', {class: 'modal-toolbar-group'}, autoScrollBtn, jumpBtn),
        el('div', {class: 'modal-toolbar-group'}, timingGroup, sizeDownBtn, sizeReadout, sizeUpBtn),
    );

    const reader = el('div', {class: 'lyrics-reader', role: 'region', 'aria-label': 'Full song lyrics'});
    reader.style.setProperty('--reader-size', `${readerPx}px`);
    let programmaticScrollUntil = 0;
    reader.addEventListener('wheel', () => {
        if (autoScroll && currentRowIndex >= 0) {
            autoScroll = false;
            syncToolbar();
        }
    }, {passive: true});
    reader.addEventListener('touchstart', () => {
        if (autoScroll && currentRowIndex >= 0) {
            autoScroll = false;
            syncToolbar();
        }
    }, {passive: true});
    reader.addEventListener('scroll', () => {
        if (Date.now() < programmaticScrollUntil)
            return;
        // Keep Jump to current visible whenever auto-scroll is off.
        syncToolbar();
    }, {passive: true});

    // Edit & publish pane
    const artistField = el('input', {id: 'pub-artist', type: 'text', class: 'search-input', autocomplete: 'off'});
    const trackField = el('input', {id: 'pub-track', type: 'text', class: 'search-input', autocomplete: 'off'});
    const albumField = el('input', {id: 'pub-album', type: 'text', class: 'search-input', autocomplete: 'off'});
    const durationField = el('input', {id: 'pub-duration', type: 'number', min: '1', step: '1', class: 'search-input'});
    const durationFmt = el('span', {class: 'duration-formatted'}, '00:00');
    const offsetBakedNotice = el('div', {class: 'publish-notice', hidden: 'hidden'});
    const editorLinesPill = el('span', {class: 'pill'}, '');
    const lyricsArea = el('textarea', {
        id: 'pub-lyrics',
        class: 'lyrics-textarea',
        spellcheck: 'false',
        'aria-label': 'Synced or plain lyrics',
    });
    const publishStatus = el('div', {class: 'publish-status', role: 'status', hidden: 'hidden'});

    const updateDurationFmt = () => {
        const secs = Number(durationField.value);
        durationFmt.textContent = Number.isFinite(secs) && secs > 0 ? formatClock(secs) : '\u2014';
    };
    const updateEditorCount = () => {
        const lines = lyricsArea.value.replace(/\r\n?/gu, '\n').split('\n').filter(l => l.trim());
        const timed = lines.some(l => /^\s*\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]/u.test(l));
        editorLinesPill.textContent = `${lines.length} lines \u00b7 ${timed ? 'Timed LRC' : 'Plain text'}`;
    };
    for (const input of [artistField, trackField, albumField, durationField, lyricsArea]) {
        input.addEventListener('input', () => {
            editorDirty = true;
            updateDurationFmt();
            updateEditorCount();
        });
    }

    const metaGrid = el('div', {class: 'meta-grid'},
        el('div', {class: 'meta-field'}, el('label', {for: 'pub-artist'}, 'Artist'), artistField),
        el('div', {class: 'meta-field'}, el('label', {for: 'pub-track'}, 'Track'), trackField),
        el('div', {class: 'meta-field'}, el('label', {for: 'pub-album'}, 'Album or single'), albumField),
        el('div', {class: 'meta-field'}, el('label', {for: 'pub-duration'}, 'Duration (seconds)'),
            el('div', {class: 'meta-duration-row'}, durationField, durationFmt)),
    );
    const editorPane = el('div', {class: 'lyrics-editor-pane', hidden: 'hidden'},
        metaGrid,
        offsetBakedNotice,
        el('div', {class: 'lyrics-textarea-wrap'},
            el('div', {class: 'lyrics-textarea-head'},
                el('label', {for: 'pub-lyrics'}, 'Lyrics (LRC timestamps or plain text)'),
                editorLinesPill),
            lyricsArea),
        el('div', {class: 'publish-notice'},
            'Anonymous LRCLIB upload: no account needed (solves a quick local proof-of-work challenge). Check artist, track, album, duration, and words before publishing \u2014 LRCLIB has no delete button.'),
        publishStatus,
    );

    const setStatus = (kind, text) => {
        publishStatus.textContent = text;
        publishStatus.className = `publish-status${kind ? ` is-${kind}` : ''}`;
        publishStatus.hidden = !text;
    };

    const saveLocalBtn = pressButton('Save local edits', async () => {
        setStatus('busy', 'Saving edits locally\u2026');
        try {
            const answer = await call('POST', '/api/command', {
                op: 'saveEditedLyrics',
                artistName: artistField.value,
                trackName: trackField.value,
                albumName: albumField.value,
                duration: Number(durationField.value) || 0,
                text: lyricsArea.value,
            });
            if (!answer?.ok)
                throw new Error(answer?.error ?? 'Could not save edits');
            editorDirty = false;
            setStatus('ok', `Saved locally (${answer.lineCount} ${answer.timed ? 'timed' : 'plain'} lines) \u2014 desktop overlay updated.`);
            loadedKey = '';
            await pollState();
            await refreshLyrics(true);
        } catch (error) {
            setStatus('error', error.message);
        }
    });

    const doPublishBtn = pressButton('Publish to LRCLIB', async () => {
        if (publishing)
            return;
        publishing = true;
        doPublishBtn.disabled = true;
        saveLocalBtn.disabled = true;
        setStatus('busy', 'Solving LRCLIB proof-of-work challenge & publishing\u2026');
        try {
            const body = {
                artistName: artistField.value.trim(),
                trackName: trackField.value.trim(),
                albumName: albumField.value.trim(),
                duration: Number(durationField.value) || 0,
                text: lyricsArea.value,
            };
            const answer = await call('POST', '/api/publish-lrclib', body);
            if (!answer?.ok)
                throw new Error(answer?.error ?? 'Publish failed');
            if (editorDirty && model.state?.active) {
                // Keep the local overlay aligned with the cleaned text just published.
                await call('POST', '/api/command', {op: 'saveEditedLyrics', ...body}).catch(() => {});
                editorDirty = false;
            }
            setStatus('ok', `Published to LRCLIB (${answer.lineCount} ${answer.timed ? 'timed' : 'plain'} lines).`);
            loadedKey = '';
            await pollState();
            await refreshLyrics(true);
        } catch (error) {
            setStatus('error', error.message);
        } finally {
            publishing = false;
            doPublishBtn.disabled = false;
            saveLocalBtn.disabled = false;
        }
    }, {class: 'primary'});

    const reloadFromActiveBtn = pressButton('Reset to current set', () => {
        editorDirty = false;
        populateEditor();
        setStatus('', '');
    }, {class: 'compact'});

    const modalFoot = el('div', {class: 'modal-foot', hidden: 'hidden'},
        reloadFromActiveBtn,
        el('div', {class: 'modal-foot-actions'}, saveLocalBtn, doPublishBtn),
    );

    const dialog = el('div', {class: 'lyrics-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Full lyrics'},
        el('div', {class: 'modal-head'},
            el('div', {class: 'modal-head-left'}, modalTitle, metaPill, publishedPill),
            el('div', {class: 'modal-head-right'}, modeSeg, closeBtn),
        ),
        readToolbar,
        el('div', {class: 'modal-body'}, reader, editorPane),
        modalFoot,
    );
    backdrop.replaceChildren(dialog);

    backdrop.addEventListener('click', event => {
        if (event.target === backdrop)
            close();
    });

    const syncUrl = () => {
        const url = new URL(window.location.href);
        if (open)
            url.searchParams.set('lyrics', mode);
        else
            url.searchParams.delete('lyrics');
        history.replaceState(null, '', url.pathname + url.search + url.hash);
    };

    const syncToolbar = () => {
        autoScrollBtn.textContent = autoScroll ? 'Auto-scroll: On' : 'Auto-scroll: Off';
        autoScrollBtn.setAttribute('aria-pressed', String(autoScroll));
        const timed = Boolean(payload?.candidate?.timed);
        autoScrollBtn.hidden = !timed;
        timingGroup.hidden = !timed;
        jumpBtn.hidden = !timed || autoScroll || currentRowIndex < 0;
        const off = Number(payload?.offsetSeconds ?? model.state?.offsetSeconds ?? 0);
        offsetReadout.textContent = `${off > 0 ? '+' : ''}${off.toFixed(1)} s`;
    };

    const scrollToCurrent = (smooth = true) => {
        if (!open || mode !== 'read')
            return;
        const rowEl = rowEls.get(currentRowIndex);
        if (!rowEl)
            return;
        programmaticScrollUntil = Date.now() + 450;
        rowEl.scrollIntoView({block: 'center', behavior: smooth ? 'smooth' : 'instant'});
    };

    const updateActiveLine = (forceScroll = false) => {
        const key = model.line?.key ?? 'none';
        const match = /:line:(\d+)$/u.exec(key);
        const nextIdx = match ? Number(match[1]) : (payload?.currentLineIndex ?? -1);
        if (nextIdx === currentRowIndex && !forceScroll)
            return;
        const prevEl = rowEls.get(currentRowIndex);
        if (prevEl) {
            prevEl.classList.remove('is-current');
            prevEl.querySelector('.lyric-now-pill')?.remove();
        }
        currentRowIndex = nextIdx;
        const nextEl = rowEls.get(currentRowIndex);
        if (nextEl) {
            nextEl.classList.add('is-current');
            if (!nextEl.querySelector('.lyric-now-pill'))
                nextEl.append(el('span', {class: 'pill pill-good lyric-now-pill'}, 'Now'));
            if (autoScroll || forceScroll)
                scrollToCurrent(!forceScroll);
        }
        syncToolbar();
    };

    const renderReader = () => {
        rowEls = new Map();
        currentRowIndex = -1;
        const candidate = payload?.candidate;
        if (!candidate || !candidate.lines?.length) {
            reader.replaceChildren(el('p', {class: 'lyrics-reader-empty'},
                payload?.active ? 'No lyrics loaded for the current song yet.' : 'No song is playing right now.'));
            syncToolbar();
            return;
        }
        const frag = document.createDocumentFragment();
        for (const entry of candidate.lines) {
            if (!entry.text) {
                const gap = el('div', {class: 'lyric-line-row is-gap', 'aria-hidden': 'true'});
                rowEls.set(entry.index, gap);
                frag.append(gap);
                continue;
            }
            const rowEl = el('div', {class: 'lyric-line-row'});
            if (candidate.timed && entry.effectiveTime !== null)
                rowEl.append(el('span', {class: 'lyric-time'}, formatClock(entry.effectiveTime)));
            const words = el('span', {class: 'lyric-words'});
            words.append(buildRubyFragment(entry.text, entry.ruby));
            rowEl.append(words);
            rowEls.set(entry.index, rowEl);
            frag.append(rowEl);
        }
        reader.replaceChildren(frag);
        updateActiveLine(true);
    };

    const populateEditor = () => {
        const candidate = payload?.candidate;
        if (!candidate) {
            artistField.value = payload?.identity?.artist ?? '';
            trackField.value = payload?.identity?.title ?? '';
            albumField.value = payload?.identity?.album ?? '';
            durationField.value = payload?.identity?.durationSeconds ? String(payload.identity.durationSeconds) : '';
            lyricsArea.value = '';
            offsetBakedNotice.hidden = true;
            updateDurationFmt();
            updateEditorCount();
            return;
        }
        artistField.value = candidate.artistName || payload?.identity?.artist || '';
        trackField.value = candidate.trackName || payload?.identity?.title || '';
        albumField.value = candidate.realAlbumName || '';
        durationField.value = candidate.duration ? String(candidate.duration) : '';
        lyricsArea.value = candidate.timed
            ? (candidate.bakedSyncedLyrics || candidate.syncedLyrics || '')
            : (candidate.plainLyrics || '');
        const off = Number(payload?.offsetSeconds ?? 0);
        if (candidate.timed && Math.abs(off) >= 0.05) {
            offsetBakedNotice.textContent = `Your ${off > 0 ? '+' : ''}${off.toFixed(1)} s timing offset has already been applied to the timestamps below.`;
            offsetBakedNotice.hidden = false;
        } else {
            offsetBakedNotice.hidden = true;
        }
        updateDurationFmt();
        updateEditorCount();
    };

    const syncHeader = () => {
        const candidate = payload?.candidate;
        modalTitle.textContent = candidate
            ? [candidate.artistName, candidate.trackName].filter(Boolean).join(' \u2014 ') || 'Full lyrics'
            : (model.state?.identityText || 'Full lyrics');
        if (candidate) {
            const spokenCount = candidate.lines.filter(l => l.text).length;
            metaPill.textContent = candidate.timed ? `Timed \u00b7 ${spokenCount} lines` : `Untimed \u00b7 ${spokenCount} lines`;
            metaPill.className = `pill ${candidate.timed ? 'pill-good' : 'pill-warn'}`;
            metaPill.hidden = false;
        } else {
            metaPill.hidden = true;
        }
        publishedPill.hidden = !payload?.publishedAt;
        const publishAllowed = model.state?.publishAvailable !== false;
        doPublishBtn.hidden = !publishAllowed;
    };

    const refreshLyrics = async (force = false) => {
        if (!open || loading)
            return;
        const key = [
            model.state?.videoId ?? '',
            model.state?.chosen?.id ?? '',
            model.state?.offsetSeconds ?? 0,
            model.values?.['text-furigana'] ? 'f1' : 'f0',
            model.state?.publishedAt ?? '',
        ].join('|');
        if (!force && key === loadedKey) {
            updateActiveLine(false);
            return;
        }
        loading = true;
        try {
            payload = await call('GET', '/api/lyrics');
            loadedKey = key;
            syncHeader();
            renderReader();
            if (!editorDirty)
                populateEditor();
        } catch (error) {
            showBanner(`Could not load full lyrics: ${error.message}`);
        } finally {
            loading = false;
        }
    };

    const setMode = next => {
        mode = next === 'edit' ? 'edit' : 'read';
        readTabBtn.setAttribute('aria-pressed', String(mode === 'read'));
        editTabBtn.setAttribute('aria-pressed', String(mode === 'edit'));
        readToolbar.hidden = mode !== 'read';
        reader.hidden = mode !== 'read';
        editorPane.hidden = mode !== 'edit';
        modalFoot.hidden = mode !== 'edit';
        if (mode === 'read')
            scrollToCurrent(false);
        else if (!editorDirty)
            populateEditor();
        syncUrl();
    };

    const openModal = (initialMode = 'read') => {
        open = true;
        autoScroll = true;
        backdrop.hidden = false;
        setStatus('', '');
        setMode(initialMode);
        refreshLyrics(true);
    };

    const close = () => {
        if (!open)
            return;
        open = false;
        backdrop.hidden = true;
        syncUrl();
    };

    window.addEventListener('keydown', event => {
        if (event.key === 'Escape' && open) {
            event.preventDefault();
            close();
            return;
        }
        const tag = event.target?.tagName;
        const typing = tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || event.target?.isContentEditable;
        if (!typing && !event.ctrlKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === 'l') {
            if (open) {
                event.preventDefault();
                close();
            } else if (model.state?.active && model.state?.chosen) {
                event.preventDefault();
                openModal('read');
            }
        }
    });

    model.stateViews.push(() => {
        if (!open)
            return;
        refreshLyrics(false);
    });
    view(() => {
        if (open)
            refreshLyrics(false);
    });

    const controller = {
        open: openModal,
        close,
        isOpen: () => open,
    };
    model.lyricsModal = controller;

    // Restore modal directly from URL (?lyrics=read or ?lyrics=edit).
    const initialParam = new URLSearchParams(window.location.search).get('lyrics');
    if (initialParam === 'read' || initialParam === 'edit')
        openModal(initialParam);

    return controller;
}

// ----- Combined settings page lifecycle

function buildWorkspace() {
    const workspace = document.getElementById('workspace');
    workspace.replaceChildren(
        pageSection('lyrics', 'Lyrics', buildLyricsGrid()),
        pageSection('pitch', 'Pitch', buildPitchGrid()),
    );
}

async function start() {
    const answer = await call('GET', '/api/settings');
    model.schema = answer.schema;
    model.values = answer.values;
    buildTopBar();
    buildStage();
    buildLyricsModal();
    buildWorkspace();
    render();
    pollState();
    setInterval(() => {
        pollSettings();
        pollState();
    }, POLL_MS);
}

start().catch(error => showBanner(`The settings page could not start: ${error.message}`));
