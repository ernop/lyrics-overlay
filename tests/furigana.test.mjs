import test from 'node:test';
import assert from 'node:assert/strict';
import {execFile, spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

import {LyricsCore, SEARCH_VERSION} from '../service/core.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const scriptPath = path.join(root, 'service', 'furigana.py');
const sharedDir = path.join(root, 'shared');
const run = promisify(execFile);

function findPython() {
    const venv = path.join(root, '.venv', 'bin', 'python');
    return fs.existsSync(venv) ? venv : 'python3';
}

function runWorkerRequests(pythonBin, requests) {
    return new Promise((resolve, reject) => {
        const proc = spawn(pythonBin, ['-u', scriptPath], {stdio: ['pipe', 'pipe', 'pipe']});
        let out = '';
        let err = '';
        proc.stdout.on('data', chunk => {
            out += chunk.toString('utf8');
        });
        proc.stderr.on('data', chunk => {
            err += chunk.toString('utf8');
        });
        proc.on('error', reject);
        proc.on('close', code => {
            if (code !== 0) {
                reject(new Error(`furigana.py exited ${code}: ${err || out}`));
                return;
            }
            const lines = out.trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
            resolve(lines);
        });
        for (const req of requests)
            proc.stdin.write(`${JSON.stringify(req)}\n`);
        proc.stdin.end();
    });
}

test('furigana.py strips okurigana, ignores ASCII/numbers/kana, and preserves exact text invariant', async t => {
    const python = findPython();
    try {
        await run(python, [scriptPath, '--check']);
    } catch {
        t.skip('sudachipy not installed in this environment');
        return;
    }

    const responses = await runWorkerRequests(python, [
        {id: 1, text: '12 気付かれないでトドメを刺す'},
        {id: 2, text: '忘れ物を取りに戻る'},
        {id: 3, text: '君の名は。'},
        {id: 4, text: 'Hello World 2026'},
        {id: 5, text: 'ひらがなとカタカナだけ'},
        {id: 6, texts: ['桜の花びらが舞い散る夜', '人々が時々歩く']},
    ]);

    assert.equal(responses[0].ready, true);

    const byId = new Map(responses.slice(1).map(r => [r.id, r]));
    assert.deepEqual(byId.get(1).segments, [
        ['12 ', ''],
        ['気付', 'きづ'],
        ['かれないでトドメを', ''],
        ['刺', 'さ'],
        ['す', ''],
    ]);
    assert.deepEqual(byId.get(2).segments, [
        ['忘', 'わす'],
        ['れ', ''],
        ['物', 'もの'],
        ['を', ''],
        ['取', 'と'],
        ['りに', ''],
        ['戻', 'もど'],
        ['る', ''],
    ]);
    assert.deepEqual(byId.get(3).segments, [
        ['君', 'きみ'],
        ['の', ''],
        ['名', 'な'],
        ['は。', ''],
    ]);
    assert.deepEqual(byId.get(4).segments, [['Hello World 2026', '']]);
    assert.deepEqual(byId.get(5).segments, [['ひらがなとカタカナだけ', '']]);

    const batch = byId.get(6).results;
    assert.equal(batch.length, 2);
    assert.equal(batch[0].map(s => s[0]).join(''), '桜の花びらが舞い散る夜');
    assert.ok(batch[0].some(([base, reading]) => base === '桜' && reading === 'さくら'));
    assert.equal(batch[1].map(s => s[0]).join(''), '人々が時々歩く');
    assert.ok(batch[1].some(([base, reading]) => base === '人々' && reading === 'ひとびと'));
});

test('LyricsCore prewarms and attaches ruby only when furigana is enabled', async () => {
    const videos = new Map();
    const searches = new Map();
    const store = {
        loadVideo: id => videos.get(id) ?? null,
        saveVideo: rec => videos.set(rec.videoId, structuredClone(rec)),
        loadSearch: key => searches.get(key) ?? null,
        saveSearch: (key, val) => searches.set(key, structuredClone(val)),
        loadBudget: () => null,
        saveBudget: () => {},
    };
    const cache = new Map();
    const warmCalls = [];
    const furigana = {
        cached: text => cache.get(text) ?? null,
        warm: async lines => {
            warmCalls.push([...lines]);
            cache.set('桜の花びらが舞い散る夜', [['桜', 'さくら'], ['の', ''], ['花', 'はな'], ['びらが', ''], ['舞', 'ま'], ['い', ''], ['散', 'ち'], ['る', ''], ['夜', 'よる']]);
            return true;
        },
        annotate: async text => cache.get(text) ?? null,
    };

    const emittedLines = [];
    let now = 1_000_000;
    const core = new LyricsCore({
        store,
        search: async () => [],
        furigana,
        furiganaEnabled: false,
        clock: {now: () => now},
        timers: {set: () => 1, clear: () => {}},
        emit: {state: () => {}, line: line => emittedLines.push(line)},
        log: () => {},
    });

    const videoId = 'jpVid123456';
    store.saveVideo({
        version: 1,
        videoId,
        identity: {videoId, title: 'Sakura', artist: 'Artist', durationSeconds: 200, musical: true, reliable: true},
        lookup: {status: 'timed', at: now, queries: ['artist|sakura'], version: SEARCH_VERSION, duration: 200},
        generated: null,
        candidates: [{
            id: 42,
            trackName: 'Sakura',
            artistName: 'Artist',
            albumName: '',
            duration: 200,
            instrumental: false,
            plainLyrics: '',
            syncedLyrics: '[00:05.00] 桜の花びらが舞い散る夜\n[00:15.00] Hello world',
            score: 1,
            matches: true,
            timed: true,
        }],
        chosenId: 42,
        rejectedIds: [],
        offsetSeconds: 0,
        userRequested: true,
    });

    core.report(1, {
        sampledAt: now,
        heartbeatMs: 5000,
        media: {videoId, currentTime: 6, duration: 200, playbackRate: 1, paused: false, ended: false, muted: false, volume: 1, stalled: false, adShowing: false},
        metadata: {videoId, videoTitle: 'Artist - Sakura', channel: 'Artist', durationSeconds: 200, category: 'Music', mediaSession: null, chapters: [], musicCards: []},
    });

    assert.equal(core.line().text, '桜の花びらが舞い散る夜');
    assert.equal('ruby' in core.line(), false);
    assert.equal(warmCalls.length, 0);

    // Enable furigana: warms the song and emits ruby on the active line.
    core.setFuriganaEnabled(true);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(warmCalls.length, 1);
    assert.equal(core.line().text, '桜の花びらが舞い散る夜');
    assert.ok(Array.isArray(core.line().ruby));
    assert.equal(core.line().ruby[0][1], 'さくら');

    // Non-kanji line omits ruby cleanly.
    now += 10_000;
    core.report(1, {
        sampledAt: now,
        heartbeatMs: 5000,
        media: {videoId, currentTime: 16, duration: 200, playbackRate: 1, paused: false, ended: false, muted: false, volume: 1, stalled: false, adShowing: false},
    });
    assert.equal(core.line().text, 'Hello world');
    assert.equal('ruby' in core.line(), false);

    // Turning furigana off clears ruby on a kanji line immediately.
    now += 1000;
    core.report(1, {
        sampledAt: now,
        heartbeatMs: 5000,
        media: {videoId, currentTime: 6, duration: 200, playbackRate: 1, paused: false, ended: false, muted: false, volume: 1, stalled: false, adShowing: false},
    });
    assert.ok(Array.isArray(core.line().ruby));
    core.setFuriganaEnabled(false);
    assert.equal('ruby' in core.line(), false);
    assert.ok(emittedLines.length >= 4);
});

test('Cairo text-layout expands height and renders furigana pixels cleanly above kanji only', async t => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lyrics-ruby-'));
    t.after(() => fs.rmSync(dir, {recursive: true, force: true}));

    const probeScript = path.join(dir, 'probe-ruby.mjs');
    fs.writeFileSync(probeScript, `
import Cairo from 'cairo';
import PangoCairo from 'gi://PangoCairo';
import {fitLyric, paintLyric} from 'file://${sharedDir}/text-layout.js';

const text = '12 気付かれないでトドメを刺す';
const ruby = [['12 ', ''], ['気付', 'きづ'], ['かれないでトドメを', ''], ['刺', 'さ'], ['す', '']];
const ctx = PangoCairo.FontMap.get_default().create_context();
const baseParams = {
    fontSize: 64, family: 'Sans', bold: true, italic: false,
    color: 'pink', border: 'triple', backdrop: 'none',
    align: 'center', anchor: 'center', width: 1200, height: 120,
};
const plain = fitLyric(ctx, text, baseParams);
const withRuby = fitLyric(ctx, text, {...baseParams, ruby});

const W = 1200;
const H = Math.max(120, withRuby.requiredHeight);
const surface = new Cairo.ImageSurface(Cairo.Format.ARGB32, W, H);
const cr = new Cairo.Context(surface);
cr.setSourceRGB(0, 0, 1); // pure blue background sentinel
cr.paint();
paintLyric(cr, withRuby);
surface.flush();

// Check that ruby runs produced non-blue painted pixels at the top of each run.
const pngPath = '${path.join(dir, 'ruby.png')}';
surface.writeToPNG(pngPath);
const runCenters = withRuby.rubyLayout.runs.map(r => ({
    text: r.text,
    x: Math.round(r.x + r.ink.x + r.ink.width / 2),
    y: Math.round(withRuby.origin.y + r.relY + r.ink.y + r.ink.height / 2),
}));
print(JSON.stringify({
    plainHeight: plain.requiredHeight,
    rubyHeight: withRuby.requiredHeight,
    plainInkHeight: plain.inkBox.height,
    rubyInkHeight: withRuby.inkBox.height,
    runCount: withRuby.rubyLayout.runs.length,
    inkTop: withRuby.inkBox.y,
    runCenters,
}));
surface.finish();
`);

    const {stdout} = await run('gjs', ['-m', probeScript]);
    const info = JSON.parse(stdout.trim().split('\n').pop());
    assert.equal(info.runCount, 2);
    assert.ok(info.rubyHeight >= info.plainHeight, `ruby requiredHeight (${info.rubyHeight}) should never shrink below plain (${info.plainHeight})`);
    assert.ok(info.rubyInkHeight > info.plainInkHeight + 18, `ruby inkBox should expand cleanly (${info.rubyInkHeight} vs ${info.plainInkHeight})`);
    assert.ok(info.inkTop >= 0 && info.inkTop < info.runCenters[0].y, 'inkBox must cover ruby top');
    assert.equal(info.runCenters[0].text, 'きづ');
    assert.equal(info.runCenters[1].text, 'さ');
    assert.ok(info.runCenters[1].x > info.runCenters[0].x + 250, 'second ruby run should sit far right over 刺');
});
