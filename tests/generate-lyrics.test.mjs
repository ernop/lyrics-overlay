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
    if fmt in ("bestaudio[filesize<100M]/bestaudio", "bestaudio[abr<=96]/bestaudio"):
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

        const runGen = async (mode, extraArgs = [], maxDuration = '900') => {
            fs.rmSync(callsLog, {force: true});
            const {stdout} = await execFileAsync('python3', [
                scriptPath,
                '--video-id', 'dQw4w9WgXcQ',
                '--max-duration', maxDuration,
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

        // 1. Automatic short-song run: 100m cap; DASH 403 -> retries once with HLS/progressive format.
        const retried = await runGen('403-then-ok', [], '900');
        assert.equal(retried.result.ok, true);
        assert.equal(retried.calls.length, 2);
        assert.equal(retried.calls[0][retried.calls[0].indexOf('--max-filesize') + 1], '100m');
        assert.equal(retried.calls[0][retried.calls[0].indexOf('-f') + 1], 'bestaudio[filesize<100M]/bestaudio');
        assert.equal(retried.calls[1][retried.calls[1].indexOf('-f') + 1], 'bestaudio[protocol^=m3u8]/best[filesize<100M]/best');

        // 2. Manual forced run (--max-duration 0): no --max-filesize cap and compact abr<=96 stream.
        const manualRetried = await runGen('403-then-ok', [], '0');
        assert.equal(manualRetried.result.ok, true);
        assert.equal(manualRetried.calls.length, 2);
        assert.equal(manualRetried.calls[0].includes('--max-filesize'), false);
        assert.equal(manualRetried.calls[0][manualRetried.calls[0].indexOf('-f') + 1], 'bestaudio[abr<=96]/bestaudio');
        assert.equal(manualRetried.calls[1][manualRetried.calls[1].indexOf('-f') + 1], 'bestaudio[protocol^=m3u8]/best');

        // 3. Non-403 error does NOT retry.
        const non403 = await runGen('non-403', [], '0');
        assert.equal(non403.result.ok, false);
        assert.equal(non403.calls.length, 1);
        assert.match(non403.result.error, /Video unavailable/u);

        // 4. Persistent 403 surfaces actionable cookiesFromBrowser hint.
        const all403 = await runGen('always-403', [], '0');
        assert.equal(all403.result.ok, false);
        assert.equal(all403.calls.length, 2);
        assert.match(all403.result.error, /cookiesFromBrowser/u);

        // 5. --cookies-from-browser passes through to yt-dlp.
        const withCookies = await runGen('ok', ['--cookies-from-browser', 'firefox'], '0');
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

test('long tracks step down to lane new, scale GPU minutes, yield/resume cleanly, and merge into one result', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lyrics-gen-long-test-'));
    try {
        const fakeBin = path.join(tmp, 'bin');
        fs.mkdirSync(fakeBin);
        const audio = path.join(tmp, 'concert.webm');
        fs.writeFileSync(audio, Buffer.alloc(8192, 0));
        const gateLog = path.join(tmp, 'gate-calls.jsonl');

        // Fake ffprobe reporting a 2-hour (7200 s) concert.
        const fakeFfprobe = path.join(fakeBin, 'ffprobe');
        fs.writeFileSync(fakeFfprobe, '#!/usr/bin/env python3\nprint("7200.0")\n', {mode: 0o755});

        // Fake GPU gate that logs argv, yields once at 600 s, then completes on resume.
        const fakeGate = path.join(tmp, 'fake-gpu');
        fs.writeFileSync(fakeGate, `#!/usr/bin/env python3
import json, sys

args = sys.argv[1:]
with open(${JSON.stringify(gateLog)}, "a", encoding="utf-8") as fh:
    fh.write(json.dumps(args) + "\\n")

sep = args.index("--")
child = args[sep + 1:]
start_offset = float(child[child.index("--start-offset") + 1]) if "--start-offset" in child else 0.0

if start_offset == 0.0:
    print("stage:transcribe:600/7200", file=sys.stderr, flush=True)
    print(json.dumps({
        "ok": True,
        "yielded": True,
        "nextOffset": 600.0,
        "language": "en",
        "duration": 7200.0,
        "device": "cuda",
        "segments": [{"start": 10.0, "end": 12.0, "text": "Part one", "no_speech_prob": 0.01, "words": []}],
    }), flush=True)
else:
    print("stage:transcribe:7200/7200", file=sys.stderr, flush=True)
    print(json.dumps({
        "ok": True,
        "yielded": False,
        "nextOffset": 7200.0,
        "language": "en",
        "duration": 7200.0,
        "device": "cuda",
        "segments": [{"start": 610.0, "end": 612.0, "text": "Part two", "no_speech_prob": 0.01, "words": []}],
    }), flush=True)
`, {mode: 0o755});

        const {stdout, stderr} = await execFileAsync('python3', [
            scriptPath,
            '--audio-file', audio,
            '--model', 'large-v3',
            '--device', 'cuda',
            '--compute-type', 'float16',
            '--max-duration', '0',
            '--gpu-gate-json', JSON.stringify({
                command: fakeGate, name: 'Lyrics overlay', what: 'Whisper', gb: 7,
                lane: 'now', minutes: 5, waitMinutes: 1,
            }),
        ], {
            timeout: 8000,
            env: {...process.env, PATH: `${fakeBin}:${process.env.PATH ?? '/usr/bin:/bin'}`},
        });

        const calls = fs.readFileSync(gateLog, 'utf8').trim().split('\n').map(line => JSON.parse(line));
        assert.equal(calls.length, 2, 'should resume after yielding');
        // Stepped down from lane "now" to "new", scaled minutes from 7200 s, omitted --wait on forced run.
        assert.equal(calls[0][calls[0].indexOf('--lane') + 1], 'new');
        assert.equal(calls[0][calls[0].indexOf('--minutes') + 1], '22');
        assert.equal(calls[0].includes('--wait'), false);
        assert.equal(calls[1][calls[1].indexOf('--minutes') + 1], '21');
        const child0 = calls[0].slice(calls[0].indexOf('--') + 1);
        const child1 = calls[1].slice(calls[1].indexOf('--') + 1);
        assert.deepEqual(
            JSON.parse(child0[child0.indexOf('--yield-check-json') + 1]),
            [fakeGate, 'should-yield', '--lane', 'new', '--name', 'Lyrics overlay'],
        );
        assert.equal(child1[child1.indexOf('--start-offset') + 1], '600.000');

        assert.match(stderr, /stage:transcribe:600\/7200/u);
        assert.match(stderr, /stage:transcribe:7200\/7200/u);
        const result = JSON.parse(stdout);
        assert.equal(result.ok, true);
        assert.equal(result.duration, 7200);
        assert.deepEqual(result.segments.map(s => [s.start, s.text]), [[10, 'Part one'], [610, 'Part two']]);
    } finally {
        fs.rmSync(tmp, {recursive: true, force: true});
    }
});

test('sliced _transcribe_audio decodes 16 kHz slices with ffmpeg, offsets timestamps, and honors yield checks', async () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lyrics-gen-slice-test-'));
    try {
        // Generate a real 5-second 16 kHz mono WAV file so real ffmpeg slicing is exercised.
        const wavPath = path.join(tmp, 'five-sec.wav');
        const yieldFlag = path.join(tmp, 'yield-once');
        fs.writeFileSync(yieldFlag, '1');
        const yieldScript = path.join(tmp, 'check-yield');
        fs.writeFileSync(yieldScript, `#!/usr/bin/env python3
from pathlib import Path
flag = Path(${JSON.stringify(yieldFlag)})
if flag.exists():
    flag.unlink()
    raise SystemExit(0)
raise SystemExit(1)
`, {mode: 0o755});

        const pyCode = `
import importlib.util, json, sys, types, wave
from pathlib import Path

with wave.open(${JSON.stringify(wavPath)}, "wb") as wf:
    wf.setnchannels(1)
    wf.setsampwidth(2)
    wf.setframerate(16000)
    wf.writeframes(b"\\x00\\x00" * (16000 * 5))

# Minimal pure-Python numpy/ctranslate2/faster_whisper stand-ins so the test runs
# without needing GPU weights while still calling real ffmpeg and ffprobe.
fake_np = types.ModuleType("numpy")
fake_np.float32 = "f32"
class _Arr:
    def __init__(self, raw):
        self.size = len(raw) // 4
fake_np.frombuffer = lambda raw, dtype=None: _Arr(raw)
sys.modules["numpy"] = fake_np

fake_ct2 = types.ModuleType("ctranslate2")
fake_ct2.get_cuda_device_count = lambda: 0
sys.modules["ctranslate2"] = fake_ct2

slice_sizes = []
class _Word:
    def __init__(self, start, end, word):
        self.start, self.end, self.word, self.probability = start, end, word, 0.9
class _Seg:
    def __init__(self, dur):
        self.start, self.end = 0.2, min(dur, 1.0)
        self.text = f"slice-{round(dur, 1)}"
        self.no_speech_prob = 0.01
        self.words = [_Word(0.2, 0.6, "hello")]
class _Info:
    language = "en"
    duration = 2.0
class _FakeModel:
    def __init__(self, *a, **kw): pass
    def transcribe(self, samples, **kw):
        dur = samples.size / 16000.0
        slice_sizes.append(round(dur, 2))
        return [_Seg(dur)], _Info()

fake_fw = types.ModuleType("faster_whisper")
fake_fw.WhisperModel = _FakeModel
sys.modules["faster_whisper"] = fake_fw
fake_hf = types.ModuleType("huggingface_hub.errors")
class _LocalErr(Exception): pass
fake_hf.LocalEntryNotFoundError = _LocalErr
sys.modules["huggingface_hub"] = types.ModuleType("huggingface_hub")
sys.modules["huggingface_hub.errors"] = fake_hf

spec = importlib.util.spec_from_file_location("gl", ${JSON.stringify(scriptPath)})
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
env = m._augmented_env()

first = m._transcribe_audio(
    Path(${JSON.stringify(wavPath)}),
    model_name="tiny", device="cpu", compute_type="int8", prompt="", env=env,
    total_duration=5.0, start_offset=0.0, yield_check_cmd=[${JSON.stringify(yieldScript)}], slice_seconds=2.0,
)
second = m._transcribe_audio(
    Path(${JSON.stringify(wavPath)}),
    model_name="tiny", device="cpu", compute_type="int8", prompt="", env=env,
    total_duration=5.0, start_offset=first["nextOffset"], yield_check_cmd=[${JSON.stringify(yieldScript)}], slice_seconds=2.0,
)
print(json.dumps({"first": first, "second": second, "sliceSizes": slice_sizes}))
`;
        const {stdout} = await execFileAsync('python3', ['-c', pyCode], {timeout: 8000});
        const data = JSON.parse(stdout);
        assert.equal(data.first.yielded, true);
        assert.equal(data.first.nextOffset, 2);
        assert.deepEqual(data.first.segments.map(s => [s.start, s.words[0].start]), [[0.2, 0.2]]);
        assert.equal(data.second.yielded, false);
        assert.deepEqual(data.second.segments.map(s => [s.start, s.words[0].start]), [[2.2, 2.2], [4.2, 4.2]]);
        assert.deepEqual(data.sliceSizes, [2, 2, 1]);
    } finally {
        fs.rmSync(tmp, {recursive: true, force: true});
    }
});
