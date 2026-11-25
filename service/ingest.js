// Stage 1 (Ingest) of the Ingest -> Analyze -> Display pipeline.
//
// Owns canonical song source selection, vocal-fused lyric candidate merging,
// non-destructive per-song score edit patching, and compact ingest status
// summaries. Preserves on-disk compatibility with videos/<id>.json and
// scores/<id>.json so existing user data and overrides stay intact.

import {plainLyricsFromSynced} from '../shared/lrc.js';
import {generateLrcFromTranscript} from '../shared/lyric-align.js';

export const PRESERVED_SONG_EDIT_KEYS = Object.freeze([
    'tempoMul',
    'meter',
    'keyOverride',
    'clef',
    'beatShift',
]);

/**
 * Selects the highest-trust human reference lyric candidate (custom local file
 * or LRCLIB entry) to guide vocal-isolated lyric fusion and Whisper prompting.
 */
export function selectReferenceLyrics(record, effective = null) {
    if (!record)
        return null;
    const rejected = new Set(record.rejectedIds ?? []);
    if (effective && !effective.generated && !effective.instrumental && (effective.syncedLyrics || effective.plainLyrics))
        return effective;
    const rankedNonGen = (record.candidates ?? []).filter(c =>
        !c.generated && !c.instrumental && !rejected.has(c.id) && (c.syncedLyrics || c.plainLyrics));
    const timed = rankedNonGen.find(c => c.timed && c.matches) ?? rankedNonGen.find(c => c.timed);
    if (timed)
        return timed;
    return rankedNonGen.find(c => c.matches) ?? rankedNonGen[0] ?? null;
}

export function referencePlainLyrics(candidate) {
    if (!candidate)
        return '';
    const plain = String(candidate.plainLyrics ?? '').trim();
    if (plain)
        return plain;
    return candidate.syncedLyrics ? plainLyricsFromSynced(candidate.syncedLyrics) : '';
}

/**
 * Fuses vocal-isolated Whisper segments with any available LRCLIB/custom
 * reference lyrics (exact words + relative line structure) into a timestamped
 * candidate without discarding the original candidates.
 */
export function buildVocalFusedCandidate({
    segments,
    refCandidate = null,
    identity = null,
    duration = 0,
    now,
    seq,
    generatedCandidateScore = 1000,
}) {
    if (!Array.isArray(segments) || !segments.length)
        return null;
    const refSynced = refCandidate?.timed && refCandidate.syncedLyrics ? refCandidate.syncedLyrics : '';
    const refPlain = referencePlainLyrics(refCandidate);
    const built = generateLrcFromTranscript({
        segments,
        duration: Number(duration) || Number(identity?.durationSeconds) || 0,
        plainLyrics: refPlain,
        referenceSyncedLyrics: refSynced,
    });
    if (!built.ok || !built.lrc)
        return null;
    const candidateId = `gen:vocal:${built.mode}:${now}-${seq}`;
    const candidate = {
        id: candidateId,
        trackName: refCandidate?.trackName || identity?.title || identity?.videoTitle || '',
        artistName: refCandidate?.artistName || identity?.artist || identity?.channel || '',
        albumName: built.mode === 'aligned'
            ? 'Vocal-isolated \u00b7 fused with lyrics'
            : 'Vocal-isolated \u00b7 transcribed',
        duration: Math.round(Number(duration) || Number(identity?.durationSeconds) || 0),
        instrumental: false,
        plainLyrics: String(built.plainText ?? '').trim(),
        syncedLyrics: built.lrc,
        score: generatedCandidateScore,
        matches: true,
        timed: true,
        generated: built.mode === 'aligned' ? 'vocal-fused' : 'vocal-transcribed',
    };
    return {candidate, built};
}

/**
 * Inserts/replaces the vocal-isolated generated candidate on `videoRec` while
 * preserving all LRCLIB and custom local-file candidates untouched.
 */
export function upsertVocalFusedCandidate(videoRec, candidate, {
    effective = null,
    activateLyrics = false,
    generateVersion = 1,
    now,
}) {
    const keepCustom = Boolean(effective?.custom) && !activateLyrics;
    const previousGeneratedIds = new Set(videoRec.candidates.filter(c => c.generated).map(c => c.id));
    videoRec.candidates = [...videoRec.candidates.filter(c => !c.generated), candidate];
    videoRec.rejectedIds = videoRec.rejectedIds.filter(id => !previousGeneratedIds.has(id) && id !== candidate.id);
    if (!keepCustom) {
        videoRec.chosenId = candidate.id;
        videoRec.offsetSeconds = 0;
    }
    videoRec.generated = {
        version: generateVersion,
        status: 'ready',
        mode: candidate.generated,
        at: now,
        error: '',
        candidateId: candidate.id,
    };
    return {activated: !keepCustom};
}

/**
 * Extracts song-level edits that should survive a fresh score re-extraction
 * (note/chord ID overrides reset because IDs regenerate on re-analysis).
 */
export function preserveSongLevelEdits(prevEdits) {
    if (!prevEdits || typeof prevEdits !== 'object')
        return {};
    const preserved = {};
    for (const key of PRESERVED_SONG_EDIT_KEYS) {
        if (prevEdits[key] !== undefined)
            preserved[key] = prevEdits[key];
    }
    return preserved;
}

/**
 * Merges a partial patch onto existing per-song score edits without discarding
 * untouched fields. Explicit `null` or `undefined` clears that field.
 */
export function patchScoreEdits(existingEdits, patch) {
    const next = existingEdits && typeof existingEdits === 'object' ? {...existingEdits} : {};
    if (!patch || typeof patch !== 'object')
        return next;
    for (const [key, value] of Object.entries(patch)) {
        if (value === null || value === undefined)
            delete next[key];
        else
            next[key] = value;
    }
    return next;
}

/**
 * Compact Stage-1 summary exposed in `state.ingest` for the UI and diagnostics.
 */
export function summarizeIngest({record = null, effective = null, scoreRecord = null} = {}) {
    if (!record) {
        return {
            lyricSource: 'none',
            candidateCount: 0,
            timedCount: 0,
            hasCustomLyrics: false,
            hasScoreEdits: false,
            keySource: 'none',
        };
    }
    const candidates = Array.isArray(record.candidates) ? record.candidates : [];
    const timedCount = candidates.filter(c => c.timed).length;
    const hasCustomLyrics = candidates.some(c => Boolean(c.custom));
    let lyricSource = 'none';
    if (effective) {
        if (effective.custom)
            lyricSource = 'custom';
        else if (effective.generated === 'vocal-fused')
            lyricSource = 'vocal-fused';
        else if (effective.generated)
            lyricSource = String(effective.generated);
        else
            lyricSource = 'lrclib';
    }
    const edits = scoreRecord?.edits;
    const hasScoreEdits = Boolean(edits && typeof edits === 'object' && Object.keys(edits).length > 0);
    const keySource = edits?.keyOverride
        ? 'override'
        : (scoreRecord?.status === 'ready' && scoreRecord?.key ? 'detected' : 'none');
    return {
        lyricSource,
        candidateCount: candidates.length,
        timedCount,
        hasCustomLyrics,
        hasScoreEdits,
        keySource,
    };
}
