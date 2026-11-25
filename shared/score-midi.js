// Pure-JavaScript Standard MIDI File (SMF Format 1) exporter and shared
// playback-plan builder for Piano Lead Sheets. Runs identically in GJS,
// Node.js, and the browser with zero external dependencies.

const PPQ = 480;
const utf8 = new TextEncoder();

const NOTE_BASE_PC = Object.freeze({
    C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11,
});

/**
 * Parses a lead-sheet chord symbol (e.g. "Dm", "Bb", "F#7", "Gmaj7", "Am/G",
 * "Csus4", "Bdim") into a balanced piano mid-register chord voicing (MIDI notes).
 * @param {string} symbol
 * @param {number} [baseOctaveMidi=48]  C3 = 48
 * @returns {number[]}
 */
export function parseChordSymbolToMidi(symbol, baseOctaveMidi = 48) {
    const raw = String(symbol ?? '').trim();
    if (!raw || raw === 'N' || raw === 'N.C.')
        return [];
    const match = /^([A-Ga-g])([#♯b♭]?)(.*)$/u.exec(raw);
    if (!match)
        return [];
    const letter = match[1].toUpperCase();
    const acc = match[2];
    let rest = match[3].trim();

    let rootPc = NOTE_BASE_PC[letter];
    if (rootPc === undefined)
        return [];
    if (acc === '#' || acc === '\u266f')
        rootPc = (rootPc + 1) % 12;
    else if (acc === 'b' || acc === '\u266d')
        rootPc = (rootPc + 11) % 12;

    // Optional slash bass note (e.g. Am/G)
    let bassPc = null;
    const slashIdx = rest.indexOf('/');
    if (slashIdx >= 0) {
        const bassStr = rest.slice(slashIdx + 1).trim();
        rest = rest.slice(0, slashIdx).trim();
        const bm = /^([A-Ga-g])([#♯b♭]?)$/u.exec(bassStr);
        if (bm) {
            let bpc = NOTE_BASE_PC[bm[1].toUpperCase()];
            if (bm[2] === '#' || bm[2] === '\u266f')
                bpc = (bpc + 1) % 12;
            else if (bm[2] === 'b' || bm[2] === '\u266d')
                bpc = (bpc + 11) % 12;
            bassPc = bpc;
        }
    }

    const q = rest.toLowerCase();
    let intervals;
    if (q.startsWith('dim7') || q.startsWith('o7'))
        intervals = [0, 3, 6, 9];
    else if (q.startsWith('dim') || q.startsWith('o'))
        intervals = [0, 3, 6];
    else if (q.startsWith('aug') || q.startsWith('+'))
        intervals = [0, 4, 8];
    else if (q.startsWith('sus2'))
        intervals = [0, 2, 7];
    else if (q.startsWith('sus4') || q === 'sus')
        intervals = [0, 5, 7];
    else if (q.startsWith('m7b5') || q.startsWith('ø'))
        intervals = [0, 3, 6, 10];
    else if (q.startsWith('mmaj7') || q.startsWith('m(maj7)'))
        intervals = [0, 3, 7, 11];
    else if (q.startsWith('min7') || q.startsWith('m7') || q.startsWith('-7'))
        intervals = [0, 3, 7, 10];
    else if (q.startsWith('min') || q === 'm' || q.startsWith('m6') || q.startsWith('m9') || q === '-')
        intervals = [0, 3, 7];
    else if (q.startsWith('maj7') || q.startsWith('Δ'))
        intervals = [0, 4, 7, 11];
    else if (q.startsWith('7') || q.startsWith('9') || q.startsWith('11') || q.startsWith('13'))
        intervals = [0, 4, 7, 10];
    else if (q === '5')
        intervals = [0, 7];
    else
        intervals = [0, 4, 7];

    // Place chord comfortably around C3..G4 (48..67) so it supports vocal melody cleanly.
    const rootMidi = baseOctaveMidi + rootPc;
    const notes = intervals.map(st => rootMidi + st);
    if (bassPc !== null && bassPc !== rootPc) {
        let bassMidi = baseOctaveMidi - 12 + bassPc;
        if (bassMidi < 36)
            bassMidi += 12;
        notes.unshift(bassMidi);
    }
    return [...new Set(notes)].filter(m => m >= 24 && m <= 108).sort((a, b) => a - b);
}

/**
 * Builds a clean, edit-aware playback plan from an engraved `leadSheet`
 * (`buildLeadSheet()`), reconstructing tied notes into single sustained notes
 * and computing exact chord spans so both the `.mid` file and the browser
 * WebAudio player play the exact music shown on the sheet.
 */
export function buildMidiPlaybackPlan(leadSheet) {
    if (!leadSheet || !Array.isArray(leadSheet.measures) || !leadSheet.measures.length)
        return null;

    const bpm = Math.max(30, Math.min(240, Number(leadSheet.bpm) || 120));
    const meter = Array.isArray(leadSheet.meter) && leadSheet.meter.length === 2 ? leadSheet.meter : [4, 4];
    const barBeats = Number(leadSheet.barBeats) || 4;
    const secPerBeat = 60 / bpm;

    // 1. Reassemble tied melody pieces into continuous notes independently per voice.
    const melody = [];
    const openByVoice = new Map();
    for (const m of leadSheet.measures) {
        if (m.multiRest > 0)
            continue;
        for (const it of (m.items ?? [])) {
            if (it.kind !== 'note')
                continue;
            const start = Number(it.start);
            const end = Number(it.end);
            if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
                continue;
            const voice = Number(it.voice) === 2 ? 2 : 1;
            const openNote = openByVoice.get(voice);
            if (it.tieFromPrev && openNote && openNote.noteId === it.noteId && openNote.midi === it.midi) {
                openNote.end = Math.max(openNote.end, end);
            } else {
                const nextNote = {
                    noteId: it.noteId,
                    voice,
                    barNumber: m.barNumber,
                    start,
                    end,
                    midi: Math.max(24, Math.min(108, Math.round(it.midi))),
                    lyric: String(it.lyric ?? '').trim(),
                };
                melody.push(nextNote);
                openByVoice.set(voice, nextNote);
            }
        }
    }

    // Prevent slight accidental overlap independently within each vocal voice.
    for (const v of [1, 2]) {
        const stream = melody.filter(n => n.voice === v);
        stream.sort((a, b) => a.start - b.start);
        for (let i = 0; i + 1 < stream.length; i++) {
            if (stream[i].end > stream[i + 1].start - 0.015)
                stream[i].end = Math.max(stream[i].start + 0.04, stream[i + 1].start - 0.015);
        }
    }
    melody.sort((a, b) => a.start - b.start || a.voice - b.voice);
    const hasMultipleVoices = melody.some(n => n.voice === 2);

    // 2. Collect chord change events across measures with clean sustained spans.
    const rawChords = [];
    for (const m of leadSheet.measures) {
        const mDur = Math.max(0.2, (Number(m.endTime) - Number(m.startTime)) || (m.barBeats * secPerBeat));
        for (const ch of (m.chords ?? [])) {
            const start = Number(m.startTime) + (Number(ch.beatInBar) / Math.max(1, m.barBeats)) * mDur;
            const midis = parseChordSymbolToMidi(ch.symbol, 48);
            if (midis.length)
                rawChords.push({start, symbol: ch.symbol, midis, barNumber: m.barNumber});
        }
    }
    rawChords.sort((a, b) => a.start - b.start);

    const lastMeasure = leadSheet.measures[leadSheet.measures.length - 1];
    const songEnd = Math.max(
        Number(leadSheet.duration) || 0,
        Number(lastMeasure?.endTime) || 0,
        melody.length ? melody[melody.length - 1].end : 0,
    );

    const chords = [];
    for (let i = 0; i < rawChords.length; i++) {
        const cur = rawChords[i];
        const nextStart = i + 1 < rawChords.length ? rawChords[i + 1].start : songEnd;
        const end = Math.max(cur.start + 0.25, Math.min(nextStart - 0.03, cur.start + barBeats * secPerBeat * 2));
        chords.push({...cur, end});
    }

    // 3. Measure start markers & metronome beats.
    const beats = [];
    for (const m of leadSheet.measures) {
        const mStart = Number(m.startTime);
        const mEnd = Number(m.endTime);
        const mBars = Math.max(1, m.multiRest || 1);
        const totalB = Math.round(mBars * barBeats);
        const stepSec = (mEnd - mStart) / Math.max(1, totalB);
        for (let bi = 0; bi < totalB; bi++) {
            beats.push({
                time: mStart + bi * stepSec,
                downbeat: (bi % Math.max(1, Math.round(barBeats))) === 0,
                barNumber: m.barNumber + Math.floor(bi / Math.max(1, Math.round(barBeats))),
            });
        }
    }

    return {
        bpm,
        meter,
        fifths: leadSheet.keySig?.fifths ?? 0,
        isMinor: leadSheet.key?.type?.includes('minor') ?? false,
        duration: songEnd,
        hasMultipleVoices,
        melody,
        chords,
        beats,
    };
}

// ----- Binary SMF Format 1 encoder

function encodeVlq(value) {
    let v = Math.max(0, Math.round(value));
    const bytes = [v & 0x7f];
    v >>= 7;
    while (v > 0) {
        bytes.unshift((v & 0x7f) | 0x80);
        v >>= 7;
    }
    return bytes;
}

function uint16BE(v) {
    return [(v >> 8) & 0xff, v & 0xff];
}

function uint32BE(v) {
    return [(v >>> 24) & 0xff, (v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff];
}

function metaEvent(typeByte, payloadBytes) {
    return [0xff, typeByte, ...encodeVlq(payloadBytes.length), ...payloadBytes];
}

function buildTrackChunk(timedEvents) {
    // Sort stably by tick, placing Note Off (0x80) before Note On (0x90) at identical ticks.
    const sorted = timedEvents
        .map((ev, idx) => ({...ev, idx}))
        .sort((a, b) => (a.tick - b.tick) || ((a.order ?? 1) - (b.order ?? 1)) || (a.idx - b.idx));

    const data = [];
    let lastTick = 0;
    for (const ev of sorted) {
        const tick = Math.max(lastTick, Math.round(ev.tick));
        data.push(...encodeVlq(tick - lastTick), ...ev.bytes);
        lastTick = tick;
    }
    // End of Track meta-event
    data.push(0x00, 0xff, 0x2f, 0x00);
    return [0x4d, 0x54, 0x72, 0x6b, ...uint32BE(data.length), ...data];
}

/**
 * Encodes a `leadSheet` into a Standard Type-1 MIDI file (`Uint8Array`).
 * Track 0: tempo, meter, key signature.
 * Track 1: melody notes (channel 0) + lyric meta-events.
 * Track 2: chord accompaniment voicings (channel 1), when chords exist.
 *
 * @param {object} leadSheet
 * @param {{title?: string, includeChords?: boolean, includeLyrics?: boolean}} [options]
 * @returns {Uint8Array|null}
 */
export function encodeLeadSheetMidi(leadSheet, {
    title = 'Piano Lead Sheet',
    includeChords = true,
    includeLyrics = true,
} = {}) {
    const plan = buildMidiPlaybackPlan(leadSheet);
    if (!plan)
        return null;

    const secToTick = sec => Math.max(0, Math.round((Math.max(0, sec) * plan.bpm / 60) * PPQ));

    // Track 0: Conductor (Tempo + Time Sig + Key Sig)
    const usPerQuarter = Math.round(60_000_000 / plan.bpm);
    const denPow = Math.round(Math.log2(plan.meter[1] || 4));
    const fifthsByte = (plan.fifths + 256) & 0xff;
    const conductorEvents = [
        {tick: 0, order: 0, bytes: metaEvent(0x03, [...utf8.encode(String(title).slice(0, 120))])},
        {tick: 0, order: 0, bytes: metaEvent(0x51, [(usPerQuarter >> 16) & 0xff, (usPerQuarter >> 8) & 0xff, usPerQuarter & 0xff])},
        {tick: 0, order: 0, bytes: metaEvent(0x58, [plan.meter[0] & 0xff, denPow & 0xff, 24, 8])},
        {tick: 0, order: 0, bytes: metaEvent(0x59, [fifthsByte, plan.isMinor ? 1 : 0])},
    ];

    // Track 1: Vocal Melody / Voice 1 (Channel 0, Acoustic Grand Piano, vel 100) + Lyrics
    const voice1Notes = plan.hasMultipleVoices ? plan.melody.filter(n => n.voice !== 2) : plan.melody;
    const voice2Notes = plan.hasMultipleVoices ? plan.melody.filter(n => n.voice === 2) : [];

    const melodyEvents = [
        {tick: 0, order: 0, bytes: metaEvent(0x03, [...utf8.encode(plan.hasMultipleVoices ? 'Voice 1 (Lead)' : 'Melody')])},
        {tick: 0, order: 0, bytes: [0xc0, 0x00]}, // Program Change ch 0 -> Acoustic Grand Piano
    ];
    for (const n of voice1Notes) {
        const t0 = secToTick(n.start);
        const t1 = Math.max(t0 + 20, secToTick(n.end));
        if (includeLyrics && n.lyric)
            melodyEvents.push({tick: t0, order: 1, bytes: metaEvent(0x05, [...utf8.encode(n.lyric)])});
        melodyEvents.push({tick: t0, order: 2, bytes: [0x90, n.midi & 0x7f, 100]});
        melodyEvents.push({tick: t1, order: 0, bytes: [0x80, n.midi & 0x7f, 0]});
    }

    const tracks = [buildTrackChunk(conductorEvents), buildTrackChunk(melodyEvents)];

    // Optional Track 2: Voice 2 Harmony (Channel 1, Electric Piano 1, vel 88)
    if (voice2Notes.length) {
        const harmonyEvents = [
            {tick: 0, order: 0, bytes: metaEvent(0x03, [...utf8.encode('Voice 2 (Harmony)')])},
            {tick: 0, order: 0, bytes: [0xc1, 0x04]}, // Program Change ch 1 -> Electric Piano 1
        ];
        for (const n of voice2Notes) {
            const t0 = secToTick(n.start);
            const t1 = Math.max(t0 + 20, secToTick(n.end));
            harmonyEvents.push({tick: t0, order: 2, bytes: [0x91, n.midi & 0x7f, 88]});
            harmonyEvents.push({tick: t1, order: 0, bytes: [0x81, n.midi & 0x7f, 0]});
        }
        tracks.push(buildTrackChunk(harmonyEvents));
    }

    // Chords Track (Channel 1 on solo, Channel 2 on multi-voice, Acoustic Grand Piano, vel 66)
    const chordChannel = voice2Notes.length ? 2 : 1;
    if (includeChords && plan.chords.length) {
        const chordEvents = [
            {tick: 0, order: 0, bytes: metaEvent(0x03, [...utf8.encode('Chords')])},
            {tick: 0, order: 0, bytes: [0xc0 | chordChannel, 0x00]},
        ];
        for (const ch of plan.chords) {
            const t0 = secToTick(ch.start);
            const t1 = Math.max(t0 + 60, secToTick(ch.end));
            for (const midi of ch.midis) {
                chordEvents.push({tick: t0, order: 2, bytes: [0x90 | chordChannel, midi & 0x7f, 66]});
                chordEvents.push({tick: t1, order: 0, bytes: [0x80 | chordChannel, midi & 0x7f, 0]});
            }
        }
        tracks.push(buildTrackChunk(chordEvents));
    }

    const header = [
        0x4d, 0x54, 0x68, 0x64, // "MThd"
        ...uint32BE(6),
        ...uint16BE(1), // SMF Format 1
        ...uint16BE(tracks.length),
        ...uint16BE(PPQ),
    ];

    const totalLen = header.length + tracks.reduce((s, tr) => s + tr.length, 0);
    const out = new Uint8Array(totalLen);
    let offset = 0;
    out.set(header, offset);
    offset += header.length;
    for (const tr of tracks) {
        out.set(tr, offset);
        offset += tr.length;
    }
    return out;
}
