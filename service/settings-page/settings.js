// The settings studio (http://localhost:8792/settings and http://lyrics.localhost/settings):
// live visual lyric preview, interactive screen placement map with 8-handle
// resize and pitch docking, one-click style presets, and four focused
// workspaces synced in real time to GNOME Shell via GSettings.

import {LYRICS_STATUS_TEXT} from '/shared/lyrics-status.js';
import {
    MIN_GEOMETRY_HEIGHT, MIN_GEOMETRY_WIDTH, PLACEMENT_PRESETS, clampGeometry,
} from '/shared/overlay-geometry.js';
import {keyName, noteLabel, pitchClassNames, SCALES} from '/shared/scales.js';
import {STYLE_PRESETS} from '/shared/style-presets.js';
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

const LINE_COLORS = [
    ['#facc15', 'Yellow'], ['#ffffff', 'White'], ['#fb923c', 'Orange'], ['#ef4444', 'Red'], ['#f472b6', 'Pink'],
    ['#e879f9', 'Magenta'], ['#a78bfa', 'Purple'], ['#60a5fa', 'Blue'], ['#22d3ee', 'Cyan'], ['#4ade80', 'Green'],
];

const BACKDROP_SWATCHES = [
    ['#000000', 'Black'], ['#141824', 'Midnight'], ['#1f2937', 'Slate'], ['#2b1429', 'Plum'], ['#ffffff', 'White'],
];

const WEIGHT_CHOICES = [
    [300, 'Light'],
    [400, 'Regular'],
    [500, 'Medium'],
    [600, 'Semi'],
    [700, 'Bold'],
    [800, 'Extra'],
    [900, 'Black'],
];

const SAMPLE_LINES = [
    {id: 'live', label: 'Live line', text: null},
    {id: 'short', label: 'Short', text: 'Amazing grace, how sweet the sound'},
    {id: 'long', label: 'Long wrap', text: 'And when the broken hearted people living in the world agree, there will be an answer'},
    {id: 'dots', label: 'i, j, o', text: 'Timing & lighting in the midnight glow...'},
    {id: 'countdown', label: 'Countdown', text: '3 Amazing grace, how sweet the sound'},
];

const QUICK_FONTS = [
    '', 'Adwaita Sans', 'DejaVu Sans', 'Liberation Sans', 'Ubuntu', 'Noto Sans',
    'DejaVu Serif', 'Liberation Serif', 'DejaVu Sans Mono', 'JetBrains Mono',
];

const TABS = [
    {id: 'lyric', label: 'Lyric style'},
    {id: 'layout', label: 'Box & position'},
    {id: 'pitch', label: 'Pitch panel'},
    {id: 'song', label: 'Song & lyrics'},
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
    previewScene: 'video',
    sampleMode: 'short',
    customSample: 'Amazing grace, how sweet the sound',
    lastTelemetry: null,
    lyricPreview: null,
    placementMap: null,
    pitchPreview: null,
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
    if (model.sampleMode === 'live' && model.line?.text)
        return model.line.text;
    return model.customSample || 'Amazing grace, how sweet the sound';
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
        if (answer?.values)
            absorb(answer.values);
        showBanner('');
    } catch (error) {
        showBanner(error.message);
    }
    pollState();
}

async function pollSettings() {
    try {
        const {values} = await call('GET', '/api/settings');
        if (!model.sending)
            absorb(values);
    } catch {
        showBanner('The lyrics service is not running.');
    }
}

async function pollState() {
    try {
        const {state, line, addon} = await call('GET', '/api/state');
        const lineChanged = line?.text !== model.line?.text;
        model.state = state;
        model.line = line ?? {text: '', key: 'none'};
        model.addon = addon;
        for (const view of model.stateViews)
            view(state, addon, model.line);
        if (lineChanged && model.sampleMode === 'live')
            render();
        else if (model.pitchPreview)
            model.pitchPreview.render(model.values, state?.key ?? null);
    } catch {
        showBanner('The lyrics service is not running.');
    }
}

// ----- DOM building blocks

function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(props)) {
        if (value === undefined || value === null)
            continue;
        if (name === 'class')
            node.className = value;
        else if (name === 'style')
            Object.assign(node.style, value);
        else if (name.startsWith('on'))
            node.addEventListener(name.slice(2), value);
        else
            node.setAttribute(name, value);
    }
    node.append(...children);
    return node;
}

function view(update) {
    model.views.push(update);
}

function row(label, ...controls) {
    return el('div', {class: 'row'}, el('span', {class: 'label'}, label), el('div', {class: 'controls'}, ...controls));
}

function card(title, headExtra, ...children) {
    const head = el('div', {class: 'card-head'}, el('h2', {}, title), ...(headExtra ? [headExtra] : []));
    return el('section', {class: 'card'}, head, ...children.flat());
}

function pressButton(text, onclick, props = {}) {
    return el('button', {type: 'button', onclick, ...props}, text);
}

function cssFamily(family) {
    return `"${family.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

function switchRow(key, label) {
    const button = pressButton('', () => set(key, !model.values[key]), {class: 'switch'});
    view(values => {
        button.setAttribute('aria-pressed', String(values[key]));
        button.textContent = values[key] ? 'On' : 'Off';
    });
    return row(label, button);
}

/** @param {Record<string, string>} labels the text for every choice the schema allows */
function choiceRow(key, label, labels) {
    const choices = model.schema[key].choices;
    const missing = choices.filter(choice => !(choice in labels));
    if (missing.length || Object.keys(labels).length !== choices.length)
        throw new Error(`the page's labels for ${key} do not match its choices (${choices.join(', ')})`);
    const buttons = Object.entries(labels).map(([value, text]) => {
        const button = pressButton(text, () => set(key, value));
        view(values => button.setAttribute('aria-pressed', String(values[key] === value)));
        return button;
    });
    return row(label, ...buttons);
}

/**
 * Notched slider with labeled endpoints, tabular current value, -/+ steppers,
 * and double-click on the value to reset that setting to its default.
 */
function sliderRow(key, label, {ticks, format, log = false, integer = false, stepBy = null}) {
    const {min, max} = model.schema[key];
    if (ticks[0] !== min || ticks[ticks.length - 1] !== max)
        throw new Error(`the ${key} slider must label both ends, ${min} and ${max}`);
    const fraction = value => log ? Math.log(value / min) / Math.log(max / min) : (value - min) / (max - min);
    const valueAt = position => {
        const f = position / SLIDER_STEPS;
        const value = log ? min * (max / min) ** f : min + (max - min) * f;
        return integer ? Math.round(value) : value;
    };
    const nudge = dir => {
        const current = model.values[key];
        let next;
        if (stepBy !== null)
            next = current + dir * stepBy;
        else if (log)
            next = current * (1.08 ** dir);
        else
            next = current + dir * ((max - min) / 25);
        next = Math.min(max, Math.max(min, integer ? Math.round(next) : next));
        set(key, next);
    };
    const input = el('input', {type: 'range', min: '0', max: String(SLIDER_STEPS), step: '1', 'aria-label': label});
    const shown = el('span', {class: 'value', title: 'Double-click to reset to default'});
    shown.addEventListener('dblclick', () => post('/api/settings/reset', {keys: [key]}));
    const minus = pressButton('\u2212', () => nudge(-1), {class: 'step', 'aria-label': `Decrease ${label}`});
    const plus = pressButton('+', () => nudge(1), {class: 'step', 'aria-label': `Increase ${label}`});
    const notches = el('div', {class: 'ticks'},
        ...ticks.map(tick => el('span', {class: 'tick', style: {left: `${fraction(tick) * 100}%`}}, format(tick, true))));
    input.addEventListener('pointerdown', () => model.held.add(key));
    for (const name of ['pointerup', 'pointercancel', 'change'])
        input.addEventListener(name, () => model.held.delete(key));
    input.addEventListener('input', () => set(key, valueAt(Number(input.value))));
    view(values => {
        if (!model.held.has(key))
            input.value = String(Math.round(fraction(values[key]) * SLIDER_STEPS));
        shown.textContent = format(values[key], false);
    });
    return row(label, el('div', {class: 'slider'},
        shown,
        el('div', {class: 'track'}, input, notches),
        el('div', {class: 'slider-steppers'}, minus, plus)));
}

/**
 * Custom notched slider bound to a virtual accessor (used for box X/Y/W/H
 * coordinates where one key holds an object).
 */
function virtualSliderRow(holdKey, label, {min, max, ticks, format, get, setValue, stepBy}) {
    const fraction = value => (value - min) / (max - min);
    const input = el('input', {type: 'range', min: '0', max: String(SLIDER_STEPS), step: '1', 'aria-label': label});
    const shown = el('span', {class: 'value'});
    const minus = pressButton('\u2212', () => setValue(Math.max(min, get(model.values) - stepBy)), {class: 'step', 'aria-label': `Decrease ${label}`});
    const plus = pressButton('+', () => setValue(Math.min(max, get(model.values) + stepBy)), {class: 'step', 'aria-label': `Increase ${label}`});
    const notches = el('div', {class: 'ticks'},
        ...ticks.map(tick => el('span', {class: 'tick', style: {left: `${fraction(tick) * 100}%`}}, format(tick, true))));
    input.addEventListener('pointerdown', () => model.held.add(holdKey));
    for (const name of ['pointerup', 'pointercancel', 'change'])
        input.addEventListener(name, () => model.held.delete(holdKey));
    input.addEventListener('input', () => {
        const value = min + (max - min) * (Number(input.value) / SLIDER_STEPS);
        setValue(value);
    });
    view(values => {
        const val = get(values);
        if (!model.held.has(holdKey))
            input.value = String(Math.round(fraction(Math.min(max, Math.max(min, val))) * SLIDER_STEPS));
        shown.textContent = format(val, false);
    });
    return row(label, el('div', {class: 'slider'},
        shown,
        el('div', {class: 'track'}, input, notches),
        el('div', {class: 'slider-steppers'}, minus, plus)));
}

const percent = (value, short) => `${Math.round(value * 100)}${short ? '' : '%'}`;
const unit = (suffix, digits = 0) => (value, short) => short ? `${value}` : `${value.toFixed(digits)} ${suffix}`;

function whenVisible(node, predicate) {
    view(values => {
        node.hidden = !predicate(values);
    });
    return node;
}

// ----- Top Command Bar

function buildTopBar() {
    const songTitle = el('span', {class: 'topbar-title'}, 'Nothing on YouTube');
    const lyricsPill = el('span', {class: 'pill'}, 'Idle');
    const lyricsToggle = pressButton('', () => set('overlay-enabled', !model.values['overlay-enabled']));
    const pitchToggle = pressButton('', () => set('pitch-enabled', !model.values['pitch-enabled']));
    const adjustBtn = pressButton('', () => set('overlay-adjust-mode', !model.values['overlay-adjust-mode']));
    const addonInstall = el('a', {class: 'button primary', href: ADDON_DOWNLOAD, hidden: 'hidden'});

    view(values => {
        lyricsToggle.setAttribute('aria-pressed', String(values['overlay-enabled']));
        lyricsToggle.textContent = values['overlay-enabled'] ? 'Lyrics: On' : 'Lyrics: Off';
        pitchToggle.setAttribute('aria-pressed', String(values['pitch-enabled']));
        pitchToggle.textContent = values['pitch-enabled'] ? 'Pitch: On' : 'Pitch: Off';
        const adjusting = Boolean(values['overlay-adjust-mode']);
        adjustBtn.className = adjusting ? 'adjust-active' : 'action-accent';
        adjustBtn.setAttribute('aria-pressed', String(adjusting));
        adjustBtn.textContent = adjusting ? 'Adjusting on desktop \u2014 Done' : 'Adjust box on desktop';
    });

    model.stateViews.push((state, addon) => {
        songTitle.textContent = state.active ? (state.identityText || state.videoId) : 'Nothing on YouTube';
        lyricsPill.textContent = LYRICS_STATUS_TEXT[state.lyrics];
        lyricsPill.className = state.lyrics === 'timed' ? 'pill pill-good'
            : (state.lyrics === 'plain' || state.lyrics === 'waiting') ? 'pill pill-warn'
                : state.lyrics === 'error' ? 'pill pill-alert' : 'pill';
        addonInstall.textContent = `Install add-on ${addon.current}`;
        addonInstall.hidden = addon.status !== 'unnamed' && addon.status !== 'older';
    });

    const bar = document.getElementById('topbar');
    bar.replaceChildren(
        el('div', {class: 'topbar-left'},
            el('h1', {}, 'Lyrics overlay'),
            el('div', {class: 'topbar-song'}, songTitle, lyricsPill)),
        el('div', {class: 'topbar-actions'}, lyricsToggle, pitchToggle, adjustBtn, addonInstall),
    );
}

// ----- Hero Visual Studio

function fitBoxHeightToText() {
    if (!model.lastTelemetry)
        return;
    const box = model.values.box;
    const nextHeight = Math.max(box.height, model.lastTelemetry.neededHeightFraction);
    set('box', clampGeometry({...box, height: nextHeight}));
}

function buildStudio() {
    // Left pane: Live Lyric Preview
    const drawnMetric = el('span', {class: 'metric-value'});
    const linesMetric = el('span', {class: 'pill'});
    const fitBtn = pressButton('Expand box to fit text', fitBoxHeightToText, {class: 'compact action-accent', hidden: 'hidden'});
    const sceneButtons = [
        ['video', 'Video'], ['dark', 'Dark'], ['light', 'Light'], ['grid', 'Grid'],
    ].map(([id, label]) => {
        const btn = pressButton(label, () => {
            model.previewScene = id;
            updateScenes();
            render();
        }, {class: 'compact'});
        btn.dataset.scene = id;
        return btn;
    });
    const updateScenes = () => {
        for (const btn of sceneButtons)
            btn.setAttribute('aria-pressed', String(btn.dataset.scene === model.previewScene));
    };
    updateScenes();

    const previewCanvas = el('canvas', {'aria-label': 'Live lyric preview'});
    const previewFrame = el('div', {class: 'preview-frame'}, previewCanvas);
    const clampBanner = el('div', {class: 'clamp-banner', hidden: 'hidden'});
    const clampText = el('span', {});
    clampBanner.append(clampText, fitBtn);

    model.lyricPreview = new LyricPreviewCanvas(previewCanvas, telemetry => {
        model.lastTelemetry = telemetry;
        if (model.values['text-fit-mode'] === 'fill') {
            drawnMetric.textContent = `Auto-filled ${Math.round(telemetry.drawnSize)} px`;
            drawnMetric.className = 'metric-value';
            clampBanner.hidden = true;
            fitBtn.hidden = true;
        } else if (telemetry.clamped) {
            drawnMetric.textContent = `Drawn ${Math.round(telemetry.drawnSize)} / ${Math.round(telemetry.targetSize)} px`;
            drawnMetric.className = 'metric-value metric-warn';
            clampText.textContent = `Box height (${telemetry.boxH} px) limits ${Math.round(telemetry.targetSize)} px text + border to ${Math.round(telemetry.drawnSize)} px.`;
            clampBanner.hidden = false;
            fitBtn.hidden = false;
        } else {
            drawnMetric.textContent = `${Math.round(telemetry.drawnSize)} px`;
            drawnMetric.className = 'metric-value';
            clampBanner.hidden = true;
            fitBtn.hidden = true;
        }
        linesMetric.textContent = `${telemetry.lines.length} ${telemetry.lines.length === 1 ? 'line' : 'lines'}`;
    });

    const sampleInput = el('input', {
        type: 'text',
        class: 'sample-input',
        value: model.customSample,
        placeholder: 'Type sample lyric to test...',
        'aria-label': 'Sample lyric text',
    });
    let previewTextTimer = 0;
    const syncDesktopPreviewText = text => {
        clearTimeout(previewTextTimer);
        previewTextTimer = setTimeout(() => {
            if (model.values && model.values['overlay-preview-text'] !== text)
                set('overlay-preview-text', text.slice(0, 200));
        }, 250);
    };
    sampleInput.addEventListener('input', () => {
        model.sampleMode = 'custom';
        model.customSample = sampleInput.value;
        updateSamples();
        render();
        syncDesktopPreviewText(sampleInput.value);
    });
    const sampleButtons = SAMPLE_LINES.map(item => {
        const btn = pressButton(item.label, () => {
            model.sampleMode = item.id;
            if (item.text !== null) {
                model.customSample = item.text;
                sampleInput.value = item.text;
                syncDesktopPreviewText(item.text);
            }
            updateSamples();
            render();
        }, {class: 'compact'});
        btn.dataset.sample = item.id;
        return btn;
    });
    const updateSamples = () => {
        for (const btn of sampleButtons)
            btn.setAttribute('aria-pressed', String(btn.dataset.sample === model.sampleMode));
    };
    updateSamples();

    const previewPane = el('div', {class: 'studio-pane'},
        el('div', {class: 'pane-head'},
            el('div', {class: 'pane-head-left'}, el('h2', {}, 'Live preview'), drawnMetric, linesMetric),
            el('div', {class: 'pane-head-right'}, ...sceneButtons)),
        previewFrame,
        clampBanner,
        el('div', {class: 'sample-bar'}, ...sampleButtons, sampleInput),
    );

    // Right pane: Interactive Screen Placement Map
    const boxMetric = el('span', {class: 'metric-value'});
    const monitorPicker = el('div', {class: 'pane-head-right'});
    const rebuildMonitors = () => {
        if (model.monitors.length <= 1) {
            monitorPicker.replaceChildren(el('span', {class: 'pill'}, model.monitors[0].label));
            return;
        }
        const primary = model.monitors.find(m => m.primary) ?? model.monitors[0];
        const ordered = [primary, ...model.monitors.filter(m => m !== primary)];
        let secondaryNum = 1;
        const buttons = ordered.map(m => {
            const isPrimary = m === primary;
            const target = isPrimary ? -1 : m.index;
            const text = isPrimary ? `Primary ${m.width}\u00d7${m.height}` : `Monitor ${++secondaryNum} ${m.width}\u00d7${m.height}`;
            const btn = pressButton(text, () => set('box-monitor', target), {class: 'compact'});
            btn.dataset.monitor = String(target);
            btn.dataset.realIndex = String(m.index);
            return btn;
        });
        monitorPicker.replaceChildren(...buttons);
        markMonitors();
    };
    const markMonitors = () => {
        const current = model.values?.['box-monitor'] ?? -1;
        for (const child of monitorPicker.children) {
            if (child.tagName === 'BUTTON') {
                const target = Number(child.dataset.monitor);
                const realIdx = Number(child.dataset.realIndex);
                const active = target === -1 ? (current < 0 || current === realIdx) : current === target;
                child.setAttribute('aria-pressed', String(active));
            }
        }
    };
    rebuildMonitors();

    const placementCanvas = el('canvas', {'aria-label': 'Interactive screen placement map'});
    const placementStage = el('div', {class: 'placement-stage'}, placementCanvas);
    model.placementMap = new ScreenPlacementMap({
        stage: placementStage,
        canvas: placementCanvas,
        onChange: changes => setMany(changes),
        onHold: (keys, held) => {
            for (const k of keys) {
                if (held) model.held.add(k);
                else model.held.delete(k);
            }
        },
    });

    const placementPresets = [
        ...PLACEMENT_PRESETS.map(preset => pressButton(preset.label, () => set('box', {...preset.box}), {class: 'compact'})),
        pressButton('Reset box', () => post('/api/settings/reset', {keys: ['box', 'box-monitor']}), {class: 'compact'}),
    ];

    view(values => {
        const mon = activeMonitor('box-monitor');
        const pxW = Math.round(values.box.width * mon.width);
        const pxH = Math.round(values.box.height * mon.height);
        boxMetric.textContent = `${pxW}\u00d7${pxH} px (${Math.round(values.box.width * 100)}%\u00d7${Math.round(values.box.height * 100)}%)`;
        markMonitors();
    });

    const placementPane = el('div', {class: 'studio-pane'},
        el('div', {class: 'pane-head'},
            el('div', {class: 'pane-head-left'}, el('h2', {}, 'Screen placement'), boxMetric),
            monitorPicker),
        el('div', {class: 'placement-wrap'}, placementStage),
        el('div', {class: 'preset-strip'}, ...placementPresets),
    );

    document.getElementById('studio').replaceChildren(previewPane, placementPane);

    call('GET', '/api/monitors').then(answer => {
        if (Array.isArray(answer?.monitors) && answer.monitors.length) {
            model.monitors = answer.monitors;
            rebuildMonitors();
            render();
        }
    }).catch(() => {});
}

// ----- Tab 1: Lyric Style

function buildStylePresetsCard() {
    const tiles = STYLE_PRESETS.map(preset => {
        const specimenSpan = el('span', {
            style: {
                color: preset.preview.color,
                background: preset.preview.bg,
                textShadow: preset.preview.border === 'double'
                    ? '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000, 0 0 5px #fff'
                    : preset.preview.border === 'single'
                        ? '-1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000, 1px 1px 0 #000'
                        : '0 2px 5px #000',
            },
        }, 'Aa Lyrics');
        const tile = pressButton('', () => setMany(preset.changes), {class: 'preset-tile'});
        tile.append(el('div', {class: 'preset-specimen'}, specimenSpan), el('span', {class: 'preset-name'}, preset.label));
        return tile;
    });
    const section = card('Quick style presets', null, el('div', {class: 'style-preset-grid'}, ...tiles));
    section.classList.add('style-presets-card');
    return section;
}

function classifyFont(family) {
    const lower = family.toLowerCase();
    if (/mono|code|consolas|courier|fixed|term|hack|fira code|jetbrains/u.test(lower))
        return 'mono';
    if (/serif|garamond|georgia|times|palatino|cambria|c059|bookman|charter|baskerville|crimson|playfair|merriweather/u.test(lower) && !/sans/u.test(lower))
        return 'serif';
    return 'sans';
}

function buildFontControl() {
    const current = el('span', {class: 'font-current-name'});
    let open = false;
    let families = [];
    let category = 'all';

    const toggleBtn = pressButton('Browse fonts', () => {
        open = !open;
        browser.hidden = !open;
        toggleBtn.setAttribute('aria-pressed', String(open));
        if (open)
            search.focus();
    }, {class: 'compact'});

    const quickRow = el('div', {class: 'controls'});
    const search = el('input', {type: 'search', placeholder: 'Filter fonts by name...', 'aria-label': 'Find a font by name'});
    const list = el('div', {class: 'list fonts', role: 'listbox', 'aria-label': 'Fonts'});

    const catButtons = [['all', 'All'], ['sans', 'Sans'], ['serif', 'Serif'], ['mono', 'Mono']].map(([id, text]) => {
        const btn = pressButton(text, () => {
            category = id;
            updateCats();
            buildList();
        }, {class: 'compact'});
        btn.dataset.cat = id;
        return btn;
    });
    const updateCats = () => {
        for (const btn of catButtons)
            btn.setAttribute('aria-pressed', String(btn.dataset.cat === category));
    };
    updateCats();

    const markSelected = () => {
        const chosen = model.values['font-family'];
        for (const button of list.children)
            button.setAttribute('aria-pressed', String(button.dataset.family === chosen));
        for (const button of quickRow.children)
            button.setAttribute('aria-pressed', String(button.dataset.family === chosen));
    };

    const buildQuick = () => {
        const installed = new Set(families);
        const picks = QUICK_FONTS.filter(f => f === '' || installed.has(f)).slice(0, 7);
        quickRow.replaceChildren(...picks.map(family => {
            const btn = pressButton(family || 'Desktop font', () => set('font-family', family), {
                class: 'compact',
                style: family ? {fontFamily: cssFamily(family)} : {},
            });
            btn.dataset.family = family;
            return btn;
        }));
        markSelected();
    };

    const buildList = () => {
        const query = search.value.trim().toLowerCase();
        const items = ['', ...families].filter(family => {
            if (query && !(family || 'desktop font').toLowerCase().includes(query))
                return false;
            if (category !== 'all' && family && classifyFont(family) !== category)
                return false;
            return true;
        });
        list.replaceChildren(...items.map(family => {
            const btn = pressButton(family || 'Desktop font', () => set('font-family', family),
                family ? {style: {fontFamily: cssFamily(family)}} : {});
            btn.dataset.family = family;
            return btn;
        }));
        markSelected();
    };

    search.addEventListener('input', buildList);

    const browser = el('div', {class: 'font-browser', hidden: 'hidden'},
        el('div', {class: 'font-browser-bar'}, search, ...catButtons),
        list);

    view(values => {
        const family = values['font-family'];
        current.textContent = family || 'Desktop font';
        current.style.fontFamily = family ? cssFamily(family) : '';
        current.style.fontStyle = values['font-italic'] ? 'italic' : 'normal';
        current.style.fontWeight = String(values['font-weight'] >= 100 ? values['font-weight'] : (values['font-bold'] ? 700 : 400));
        markSelected();
    });

    call('GET', '/api/fonts').then(answer => {
        families = answer.families;
        toggleBtn.textContent = `Browse all (${families.length})`;
        buildQuick();
        buildList();
    }, error => showBanner(`Could not list the fonts: ${error.message}`));

    return [
        row('Font', el('div', {class: 'font-summary-row'}, current, toggleBtn)),
        el('div', {class: 'row'}, el('span', {class: 'label'}, 'Quick fonts'), quickRow),
        browser,
    ];
}

function buildWeightRow() {
    const buttons = WEIGHT_CHOICES.map(([weight, label]) => {
        const btn = pressButton(label, () => setMany({'font-weight': weight, 'font-bold': weight >= 600}), {
            class: 'compact',
            style: {fontWeight: String(weight)},
        });
        view(values => {
            const active = values['font-weight'] >= 100 ? values['font-weight'] : (values['font-bold'] ? 700 : 400);
            btn.setAttribute('aria-pressed', String(active === weight));
        });
        return btn;
    });
    return row('Weight', ...buttons);
}

function buildTextColorRow() {
    const buttons = model.schema['text-color'].choices.map(name => {
        const label = `${name[0].toUpperCase()}${name.slice(1)}`;
        const button = pressButton('', () => setMany({'text-color': name, 'text-custom-color': ''}), {class: 'swatch'});
        button.append(el('span', {class: 'chip', style: {background: hexColor(TEXT_COLORS[name])}}), label);
        view(values => button.setAttribute('aria-pressed', String(!values['text-custom-color'] && values['text-color'] === name)));
        return button;
    });
    const customInput = el('input', {type: 'color', 'aria-label': 'Custom text color'});
    const hexOut = el('span', {class: 'hex-readout'});
    customInput.addEventListener('input', () => {
        const hex = customInput.value.toLowerCase();
        const rgb = parseHexColor(hex);
        const nearest = rgb ? nearestNamedColor(rgb) : model.values['text-color'];
        setMany({'text-custom-color': hex, 'text-color': nearest});
    });
    view(values => {
        const rgb = resolveTextColor(values['text-color'], values['text-custom-color'] ?? '');
        const hex = hexColor(rgb);
        customInput.value = hex;
        hexOut.textContent = values['text-custom-color'] ? hex.toUpperCase() : 'Custom';
    });
    return row('Text color', ...buttons, el('span', {class: 'color-custom-wrap'}, customInput, hexOut));
}

function buildBorderColorRow() {
    const autoBtn = pressButton('Auto contrast', () => set('text-border-color-mode', 'auto'));
    const customBtn = pressButton('Custom', () => set('text-border-color-mode', 'custom'));
    const picker = el('input', {type: 'color', 'aria-label': 'Custom border color'});
    const hexOut = el('span', {class: 'hex-readout'});
    picker.addEventListener('input', () => setMany({'text-border-color-mode': 'custom', 'text-border-color': picker.value.toLowerCase()}));
    const pickerWrap = el('span', {class: 'color-custom-wrap'}, picker, hexOut);
    view(values => {
        const custom = values['text-border-color-mode'] === 'custom';
        autoBtn.setAttribute('aria-pressed', String(!custom));
        customBtn.setAttribute('aria-pressed', String(custom));
        picker.value = values['text-border-color'].toLowerCase();
        hexOut.textContent = values['text-border-color'].toUpperCase();
        pickerWrap.hidden = !custom;
    });
    return whenVisible(row('Border color', autoBtn, customBtn, pickerWrap), values => values['text-border'] !== 'none');
}

function buildBackdropColorRow() {
    const swatches = BACKDROP_SWATCHES.map(([hex, label]) => {
        const btn = pressButton('', () => set('text-backdrop-color', hex), {class: 'swatch'});
        btn.append(el('span', {class: 'chip', style: {background: hex}}), label);
        view(values => btn.setAttribute('aria-pressed', String(values['text-backdrop-color'].toLowerCase() === hex)));
        return btn;
    });
    const picker = el('input', {type: 'color', 'aria-label': 'Custom backdrop color'});
    picker.addEventListener('input', () => set('text-backdrop-color', picker.value.toLowerCase()));
    view(values => {
        picker.value = values['text-backdrop-color'].toLowerCase();
    });
    return whenVisible(row('Backdrop color', ...swatches, picker), values => values['text-backdrop'] !== 'none');
}

function buildMaxLinesRow() {
    const options = [[0, 'Auto'], [1, '1 line'], [2, '2 lines'], [3, '3 lines'], [4, '4 lines']];
    const buttons = options.map(([count, label]) => {
        const btn = pressButton(label, () => set('text-max-lines', count));
        view(values => btn.setAttribute('aria-pressed', String(values['text-max-lines'] === count)));
        return btn;
    });
    return row('Max lines', ...buttons);
}

function buildLyricStyleTab() {
    const fontSizeSlider = whenVisible(
        sliderRow('font-size', 'Target size', {
            ticks: [16, 24, 32, 48, 64, 96, 128, 256],
            format: unit('px'),
            log: true,
        }),
        values => values['text-fit-mode'] !== 'fill',
    );
    const fillHint = whenVisible(
        row('Text size', el('span', {class: 'note'}, 'Auto-fills the box up to 256 px. Resize the box to scale text.')),
        values => values['text-fit-mode'] === 'fill',
    );

    const typographyCard = card('Typography', null,
        ...buildFontControl(),
        buildWeightRow(),
        row('Style',
            (() => {
                const btn = pressButton('Italic', () => set('font-italic', !model.values['font-italic']));
                view(v => btn.setAttribute('aria-pressed', String(v['font-italic'])));
                return btn;
            })(),
            (() => {
                const btn = pressButton('UPPERCASE', () => set('text-uppercase', !model.values['text-uppercase']));
                view(v => btn.setAttribute('aria-pressed', String(v['text-uppercase'])));
                return btn;
            })()),
        sliderRow('text-letter-spacing', 'Letter spacing', {
            ticks: [-2, 0, 2, 4, 8, 12],
            format: (v, s) => s ? `${v}` : `${v > 0 ? '+' : ''}${v.toFixed(1)} px`,
            stepBy: 0.5,
        }),
    );

    const sizingCard = card('Size, fit & alignment', null,
        choiceRow('text-fit-mode', 'Sizing mode', {shrink: 'Target size (shrink if long)', fill: 'Fill the box'}),
        fontSizeSlider,
        fillHint,
        buildMaxLinesRow(),
        choiceRow('text-align', 'Horizontal', {left: 'Left', center: 'Center', right: 'Right'}),
        choiceRow('text-valign', 'Vertical', {top: 'Top', center: 'Middle', bottom: 'Bottom'}),
        choiceRow('transition', 'Transition', {
            'instant': 'Instant',
            'fade-in': 'Fade 0.15 s',
            'crossfade-quick': 'Quick 0.12 s',
            'crossfade-soft': 'Soft 0.25 s',
        }),
    );

    const colorCard = card('Color, outline & shadow', null,
        buildTextColorRow(),
        sliderRow('text-opacity', 'Text opacity', {ticks: [0.2, 0.4, 0.6, 0.8, 1], format: percent, stepBy: 0.05}),
        choiceRow('text-border', 'Border', {none: 'None', single: 'Single', double: 'Double'}),
        whenVisible(sliderRow('text-border-scale', 'Border thickness', {
            ticks: [0.25, 0.5, 1, 2, 4],
            format: (value, short) => `${short ? value : value.toFixed(2)}\u00d7`,
            log: true,
        }), values => values['text-border'] !== 'none'),
        buildBorderColorRow(),
        sliderRow('text-shadow', 'Drop shadow', {ticks: [0, 0.25, 0.5, 0.75, 1], format: percent, stepBy: 0.05}),
    );

    const backdropCard = card('Backdrop plate', null,
        choiceRow('text-backdrop', 'Style', {none: 'None', pill: 'Text pill', box: 'Full box'}),
        buildBackdropColorRow(),
        whenVisible(sliderRow('text-backdrop-opacity', 'Opacity', {
            ticks: [0, 0.25, 0.5, 0.75, 1], format: percent, stepBy: 0.05,
        }), values => values['text-backdrop'] !== 'none'),
        whenVisible(sliderRow('text-backdrop-radius', 'Corner radius', {
            ticks: [0, 8, 16, 24, 32, 40], format: unit('px'), integer: true, stepBy: 2,
        }), values => values['text-backdrop'] !== 'none'),
        whenVisible(sliderRow('text-backdrop-padding', 'Padding', {
            ticks: [4, 12, 20, 32, 48], format: unit('px'), integer: true, stepBy: 2,
        }), values => values['text-backdrop'] !== 'none'),
    );

    return el('div', {class: 'tab-panel'}, buildStylePresetsCard(), typographyCard, sizingCard, colorCard, backdropCard);
}

// ----- Tab 2: Box & Position

function boxSlidersFor(key, monitorKey, title) {
    const posX = v => {
        const b = v[key];
        const span = Math.max(0.0001, 1 - b.width);
        return Math.min(1, Math.max(0, (b.cx - b.width / 2) / span));
    };
    const posY = v => {
        const b = v[key];
        const span = Math.max(0.0001, 1 - b.height);
        return Math.min(1, Math.max(0, (b.cy - b.height / 2) / span));
    };
    const setPos = (axis, frac) => {
        const b = model.values[key];
        if (axis === 'x')
            set(key, clampGeometry({...b, cx: b.width / 2 + frac * (1 - b.width)}));
        else
            set(key, clampGeometry({...b, cy: b.height / 2 + frac * (1 - b.height)}));
    };
    const setSize = (axis, frac) => {
        const b = model.values[key];
        if (axis === 'w')
            set(key, clampGeometry({...b, width: Math.min(1, Math.max(MIN_GEOMETRY_WIDTH, frac))}));
        else
            set(key, clampGeometry({...b, height: Math.min(1, Math.max(MIN_GEOMETRY_HEIGHT, frac))}));
    };

    const pxFormat = (axis, short) => (value, isTick) => {
        if (isTick)
            return `${Math.round(value * 100)}`;
        const mon = activeMonitor(monitorKey);
        const px = Math.round(value * (axis === 'w' ? mon.width : mon.height));
        return `${Math.round(value * 100)}% (${px} px)`;
    };

    const posFormat = axis => (value, isTick) => {
        if (isTick)
            return `${Math.round(value * 100)}`;
        const mon = activeMonitor(monitorKey);
        const b = model.values[key];
        const px = axis === 'x'
            ? Math.round((b.cx - b.width / 2) * mon.width)
            : Math.round((b.cy - b.height / 2) * mon.height);
        return `${Math.round(value * 100)}% (${axis.toUpperCase()} ${px} px)`;
    };

    const actions = [
        pressButton('Center X', () => set(key, clampGeometry({...model.values[key], cx: 0.5})), {class: 'compact'}),
        pressButton('Center Y', () => set(key, clampGeometry({...model.values[key], cy: 0.5})), {class: 'compact'}),
        ...(key === 'box' ? [pressButton('Fit height to text', fitBoxHeightToText, {class: 'compact action-accent'})] : []),
        pressButton('Reset', () => post('/api/settings/reset', {keys: [key, monitorKey]}), {class: 'compact'}),
    ];

    return card(title, null,
        virtualSliderRow(key, 'Horizontal position', {
            min: 0, max: 1, ticks: [0, 0.25, 0.5, 0.75, 1],
            format: posFormat('x'),
            get: posX, setValue: v => setPos('x', v), stepBy: 0.02,
        }),
        virtualSliderRow(key, 'Vertical position', {
            min: 0, max: 1, ticks: [0, 0.25, 0.5, 0.75, 1],
            format: posFormat('y'),
            get: posY, setValue: v => setPos('y', v), stepBy: 0.02,
        }),
        virtualSliderRow(key, 'Width', {
            min: 0.05, max: 1, ticks: [0.05, 0.25, 0.5, 0.75, 1],
            format: pxFormat('w'),
            get: v => v[key].width, setValue: v => setSize('w', v), stepBy: 0.02,
        }),
        virtualSliderRow(key, 'Height', {
            min: 0.02, max: 1, ticks: [0.02, 0.25, 0.5, 0.75, 1],
            format: pxFormat('h'),
            get: v => v[key].height, setValue: v => setSize('h', v), stepBy: 0.01,
        }),
        row('Quick actions', ...actions),
    );
}

function buildLayoutTab() {
    const adjustCard = card('Interactive desktop adjust & mouse controls', null,
        switchRow('overlay-adjust-mode', 'Adjust box on desktop'),
        row('About adjust mode', el('span', {class: 'note'},
            'Shows the lyric box on your desktop with 8 edge/corner resize handles, magnetic center snap, scroll-to-size, and a sample line even when no song plays.')),
        el('table', {class: 'help-table'},
            el('tbody', {},
                el('tr', {}, el('th', {}, el('kbd', {}, 'Adjust mode')), el('td', {}, 'Drag anywhere to move; drag any of 8 edges or corners to resize; scroll for text size; Shift disables snap; Esc finishes.')),
                el('tr', {}, el('th', {}, el('kbd', {}, 'Ctrl'), ' + drag lyric'), el('td', {}, 'Move the lyric box anytime during playback.')),
                el('tr', {}, el('th', {}, el('kbd', {}, 'Alt'), ' + drag lyric'), el('td', {}, 'Resize the lyric box freely about its center anytime.')),
                el('tr', {}, el('th', {}, el('kbd', {}, 'Ctrl'), ' + scroll lyric'), el('td', {}, 'Scale text size up or down smoothly.')),
                el('tr', {}, el('th', {}, 'Click lyric'), el('td', {}, 'Jump to the playing YouTube tab and raise Firefox.')),
                el('tr', {}, el('th', {}, 'Right-click'), el('td', {}, 'Open this settings page from the lyric, pitch panel or tray icon.')),
                el('tr', {}, el('th', {}, 'Click tray icon'), el('td', {}, 'Toggle the lyrics overlay on or off.')),
                el('tr', {}, el('th', {}, 'Drag pitch panel'), el('td', {}, 'Drag edges to resize; drag body near the lyric to dock, or pull away to separate.')),
            ),
        ),
    );
    const pitchBoxCard = whenVisible(
        boxSlidersFor('pitch-box', 'pitch-box-monitor', 'Separate pitch panel geometry'),
        v => v['pitch-enabled'] && v['pitch-dock'] === 'separate',
    );
    return el('div', {class: 'tab-panel'}, boxSlidersFor('box', 'box-monitor', 'Lyric box geometry'), adjustCard, pitchBoxCard);
}

// ----- Tab 3: Pitch Panel

function lineColorRow() {
    const buttons = LINE_COLORS.map(([hex, label]) => {
        const button = pressButton('', () => set('pitch-line-color', hex), {class: 'swatch'});
        button.append(el('span', {class: 'chip', style: {background: hex}}), label);
        view(values => button.setAttribute('aria-pressed', String(values['pitch-line-color'].toLowerCase() === hex)));
        return button;
    });
    const custom = el('input', {type: 'color', 'aria-label': 'Any color'});
    custom.addEventListener('input', () => set('pitch-line-color', custom.value));
    view(values => {
        custom.value = values['pitch-line-color'].toLowerCase();
    });
    return row('Line color', ...buttons, custom);
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
    return whenVisible(row('Scale root', ...buttons), values => values['pitch-scale'] === 'fixed');
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
    const pitchCanvas = el('canvas', {'aria-label': 'Live pitch panel preview'});
    model.pitchPreview = new PitchPreviewCanvas(pitchCanvas);
    const previewCard = card('Pitch panel preview',
        (() => {
            const btn = pressButton('', () => set('pitch-enabled', !model.values['pitch-enabled']), {class: 'switch'});
            view(v => {
                btn.setAttribute('aria-pressed', String(v['pitch-enabled']));
                btn.textContent = v['pitch-enabled'] ? 'Pitch: On' : 'Pitch: Off';
            });
            return btn;
        })(),
        el('div', {class: 'pitch-preview-frame'}, pitchCanvas),
    );
    previewCard.classList.add('full-span');

    const placementCard = card('Placement & size', null,
        choiceRow('pitch-dock', 'Placement', {below: 'Below', above: 'Above', left: 'Left', right: 'Right', separate: 'Separate'}),
        whenVisible(sliderRow('pitch-docked-height', 'Docked height', {
            ticks: [0.03, 0.15, 0.3, 0.45, 0.6], format: percent, stepBy: 0.02,
        }), v => v['pitch-dock'] === 'below' || v['pitch-dock'] === 'above'),
        whenVisible(sliderRow('pitch-docked-width', 'Docked width', {
            ticks: [0.05, 0.18, 0.32, 0.46, 0.6], format: percent, stepBy: 0.02,
        }), v => v['pitch-dock'] === 'left' || v['pitch-dock'] === 'right'),
        whenVisible(row('Separate box',
            el('span', {class: 'note'}, 'Drag and resize directly on the Screen placement map above.'),
            pressButton('Reset position and size', () => post('/api/settings/reset', {keys: ['pitch-box', 'pitch-box-monitor']}), {class: 'compact'}),
        ), v => v['pitch-dock'] === 'separate'),
    );

    const rangeCard = card('Note range & timing', null,
        choiceRow('pitch-range', 'Notes shown', {fixed: 'Fixed range', follow: 'Follow my voice'}),
        whenVisible(noteRow('pitch-range-top', 'Highest note'), v => v['pitch-range'] === 'fixed'),
        whenVisible(noteRow('pitch-range-bottom', 'Lowest note'), v => v['pitch-range'] === 'fixed'),
        whenVisible(row('Auto-fit', pressButton('Fit to my last 30 s of singing', () => post('/api/pitch/fit', {}))), v => v['pitch-range'] === 'fixed'),
        whenVisible(sliderRow('pitch-follow-span', 'Voice span', {
            ticks: [6, 12, 18, 24, 36], format: unit('semitones'), integer: true, stepBy: 1,
        }), v => v['pitch-range'] === 'follow'),
        sliderRow('pitch-window-seconds', 'Time across', {ticks: [2, 5, 10, 20, 45, 120], format: unit('s', 1), log: true}),
        switchRow('pitch-time-in-silence', 'Scroll through silences'),
        sliderRow('pitch-rate', 'Analyses per second', {ticks: [10, 25, 50, 75, 100], format: unit('per s'), integer: true, stepBy: 5}),
    );

    const scaleTypes = Object.fromEntries(Object.entries(SCALES).map(([type, scale]) => [type, scale.name[0].toUpperCase() + scale.name.slice(1)]));
    const lookCard = card('Trace, grid & readout', null,
        sliderRow('pitch-line-width', 'Line thickness', {ticks: [0.5, 1, 2, 4, 8, 12], format: unit('px', 1), log: true}),
        lineColorRow(),
        sliderRow('pitch-background-opacity', 'Background', {ticks: [0, 0.25, 0.5, 0.75, 1], format: percent, stepBy: 0.05}),
        choiceRow('pitch-labels', 'Note names', {all: 'Every line', scale: 'Scale notes', c: 'C only', none: 'None'}),
        whenVisible(sliderRow('pitch-label-size', 'Note name size', {
            ticks: [8, 12, 16, 24, 32], format: unit('px'), stepBy: 1,
        }), v => v['pitch-labels'] !== 'none'),
        choiceRow('pitch-readout', 'Current note', {
            'right': 'Right col', 'left': 'Left col', 'top-right': 'Top right',
            'top-left': 'Top left', 'bottom-right': 'Bottom right', 'bottom-left': 'Bottom left', 'off': 'Hidden',
        }),
        whenVisible(sliderRow('pitch-readout-size', 'Note readout size', {
            ticks: [0.15, 0.35, 0.55, 0.75, 1], format: percent, stepBy: 0.05,
        }), v => v['pitch-readout'] !== 'off'),
        whenVisible(switchRow('pitch-readout-cents', 'Show cents'), v => v['pitch-readout'] !== 'off'),
    );

    const scaleMicCard = card('Scale & microphone', null,
        choiceRow('pitch-scale', 'Scale', {detect: 'Detect from song', fixed: 'Fixed', none: 'None'}),
        rootRow(),
        whenVisible(choiceRow('pitch-scale-type', 'Scale type', scaleTypes), v => v['pitch-scale'] === 'fixed'),
        whenVisible(switchRow('pitch-show-key', 'Name the scale'), v => v['pitch-scale'] !== 'none'),
        ...microphoneRows(),
    );

    return el('div', {class: 'tab-panel'}, previewCard, placementCard, rangeCard, lookCard, scaleMicCard);
}

// ----- Tab 4: Song & Lyrics

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
    const wrong = pressButton('Wrong lyrics: hide this set', () => command({op: 'reject'}));
    const again = pressButton('Search again', () => command({op: 'searchAgain'}));
    const lookUp = pressButton('Look up lyrics for this video', () => command({op: 'lookUp'}));
    const timingButtons = [
        pressButton('Too fast (\u22120.5 s)', () => command({op: 'tooFast'})),
        pressButton('Too slow (+0.5 s)', () => command({op: 'tooSlow'})),
        pressButton('Reset', () => command({op: 'resetOffset'})),
    ];

    model.stateViews.push((state, addon) => {
        addonVersion.textContent = ADDON_TEXT[addon.status](addon);
        install.textContent = `Install ${addon.current}`;
        install.hidden = addon.status !== 'unnamed' && addon.status !== 'older';
        updateService.hidden = addon.status !== 'newer';
        playing.textContent = state.active ? state.identityText || state.videoId : 'Nothing on YouTube';
        lyrics.textContent = LYRICS_STATUS_TEXT[state.lyrics];
        timing.textContent = `${state.offsetSeconds > 0 ? '+' : ''}${state.offsetSeconds.toFixed(1)} s`;
        for (const button of timingButtons)
            button.disabled = !state.active;
        wrong.disabled = !state.chosen;
        again.disabled = !state.active;
        lookUp.disabled = !state.active;
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
            const tags = [
                el('span', {class: candidate.timed ? 'pill pill-good' : 'pill pill-warn'}, candidate.timed ? 'Timed' : 'Untimed'),
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

    const songCard = card('Active song & timing', null,
        row('Playing', playing),
        row('Lyrics', lyrics),
        row('Timing offset', timing, ...timingButtons),
        row('Actions', wrong, again, lookUp),
        row('Microphone', microphone),
        row('Detected scale', heardKey),
        row('Firefox add-on', addonVersion, install, updateService),
    );
    songCard.classList.add('full-span');

    const setsCard = card('Lyric sets', setsCount, emptySets, sets);
    setsCard.classList.add('full-span');

    return el('div', {class: 'tab-panel single-col'}, songCard, setsCard);
}

// ----- Tabs & page lifecycle

function buildWorkspace() {
    const panels = {
        lyric: buildLyricStyleTab(),
        layout: buildLayoutTab(),
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
        // Re-render pitch canvas cleanly once visible
        if (id === 'pitch' && model.pitchPreview)
            requestAnimationFrame(() => model.pitchPreview.render(model.values, model.state?.key ?? null));
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
    if (model.values['overlay-preview-text'])
        model.customSample = model.values['overlay-preview-text'];
    buildTopBar();
    buildStudio();
    buildWorkspace();
    render();
    pollState();
    setInterval(() => {
        pollSettings();
        pollState();
    }, POLL_MS);
}

start().catch(error => showBanner(`The settings page could not start: ${error.message}`));
