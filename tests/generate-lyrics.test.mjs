import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath} from 'node:url';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scriptPath = path.join(root, 'service', 'generate-lyrics.py');

test('gpu-gate wrapper drains stdout concurrently with stderr and never deadlocks on >64 KB transcripts', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lyrics-gen-pipe-test-'));
    try {
        const audio = path.join(tmp, 'sample.mp3');
        fs.writeFileSync(audio, Buffer.alloc(8192, 0));

        // Stand-in GPU gate executable that ignores --transcribe-audio and emits
        // stage markers on stderr alongside a >256 KB JSON transcript on stdout
        // (well above Linux's 64 KB pipe buffer).
        const fakeGate = path.join(tmp, 'fake-gpu');
        fs.writeFileSync(fakeGate, `#!/usr/bin/env python3
import json, sys
print("stage:transcribe", file=sys.stderr, flush=True)
segments = [
    {
        "start": i * 2.0,
        "end": i * 2.0 + 1.8,
        "text": f"line {i} with repeated words to exceed pipe buffer",
        "no_speech_prob": 0.01,
        "words": [
            {"start": i * 2.0 + j * 0.2, "end": i * 2.0 + (j + 1) * 0.2, "word": f"word{j}", "probability": 0.95}
            for j in range(8)
        ],
    }
    for i in range(400)
]
payload = json.dumps({"ok": True, "language": "en", "duration": 800.0, "device": "cuda", "segments": segments})
assert len(payload.encode("utf-8")) > 256_000
print(payload, flush=True)
print("gpu: Whisper large-v3 had at most 3.1 GB on the GPU", file=sys.stderr, flush=True)
`, {mode: 0o755});

        const {stdout, stderr} = await execFileAsync('python3', [
            scriptPath,
            '--audio-file', audio,
            '--model', 'large-v3',
            '--device', 'cuda',
            '--compute-type', 'float16',
            '--max-duration', '0',
            '--gpu-gate-json', JSON.stringify({command: fakeGate, name: 'Test', what: 'Test Whisper', gb: 1, lane: 'now', minutes: 1}),
        ], {timeout: 5000, maxBuffer: 8 * 1024 * 1024});

        assert.match(stderr, /stage:gpu-wait/u);
        assert.match(stderr, /stage:transcribe/u);
        const result = JSON.parse(stdout);
        assert.equal(result.ok, true);
        assert.equal(result.segments.length, 400);
    } finally {
        fs.rmSync(tmp, {recursive: true, force: true});
    }
});

test('yt-dlp HTTP 403 on primary DASH audio retries once via HLS/progressive, cleans partials, and honors cookiesFromBrowser', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lyrics-gen-403-test-'));
    try {
        const fakeBin = path.join(tmp, 'bin');
        fs.mkdirSync(fakeBin);
        const callsLog = path.join(tmp, 'yt-dlp-calls.jsonl');
        const fakeYtDlp = path.join(fakeBin, 'yt-dlp');
        fs.writeFileSync(fakeYtDlp, `#!/usr/bin/env python3
import json, os, sys
from pathlib import Path

args = sys.argv[1:]
with open(${JSON.stringify(callsLog)}, "a", encoding="utf-8") as fh:
    fh.write(json.dumps(args) + "\\n")

fmt = args[args.index("-f") + 1]
out_tpl = args[args.index("-o") + 1]
out_dir = Path(out_tpl).parent
mode = os.environ.get("FAKE_YTDLP_MODE", "403-then-ok")

if mode == "403-then-ok":
    if fmt == "bestaudio[filesize<30M]/bestaudio":
        (out_dir / "audio.webm.part").write_bytes(b"partial")
        print("ERROR: unable to download video data: HTTP Error 403: Forbidden", file=sys.stderr)
        raise SystemExit(1)
    assert not list(out_dir.glob("audio.*")), f"leftover partial files: {list(out_dir.glob('audio.*'))}"
    (out_dir / "audio.mp4").write_bytes(b"fake-hls-audio" * 512)
    raise SystemExit(0)
if mode == "always-403":
    print("ERROR: unable to download video data: HTTP Error 403: Forbidden", file=sys.stderr)
    raise SystemExit(1)
if mode == "non-403":
    print("ERROR: Video unavailable", file=sys.stderr)
    raise SystemExit(1)
(out_dir / "audio.webm").write_bytes(b"fake-cookie-audio" * 512)
`, {mode: 0o755});

        const fakeGate = path.join(tmp, 'fake-gpu');
        fs.writeFileSync(fakeGate, `#!/usr/bin/env python3
import json, sys
print(json.dumps({"ok": True, "language": "en", "duration": 10.0, "device": "cuda", "segments": []}))
`, {mode: 0o755});

        const runGen = async (mode, extraArgs = []) => {
            fs.rmSync(callsLog, {force: true});
            const {stdout} = await execFileAsync('python3', [
                scriptPath,
                '--video-id', 'dQw4w9WgXcQ',
                '--max-duration', '0',
                '--gpu-gate-json', JSON.stringify({command: fakeGate, name: 'Test', what: 'Test', gb: 1, lane: 'now', minutes: 1}),
                ...extraArgs,
            ], {
                timeout: 5000,
                env: {
                    ...process.env,
                    PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`,
                    FAKE_YTDLP_MODE: mode,
                },
            });
            const calls = fs.existsSync(callsLog)
                ? fs.readFileSync(callsLog, 'utf8').trim().split('\n').map(line => JSON.parse(line))
                : [];
            return {result: JSON.parse(stdout), calls};
        };

        // 1. Primary DASH 403 -> retries once with HLS/progressive format and succeeds.
        const retried = await runGen('403-then-ok');
        assert.equal(retried.result.ok, true);
        assert.equal(retried.calls.length, 2);
        assert.equal(retried.calls[0][retried.calls[0].indexOf('-f') + 1], 'bestaudio[filesize<30M]/bestaudio');
        assert.equal(retried.calls[1][retried.calls[1].indexOf('-f') + 1], 'bestaudio[protocol^=m3u8]/best[filesize<30M]/best');

        // 2. Non-403 error does NOT retry.
        const non403 = await runGen('non-403');
        assert.equal(non403.result.ok, false);
        assert.equal(non403.calls.length, 1);
        assert.match(non403.result.error, /Video unavailable/u);

        // 3. Persistent 403 surfaces actionable cookiesFromBrowser hint.
        const all403 = await runGen('always-403');
        assert.equal(all403.result.ok, false);
        assert.equal(all403.calls.length, 2);
        assert.match(all403.result.error, /cookiesFromBrowser/u);

        // 4. --cookies-from-browser passes through to yt-dlp.
        const withCookies = await runGen('ok', ['--cookies-from-browser', 'firefox']);
        assert.equal(withCookies.result.ok, true);
        assert.equal(withCookies.calls.length, 1);
        const cookieIdx = withCookies.calls[0].indexOf('--cookies-from-browser');
        assert.ok(cookieIdx !== -1 && withCookies.calls[0][cookieIdx + 1] === 'firefox');

        // 5. _augmented_env places ~/.local/bin ahead of /usr/bin even if appended later in PATH,
        //    while preserving custom dirs placed before /usr/bin.
        const {stdout: pathCheck} = await execFileAsync('python3', ['-c', `
import importlib.util, json, os
from pathlib import Path
spec = importlib.util.spec_from_file_location("gl", ${JSON.stringify(scriptPath)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
local_bin = str(Path.home() / ".local" / "bin")
os.environ["PATH"] = f"/custom/bin:/usr/bin:/bin:{local_bin}"
parts = m._augmented_env()["PATH"].split(os.pathsep)
print(json.dumps({"parts": parts, "local_bin": local_bin}))
`], {timeout: 5000});
        const {parts, local_bin: localBin} = JSON.parse(pathCheck);
        assert.equal(parts.indexOf('/custom/bin'), 0);
        assert.ok(parts.indexOf(localBin) > 0 && parts.indexOf(localBin) < parts.indexOf('/usr/bin'), JSON.stringify(parts));
    } finally {
        fs.rmSync(tmp, {recursive: true, force: true});
    }
});

test('validateGeneratorConfig validates optional cookiesFromBrowser and defaults to null', async () => {
    const loader = `
import {validateGeneratorConfig} from ${JSON.stringify(`file://${path.join(root, 'service', 'lyric-generator.js')}`)};
const base = {command: ['.venv/bin/python', 'service/generate-lyrics.py']};
const results = {
    defaultNull: validateGeneratorConfig(base, 's.json').cookiesFromBrowser,
    firefox: validateGeneratorConfig({...base, cookiesFromBrowser: 'firefox'}, 's.json').cookiesFromBrowser,
    errors: [],
};
for (const bad of ['', '   ', '-flag', 'fire fox', 123]) {
    try {
        validateGeneratorConfig({...base, cookiesFromBrowser: bad}, 's.json');
        results.errors.push('accepted:' + JSON.stringify(bad));
    } catch (e) {
        results.errors.push(e.message);
    }
}
print(JSON.stringify(results));
`;
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lyrics-gen-cfg-test-'));
    try {
        const script = path.join(tmp, 'check.js');
        fs.writeFileSync(script, loader);
        const {stdout} = await execFileAsync('gjs', ['-m', script], {timeout: 5000});
        const parsed = JSON.parse(stdout);
        assert.equal(parsed.defaultNull, null);
        assert.equal(parsed.firefox, 'firefox');
        assert.equal(parsed.errors.length, 5);
        for (const msg of parsed.errors)
            assert.match(msg, /cookiesFromBrowser/u);
    } finally {
        fs.rmSync(tmp, {recursive: true, force: true});
    }
});
