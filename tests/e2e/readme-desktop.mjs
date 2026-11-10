// Stages the README's desktop picture in a hermetic headless GNOME Shell: a
// song's video in a maximized window, with the current lyric line and the
// pitch trace of the tune being sung at the bottom of the screen. The shell,
// service and extension are the real ones; the recording, the window and
// the singing are made up, and the words are public domain ("Amazing
// Grace", John Newton, 1779). Run by scripts/update-readme-pictures.sh;
// the picture is build/e2e-artifacts/readme-desktop.png.
//
//   node tests/e2e/readme-desktop.mjs
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {MONITOR, sleep, startHarness} from './shell-harness.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXTENSION = `Main.extensionManager.lookup('lyrics-overlay@ernop')`;
const VIDEO = 'chapelgrace';
const TITLE = 'Amazing Grace';
const ARTIST = 'The Chapel Sessions';
const FIRST_LINE = 'Amazing grace, how sweet the sound';
const LRC = [
    `[00:08.00] ${FIRST_LINE}`,
    '[00:20.00] That saved a wretch like me',
    '[00:32.00] I once was lost, but now am found',
    '[00:44.00] Was blind, but now I see',
].join('\n');
const ANSWERS = {
    [`${ARTIST}|${TITLE}`]: [{id: 1, trackName: TITLE, artistName: ARTIST, albumName: 'Live at the Chapel', duration: 222,
        instrumental: false, plainLyrics: FIRST_LINE, syncedLyrics: LRC}],
};
const METADATA = {host: 'www.youtube.com', videoId: VIDEO, title: TITLE, author: `${ARTIST} - Topic`, lengthSeconds: 222,
    category: 'Music', musicVideoType: '', musicCards: [], mediaSession: null, ytmByline: '',
    description: `Provided to YouTube by Label\n\n${TITLE} · ${ARTIST}\n\nLive at the Chapel\n\n℗ 2026 Label`};

// The first line's tune (New Britain, in G from D4), one entry per sung
// pitch; a slurred pitch continues its syllable without a break.
const BEAT_MS = 600;
const TUNE = [
    {midi: 62, beats: 1}, // A-
    {midi: 67, beats: 2}, // -ma-
    {midi: 71, beats: 0.5}, // -zing
    {midi: 67, beats: 0.5, slurred: true},
    {midi: 71, beats: 2}, // grace,
    {midi: 69, beats: 1}, // how
    {midi: 67, beats: 2}, // sweet
    {midi: 64, beats: 1}, // the
    {midi: 62, beats: 2}, // sound
];
const SAMPLE_MS = 20;
const CONSONANT_MS = 60;
const WINDOW_WIDTH = 1240;

/** A fixed pseudo-random sequence, so the picture is the same on every run. */
function random(seed) {
    let state = seed;
    return () => {
        state = (state * 1103515245 + 12345) % 2147483648;
        return state / 2147483648;
    };
}

/** Pitch samples as a voice sings the tune: scoops into notes, vibrato on long ones. */
function sungSamples() {
    const jitter = random(7);
    const samples = [];
    let start = 0;
    let previous = null;
    for (const note of TUNE) {
        const length = note.beats * BEAT_MS;
        const voicedFrom = note.slurred ? 0 : CONSONANT_MS;
        for (let t = voicedFrom; t < length; t += SAMPLE_MS) {
            const approach = note.slurred
                ? (previous - note.midi) * Math.exp(-t / 35)
                : -0.4 * Math.exp(-t / 45);
            const vibratoDepth = 0.22 * Math.min(1, Math.max(0, (t - 300) / 200));
            const vibrato = vibratoDepth * Math.sin(2 * Math.PI * 5.6 * t / 1000);
            const drift = 0.05 * Math.sin(2 * Math.PI * (start + t) / 900) + 0.03 * (jitter() - 0.5);
            samples.push({t: start + t, midi: note.midi + approach + vibrato + drift});
        }
        start += length;
        previous = note.midi;
    }
    return samples;
}

/** The samples in the batches the service sends, up to `nowMs` into the tune. */
function frameBatches(samples, nowMs, base) {
    const batches = [];
    for (let at = 100; at <= nowMs; at += 100) {
        batches.push({at: base + at, voiced: true,
            samples: samples.filter(sample => sample.t > at - 100 && sample.t <= at).map(sample => ({t: base + sample.t, midi: sample.midi}))});
    }
    return batches;
}

const h = await startHarness({answers: ANSWERS});
try {
    await h.evalJs('Main.overview.hide(); true');
    await h.waitFor(async () => !(await h.evalJs('Main.overview.visible')), 'the overview to close');
    await h.gsettings.set('overlay-enabled', 'true');
    await h.gsettings.set('pitch-enabled', 'true');
    for (const [key, value] of [['picture-options', 'none'], ['color-shading-type', 'vertical'],
        ['primary-color', '#1b2440'], ['secondary-color', '#4a2346']])
        await h.gsettings.setDesktop('org.gnome.desktop.background', key, value);
    await h.openWindow(TITLE, path.join(HERE, 'video-window.js'));
    await h.play({tabId: 4, heartbeatMs: 5000, metadata: METADATA, next: null,
        media: {videoId: VIDEO, currentTime: 9, duration: 222, paused: false, ended: false, stalled: false,
            playbackRate: 1, muted: false, volume: 1, adShowing: false}});
    await h.waitFor(async () => (await h.evalJs(`(() => {
        const overlay = ${EXTENSION}.stateObj._overlay;
        return overlay._root.visible && overlay._pitch.visible && overlay._layers[overlay._current].text;
    })()`)) === FIRST_LINE, 'the first line with the pitch strip');
    await h.evalJs(`(() => {
        const top = ${EXTENSION}.stateObj._overlay._root.y;
        const window = global.display.list_all_windows().find(window => window.get_title() === ${JSON.stringify(TITLE)});
        window.move_resize_frame(false, ${(MONITOR.width - WINDOW_WIDTH) / 2}, 56, ${WINDOW_WIDTH}, top - 30 - 56);
        return true;
    })()`);

    // Sustaining "sound": the strip's last six seconds hold the line's tune.
    const batches = frameBatches(sungSamples(), 6700, 1_000_000);
    await h.evalJs(`(() => {
        for (const frames of ${JSON.stringify(batches)})
            ${EXTENSION}.stateObj._overlay.pushPitch(frames);
        return true;
    })()`);
    // A fixed clock keeps the picture the same from run to run.
    await h.evalJs("Main.panel.statusArea.dateMenu._clockDisplay.text = 'Fri  8:15 PM'; true");
    // The harness drives the shell in unsafe mode, whose banner and padlock
    // icon a desktop never shows.
    await h.evalJs(`(() => {
        Main.messageTray.getSources().forEach(source => source.destroy());
        const icons = [];
        const find = actor => {
            if (actor.icon_name === 'channel-insecure-symbolic')
                icons.push(actor);
            actor.get_children().forEach(find);
        };
        find(Main.panel);
        if (icons.length !== 1)
            throw new Error('unsafe-mode icons in the top bar: ' + icons.length);
        icons[0].visible = false;
        return true;
    })()`);
    await sleep(1000);
    await h.screenshot('readme-desktop');
} finally {
    await h.close();
}
