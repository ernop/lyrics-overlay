import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {fileURLToPath, pathToFileURL} from 'node:url';

import {LyricsCore} from '../service/core.js';

const TOPIC = `Provided to YouTube by Label

Amazing Grace · Singer

Hymns

℗ 1999 Label`;

const LRC = [
    '[00:10.00] Amazing grace, how sweet the sound',
    '[00:16.00] That saved a wretch like me',
].join('\n');

const SAMPLE_SCORE = {
    ok: true,
    version: 2,
    bpm: 72,
    meter: [3, 4],
    beats: [10.0, 10.833, 11.667, 12.5, 13.333, 14.167, 15.0, 15.833, 16.667],
    downbeats: [10.833, 13.333, 15.833],
    key: {root: 7, type: 'major', confidence: 0.91},
    tuningCents: 0,
    medianMidi: 67,
    chords: [
        {bar: 1, beatInBar: 0, start: 10.833, end: 13.333, symbol: 'G'},
        {bar: 2, beatInBar: 0, start: 13.333, end: 15.833, symbol: 'C'},
    ],
    words: [
        {word: 'Amazing', start: 10.0, end: 11.6},
        {word: 'grace,', start: 11.6, end: 13.2},
        {word: 'how', start: 13.3, end: 14.1},
        {word: 'sweet', start: 14.1, end: 14.9},
        {word: 'the', start: 14.9, end: 15.4},
        {word: 'sound', start: 15.4, end: 16.0},
    ],
    notes: [
        {id: 1, start: 10.0, end: 10.8, pitch: 62.0, durBeats: 1.0},
        {id: 2, start: 10.8, end: 12.4, pitch: 67.0, durBeats: 2.0},
        {id: 3, start: 12.4, end: 12.8, pitch: 71.0, durBeats: 0.5},
        {id: 4, start: 12.8, end: 13.2, pitch: 67.0, durBeats: 0.5},
        {id: 5, start: 13.3, end: 14.9, pitch: 71.0, durBeats: 2.0},
        {id: 6, start: 14.9, end: 15.4, pitch: 69.0, durBeats: 1.0},
        {id: 7, start: 15.4, end: 16.0, pitch: 67.0, durBeats: 1.0},
    ],
};

function makeHarness({generateScore, scoreEnabled = false, onSearch = null} = {}) {
    let now = 1_700_000_000_000;
    const saved = {videos: new Map(), searches: new Map(), scores: new Map(), budget: null};
    const states = [];
    const lines = [];
    const scores = [];
    const store = {
        loadVideo: id => (saved.videos.has(id) ? structuredClone(saved.videos.get(id)) : null),
        saveVideo: rec => saved.videos.set(rec.videoId, structuredClone(rec)),
        loadSearch: key => saved.searches.get(key) ?? null,
        saveSearch: (key, entry) => saved.searches.set(key, entry),
        loadBudget: () => saved.budget,
        saveBudget: state => { saved.budget = state; },
        loadScore: id => (saved.scores.has(id) ? structuredClone(saved.scores.get(id)) : null),
        saveScore: rec => saved.scores.set(rec.videoId, structuredClone(rec)),
    };
    let nextHandle = 1;
    const pending = [];
    const timers = {
        set(callback, delayMs) {
            const handle = nextHandle++;
            pending.push({handle, at: now + delayMs, callback});
            return handle;
        },
        clear(handle) {
            const idx = pending.findIndex(t => t.handle === handle);
            if (idx >= 0) pending.splice(idx, 1);
        },
    };
    const core = new LyricsCore({
        store,
        search: async candidate => {
            onSearch?.(candidate);
            return [{
                id: 1, trackName: 'Amazing Grace', artistName: 'Singer', albumName: 'Hymns',
                duration: 200, instrumental: false, plainLyrics: 'Amazing grace', syncedLyrics: LRC,
            }];
        },
        clock: {now: () => now},
        timers,
        emit: {
            state: s => states.push(s),
            presence: () => {},
            videoUpdated: () => {},
            line: l => lines.push(l),
            score: sc => scores.push(sc),
        },
        log: () => {},
        generateScore,
        scoreEnabled,
    });
    const flush = () => new Promise(resolve => setImmediate(resolve));
    const report = (mediaTime, playing = true) => core.report(1, {
        sampledAt: now,
        heartbeatMs: playing ? 5000 : null,
        metadata: {
            host: 'www.youtube.com',
            videoId: 'grace001',
            title: 'Amazing Grace',
            author: 'Singer - Topic',
            lengthSeconds: 200,
            category: 'Music',
            musicVideoType: '',
            description: TOPIC,
            musicCards: [],
            mediaSession: null,
            ytmByline: '',
        },
        media: {
            videoId: 'grace001',
            currentTime: mediaTime,
            duration: 200,
            paused: !playing,
            ended: false,
            stalled: false,
            playbackRate: 1,
            muted: false,
            volume: 1,
            adShowing: false,
        },
    });
    return {core, saved, states, lines, scores, flush, report, advance: ms => { now += ms; }};
}

test('scoreEnabled=false leaves LineChanged pure and does not auto-extract', async () => {
    let calls = 0;
    const h = makeHarness({
        scoreEnabled: false,
        generateScore: () => {
            calls++;
            return {promise: Promise.resolve(structuredClone(SAMPLE_SCORE)), cancel: () => {}};
        },
    });
    h.report(10.5, true);
    await h.flush();
    await h.flush();

    assert.equal(calls, 0);
    const line = h.core.line();
    assert.deepEqual(Object.keys(line).sort(), ['key', 'text']);
    assert.equal(line.text, 'Amazing grace, how sweet the sound');
});

test('scoreEnabled=true auto-extracts melody + chords, emits ScoreChanged cleanly, and supports non-destructive edits + HQ refine', async () => {
    const qualities = [];
    const stages = [];
    const h = makeHarness({
        scoreEnabled: true,
        generateScore: ({onStage, quality}) => {
            qualities.push(quality);
            onStage?.('separate');
            stages.push('separate');
            return {promise: Promise.resolve({...structuredClone(SAMPLE_SCORE), quality}), cancel: () => {}};
        },
    });

    h.report(10.5, true);
    await h.flush();
    await h.flush();
    await h.flush();

    assert.deepEqual(qualities, ['standard']);
    assert.deepEqual(stages, ['separate']);
    assert.ok(h.saved.scores.has('grace001'));

    const state = h.core.state();
    assert.equal(state.score.status, 'ready');
    assert.equal(state.score.bpm, 72);
    assert.equal(state.score.noteCount, 7);
    assert.equal(state.score.chordCount, 2);
    assert.deepEqual(state.score.key, {root: 7, type: 'major', confidence: 0.91});
    assert.deepEqual(state.key, {root: 7, type: 'major'}, 'detected score key fills state.key when live mic has none');

    // LineChanged stays pure lyrics without scoreSlice bloat.
    assert.deepEqual(Object.keys(h.core.line()).sort(), ['key', 'text']);

    // Separate scorePayload / ScoreChanged carries score + aligned lyrics + playback clock.
    const payload = h.core.scorePayload();
    assert.equal(payload.status, 'ready');
    assert.equal(payload.score.notes.length, 7);
    assert.equal(payload.score.chords.length, 2);
    assert.equal(payload.lyricsLines.length, 2);
    assert.equal(payload.clock.playing, true);
    assert.equal(payload.clock.rate, 1);

    // Non-destructive edits persist and override effective key.
    const editRes = h.core.editScore({
        edits: {
            tempoMul: 0.5,
            keyOverride: {root: 2, type: 'minor'},
            noteOverrides: {'1': {pitch: 64}},
            chordOverrides: {'1:0': 'Dm'},
        },
    });
    assert.equal(editRes.ok, true);
    assert.deepEqual(h.core.state().key, {root: 2, type: 'minor'});
    assert.equal(h.core.state().score.edited, true);
    assert.equal(h.core.scorePayload().score.edits.tempoMul, 0.5);

    // Refine (HQ) triggers quality='high' and preserves song-level overrides!
    const hqRes = h.core.command({op: 'generateScore', force: true, quality: 'high'});
    assert.equal(hqRes.ok, true);
    await h.flush();
    await h.flush();
    assert.deepEqual(qualities, ['standard', 'high']);
    assert.equal(h.core.state().score.quality, 'high');
    assert.equal(h.core.scorePayload().score.edits.tempoMul, 0.5);
    assert.deepEqual(h.core.scorePayload().score.edits.keyOverride, {root: 2, type: 'minor'});
});

test('generateScore and cancelScore commands run and cancel cleanly', async () => {
    let cancelled = false;
    let rejectRun = null;
    const h = makeHarness({
        scoreEnabled: false,
        generateScore: () => {
            const promise = new Promise((_resolve, reject) => {
                rejectRun = reject;
            });
            return {
                promise,
                cancel() {
                    cancelled = true;
                    const err = new Error('cancelled');
                    err.cancelled = true;
                    rejectRun(err);
                },
            };
        },
    });

    h.report(10.5, true);
    await h.flush();

    const startRes = h.core.command({op: 'generateScore'});
    assert.equal(startRes.ok, true);
    assert.equal(h.core.state().score.status, 'running');

    const cancelRes = h.core.command({op: 'cancelScore'});
    assert.equal(cancelRes.ok, true);
    await h.flush();
    assert.equal(cancelled, true);
    assert.equal(h.core.state().score.status, 'skipped');
});

test('Cairo fitLyric + paintLineScoreBelow renders visible staff pixels for single, wrapped, and Japanese ruby lines', () => {
    const script = `
        import Cairo from 'cairo';
        import PangoCairo from 'gi://PangoCairo';
        import {fitLyric, paintLyric} from './shared/text-layout.js';
        import {buildLineScore, sampleScoreForPreview} from './shared/score-layout.js';
        import {paintLineScoreBelow} from './shared/score-painter.js';

        const sample = sampleScoreForPreview();

        function testCase(text, width, ruby = null, harmony = 'both', noteNames = 'letters') {
            const lineScore = buildLineScore({
                displayText: text,
                lineStart: 0,
                lineEnd: 7.2,
                score: sample,
                scaleSnap: 'soft',
                harmony,
            });
            if (!lineScore || !lineScore.items.length)
                throw new Error('empty lineScore for ' + text);
            const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, width, 480);
            const cr = new Cairo.Context(surface);
            const ctx = PangoCairo.create_context(cr);
            const fitted = fitLyric(ctx, text, {
                fontSize: 44,
                family: 'Sans',
                bold: true,
                border: 'triple',
                color: 'white',
                align: 'center',
                width,
                height: 160,
                ruby,
                scoreBandHeight: 92,
                scoreWords: lineScore.words,
            });
            if (!fitted.scoreLayout || !fitted.scoreLayout.bands.length)
                throw new Error('missing score bands for ' + text);
            if (!fitted.scoreLayout.wordAnchors.length)
                throw new Error('missing word anchors for ' + text);
            paintLyric(cr, fitted);
            paintLineScoreBelow(cr, fitted, lineScore, {
                activeNoteId: lineScore.items.find(i => i.kind === 'note')?.id ?? null,
                noteNames,
                backgroundOpacity: 0.78,
            });
            surface.flush();
            return {bands: fitted.scoreLayout.bands.length, reqH: fitted.requiredHeight, anchors: fitted.scoreLayout.wordAnchors.length};
        }

        const r1 = testCase('Amazing grace, how sweet the sound', 1100);
        const r2 = testCase('Amazing grace, how sweet the sound that saved a wretch like me', 520, null, 'above', 'degrees');
        const r3 = testCase('夜に駆ける 夢の中で', 760, [['夜', 'よる'], ['に', null], ['駆', 'か'], ['ける ', null], ['夢', 'ゆめ'], ['の', null], ['中', 'なか'], ['で', null]], 'off', 'letters');
        if (r1.bands !== 1) throw new Error('expected 1 band, got ' + r1.bands);
        if (r2.bands < 2) throw new Error('expected >=2 wrapped bands, got ' + r2.bands);
        if (r3.bands < 1 || r3.anchors < 2) throw new Error('japanese score failed');
        print(JSON.stringify({r1, r2, r3}));
    `;
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const sharedUrl = `${pathToFileURL(path.join(repoRoot, 'shared')).href}/`;
    const tmpFile = path.join(os.tmpdir(), `score-render-test-${process.pid}-${Date.now()}.mjs`);
    fs.writeFileSync(tmpFile, script.replaceAll('./shared/', sharedUrl));
    try {
        const out = execFileSync('gjs', ['-m', tmpFile], {
            cwd: repoRoot,
            encoding: 'utf8',
        }).trim();
        const parsed = JSON.parse(out.split('\n').pop());
        assert.equal(parsed.r1.bands, 1);
        assert.ok(parsed.r2.bands >= 2);
        assert.ok(parsed.r3.anchors >= 2);
    } finally {
        fs.rmSync(tmpFile, {force: true});
    }
});

test('Cairo paintLeadSheetPage renders crisp white-paper multi-system lead sheet cleanly', () => {
    const script = `
        import Cairo from 'cairo';
        import {sampleLeadSheetForPreview} from './shared/score-layout.js';
        import {paintLeadSheetPage} from './shared/score-painter.js';

        const sheet = sampleLeadSheetForPreview({harmony: 'both', barsPerSystem: 4});
        const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, 1080, 380);
        const cr = new Cairo.Context(surface);
        paintLeadSheetPage(cr, sheet, {
            width: 1080,
            height: 380,
            title: 'Amazing Grace',
            startSystemIndex: 0,
            activeMeasureIndex: 1,
            activeNoteId: '2',
            measureProgress: 0.4,
            noteNames: 'letters',
            paperOpacity: 0.96,
        });
        paintLeadSheetPage(cr, null, {
            width: 640,
            height: 220,
            title: 'Loading',
            statusMessage: 'Extracting lead sheet...',
        });
        surface.flush();
        print(JSON.stringify({systems: sheet.systems.length, totalBars: sheet.totalBars, chords: sheet.chordCount}));
    `;
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const sharedUrl = `${pathToFileURL(path.join(repoRoot, 'shared')).href}/`;
    const tmpFile = path.join(os.tmpdir(), `leadsheet-render-test-${process.pid}-${Date.now()}.mjs`);
    fs.writeFileSync(tmpFile, script.replaceAll('./shared/', sharedUrl));
    try {
        const out = execFileSync('gjs', ['-m', tmpFile], {
            cwd: repoRoot,
            encoding: 'utf8',
        }).trim();
        const parsed = JSON.parse(out.split('\n').pop());
        assert.ok(parsed.systems >= 2);
        assert.ok(parsed.totalBars >= 6);
        assert.ok(parsed.chords >= 3);
    } finally {
        fs.rmSync(tmpFile, {force: true});
    }
});

test('vocal-isolated score segments fuse with LRCLIB reference into a new candidate without overwriting LRCLIB, and refreshAll chains both', async () => {
    let searchCalls = 0;
    const scoreCalls = [];
    const h = makeHarness({
        scoreEnabled: true,
        onSearch: () => { searchCalls++; },
        generateScore: ({plainLyrics, freshAudio, quality}) => {
            scoreCalls.push({plainLyrics, freshAudio, quality});
            return {
                promise: Promise.resolve({
                    ...structuredClone(SAMPLE_SCORE),
                    segments: [
                        {
                            start: 10.2, end: 13.0, text: 'Amazing grace how sweet the sound', no_speech_prob: 0.01,
                            words: [
                                {start: 10.2, end: 10.9, word: 'Amazing', probability: 0.95},
                                {start: 10.9, end: 11.4, word: 'grace', probability: 0.95},
                                {start: 11.4, end: 11.8, word: 'how', probability: 0.95},
                                {start: 11.8, end: 12.2, word: 'sweet', probability: 0.95},
                                {start: 12.2, end: 12.5, word: 'the', probability: 0.95},
                                {start: 12.5, end: 13.0, word: 'sound', probability: 0.95},
                            ],
                        },
                        {
                            start: 16.4, end: 19.0, text: 'That saved a wretch like me', no_speech_prob: 0.01,
                            words: [
                                {start: 16.4, end: 16.8, word: 'That', probability: 0.95},
                                {start: 16.8, end: 17.3, word: 'saved', probability: 0.95},
                                {start: 17.3, end: 17.5, word: 'a', probability: 0.95},
                                {start: 17.5, end: 18.1, word: 'wretch', probability: 0.95},
                                {start: 18.1, end: 18.5, word: 'like', probability: 0.95},
                                {start: 18.5, end: 19.0, word: 'me', probability: 0.95},
                            ],
                        },
                    ],
                }),
                cancel: () => {},
            };
        },
    });

    h.report(10.5, true);
    await h.flush();
    await h.flush();
    await h.flush();
    await h.flush();

    assert.equal(searchCalls, 1);
    assert.equal(scoreCalls.length, 1);
    assert.match(scoreCalls[0].plainLyrics, /Amazing grace/);
    const rec = h.saved.videos.get('grace001');
    const fused = rec.candidates.find(c => String(c.id).startsWith('gen:vocal:'));
    const lrclib = rec.candidates.find(c => !c.generated);
    assert.ok(lrclib, 'original LRCLIB candidate must remain intact');
    assert.ok(fused, 'vocal-fused candidate must be added alongside LRCLIB');
    assert.equal(fused.generated, 'vocal-fused');

    // Coupled refreshAll re-checks LRCLIB and passes freshAudio=true to score generator.
    const refreshRes = h.core.command({op: 'refreshAll'});
    assert.equal(refreshRes.ok, true);
    await h.flush();
    await h.flush();
    await h.flush();
    await h.flush();
    assert.equal(searchCalls, 2);
    assert.equal(scoreCalls.length, 2);
    assert.equal(scoreCalls[1].freshAudio, true);
});

test('Cairo fitLyric contentFit+maxLines and paintLeadSheetPage paging/dimensions/gearBox behave cleanly', () => {
    const script = `
        import Cairo from 'cairo';
        import PangoCairo from 'gi://PangoCairo';
        import {fitLyric} from './shared/text-layout.js';
        import {sampleLeadSheetForPreview} from './shared/score-layout.js';
        import {computeAutoBarsPerSystem, computeLeadSheetDimensions, paintLeadSheetPage} from './shared/score-painter.js';

        const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, 1200, 500);
        const cr = new Cairo.Context(surface);
        const ctx = PangoCairo.create_context(cr);

        const shortFit = fitLyric(ctx, 'Hello', {
            fontSize: 44, family: 'Sans', bold: true, border: 'triple', color: 'white',
            align: 'center', width: 1100, height: 140, maxLines: 1, contentFit: true,
        });
        const moderateFit = fitLyric(ctx, 'This lyric line shrinks gently', {
            fontSize: 48, family: 'Sans', bold: true, border: 'triple', color: 'white',
            align: 'center', width: 640, height: 140, maxLines: 1, contentFit: true,
        });
        const extremeFit = fitLyric(ctx, 'This is a long lyric line that shrinks cleanly to one line', {
            fontSize: 48, family: 'Sans', bold: true, border: 'triple', color: 'white',
            align: 'center', width: 640, height: 140, maxLines: 1, contentFit: true,
        });

        const sheet = sampleLeadSheetForPreview({barsPerSystem: 4});
        const dims = computeLeadSheetDimensions(sheet, {scale: 1.0, spacing: 'normal', showHeader: true, showChords: true, showLyrics: true});
        const autoNarrow = computeAutoBarsPerSystem(sheet, {width: 480, scale: 1.5, spacing: 'normal'});
        const autoZoomed = computeAutoBarsPerSystem(sheet, {width: 1000, scale: 3.0, spacing: 'normal'});
        const painted = paintLeadSheetPage(cr, sheet, {
            width: Math.min(1200, dims.width),
            height: Math.min(500, dims.height),
            title: 'Amazing Grace',
            paging: 'page',
            currentSystemIndex: 1,
            activeMeasureIndex: 5,
            showPlayhead: false,
            showActiveMeasure: false,
            showSnapMoves: true,
            showHeader: true,
            headerFields: {title: true, key: true, time: false, bpm: true, clef: false, bars: true, page: true},
            showConfigButton: true,
        });
        // Short 1-row window auto-fits 1 row and flips cleanly to system 1 on page 2.
        const paintedPage2 = paintLeadSheetPage(cr, sheet, {
            width: Math.min(1200, dims.width),
            height: 190,
            title: 'Amazing Grace',
            paging: 'page',
            currentSystemIndex: 1,
            activeMeasureIndex: 5,
            showPlayhead: true,
            showActiveMeasure: true,
            showConfigButton: true,
        });
        // Tall square-ish window at 200% zoom with pinned 6 bars + spacious must reflow cleanly and stay top-anchored.
        const tallSurface = new Cairo.ImageSurface(Cairo.Format.ARGB32, 920, 760);
        const tallCr = new Cairo.Context(tallSurface);
        const paintedTall200 = paintLeadSheetPage(tallCr, sheet, {
            width: 920,
            height: 760,
            title: 'Sample Song',
            scale: 2.0,
            barsPerSystem: 6,
            spacing: 'spacious',
            showChords: false,
            showMeasureNumbers: false,
            noteNames: 'off',
            showLyrics: true,
        });
        print(JSON.stringify({
            shortW: shortFit.surfaceWidth,
            shortInkW: shortFit.inkBox.width,
            moderateLineCount: moderateFit.lineCount,
            moderateFont: moderateFit.effectiveFontSize,
            extremeLineCount: extremeFit.lineCount,
            extremeFont: extremeFit.effectiveFontSize,
            dims,
            autoNarrow,
            autoZoomed,
            pageStart0: painted.startSystemIndex,
            pageStart1: paintedPage2.startSystemIndex,
            hasGear: Boolean(painted.gearBox && painted.gearBox.width > 12),
            tall200: paintedTall200,
        }));
    `;
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
    const sharedUrl = `${pathToFileURL(path.join(repoRoot, 'shared')).href}/`;
    const tmpFile = path.join(os.tmpdir(), `snug-leadsheet-test-${process.pid}-${Date.now()}.mjs`);
    fs.writeFileSync(tmpFile, script.replaceAll('./shared/', sharedUrl));
    try {
        const out = execFileSync('gjs', ['-m', tmpFile], {
            cwd: repoRoot,
            encoding: 'utf8',
        }).trim();
        const r = JSON.parse(out.split('\n').pop());
        assert.ok(r.shortW < 400 && r.shortW >= r.shortInkW, `short lyric surfaceWidth must be snug, got ${JSON.stringify(r)}`);
        assert.equal(r.moderateLineCount, 1, 'moderate overflow must shrink gently onto 1 line');
        assert.ok(r.moderateFont < 48 && r.moderateFont >= 26, `moderate shrink stays readable, got ${r.moderateFont}`);
        assert.ok(r.extremeLineCount >= 2, 'extreme narrow overflow must wrap cleanly instead of turning microscopic');
        assert.ok(r.extremeFont >= 26, `wrapped narrow lyric must keep readable font floor, got ${r.extremeFont}`);
        assert.ok(r.autoNarrow >= 1 && r.autoNarrow <= 2, `narrow 480px at 1.5x should reflow to 1-2 bars, got ${r.autoNarrow}`);
        assert.ok(r.autoZoomed >= 1 && r.autoZoomed <= 3, `1000px at 3.0x zoom should reflow to 1-3 bars, got ${r.autoZoomed}`);
        assert.ok(r.dims.width > 400 && r.dims.height > 200);
        // Page mode with 2 visible systems keeps system 1 on page 0 (startSystemIndex === 0) until page finishes!
        assert.equal(r.pageStart0, 0);
        // Page mode with 1 auto-fitted visible system flips to system 1 immediately when activeSystemIndex === 1!
        assert.equal(r.pageStart1, 1);
        assert.equal(r.hasGear, true);
        assert.equal(r.tall200.effectiveScale, 2.0, '200% zoom must render at true 200% instead of shrinking');
        assert.ok(r.tall200.visibleRows >= 3, `920x760 at 200% must auto-fill >= 3 rows, got ${r.tall200.visibleRows}`);
        assert.ok(r.tall200.topMargin <= 24, `systems must be top-anchored, got topMargin=${r.tall200.topMargin}`);
    } finally {
        fs.rmSync(tmpFile, {force: true});
    }
});

test('command editScore patches per-song keyOverride and clef while preserving existing chord/note edits', async () => {
    const h = makeHarness({
        generateScore: () => ({promise: Promise.resolve(SAMPLE_SCORE), cancel() {}}),
        scoreEnabled: true,
    });
    h.report(11.0, true);
    await h.flush();
    await h.flush();
    await h.flush();

    // Seed an existing chord edit via editScore
    const r1 = h.core.editScore({edits: {chordOverrides: {'1:0': 'Gmaj7'}}});
    assert.equal(r1.ok, true);

    // Now patch per-song keyOverride + clef via D-Bus command({op: 'editScore', patch})
    const r2 = h.core.command({op: 'editScore', patch: {keyOverride: {root: 2, type: 'major'}, clef: 'treble-8vb'}});
    assert.equal(r2.ok, true);
    const saved = h.saved.scores.get('grace001');
    assert.deepEqual(saved.edits.chordOverrides, {'1:0': 'Gmaj7'}, 'existing chord edits must be preserved');
    assert.deepEqual(saved.edits.keyOverride, {root: 2, type: 'major'});
    assert.equal(saved.edits.clef, 'treble-8vb');
    assert.deepEqual(h.core.state().key, {root: 2, type: 'major'});

    // Clearing keyOverride returns to detected key without losing clef or chords
    h.core.command({op: 'editScore', patch: {keyOverride: null}});
    const saved2 = h.saved.scores.get('grace001');
    assert.equal(saved2.edits.keyOverride, undefined);
    assert.equal(saved2.edits.clef, 'treble-8vb');
    assert.deepEqual(saved2.edits.chordOverrides, {'1:0': 'Gmaj7'});
});
