// Stage 2 (Analyze) of the Ingest -> Analyze -> Display pipeline.
//
// Unifies the audio-analysis status across vocal isolation, beat/meter/key/chord
// detection, single/polyphonic vocal melody transcription, and vocal-isolated
// lyric fusion into one clean `state.analysis` contract while keeping legacy
// `state.score` and `state.generation` fields intact for existing clients.

export const ANALYSIS_STAGE_LABELS = Object.freeze({
    idle: 'Idle',
    audio: 'Acquiring audio',
    downloading: 'Downloading audio',
    gpu: 'Waiting for GPU',
    separate: 'Separating vocals',
    beats: 'Detecting beats & meter',
    chords: 'Recognizing chords',
    whisper: 'Transcribing isolated vocals',
    notes: 'Transcribing vocal melody',
    harmony: 'Extracting harmonizing voices',
    align: 'Aligning lyrics & notes',
    finalizing: 'Finalizing lead sheet',
    ready: 'Ready',
    skipped: 'Skipped',
    error: 'Analysis failed',
});

export function analysisStageLabel(stage) {
    if (!stage)
        return '';
    if (ANALYSIS_STAGE_LABELS[stage])
        return ANALYSIS_STAGE_LABELS[stage];
    if (String(stage).startsWith('gpu:'))
        return `Waiting for GPU (${String(stage).slice(4)})`;
    return String(stage);
}

/**
 * Counts how many distinct vocal parts (1 = solo lead, 2 = harmonizing voices)
 * exist in a ready score record.
 */
export function countScoreVoices(scoreRecord) {
    if (!scoreRecord || scoreRecord.status !== 'ready')
        return 0;
    if (Number.isFinite(scoreRecord.voiceCount) && scoreRecord.voiceCount >= 1)
        return Math.round(scoreRecord.voiceCount);
    const voices = new Set();
    for (const n of (scoreRecord.notes ?? [])) {
        const v = Number(n?.voice);
        voices.add(Number.isFinite(v) && v >= 1 ? Math.round(v) : 1);
    }
    return voices.size || (scoreRecord.notes?.length ? 1 : 0);
}

/**
 * Projects the unified Stage-2 `analysis` summary from the live score and
 * lyric-generation state.
 */
export function projectAnalysisState({
    scoreState = null,
    generationState = null,
    scoreRecord = null,
    effectiveLyric = null,
    effectiveKey = null,
} = {}) {
    const scoreStatus = scoreState?.status ?? 'idle';
    const genStatus = generationState?.status ?? 'idle';

    let status = 'idle';
    let stage = 'idle';
    let label = 'Idle';
    let error = '';

    if (scoreStatus === 'running') {
        status = 'running';
        stage = scoreState.stage || 'audio';
        label = scoreState.message || analysisStageLabel(stage);
    } else if (genStatus === 'running') {
        status = 'running';
        stage = generationState.stage || 'whisper';
        label = generationState.message || analysisStageLabel(stage);
    } else if (scoreStatus === 'ready') {
        status = 'ready';
        stage = 'ready';
        const voices = countScoreVoices(scoreRecord);
        label = voices >= 2 ? `Ready (${voices} vocal voices)` : 'Ready';
    } else if (scoreStatus === 'error') {
        status = 'error';
        stage = 'error';
        error = scoreState.message || 'Analysis failed';
        label = error;
    } else if (scoreStatus === 'skipped') {
        status = 'skipped';
        stage = 'skipped';
        error = scoreState.message || '';
        label = error || 'Skipped';
    } else if (genStatus === 'error') {
        status = 'error';
        stage = 'error';
        error = generationState.message || 'Timing failed';
        label = error;
    }

    let lyricsTrack = 'none';
    if (scoreStatus === 'running' || genStatus === 'running')
        lyricsTrack = 'running';
    else if (effectiveLyric?.custom)
        lyricsTrack = 'custom';
    else if (effectiveLyric?.generated)
        lyricsTrack = String(effectiveLyric.generated);
    else if (effectiveLyric)
        lyricsTrack = 'lrclib';

    const melodyTrack = scoreStatus === 'running'
        ? 'running'
        : (scoreStatus === 'ready' || scoreStatus === 'error' || scoreStatus === 'skipped'
            ? scoreStatus
            : 'none');

    const voicesDetected = countScoreVoices(scoreRecord);

    return {
        available: Boolean(scoreState?.available || generationState?.available),
        status,
        stage,
        label,
        quality: scoreState?.quality ?? null,
        voicesDetected,
        tracks: {
            lyrics: lyricsTrack,
            melody: melodyTrack,
        },
        bpm: scoreState?.bpm ?? null,
        key: effectiveKey ?? scoreState?.key ?? null,
        noteCount: scoreState?.noteCount ?? 0,
        chordCount: scoreState?.chordCount ?? 0,
        error,
    };
}
