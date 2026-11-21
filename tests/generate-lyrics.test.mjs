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
