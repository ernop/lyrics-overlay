// Lyrics overlay settings page (http://localhost:8792/settings):
// Two-column pro studio layout with a sticky left live stage (switching
// cleanly between Live Preview / Live Pitch Preview and interactive Screen
// Map) beside a calm borderless inspector (Lyrics, Pitch, Song).

import {LYRICS_STATUS_TEXT} from '/shared/lyrics-status.js';
import {PLACEMENT_PRESETS} from '/shared/overlay-geometry.js';
import {keyName, noteLabel, pitchClassNames, SCALES} from '/shared/scales.js';
import {TEXT_COLORS, hexColor, nearestNamedColor, parseHexColor, resolveTextColor} from '/shared/text-ink.js';
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

const LINE_COLORS = [
    ['#facc15', 'Yellow'], ['#ffffff', 'White'], ['#fb923c', 'Orange'], ['#ef4444', 'Red'], ['#f472b6', 'Pink'],
    ['#e879f9', 'Magenta'], ['#a78bfa', 'Purple'], ['#60a5fa', 'Blue'], ['#22d3ee', 'Cyan'], ['#4ade80', 'Green'],
];

const BACKDROP_SWATCHES = [
    ['#000000', 'Black'], ['#141824', 'Midnight'], ['#1f2937', 'Slate'], ['#2b1429', 'Plum'], ['#ffffff', 'White'],
];

const TABS = [
    {id: 'lyric', label: 'Lyrics'},
    {id: 'pitch', label: 'Pitch'},
    {id: 'song', label: 'Song'},
];

const DEFAULT_MONITOR = {index: 0, x: 0, y: 0, width: 1920, height: 1080, scale: 1, primary: true, label: 'Primary (1920\u00d71080)'};

const model = {
    schema: null,
    values: null,
    monitors: [DEFAULT_MONITOR],
    state: null,
    line: {text: '', key: 'none'},
    addon: null,
    pending: new Map(),
    sending: false,
    held: new Set(),
    views: [],
    stateViews: [],
    activeTab: 'lyric',
    stageMode: 'preview', // 'preview' | 'map'
    previewScene: 'video',
    customSample: '',
    lyricPreview: null,
    placementMap: null,
    pitchPreview: null,
    stageSync: null,
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

function showBanner(text) {
    const banner = document.getElementById('banner');
    banner.textContent = text;
    banner.hidden = !text;
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

function render() {
    if (!model.values)
        return;
    for (const view of model.views)
        view(model.values);
    const monitor = activeMonitor('box-monitor');
    const text = activeSampleText();
    model.lyricPreview?.render(model.values, monitor, text, model.previewScene);
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
        const nextLine = answer.line ?? {text: '', key: 'none'};
        const lineChanged = nextLine.text !== model.line.text || nextLine.key !== model.line.key;
        model.line = nextLine;
        for (const fn of model.stateViews)
            fn(model.state, model.addon, model.line);
        if (lineChanged)
            render();
        showBanner('');
    } catch (error) {
        showBanner(`Could not reach the service: ${error.message}`);
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

function section(title, headRight, ...rows) {
    const head = el('div', {class: 'section-head'}, el('h2', {}, title));
    if (headRight)
        head.append(headRight);
    return el('section', {class: 'section'}, head, ...rows);
}

function row(label, ...controls) {
    return el('div', {class: 'row'},
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

function segmentedRow(key, label, choices) {
    const buttons = Object.entries(choices).map(([value, text]) => {
        const button = pressButton(text, () => set(key, value));
        view(values => button.setAttribute('aria-pressed', String(values[key] === value)));
        return button;
    });
    return row(label, el('div', {class: 'seg'}, ...buttons));
}

function switchRow(key, label) {
    const button = pressButton('', () => set(key, !model.values[key]), {class: 'switch'});
    view(values => {
        button.setAttribute('aria-pressed', String(values[key]));
        button.textContent = values[key] ? 'On' : 'Off';
    });
    return row(label, button);
}

function sliderRow(key, label, {ticks, format, log = false, integer = false, stepBy = null}) {
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
    return row(label, el('div', {class: 'slider'},
        shown,
        el('div', {class: 'track'}, input, tickMarks),
        el('div', {class: 'slider-steppers'}, minus, plus)));
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

    const overlayBtn = pressButton('', () => set('overlay-enabled', !model.values['overlay-enabled']), {class: 'switch'});
    const pitchBtn = pressButton('', () => set('pitch-enabled', !model.values['pitch-enabled']), {class: 'switch'});

    view(values => {
        overlayBtn.setAttribute('aria-pressed', String(values['overlay-enabled']));
        overlayBtn.textContent = values['overlay-enabled'] ? 'Lyrics: On' : 'Lyrics: Off';
        pitchBtn.setAttribute('aria-pressed', String(values['pitch-enabled']));
        pitchBtn.textContent = values['pitch-enabled'] ? 'Pitch: On' : 'Pitch: Off';
    });

    model.stateViews.push(state => {
        songTitle.textContent = state.active ? (state.identityText || state.videoId) : 'No song playing';
        const statusText = state.lyrics === 'generating' && state.generation?.message
            ? state.generation.message
            : (LYRICS_STATUS_TEXT[state.lyrics] ?? state.lyrics);
        statusPill.textContent = statusText;
        statusPill.className = 'pill';
        if (state.lyrics === 'timed')
            statusPill.classList.add('pill-good');
        else if (state.lyrics === 'searching' || state.lyrics === 'waiting' || state.lyrics === 'plain' || state.lyrics === 'generating')
            statusPill.classList.add('pill-warn');
        else if (state.lyrics === 'error')
            statusPill.classList.add('pill-alert');
        markMusicBtn.hidden = !(state.active && state.lyrics === 'not-music');
    });

    const header = document.getElementById('topbar');
    header.replaceChildren(
        el('div', {class: 'topbar-left'},
            el('h1', {}, 'Lyrics overlay'),
            el('span', {class: 'topbar-sep', 'aria-hidden': 'true'}),
            el('div', {class: 'topbar-song'}, songTitle, statusPill, markMusicBtn),
        ),
        el('div', {class: 'topbar-actions'}, overlayBtn, pitchBtn),
    );
}

// ----- Left sticky Live Stage (unified Lyric/Pitch Preview + Screen Map)

function buildStage() {
    const stage = document.getElementById('stage');

    // Top mode toggle: Preview | Screen map
    const previewModeBtn = pressButton('Preview', () => {
        model.stageMode = 'preview';
        model.stageSync();
    });
    const mapModeBtn = pressButton('Screen map', () => {
        model.stageMode = 'map';
        model.stageSync();
    });
    const modeSeg = el('div', {class: 'seg compact'}, previewModeBtn, mapModeBtn);

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
        telemetryLine.textContent = `${Math.round(layout.fontSize)} px \u00b7 ${layout.lines.length} ${layout.lines.length === 1 ? 'line' : 'lines'} \u00b7 ${layout.boxW}\u00d7${layout.boxH} px`;
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

    const lyricPane = el('div', {style: {display: 'flex', flexDirection: 'column', gap: '0.75rem'}},
        el('div', {class: 'stage-canvas-frame'}, lyricCanvas),
        el('div', {class: 'sample-row'},
            el('label', {class: 'sample-label', for: 'sample-input'}, 'Sample'),
            sampleInput,
            clearSampleBtn),
        el('div', {class: 'stage-meta'},
            telemetryLine,
            el('span', {class: 'hint-line'}, 'Ctrl+drag lyric on desktop to move; resize here'),
        ),
    );

    // 2. Pitch preview pane (auto-shown when Pitch tab is active)
    const pitchCanvas = el('canvas', {'aria-label': 'Live pitch panel preview'});
    model.pitchPreview = new PitchPreviewCanvas(pitchCanvas);
    const pitchMeta = el('span', {class: 'metric-value'});
    view(values => {
        const rangeText = values['pitch-range'] === 'fixed'
            ? `${noteLabel(values['pitch-range-bottom'], SHARPS)}\u2013${noteLabel(values['pitch-range-top'], SHARPS)}`
            : `${values['pitch-follow-span']} st follow`;
        pitchMeta.textContent = `${rangeText} \u00b7 ${Number(values['pitch-window-seconds']).toFixed(1).replace(/\.0$/u, '')} s \u00b7 ${values['pitch-dock']}`;
    });
    const pitchPane = el('div', {style: {display: 'flex', flexDirection: 'column', gap: '0.75rem'}, hidden: 'hidden'},
        el('div', {class: 'pitch-stage-frame'}, pitchCanvas),
        el('div', {class: 'stage-meta'},
            pitchMeta,
            el('span', {class: 'hint-line'}, 'Ctrl+drag pitch panel edges on desktop to resize or dock'),
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
        el('div', {class: 'stage-meta'}, mapMetrics, el('span', {class: 'hint-line'}, 'Drag box or any edge; hold Shift to disable snap')),
        snapBar,
    );

    model.stageSync = () => {
        const isMap = model.stageMode === 'map';
        const isPitch = !isMap && model.activeTab === 'pitch';
        const isLyric = !isMap && !isPitch;
        previewModeBtn.textContent = model.activeTab === 'pitch' ? 'Pitch preview' : 'Preview';
        previewModeBtn.setAttribute('aria-pressed', String(!isMap));
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
    );
    model.stageSync();
}

// ----- Tab 1: Lyrics (clean 8-control pro inspector)

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

function fontPickerRow() {
    let families = [];
    let category = 'all';
    let expanded = false;

    const current = el('span', {class: 'font-current-name'});
    const toggleBtn = pressButton('Choose font', () => {
        expanded = !expanded;
        browser.hidden = !expanded;
        toggleBtn.setAttribute('aria-pressed', String(expanded));
        toggleBtn.textContent = expanded ? 'Close list' : 'Choose font';
        if (expanded)
            search.focus();
    }, {class: 'compact'});
    const defaultBtn = pressButton('Desktop default', () => set('font-family', ''), {class: 'compact'});

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

    return row('Font',
        el('div', {class: 'font-summary-row'}, current, toggleBtn, defaultBtn),
        browser,
    );
}

function textColorRow() {
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

    return row('Color', el('div', {class: 'swatch-strip'},
        ...swatches,
        el('span', {class: 'color-custom-wrap'}, picker, hexOut),
    ));
}

function backdropColorRow() {
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
        row('Backdrop color', el('div', {class: 'swatch-strip'},
            ...swatches,
            el('span', {class: 'color-custom-wrap'}, picker, hexOut),
        )),
        v => v['text-backdrop'] !== 'none',
    );
}

function buildLyricsTab() {
    const boldBtn = pressButton('Bold', () => set('font-bold', !model.values['font-bold']));
    const italicBtn = pressButton('Italic', () => set('font-italic', !model.values['font-italic']));
    view(v => {
        boldBtn.setAttribute('aria-pressed', String(v['font-bold']));
        italicBtn.setAttribute('aria-pressed', String(v['font-italic']));
    });

    const typography = section('Typography', null,
        fontPickerRow(),
        sliderRow('font-size', 'Size', {ticks: [16, 28, 48, 84, 144, 256], format: unit('px'), log: true}),
        row('Style', el('div', {class: 'seg'}, boldBtn, italicBtn)),
    );

    const appearance = section('Appearance', null,
        textColorRow(),
        segmentedRow('text-border', 'Border', {double: 'Double', glow: 'Glow', single: 'Single', none: 'None'}),
        segmentedRow('text-backdrop', 'Backdrop', {none: 'None', pill: 'Behind text', box: 'Full bar'}),
        backdropColorRow(),
        whenVisible(sliderRow('text-backdrop-opacity', 'Backdrop opacity', {
            ticks: [0, 0.25, 0.5, 0.75, 1], format: percent, stepBy: 0.05,
        }), v => v['text-backdrop'] !== 'none'),
    );

    const layoutMotion = section('Layout & motion', null,
        segmentedRow('text-align', 'Alignment', {left: 'Left', center: 'Center', right: 'Right'}),
        segmentedRow('transition', 'Transition', {'fade-in': 'Fade (0.15 s)', instant: 'Instant'}),
    );

    return el('div', {class: 'panel'}, typography, appearance, layoutMotion);
}

// ----- Tab 2: Pitch

function lineColorRow() {
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
    return row('Line color', el('div', {class: 'swatch-strip'},
        ...swatches,
        el('span', {class: 'color-custom-wrap'}, custom, hexOut),
    ));
}

function noteRow(key, label) {
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
    return row(label, steps[0], steps[1], shown, steps[2], steps[3]);
}

function rootRow() {
    const buttons = Array.from({length: 12}, (_, root) => {
        const button = pressButton('', () => set('pitch-scale-root', root), {class: 'compact'});
        view(values => {
            button.textContent = pitchClassNames({root, type: values['pitch-scale-type']})[root];
            button.setAttribute('aria-pressed', String(values['pitch-scale-root'] === root));
        });
        return button;
    });
    return whenVisible(row('Scale root', el('div', {class: 'seg compact'}, ...buttons)), values => values['pitch-scale'] === 'fixed');
}

function microphoneRows() {
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
    return [row('Microphone', list), switchRow('pitch-echo-cancel', 'Echo cancelling')];
}

function buildPitchTab() {
    const placement = section('Placement', null,
        segmentedRow('pitch-dock', 'Dock', {below: 'Below', above: 'Above', left: 'Left', right: 'Right', separate: 'Separate'}),
        whenVisible(sliderRow('pitch-docked-height', 'Docked height', {
            ticks: [0.03, 0.15, 0.3, 0.45, 0.6], format: percent, stepBy: 0.02,
        }), v => v['pitch-dock'] === 'below' || v['pitch-dock'] === 'above'),
        whenVisible(sliderRow('pitch-docked-width', 'Docked width', {
            ticks: [0.05, 0.18, 0.32, 0.46, 0.6], format: percent, stepBy: 0.02,
        }), v => v['pitch-dock'] === 'left' || v['pitch-dock'] === 'right'),
        whenVisible(row('Separate box',
            el('span', {class: 'note'}, 'Switch the stage to Screen map to place it.'),
            pressButton('Reset box', () => post('/api/settings/reset', {keys: ['pitch-box', 'pitch-box-monitor']}), {class: 'compact'}),
        ), v => v['pitch-dock'] === 'separate'),
    );

    const range = section('Note range & timing', null,
        segmentedRow('pitch-range', 'Notes shown', {fixed: 'Fixed range', follow: 'Follow voice'}),
        whenVisible(noteRow('pitch-range-top', 'Highest note'), v => v['pitch-range'] === 'fixed'),
        whenVisible(noteRow('pitch-range-bottom', 'Lowest note'), v => v['pitch-range'] === 'fixed'),
        whenVisible(row('Auto-fit', pressButton('Fit to my last 30 s of singing', () => post('/api/pitch/fit', {}))), v => v['pitch-range'] === 'fixed'),
        whenVisible(sliderRow('pitch-follow-span', 'Voice span', {
            ticks: [6, 12, 18, 24, 36], format: unit('semitones'), integer: true, stepBy: 1,
        }), v => v['pitch-range'] === 'follow'),
        sliderRow('pitch-window-seconds', 'Time across', {ticks: [2, 5, 10, 20, 45, 120], format: unit('s', 1), log: true}),
        switchRow('pitch-time-in-silence', 'Scroll in silence'),
        sliderRow('pitch-rate', 'Analyses per s', {ticks: [10, 25, 50, 75, 100], format: unit('per s'), integer: true, stepBy: 5}),
    );

    const scaleTypes = Object.fromEntries(Object.entries(SCALES).map(([type, scale]) => [type, scale.name[0].toUpperCase() + scale.name.slice(1)]));
    const trace = section('Trace & readout', null,
        sliderRow('pitch-line-width', 'Line thickness', {ticks: [0.5, 1, 2, 4, 8, 12], format: unit('px', 1), log: true}),
        lineColorRow(),
        sliderRow('pitch-background-opacity', 'Background', {ticks: [0, 0.25, 0.5, 0.75, 1], format: percent, stepBy: 0.05}),
        segmentedRow('pitch-labels', 'Note names', {all: 'All', scale: 'Scale', c: 'C only', none: 'None'}),
        whenVisible(sliderRow('pitch-label-size', 'Note name size', {
            ticks: [8, 12, 16, 24, 32], format: unit('px'), stepBy: 1,
        }), v => v['pitch-labels'] !== 'none'),
        segmentedRow('pitch-readout', 'Current note', {
            'right': 'Right', 'left': 'Left', 'top-right': 'Top R',
            'top-left': 'Top L', 'bottom-right': 'Bot R', 'bottom-left': 'Bot L', 'off': 'Off',
        }),
        whenVisible(sliderRow('pitch-readout-size', 'Readout size', {
            ticks: [0.15, 0.35, 0.55, 0.75, 1], format: percent, stepBy: 0.05,
        }), v => v['pitch-readout'] !== 'off'),
        whenVisible(switchRow('pitch-readout-cents', 'Show cents'), v => v['pitch-readout'] !== 'off'),
    );

    const scaleMic = section('Scale & microphone', null,
        segmentedRow('pitch-scale', 'Scale', {detect: 'Detect from song', fixed: 'Fixed', none: 'None'}),
        rootRow(),
        whenVisible(segmentedRow('pitch-scale-type', 'Scale type', scaleTypes), v => v['pitch-scale'] === 'fixed'),
        whenVisible(switchRow('pitch-show-key', 'Name scale'), v => v['pitch-scale'] !== 'none'),
        ...microphoneRows(),
    );

    return el('div', {class: 'panel'}, placement, range, trace, scaleMic);
}

// ----- Tab 3: Song & Lyrics

function buildSongTab() {
    const playing = el('span', {class: 'value'});
    const lyrics = el('span', {class: 'value'});
    const timing = el('span', {class: 'value'});
    const microphone = el('span', {class: 'value'});
    const heardKey = el('span', {class: 'value'});
    const addonVersion = el('span', {class: 'value'});
    const install = el('a', {class: 'button primary', href: ADDON_DOWNLOAD});
    const updateService = el('span', {class: 'note'}, 'Update the service: ', el('kbd', {}, 'git pull && scripts/install.sh'));
    const sets = el('div', {class: 'list short', role: 'listbox', 'aria-label': 'Lyric sets'});
    const setsCount = el('span', {class: 'pill'}, '0 sets');
    const emptySets = el('p', {class: 'note'}, 'No lyric candidates loaded for the current video.');

    const command = body => post('/api/command', body);
    const markMusic = pressButton('This is a music video', () => command({op: 'lookUp'}), {class: 'primary', hidden: 'hidden'});
    const wrong = pressButton('Wrong lyrics: hide this set', () => command({op: 'reject'}));
    const again = pressButton('Search again', () => command({op: 'searchAgain'}));
    const generate = pressButton('Generate timed lyrics', () => command({op: 'generate'}), {hidden: 'hidden'});
    const timingButtons = [
        pressButton('Too fast (\u22120.5 s)', () => command({op: 'tooFast'})),
        pressButton('Too slow (+0.5 s)', () => command({op: 'tooSlow'})),
        pressButton('Reset', () => command({op: 'resetOffset'})),
    ];

    const fileInput = el('input', {type: 'file', accept: '.lrc,.txt,text/plain', hidden: 'hidden'});
    const loadFileBtn = pressButton('Load .lrc / .txt file', () => fileInput.click(), {class: 'compact'});
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
    const manualSearchBtn = el('button', {type: 'submit', class: 'compact'}, 'Search LRCLIB');
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
        playing.textContent = state.active ? state.identityText || state.videoId : 'Nothing on YouTube';
        if (state.videoId !== lastVideoId) {
            lastVideoId = state.videoId;
            artistInput.value = '';
            titleInput.value = '';
        }
        const gen = state.generation;
        if (state.lyrics === 'generating' && gen?.message) {
            lyrics.textContent = gen.message;
        } else if ((gen?.status === 'error' || gen?.status === 'skipped') && gen.message && state.lyrics !== 'timed') {
            lyrics.textContent = `${LYRICS_STATUS_TEXT[state.lyrics]} (${gen.message})`;
        } else {
            lyrics.textContent = LYRICS_STATUS_TEXT[state.lyrics] ?? state.lyrics;
        }
        timing.textContent = `${state.offsetSeconds > 0 ? '+' : ''}${state.offsetSeconds.toFixed(1)} s`;
        for (const button of timingButtons)
            button.disabled = !state.active;
        const notMusic = state.active && state.lyrics === 'not-music';
        markMusic.hidden = !notMusic;
        markMusic.disabled = !notMusic;
        wrong.disabled = !state.chosen;
        again.disabled = !state.active;
        loadFileBtn.disabled = !state.active;
        artistInput.disabled = !state.active;
        titleInput.disabled = !state.active;
        manualSearchBtn.disabled = !state.active;
        const canGenerate = Boolean(gen?.available);
        generate.hidden = !canGenerate;
        generate.disabled = !state.active || state.lyrics === 'generating';
        if (state.lyrics === 'generating')
            generate.textContent = 'Timing lyrics\u2026';
        else if (gen?.status === 'error')
            generate.textContent = 'Retry timing';
        else if (state.candidates.some(c => c.generated))
            generate.textContent = 'Regenerate timed lyrics';
        else
            generate.textContent = 'Generate timed lyrics';
        microphone.textContent = state.pitch.error ? `Stopped: ${state.pitch.error}`
            : state.pitch.capturing ? state.pitch.microphone || 'On' : 'Off';
        const scale = model.values['pitch-scale'];
        if (scale === 'detect')
            heardKey.textContent = state.key ? `${keyName(state.key)}, heard in the song` : 'Not heard yet';
        else if (scale === 'fixed')
            heardKey.textContent = `${keyName({root: model.values['pitch-scale-root'], type: model.values['pitch-scale-type']})}, fixed`;
        else
            heardKey.textContent = 'None';

        const timedCount = state.candidates.filter(c => c.timed).length;
        setsCount.textContent = `${state.candidates.length} sets (${timedCount} timed)`;
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

    const songSection = section('Active song & timing', null,
        row('Playing', playing),
        row('Lyrics', lyrics),
        row('Timing offset', timing, ...timingButtons),
        row('Actions', markMusic, wrong, again, generate),
        row('Microphone', microphone),
        row('Detected scale', heardKey),
        row('Firefox add-on', addonVersion, install, updateService),
    );

    const setsHeadRight = el('div', {class: 'section-head-actions'}, setsCount, loadFileBtn, fileInput);
    const setsSection = section('Lyric sets', setsHeadRight, manualSearchForm, emptySets, sets);

    return el('div', {class: 'panel'}, songSection, setsSection);
}

// ----- Tabs & page lifecycle

function buildWorkspace() {
    const panels = {
        lyric: buildLyricsTab(),
        pitch: buildPitchTab(),
        song: buildSongTab(),
    };
    const songBadge = el('span', {class: 'tab-badge', hidden: 'hidden'});
    model.stateViews.push(state => {
        if (state.candidates.length) {
            songBadge.textContent = String(state.candidates.length);
            songBadge.hidden = false;
        } else {
            songBadge.hidden = true;
        }
    });

    const tabButtons = {};
    const activate = id => {
        if (!(id in panels))
            id = 'lyric';
        model.activeTab = id;
        for (const [key, panel] of Object.entries(panels)) {
            const selected = key === id;
            panel.hidden = !selected;
            tabButtons[key].setAttribute('aria-selected', String(selected));
        }
        if (window.location.hash !== `#${id}`)
            history.replaceState(null, '', `#${id}`);
        model.stageSync?.();
    };

    const nav = document.getElementById('tabs');
    nav.replaceChildren(...TABS.map(tab => {
        const btn = pressButton(tab.label, () => activate(tab.id), {role: 'tab', 'aria-selected': 'false'});
        if (tab.id === 'song')
            btn.append(songBadge);
        tabButtons[tab.id] = btn;
        return btn;
    }));

    const workspace = document.getElementById('workspace');
    workspace.replaceChildren(...Object.values(panels));

    const initialHash = window.location.hash.replace(/^#/u, '');
    activate(initialHash in panels ? initialHash : 'lyric');
    window.addEventListener('hashchange', () => {
        const target = window.location.hash.replace(/^#/u, '');
        if (target in panels && target !== model.activeTab)
            activate(target);
    });
}

async function start() {
    const answer = await call('GET', '/api/settings');
    model.schema = answer.schema;
    model.values = answer.values;
    buildTopBar();
    buildStage();
    buildWorkspace();
    render();
    pollState();
    setInterval(() => {
        pollSettings();
        pollState();
    }, POLL_MS);
}

start().catch(error => showBanner(`The settings page could not start: ${error.message}`));
