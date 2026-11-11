// The settings page (http://lyrics.localhost:8792/settings): every look and
// pitch setting, applied while a control moves, and the playing song's
// lyric controls. The service stores settings where the shell extension
// reads them, so the lyric and the pitch panel change as you adjust them.
// The page asks the service every POLL_MS for changes made on the desktop
// (dragging the lyric, Ctrl+scroll) and for the song's state.

import {LYRICS_STATUS_TEXT} from '/shared/lyrics-status.js';
import {keyName, noteLabel, pitchClassNames, SCALES} from '/shared/scales.js';
import {hexColor, TEXT_COLORS} from '/shared/text-ink.js';

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

const model = {
    schema: null,
    values: null,
    // Written but not yet answered: polls do not overwrite these.
    pending: new Map(),
    sending: false,
    // Keys whose slider is held: polls do not move it under the pointer.
    held: new Set(),
    views: [],
    stateViews: [],
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
    document.getElementById('banner').textContent = text;
}

function render() {
    for (const view of model.views)
        view(model.values);
}

function absorb(values) {
    for (const [key, value] of Object.entries(values)) {
        if (!model.pending.has(key) && !model.held.has(key))
            model.values[key] = value;
    }
    render();
}

function set(key, value) {
    model.values[key] = value;
    model.pending.set(key, value);
    render();
    flush();
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
        const {state, addon} = await call('GET', '/api/state');
        for (const view of model.stateViews)
            view(state, addon);
    } catch {
        showBanner('The lyrics service is not running.');
    }
}

// ----- building blocks

function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(props)) {
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

function section(title, ...rows) {
    return el('section', {}, el('h2', {}, title), ...rows.flat());
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
 * A slider with its value, notches and numbered ends. Positions run
 * 0..SLIDER_STEPS along the track, linear or logarithmic in the value.
 * @param {{ticks: number[], format: (value: number, short: boolean) => string, log?: boolean, integer?: boolean}} options
 */
function sliderRow(key, label, {ticks, format, log = false, integer = false}) {
    const {min, max} = model.schema[key];
    if (ticks[0] !== min || ticks[ticks.length - 1] !== max)
        throw new Error(`the ${key} slider must label both ends, ${min} and ${max}`);
    const fraction = value => log ? Math.log(value / min) / Math.log(max / min) : (value - min) / (max - min);
    const valueAt = position => {
        const f = position / SLIDER_STEPS;
        const value = log ? min * (max / min) ** f : min + (max - min) * f;
        return integer ? Math.round(value) : value;
    };
    const input = el('input', {type: 'range', min: '0', max: String(SLIDER_STEPS), step: '1', 'aria-label': label});
    const shown = el('span', {class: 'value'});
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
    return row(label, el('div', {class: 'slider'}, shown, el('div', {class: 'track'}, input, notches)));
}

const percent = (value, short) => `${Math.round(value * 100)}${short ? '' : '%'}`;
const unit = (suffix, digits = 0) => (value, short) => short ? `${value}` : `${value.toFixed(digits)} ${suffix}`;

// ----- song

function songRows() {
    const playing = el('span', {class: 'value'});
    const lyrics = el('span', {class: 'value'});
    const timing = el('span', {class: 'value'});
    const microphone = el('span', {class: 'value'});
    const heardKey = el('span', {class: 'value'});
    const addonVersion = el('span', {class: 'value'});
    const install = el('a', {class: 'button', href: ADDON_DOWNLOAD});
    const updateService = el('span', {class: 'note'}, 'Update the service: ', el('kbd', {}, 'git pull && scripts/install.sh'));
    const sets = el('div', {class: 'list short', role: 'listbox', 'aria-label': 'Lyric sets'});
    const command = body => post('/api/command', body);
    const wrong = pressButton('Wrong lyrics: hide this set', () => command({op: 'reject'}));
    const again = pressButton('Search again', () => command({op: 'searchAgain'}));
    const lookUp = pressButton('Look up lyrics for this video', () => command({op: 'lookUp'}));
    const timingButtons = [
        pressButton('Too fast', () => command({op: 'tooFast'})),
        pressButton('Too slow', () => command({op: 'tooSlow'})),
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
        sets.replaceChildren(...state.candidates.map(candidate => {
            const notes = [candidate.timed ? 'timed' : 'untimed', candidate.matches ? '' : 'weak match', candidate.rejected ? 'marked wrong' : '']
                .filter(Boolean).join(', ');
            const button = pressButton(`${candidate.label} (${notes})`, () => command({op: 'choose', id: candidate.id}));
            button.setAttribute('aria-pressed', String(candidate.current));
            return button;
        }));
        sets.hidden = !state.candidates.length;
    });
    return [
        row('Playing', playing),
        row('Lyrics', lyrics),
        row('Timing', timing, ...timingButtons),
        row('Lyric sets', wrong, again, lookUp),
        el('div', {class: 'wide'}, sets),
        row('Microphone', microphone),
        row('Scale', heardKey),
        row('Firefox add-on', addonVersion, install, updateService),
    ];
}

// ----- lyric line

function fontRows() {
    const current = el('span', {class: 'value'});
    const search = el('input', {type: 'search', placeholder: 'Find a font by name', 'aria-label': 'Find a font by name'});
    const list = el('div', {class: 'list fonts', role: 'listbox', 'aria-label': 'Fonts'});
    let families = [];
    const mark = () => {
        for (const button of list.children)
            button.setAttribute('aria-pressed', String(button.dataset.family === model.values['font-family']));
    };
    const build = () => {
        const query = search.value.trim().toLowerCase();
        list.replaceChildren(...['', ...families]
            .filter(family => !query || (family || 'desktop font').toLowerCase().includes(query))
            .map(family => {
                const button = pressButton(family || 'Desktop font', () => set('font-family', family),
                    family ? {style: {fontFamily: cssFamily(family)}} : {});
                button.dataset.family = family;
                return button;
            }));
        mark();
    };
    search.addEventListener('input', build);
    view(values => {
        const family = values['font-family'];
        current.textContent = `${family || 'Desktop font'}${values['font-bold'] ? ', bold' : ''}`;
        current.style.fontFamily = family ? cssFamily(family) : '';
        mark();
    });
    call('GET', '/api/fonts').then(answer => {
        families = answer.families;
        build();
    }, error => showBanner(`Could not list the fonts: ${error.message}`));
    return [row('Font', current), el('div', {class: 'wide'}, search), el('div', {class: 'wide'}, list)];
}

function textColorRow() {
    const buttons = model.schema['text-color'].choices.map(name => {
        const label = `${name[0].toUpperCase()}${name.slice(1)}`;
        const button = pressButton('', () => set('text-color', name), {class: 'swatch'});
        button.append(el('span', {class: 'chip', style: {background: hexColor(TEXT_COLORS[name])}}), label);
        view(values => button.setAttribute('aria-pressed', String(values['text-color'] === name)));
        return button;
    });
    return row('Color', ...buttons);
}

// ----- pitch panel

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
    const steps = [[-12, '−oct'], [-1, '−'], [1, '+'], [12, '+oct']].map(([delta, text]) => {
        const button = pressButton(text, () => set(key, model.values[key] + delta), {class: 'big', 'aria-label': `${label} ${delta > 0 ? 'up' : 'down'} ${Math.abs(delta) === 12 ? 'an octave' : 'a semitone'}`});
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
        const button = pressButton('', () => set('pitch-scale-root', root));
        view(values => {
            button.textContent = pitchClassNames({root, type: values['pitch-scale-type']})[root];
            button.setAttribute('aria-pressed', String(values['pitch-scale-root'] === root));
        });
        return button;
    });
    return row('Fixed scale root', ...buttons);
}

// ----- microphone

function microphoneRows() {
    const list = el('div', {class: 'list short', role: 'listbox', 'aria-label': 'Microphones'});
    let found = {microphones: [], defaultName: ''};
    const build = () => {
        const chosen = model.values['pitch-microphone'];
        const describe = name => found.microphones.find(microphone => microphone.name === name)?.description;
        const options = [['', `System default${found.defaultName ? `: ${describe(found.defaultName) ?? found.defaultName}` : ''}`],
            ...found.microphones.map(microphone => [microphone.name, microphone.description])];
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
        build();
    }, error => showBanner(`Could not list the microphones: ${error.message}`));
    view(build);
    refresh();
    setInterval(refresh, MICROPHONE_POLL_MS);
    return [el('div', {class: 'wide'}, list)];
}

// ----- page

function build() {
    const scaleTypes = Object.fromEntries(Object.entries(SCALES).map(([type, scale]) => [type, scale.name[0].toUpperCase() + scale.name.slice(1)]));
    const sections = [
        section('Song', songRows()),
        section('Lyric line',
            switchRow('overlay-enabled', 'Show lyrics'),
            fontRows(),
            switchRow('font-bold', 'Bold'),
            sliderRow('font-size', 'Size', {ticks: [16, 24, 32, 48, 64, 96, 128, 192, 256], format: unit('px'), log: true}),
            textColorRow(),
            choiceRow('text-border', 'Border', {none: 'None', single: 'Single', double: 'Double'}),
            sliderRow('text-border-scale', 'Border thickness', {ticks: [0.25, 0.5, 1, 2, 4], format: (value, short) => `${short ? value : value.toFixed(2)}×`, log: true}),
            choiceRow('text-align', 'Alignment', {center: 'Centered', left: 'Left'}),
            choiceRow('transition', 'Transition', {'instant': 'Instant', 'fade-in': 'Fade in, 0.15 s', 'crossfade-quick': 'Crossfade, 0.12 s', 'crossfade-soft': 'Crossfade, 0.25 s'}),
            row('Position', pressButton('Reset position and size', () => post('/api/settings/reset', {keys: ['box', 'box-monitor']})))),
        section('Pitch panel',
            switchRow('pitch-enabled', 'Show the pitch panel'),
            choiceRow('pitch-dock', 'Placement', {below: 'Below the lyric', above: 'Above', left: 'Left', right: 'Right', separate: 'Separate'}),
            sliderRow('pitch-docked-height', 'Height above or below', {ticks: [0.03, 0.1, 0.2, 0.3, 0.45, 0.6], format: percent}),
            sliderRow('pitch-docked-width', 'Width left or right', {ticks: [0.05, 0.2, 0.3, 0.45, 0.6], format: percent}),
            row('Separate panel', pressButton('Reset its position and size', () => post('/api/settings/reset', {keys: ['pitch-box', 'pitch-box-monitor']}))),
            choiceRow('pitch-range', 'Notes shown', {fixed: 'Fixed range', follow: 'Follow my voice'}),
            noteRow('pitch-range-top', 'Highest note'),
            noteRow('pitch-range-bottom', 'Lowest note'),
            row('Fit', pressButton('Fit to my last 30 s of singing', () => post('/api/pitch/fit', {}))),
            sliderRow('pitch-follow-span', 'Semitones when following', {ticks: [6, 12, 18, 24, 36], format: unit('semitones'), integer: true}),
            sliderRow('pitch-window-seconds', 'Time across', {ticks: [2, 5, 10, 20, 30, 60, 120], format: unit('s', 1), log: true}),
            switchRow('pitch-time-in-silence', 'Scroll through silences'),
            sliderRow('pitch-line-width', 'Line thickness', {ticks: [0.5, 1, 2, 4, 8, 12], format: unit('px', 1), log: true}),
            lineColorRow(),
            sliderRow('pitch-background-opacity', 'Background', {ticks: [0, 0.25, 0.5, 0.75, 1], format: percent}),
            choiceRow('pitch-labels', 'Note names', {all: 'Every line', scale: 'Scale notes', c: 'C only', none: 'None'}),
            sliderRow('pitch-label-size', 'Note name size', {ticks: [8, 12, 16, 24, 32], format: unit('px')}),
            choiceRow('pitch-scale', 'Scale', {detect: 'Detect from the song', fixed: 'Fixed', none: 'None'}),
            rootRow(),
            choiceRow('pitch-scale-type', 'Fixed scale type', scaleTypes),
            switchRow('pitch-show-key', 'Name the scale'),
            choiceRow('pitch-readout', 'Current note', {'right': 'Right column', 'left': 'Left column', 'top-right': 'Top right',
                'top-left': 'Top left', 'bottom-right': 'Bottom right', 'bottom-left': 'Bottom left', 'off': 'Hidden'}),
            sliderRow('pitch-readout-size', 'Current note size', {ticks: [0.15, 0.25, 0.5, 0.75, 1], format: percent}),
            switchRow('pitch-readout-cents', 'Show cents'),
            sliderRow('pitch-rate', 'Analyses per second', {ticks: [10, 25, 50, 75, 100], format: unit('per s'), integer: true})),
        section('Microphone',
            microphoneRows(),
            switchRow('pitch-echo-cancel', 'Echo cancelling')),
        section('Mouse',
            el('ul', {class: 'help'},
                el('li', {}, 'Click the lyric to go to the song.'),
                el('li', {}, 'Right-click the lyric, the pitch panel or the panel icon for this page.'),
                el('li', {}, 'Click the panel icon to turn the overlay on or off.'),
                el('li', {}, el('kbd', {}, 'Ctrl'), '+drag the lyric to move it; ', el('kbd', {}, 'Alt'), '+drag to resize its box.'),
                el('li', {}, el('kbd', {}, 'Ctrl'), '+scroll on the lyric to size the text.'),
                el('li', {}, 'Drag the pitch panel’s edges to resize it. Drag a separate panel to move it; drop it against a side of the lyric to dock it there, and drag a docked one away to make it separate.'))),
    ];
    document.getElementById('sections').replaceChildren(...sections);
}

async function start() {
    const answer = await call('GET', '/api/settings');
    model.schema = answer.schema;
    model.values = answer.values;
    build();
    render();
    pollState();
    setInterval(() => {
        pollSettings();
        pollState();
    }, POLL_MS);
}

start().catch(error => showBanner(`The settings page could not start: ${error.message}`));
