// Stages the README's desktop picture in a hermetic headless GNOME Shell: a
// song's video in a window, with the current lyric line and, docked below
// it, the pitch panel tracing the tune being sung. The shell, service and
// extension are the real ones; the recording, the window and the singing
// are made up, and the words are public domain ("Amazing Grace", John
// Newton, 1779). The song's key is set rather than heard, since the
// harness has no sound. Run by scripts/update-readme-pictures.sh; the
// picture is build/e2e-artifacts/readme-desktop.png.
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

const SAKURA_VIDEO = 'sakurasakura1';
const SAKURA_TITLE = 'Sakura Sakura';
const SAKURA_ARTIST = 'Traditional Ensemble';
const SAKURA_LINE = '\u685c \u5f25\u751f\u306e\u7a7a\u306f \u898b\u6e21\u3059\u9650\u308a';
const SAKURA_LRC = [
    `[00:05.00] ${SAKURA_LINE}`,
    '[00:18.00] \u971e\u304b\u96f2\u304b \u671d\u65e5\u306b\u5302\u3046',
    '[00:31.00] \u685c \u685c \u82b1\u3056\u304b\u308a',
    '[00:44.00] \u3044\u3056\u3084 \u3044\u3056\u3084 \u898b\u306b\u3086\u304b\u3093',
].join('\n');

const ANSWERS = {
    [`${ARTIST}|${TITLE}`]: [{id: 1, trackName: TITLE, artistName: ARTIST, albumName: 'Live at the Chapel', duration: 222,
        instrumental: false, plainLyrics: FIRST_LINE, syncedLyrics: LRC}],
    [`${SAKURA_ARTIST}|${SAKURA_TITLE}`]: [{id: 2, trackName: SAKURA_TITLE, artistName: SAKURA_ARTIST, albumName: 'Spring Folk Songs', duration: 168,
        instrumental: false, plainLyrics: SAKURA_LINE, syncedLyrics: SAKURA_LRC}],
};
const METADATA = {host: 'www.youtube.com', videoId: VIDEO, title: TITLE, author: `${ARTIST} - Topic`, lengthSeconds: 222,
    category: 'Music', musicVideoType: '', musicCards: [], mediaSession: null, ytmByline: '',
    description: `Provided to YouTube by Label\n\n${TITLE} · ${ARTIST}\n\nLive at the Chapel\n\n℗ 2026 Label`};
const SAKURA_METADATA = {host: 'www.youtube.com', videoId: SAKURA_VIDEO, title: SAKURA_TITLE, author: `${SAKURA_ARTIST} - Topic`, lengthSeconds: 168,
    category: 'Music', musicVideoType: '', musicCards: [], mediaSession: null, ytmByline: '',
    description: `Provided to YouTube by Label\n\n${SAKURA_TITLE} · ${SAKURA_ARTIST}\n\nSpring Folk Songs\n\n℗ 2026 Label`};

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

// Traditional Sakura Sakura melody (Miyako-bushi on A/E): A4-A4-B4, A4-B4-C5-B4-A4-B4-A4-F4-E4
const SAKURA_BEAT_MS = 460;
const SAKURA_TUNE = [
    {midi: 69, beats: 1}, // Sa-
    {midi: 69, beats: 1}, // ku-
    {midi: 71, beats: 2}, // ra
    {midi: 69, beats: 1}, // Ya-
    {midi: 71, beats: 1}, // yo-
    {midi: 72, beats: 1}, // i
    {midi: 71, beats: 1}, // no
    {midi: 69, beats: 1}, // so-
    {midi: 71, beats: 0.5}, // ra
    {midi: 69, beats: 0.5, slurred: true},
    {midi: 65, beats: 1.5}, // wa
    {midi: 64, beats: 2.5}, // (sustained E4)
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

/** Pitch samples as a voice sings `tune`: scoops into notes, vibrato on long ones. */
function sungSamples(tune = TUNE, beatMs = BEAT_MS, seed = 7) {
    const jitter = random(seed);
    const samples = [];
    let start = 0;
    let previous = null;
    for (const note of tune) {
        const length = note.beats * beatMs;
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
    for (const [key, value] of [['overlay-enabled', 'true'], ['pitch-enabled', 'true'], ['pitch-scale', "'fixed'"],
        ['pitch-scale-root', '7'], ['pitch-scale-type', "'major'"]])
        await h.gsettings.set(key, value);
    for (const [key, value] of [['picture-options', 'none'], ['color-shading-type', 'vertical'],
        ['primary-color', '#1b2440'], ['secondary-color', '#4a2346']])
        await h.gsettings.setDesktop('org.gnome.desktop.background', key, value);
    await h.openWindow(TITLE, path.join(HERE, 'video-window.js'));
    const firstPlay = await h.play({tabId: 4, heartbeatMs: 5000, metadata: METADATA, next: null,
        media: {videoId: VIDEO, currentTime: 9, duration: 222, paused: false, ended: false, stalled: false,
            playbackRate: 1, muted: false, volume: 1, adShowing: false}});
    await h.waitFor(async () => (await h.evalJs(`(() => {
        const {_overlay: overlay, _pitchPanel: panel} = ${EXTENSION}.stateObj;
        return overlay._root.visible && panel._frame.visible && overlay._layers[overlay._current].text;
    })()`)) === FIRST_LINE, 'the first line with the pitch panel');
    await h.evalJs(`(() => {
        const top = ${EXTENSION}.stateObj._overlay._root.y;
        const window = global.display.list_all_windows().find(window => window.get_title() === ${JSON.stringify(TITLE)});
        window.move_resize_frame(false, ${(MONITOR.width - WINDOW_WIDTH) / 2}, 56, ${WINDOW_WIDTH}, top - 30 - 56);
        return true;
    })()`);

    // Sustaining "sound": the panel's last six seconds hold the line's tune.
    const batches = frameBatches(sungSamples(), 6700, 1_000_000);
    await h.evalJs(`(() => {
        for (const frames of ${JSON.stringify(batches)})
            ${EXTENSION}.stateObj._pitchPanel.pushFrames(frames);
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

    // Second desktop picture: singing along while working in other apps
    // (a bright light-mode notes window + a dark code editor, with YouTube
    // hidden on another workspace), showing offline Japanese furigana and a
    // 4-ring pink telop border crisp across both bright and dark windows.
    firstPlay.stop();
    await h.evalJs(`(() => {
        const win = global.display.list_all_windows().find(w => w.get_title() === ${JSON.stringify(TITLE)});
        if (win) win.delete(global.get_current_time());
        ${EXTENSION}.stateObj._pitchPanel._view.clear();
        return true;
    })()`);
    await sleep(250);

    for (const [key, value] of [['primary-color', '#1a273a'], ['secondary-color', '#263a52']])
        await h.gsettings.setDesktop('org.gnome.desktop.background', key, value);
    for (const [key, value] of [
        ['font-size', '58'],
        ['text-color', "'pink'"],
        ['text-border', "'quad'"],
        ['text-furigana', 'true'],
        ['pitch-scale', "'fixed'"],
        ['pitch-scale-root', '9'],
        ['pitch-scale-type', "'minor'"],
        ['pitch-range-bottom', '57'],
        ['pitch-range-top', '76'],
        ['pitch-line-color', "'#5eead4'"],
        ['pitch-background-opacity', '0.82'],
    ])
        await h.gsettings.set(key, value);

    const NOTES_TITLE = 'Notes';
    const CODE_TITLE = 'melody.py — Code';
    await h.openWindow(NOTES_TITLE, path.join(HERE, 'workspace-notes.js'));
    await h.openWindow(CODE_TITLE, path.join(HERE, 'workspace-code.js'));
    await h.evalJs(`(() => {
        const notes = global.display.list_all_windows().find(w => w.get_title() === ${JSON.stringify(NOTES_TITLE)});
        const code = global.display.list_all_windows().find(w => w.get_title() === ${JSON.stringify(CODE_TITLE)});
        notes.move_resize_frame(false, 36, 50, 758, 822);
        code.move_resize_frame(false, 806, 50, 758, 822);
        return true;
    })()`);

    const secondPlay = await h.play({tabId: 5, heartbeatMs: 5000, metadata: SAKURA_METADATA, next: null,
        media: {videoId: SAKURA_VIDEO, currentTime: 7, duration: 168, paused: false, ended: false, stalled: false,
            playbackRate: 1, muted: false, volume: 1, adShowing: false}});
    await h.waitFor(async () => (await h.evalJs(`(() => {
        const {_overlay: overlay, _pitchPanel: panel} = ${EXTENSION}.stateObj;
        return overlay._root.visible && panel._frame.visible &&
            overlay._line?.text === ${JSON.stringify(SAKURA_LINE)} &&
            Array.isArray(overlay._line?.ruby) && overlay._line.ruby.length > 0;
    })()`)), 'Sakura Sakura line with offline furigana');

    const sakuraBatches = frameBatches(sungSamples(SAKURA_TUNE, SAKURA_BEAT_MS, 19), 6300, 2_000_000);
    await h.evalJs(`(() => {
        ${EXTENSION}.stateObj._pitchPanel._view.clear();
        for (const frames of ${JSON.stringify(sakuraBatches)})
            ${EXTENSION}.stateObj._pitchPanel.pushFrames(frames);
        return true;
    })()`);
    await h.evalJs("Main.panel.statusArea.dateMenu._clockDisplay.text = 'Fri  8:18 PM'; true");
    await sleep(1000);
    await h.screenshot('readme-workspace');
    secondPlay.stop();
} finally {
    await h.close();
}
