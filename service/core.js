// The lyrics service's decisions, free of GNOME and network code so they
// run under both gjs (service/main.js) and node (tests).
//
// Inputs: playback reports from the browser extension, commands from the
// shell extension. Outputs: a state summary and the one line to show, each
// emitted only when it changes. All persistence goes through `store`;
// LRCLIB is reached only through `search`, behind the shared budget.

import {LRCLIB_WINDOWS, ProviderRateLimit, loadedBudgetState, pauseBudget, takeBudget} from '../shared/budget.js';
import {parseSyncedLyrics, plainLyricsFromSynced, shiftSyncedLyrics} from '../shared/lrc.js';
import {OFFSET_STEP_SECONDS, displayAt, nudgedOffset} from '../shared/lyric-display.js';
import {
    buildLookupCandidates, candidateKey, chooseAutomatic, rankRecords, searchSettlesLookup,
} from '../shared/lyric-text.js';
import {deriveIdentity, deriveNextIdentity, describeIdentity} from '../shared/song-identity.js';

export const SEARCH_VERSION = 1;
export const GENERATE_VERSION = 1;
// The indicator stays this long after YouTube stops sounding.
export const SOUNDING_GRACE_MS = 120_000;
// A tab that promised a heartbeat (report heartbeatMs) and misses this many
// is gone: the browser quit, crashed or slept without saying goodbye.
export const MISSED_HEARTBEATS = 3;
// LRCLIB answers change only when someone contributes lyrics.
export const SEARCH_CACHE_MS = 7 * 24 * 3600 * 1000;
export const MISS_RECHECK_MS = 7 * 24 * 3600 * 1000;
export const ERROR_RECHECK_MS = 10 * 60 * 1000;
export const GENERATE_ERROR_RECHECK_MS = 10 * 60 * 1000;
export const DEFAULT_MAX_GENERATE_DURATION_SECONDS = 900;
// Above MIN_ACCEPT_SCORE (0.58) so an auto-timed set wins over untimed LRCLIB
// text, below strong LRCLIB timed matches so a later LRCLIB timed match wins.
export const GENERATED_CANDIDATE_SCORE = 0.62;
export const MAX_STORED_CANDIDATES = 20;

const LRC_META_TAG = /^\s*\[(ar|ti|al|length|by|re|ve|offset):([^\]]*)\]\s*$/iu;
const KANJI_RE = /[\u4e00-\u9fff\u3400-\u4dbf\u3005]/u;
const SYNTHETIC_ALBUM_RE = /^(?:Auto-transcribed from audio|Auto-timed from lyrics|Local file|Edited lyrics|File:\s.*)$/iu;

function realAlbumName(candidateAlbum, identityAlbum) {
    const clean = String(candidateAlbum ?? '').trim();
    if (clean && !SYNTHETIC_ALBUM_RE.test(clean))
        return clean;
    return String(identityAlbum ?? '').trim();
}

function parseEditedText(rawText) {
    const normalized = String(rawText ?? '').replace(/\r\n?/gu, '\n').trim();
    if (!normalized)
        return {ok: false, error: 'Lyrics cannot be empty'};
    const bodyLines = normalized.split('\n').filter(line => !LRC_META_TAG.test(line));
    const body = bodyLines.join('\n').trim();
    if (!body)
        return {ok: false, error: 'Lyrics cannot be empty'};
    const timedLines = parseSyncedLyrics(body);
    const timed = timedLines.length > 0;
    const syncedLyrics = timed ? shiftSyncedLyrics(body, 0) : '';
    const plainLyrics = timed ? plainLyricsFromSynced(syncedLyrics) : body;
    if (!plainLyrics.trim())
        return {ok: false, error: 'Lyrics have no sung lines'};
    const lineCount = timed
        ? timedLines.filter(line => line.text.trim()).length
        : plainLyrics.split('\n').filter(line => line.trim()).length;
    return {ok: true, timed, syncedLyrics, plainLyrics, lineCount};
}

function parseLrcLengthTag(value) {
    const match = /^(\d+):(\d{1,2})(?:\.\d+)?$/u.exec(String(value ?? '').trim());
    return match ? Number(match[1]) * 60 + Number(match[2]) : 0;
}

function parseImportedLyrics(filename, rawText, identity) {
    const normalized = String(rawText ?? '').replace(/\r\n?/gu, '\n').trim();
    if (!normalized)
        return {ok: false, error: 'Lyric file is empty'};
    const meta = {artist: '', title: '', album: '', duration: 0};
    const bodyLines = [];
    for (const line of normalized.split('\n')) {
        const tag = LRC_META_TAG.exec(line);
        if (tag) {
            const key = tag[1].toLowerCase();
            const val = tag[2].trim();
            if (key === 'ar' && val)
                meta.artist = val;
            else if (key === 'ti' && val)
                meta.title = val;
            else if (key === 'al' && val)
                meta.album = val;
            else if (key === 'length' && val)
                meta.duration = parseLrcLengthTag(val);
            continue;
        }
        bodyLines.push(line);
    }
    const body = bodyLines.join('\n').trim();
    if (!body)
        return {ok: false, error: 'Lyric file has no lyrics'};
    const timedLines = parseSyncedLyrics(body);
    const timed = timedLines.length > 0;
    const plainLyrics = timed
        ? timedLines.map(line => line.text).filter(Boolean).join('\n')
        : body;
    const cleanName = String(filename ?? '').trim().replace(/^.*[/\\]/u, '');
    const stem = cleanName.replace(/\.(?:lrc|txt)$/iu, '').trim();
    return {
        ok: true,
        timed,
        syncedLyrics: timed ? body : null,
        plainLyrics,
        trackName: meta.title || stem || identity?.title || identity?.videoTitle || 'Imported lyrics',
        artistName: meta.artist || identity?.artist || '',
        albumName: cleanName ? `File: ${cleanName}` : (meta.album || 'Local file'),
        duration: meta.duration || Math.round(Number(identity?.durationSeconds) || 0),
    };
}

function storedCandidate(entry) {
    const {record} = entry;
    return {
        id: record.id,
        trackName: record.trackName || record.name || '',
        artistName: record.artistName || '',
        albumName: record.albumName || '',
        duration: Number(record.duration) || 0,
        instrumental: Boolean(record.instrumental),
        plainLyrics: (record.plainLyrics || '').trim(),
        syncedLyrics: entry.timed ? record.syncedLyrics : null,
        score: Math.round(entry.score * 1000) / 1000,
        matches: entry.matches,
        timed: entry.timed,
    };
}

function formatDuration(seconds) {
    const whole = Math.round(seconds);
    return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, '0')}`;
}

export function candidateLabel(candidate) {
    return [candidate.artistName, candidate.trackName, candidate.albumName, candidate.duration ? formatDuration(candidate.duration) : '']
        .filter(Boolean)
        .join(' - ');
}

function newVideoRecord(videoId) {
    return {version: 1, videoId, identity: null, lookup: null, generated: null, candidates: [], chosenId: null, rejectedIds: [], offsetSeconds: 0, userRequested: false};
}

function formatProgressClock(seconds) {
    const total = Math.max(0, Math.floor(seconds));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor((total % 3600) / 60);
    const secs = total % 60;
    if (hours > 0)
        return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
    return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function formatBytesProgress(done, total) {
    if (total > 0) {
        const pct = Math.min(100, Math.round((Math.min(done, total) / total) * 100));
        if (total >= 1_000_000) {
            const digits = total >= 10_000_000 ? 0 : 1;
            return `${(done / 1_000_000).toFixed(digits)} / ${(total / 1_000_000).toFixed(digits)} MB (${pct}%)`;
        }
        return `${Math.round(done / 1_000)} / ${Math.round(total / 1_000)} kB (${pct}%)`;
    }
    if (done >= 1_000_000)
        return `${(done / 1_000_000).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(done / 1_000))} kB`;
}

function generationStageMessage(hasPlain, stage) {
    const verb = hasPlain ? 'Aligning lyrics' : 'Timing lyrics';
    const raw = String(stage ?? '');
    const audioProgress = /^audio:(\d+)\/(\d+)$/u.exec(raw);
    if (audioProgress) {
        const done = Number(audioProgress[1]);
        const total = Number(audioProgress[2]);
        if (Number.isFinite(done) && Number.isFinite(total) && (done > 0 || total > 0))
            return `${verb} \u00b7 loading audio ${formatBytesProgress(done, total)}`;
    }
    if (raw.startsWith('gpu-wait:')) {
        const why = raw.slice('gpu-wait:'.length).trim();
        if (why)
            return `${verb} \u00b7 waiting for GPU (${why})`;
    }
    const progress = /^transcribe:(\d+(?:\.\d+)?)\/(\d+(?:\.\d+)?)$/u.exec(raw);
    if (progress) {
        const done = Number(progress[1]);
        const total = Number(progress[2]);
        if (Number.isFinite(done) && Number.isFinite(total) && total > 0) {
            const clamped = Math.min(total, Math.max(0, done));
            const pct = Math.min(100, Math.round((clamped / total) * 100));
            return `${verb} \u00b7 ${formatProgressClock(clamped)} / ${formatProgressClock(total)} (${pct}%)`;
        }
    }
    switch (raw) {
    case 'audio':
        return `${verb} \u00b7 loading audio`;
    case 'gpu-wait':
        return `${verb} \u00b7 waiting for GPU`;
    case 'transcribe':
    default:
        return `${verb}\u2026`;
    }
}

export class LyricsCore {
    /**
     * @param {{
     *   store: {loadVideo(id: string): object|null, saveVideo(record: object): void,
     *           loadSearch(key: string): {at: number, records: object[]}|null,
     *           saveSearch(key: string, entry: {at: number, records: object[]}): void,
     *           loadBudget(): object|null, saveBudget(state: object): void},
     *   search: (candidate: {artist: string, title: string}) => Promise<object[]>,
     *   generate?: (request: {videoId: string, identity: object, plainLyrics: string,
     *                         onStage: (stage: string) => void}) => {promise: Promise<object>, cancel: () => void},
     *   maxGenerateDurationSeconds?: number,
     *   furigana?: {cached(text: string): Array<[string, string]>|null,
     *               annotate(text: string): Promise<Array<[string, string]>|null>,
     *               warm(lines: string[]): Promise<boolean>},
     *   furiganaEnabled?: boolean,
     *   clock: {now(): number},
     *   timers: {set(callback: () => void, delayMs: number): unknown, clear(handle: unknown): void},
     *   emit: {state(state: object): void, line(line: {text: string, key: string, ruby?: Array<[string, string]>}): void,
     *          presence?: (presence: {sounding: string[], open: string[]}) => void},
     *   log: (message: string) => void,
     *   budgetWindows?: ReadonlyArray<{seconds: number, limit: number}>,
     * }} deps
     */
    constructor(deps) {
        for (const name of ['store', 'search', 'clock', 'timers', 'emit', 'log']) {
            if (!deps[name])
                throw new Error(`LyricsCore needs ${name}`);
        }
        this._deps = deps;
        this._budgetWindows = deps.budgetWindows ?? LRCLIB_WINDOWS;
        this._maxGenerateDurationSeconds = deps.maxGenerateDurationSeconds ?? DEFAULT_MAX_GENERATE_DURATION_SECONDS;
        this._furiganaEnabled = Boolean(deps.furiganaEnabled);
        this._furiganaWarmedKey = '';
        this._budget = loadedBudgetState(deps.store.loadBudget());
        this._sessions = new Map();
        this._videos = new Map();
        this._lines = new Map();
        this._queue = [];
        this._running = null;
        this._generating = null;
        this._generateSeq = 0;
        this._customSeq = 0;
        this._userRequestedNow = null;
        this._waitingUntil = 0;
        this._timers = {line: null, activity: null, budget: null};
        this._lastState = '';
        this._lastPresence = '';
        this._lastLine = {text: '', key: 'none'};
        this._lastLineJson = JSON.stringify(this._lastLine);
        this._pitch = {capturing: false, error: '', microphone: ''};
        /** @type {{videoId: string, root: number, type: 'major'|'minor'}|null} */
        this._songKey = null;
    }

    /** Stops any active lyric generation subprocess cleanly on service shutdown. */
    shutdown() {
        this._cancelGeneration('service stopping');
    }

    // ----- browser reports

    /**
     * @param {number} tabId
     * @param {{sampledAt: number, heartbeatMs: number|null, media: object, metadata?: object, next?: object}} message
     */
    report(tabId, message) {
        const now = this._deps.clock.now();
        const media = message.media;
        if (!media.videoId) {
            this._sessions.delete(tabId);
            this._refresh();
            return;
        }
        let session = this._sessions.get(tabId);
        if (!session || session.videoId !== media.videoId) {
            session = {
                tabId,
                videoId: media.videoId,
                identity: null,
                next: null,
                media: null,
                heartbeatMs: null,
                receivedAt: now,
                soundingSince: 0,
                lastSoundingAt: 0,
            };
            this._sessions.set(tabId, session);
        }
        const wasSounding = this._sounding(session);
        // Every report carries metadata so a restarted service recovers at
        // once; the record is written only when the identity changes.
        if (message.metadata && message.metadata.videoId === media.videoId) {
            session.identity = deriveIdentity(message.metadata);
            const record = this._video(media.videoId);
            if (JSON.stringify(record.identity) !== JSON.stringify(session.identity)) {
                record.identity = session.identity;
                this._deps.store.saveVideo(record);
            }
        }
        if (message.next !== undefined)
            session.next = message.next && message.next.videoId !== media.videoId ? message.next : null;
        session.media = {...media, sampledAt: message.sampledAt};
        session.heartbeatMs = message.heartbeatMs;
        session.receivedAt = now;
        // Paused, muted and background tabs report too; only the song being
        // heard (and the one after it) is worth a lookup. soundingSince tracks
        // when playback actually started (never overwritten by heartbeats) so
        // simultaneously playing tabs never ping-pong on every heartbeat.
        if (this._sounding(session)) {
            if (!wasSounding)
                session.soundingSince = now;
            session.lastSoundingAt = now;
            this._requestLookups(session);
        }
        this._refresh();
    }

    tabGone(tabId) {
        if (this._sessions.delete(tabId))
            this._refresh();
    }

    // ----- shell commands

    command(command) {
        const session = this._activeSession();
        const record = session ? this._video(session.videoId) : null;
        switch (command.op) {
        // Too fast: each line appears before it is sung, so lower the
        // offset to show every line later (voice-wei's convention).
        case 'tooFast':
        case 'tooSlow':
            if (!record)
                return {ok: false};
            record.offsetSeconds = nudgedOffset(record.offsetSeconds,
                command.op === 'tooFast' ? -OFFSET_STEP_SECONDS : OFFSET_STEP_SECONDS);
            break;
        case 'resetOffset':
            if (!record)
                return {ok: false};
            record.offsetSeconds = 0;
            break;
        case 'choose': {
            const chosen = record?.candidates.find(candidate => candidate.id === command.id);
            if (!record || !chosen)
                return {ok: false};
            record.chosenId = command.id;
            record.rejectedIds = record.rejectedIds.filter(id => id !== command.id);
            if (chosen.timed && this._generating?.videoId === session.videoId)
                this._cancelGeneration('timed lyrics selected');
            break;
        }
        case 'reject': {
            const effective = record ? this._effective(record) : null;
            if (!effective)
                return {ok: false};
            record.rejectedIds = [...new Set([...record.rejectedIds, effective.id])];
            if (record.chosenId === effective.id)
                record.chosenId = null;
            break;
        }
        case 'searchAgain':
        case 'lookUp':
            if (!record || !session.identity)
                return {ok: false};
            record.userRequested = true;
            this._userRequestedNow = session.videoId;
            this._deps.store.saveVideo(record);
            this._enqueue({videoId: session.videoId, identity: session.identity, force: command.op === 'searchAgain', current: true});
            if (session.next) {
                const nextIdentity = this._video(session.next.videoId).identity ?? deriveNextIdentity(session.next);
                if (nextIdentity.musical)
                    this._enqueue({videoId: session.next.videoId, identity: nextIdentity, force: false, current: false});
            }
            this._refresh();
            return {ok: true};
        case 'searchQuery': {
            if (!record || !session.identity)
                return {ok: false, error: 'No active video'};
            const artist = String(command.artist ?? '').trim();
            const title = String(command.title ?? '').trim();
            if (!title)
                return {ok: false, error: 'Enter a song title to search LRCLIB'};
            record.userRequested = true;
            this._userRequestedNow = session.videoId;
            this._deps.store.saveVideo(record);
            this._enqueue({
                videoId: session.videoId,
                identity: session.identity,
                force: false,
                current: true,
                customCandidates: [{artist, title}],
            });
            this._refresh();
            return {ok: true};
        }
        case 'importLyrics': {
            if (!record)
                return {ok: false, error: 'No active video'};
            const parsed = parseImportedLyrics(command.filename, command.text, session.identity);
            if (!parsed.ok)
                return parsed;
            const now = this._deps.clock.now();
            const candidateId = `file:${now}-${++this._customSeq}`;
            const candidate = {
                id: candidateId,
                trackName: parsed.trackName,
                artistName: parsed.artistName,
                albumName: parsed.albumName,
                duration: parsed.duration,
                instrumental: false,
                plainLyrics: parsed.plainLyrics,
                syncedLyrics: parsed.syncedLyrics,
                score: 1,
                matches: true,
                timed: parsed.timed,
                custom: true,
            };
            record.candidates = [candidate, ...record.candidates];
            record.chosenId = candidateId;
            record.rejectedIds = record.rejectedIds.filter(id => id !== candidateId);
            record.userRequested = true;
            if (this._generating?.videoId === session.videoId)
                this._cancelGeneration(parsed.timed ? 'timed lyrics imported' : 'plain lyrics imported');
            if (!parsed.timed) {
                if (record.generated?.status === 'ready')
                    record.generated = null;
                this._userRequestedNow = session.videoId;
            }
            this._deps.store.saveVideo(record);
            this._refresh();
            return {ok: true, id: candidateId, timed: parsed.timed};
        }
        case 'saveEditedLyrics': {
            if (!record)
                return {ok: false, error: 'No active video'};
            const parsed = parseEditedText(command.text);
            if (!parsed.ok)
                return parsed;
            const now = this._deps.clock.now();
            const candidateId = `edit:${now}-${++this._customSeq}`;
            const current = this._effective(record);
            const trackName = String(command.trackName ?? '').trim()
                || current?.trackName || session.identity?.title || session.identity?.videoTitle || 'Edited lyrics';
            const artistName = String(command.artistName ?? '').trim()
                || current?.artistName || session.identity?.artist || '';
            const albumName = String(command.albumName ?? '').trim()
                || realAlbumName(current?.albumName, session.identity?.album) || 'Edited lyrics';
            const rawDuration = Number(command.duration);
            const duration = Number.isFinite(rawDuration) && rawDuration > 0
                ? Math.round(rawDuration)
                : Math.round(Number(current?.duration) || Number(session.identity?.durationSeconds) || 0);
            const candidate = {
                id: candidateId,
                trackName,
                artistName,
                albumName,
                duration,
                instrumental: false,
                plainLyrics: parsed.plainLyrics,
                syncedLyrics: parsed.timed ? parsed.syncedLyrics : null,
                score: 1,
                matches: true,
                timed: parsed.timed,
                custom: true,
            };
            record.candidates = [candidate, ...record.candidates];
            record.chosenId = candidateId;
            record.rejectedIds = record.rejectedIds.filter(id => id !== candidateId);
            record.offsetSeconds = 0;
            record.userRequested = true;
            if (this._generating?.videoId === session.videoId)
                this._cancelGeneration('edited lyrics saved');
            this._deps.store.saveVideo(record);
            this._refresh();
            return {ok: true, id: candidateId, timed: parsed.timed, lineCount: parsed.lineCount};
        }
        case 'generate':
        case 'generateFromScratch':
            if (!this._deps.generate)
                return {ok: false, error: 'automatic lyric timing is not configured'};
            if (!record || !session.identity)
                return {ok: false};
            if (this._generating?.videoId === session.videoId)
                return {ok: true};
            if (this._generating)
                this._cancelGeneration('replaced by user request');
            record.userRequested = true;
            this._deps.store.saveVideo(record);
            this._startGeneration(session.videoId, session.identity, record, {
                force: true,
                fromScratch: command.op === 'generateFromScratch',
                startAt: this._mediaTime(session, this._deps.clock.now()),
            });
            this._refresh();
            return {ok: true};
        case 'cancelGenerate': {
            if (!this._generating)
                return {ok: true, cancelled: false};
            const {videoId} = this._generating;
            this._cancelGeneration('cancelled by user');
            const target = this._video(videoId);
            if (!target.generated || (target.generated.status !== 'ready' && target.generated.status !== 'skipped')) {
                target.generated = {
                    version: GENERATE_VERSION,
                    status: 'skipped',
                    mode: null,
                    at: this._deps.clock.now(),
                    error: 'Cancelled',
                    candidateId: null,
                };
                this._deps.store.saveVideo(target);
            }
            this._refresh();
            return {ok: true, cancelled: true};
        }
        default:
            return {ok: false, error: `unknown command ${command.op}`};
        }
        this._deps.store.saveVideo(record);
        this._refresh();
        return {ok: true};
    }

    /** @param {{capturing: boolean, error: string, microphone: string}} pitch */
    setPitchStatus(pitch) {
        this._pitch = {capturing: pitch.capturing, error: pitch.error, microphone: pitch.microphone};
        this._refresh();
    }

    /** The key heard in a video's sound (song-key.js), or null when nothing is listening. */
    setSongKey(key) {
        this._songKey = key && {videoId: key.videoId, root: key.root, type: key.type};
        this._refresh();
    }

    /** Turns offline Japanese furigana annotation on or off for emitted lyric lines. */
    setFuriganaEnabled(enabled) {
        const next = Boolean(enabled);
        if (this._furiganaEnabled === next)
            return;
        this._furiganaEnabled = next;
        if (!next)
            this._furiganaWarmedKey = '';
        this._refresh();
    }

    /**
     * Complete active lyric set for the Full Lyrics reader and Review/Publish
     * editor (`GET /api/lyrics`).
     */
    activeLyrics() {
        const session = this._activeSession();
        if (!session)
            return {active: false, videoId: null, identity: null, offsetSeconds: 0, currentLineKey: 'none', currentLineIndex: -1, publishedAt: null, candidate: null};
        const record = this._video(session.videoId);
        const effective = this._effective(record);
        const currentLineKey = this._lastLine?.key ?? 'none';
        const indexMatch = /:line:(\d+)$/u.exec(currentLineKey);
        const currentLineIndex = indexMatch ? Number(indexMatch[1]) : -1;
        const identity = session.identity ? {
            artist: session.identity.artist || '',
            title: session.identity.title || session.identity.videoTitle || '',
            album: session.identity.album || '',
            durationSeconds: Math.round(Number(session.identity.durationSeconds) || Number(session.media?.duration) || 0),
        } : null;
        if (!effective) {
            return {
                active: true,
                videoId: session.videoId,
                identity,
                offsetSeconds: record.offsetSeconds,
                currentLineKey,
                currentLineIndex,
                publishedAt: record.publishedAt ?? null,
                candidate: null,
            };
        }
        const rubyFor = text => (this._furiganaEnabled && this._deps.furigana && text && KANJI_RE.test(text)
            ? this._deps.furigana.cached(text)
            : null);
        let lines;
        if (effective.timed) {
            lines = this._linesFor(effective).map((entry, index) => {
                const ruby = rubyFor(entry.text);
                return {
                    index,
                    time: entry.time,
                    effectiveTime: Math.max(0, entry.time - record.offsetSeconds),
                    text: entry.text,
                    ...(ruby ? {ruby} : {}),
                };
            });
        } else {
            const plainLines = String(effective.plainLyrics ?? '')
                .replace(/\r\n?/gu, '\n')
                .split('\n')
                .map(text => text.trim());
            if (this._furiganaEnabled && this._deps.furigana) {
                const warmKey = `${session.videoId}:${effective.id}:plain`;
                if (warmKey !== this._furiganaWarmedKey) {
                    this._furiganaWarmedKey = warmKey;
                    this._deps.furigana.warm(plainLines.filter(Boolean)).then(added => {
                        if (added && this._furiganaEnabled)
                            this._refresh();
                    }).catch(() => {});
                }
            }
            lines = plainLines.map((text, index) => {
                const ruby = rubyFor(text);
                return {
                    index,
                    time: null,
                    effectiveTime: null,
                    text,
                    ...(ruby ? {ruby} : {}),
                };
            });
        }
        const bakedSyncedLyrics = effective.timed && effective.syncedLyrics
            ? shiftSyncedLyrics(effective.syncedLyrics, record.offsetSeconds)
            : '';
        return {
            active: true,
            videoId: session.videoId,
            identity,
            offsetSeconds: record.offsetSeconds,
            currentLineKey,
            currentLineIndex,
            publishedAt: record.publishedAt ?? null,
            candidate: {
                id: effective.id,
                label: candidateLabel(effective),
                artistName: effective.artistName || identity?.artist || '',
                trackName: effective.trackName || identity?.title || '',
                albumName: effective.albumName || '',
                realAlbumName: realAlbumName(effective.albumName, identity?.album),
                duration: Math.round(Number(effective.duration) || identity?.durationSeconds || 0),
                timed: Boolean(effective.timed),
                custom: Boolean(effective.custom),
                generated: effective.generated ?? null,
                syncedLyrics: effective.syncedLyrics ?? '',
                bakedSyncedLyrics,
                plainLyrics: effective.plainLyrics || (bakedSyncedLyrics ? plainLyricsFromSynced(bakedSyncedLyrics) : ''),
                lines,
            },
        };
    }

    /**
     * Publishes user-reviewed lyrics anonymously to LRCLIB behind the shared
     * persistent rate-limit budget. Never called automatically.
     */
    async publishToLrclib(input) {
        if (!this._deps.publish)
            return {ok: false, status: 501, error: 'LRCLIB publishing is not configured'};
        const trackName = String(input?.trackName ?? '').trim();
        const artistName = String(input?.artistName ?? '').trim();
        const albumName = String(input?.albumName ?? '').trim();
        const duration = Math.round(Number(input?.duration));
        if (!artistName)
            return {ok: false, status: 400, error: 'Enter the artist name before publishing to LRCLIB'};
        if (!trackName)
            return {ok: false, status: 400, error: 'Enter the track title before publishing to LRCLIB'};
        if (!albumName)
            return {ok: false, status: 400, error: 'Enter the album (or single) name before publishing to LRCLIB'};
        if (SYNTHETIC_ALBUM_RE.test(albumName))
            return {ok: false, status: 400, error: 'Replace the placeholder album name with the real release or single name'};
        if (!Number.isFinite(duration) || duration <= 0)
            return {ok: false, status: 400, error: 'Duration must be a positive number of seconds'};
        const parsed = parseEditedText(input?.text ?? input?.syncedLyrics ?? input?.plainLyrics);
        if (!parsed.ok)
            return {ok: false, status: 400, error: parsed.error};

        const {store, clock, log} = this._deps;
        const now = clock.now();
        // Publishing sends two HTTP requests (/api/request-challenge + /api/publish).
        for (let i = 0; i < 2; i++) {
            const decision = takeBudget(this._budget, this._budgetWindows, now);
            this._budget = decision.state;
            store.saveBudget(this._budget);
            if (!decision.allowed) {
                const waitSec = Math.max(1, Math.ceil((decision.retryAtMs - now) / 1000));
                return {ok: false, status: 429, error: `LRCLIB request budget spent; try again in ${waitSec} s`};
            }
        }

        const startedAt = clock.now();
        try {
            await this._deps.publish({
                trackName,
                artistName,
                albumName,
                duration,
                plainLyrics: parsed.plainLyrics,
                syncedLyrics: parsed.timed ? parsed.syncedLyrics : '',
            });
        } catch (error) {
            if (error instanceof ProviderRateLimit) {
                this._budget = pauseBudget(this._budget, error.retryAtMs);
                store.saveBudget(this._budget);
                const waitSec = Math.max(1, Math.ceil((error.retryAtMs - clock.now()) / 1000));
                return {ok: false, status: 429, error: `LRCLIB rate-limited the publish request; try again in ${waitSec} s`};
            }
            log(`lrclib: publish failed: ${error.message}`);
            return {ok: false, status: 502, error: error.message};
        }

        const publishedAt = clock.now();
        const session = this._activeSession();
        const videoId = session?.videoId ?? null;
        if (videoId) {
            const record = this._video(videoId);
            record.publishedAt = publishedAt;
            store.saveVideo(record);
            this._refresh();
        }
        log(`lrclib: published ${videoId ?? 'manual'} (${parsed.timed ? 'timed' : 'plain'}, ${parsed.lineCount} lines, ${publishedAt - startedAt} ms)`);
        return {ok: true, status: 201, timed: parsed.timed, lineCount: parsed.lineCount, publishedAt};
    }

    state() {
        return JSON.parse(this._lastState || this._stateJson(this._deps.clock.now()));
    }

    /** The browser tab whose song the overlay shows, or null. */
    activeTabId() {
        return this._activeSession()?.tabId ?? null;
    }

    /** The stored lyrics candidate the overlay uses for a video, or null. */
    lyricsFor(videoId) {
        return this._effective(this._video(videoId));
    }

    line() {
        return {...this._lastLine};
    }

    // ----- sessions and time

    _sounding(session) {
        const media = session.media;
        return Boolean(media) && !media.paused && !media.ended && !media.muted && media.volume > 0;
    }

    /**
     * Forgets a tab that broke its heartbeat promise, so its clock never
     * runs on unreported, and one quiet past the grace period. A later
     * report starts it afresh from the stored records.
     */
    _pruneSessions(now) {
        for (const [tabId, session] of this._sessions) {
            const lapsed = session.heartbeatMs !== null && now - session.receivedAt > MISSED_HEARTBEATS * session.heartbeatMs;
            const quiet = !this._sounding(session) && now - session.lastSoundingAt >= SOUNDING_GRACE_MS;
            if (lapsed || quiet)
                this._sessions.delete(tabId);
        }
    }

    _isMusical(session) {
        return Boolean(session.identity?.musical || this._video(session.videoId).userRequested);
    }

    /**
     * Ranks kept sessions without using heartbeat timestamps:
     * - Tier 2: sounding musical tabs, ordered by when playback started
     *   (soundingSince), so a background non-music tab (webcam, livestream)
     *   never steals from a playing song and two playing songs never ping-pong.
     * - Tier 1: paused musical tabs in grace (lastSoundingAt) vs sounding
     *   non-music tabs (soundingSince), so an older background stream never
     *   hijacks a just-paused song while a newly started video takes over.
     * - Tier 0: paused non-music tabs (lastSoundingAt).
     */
    _sessionRank(session) {
        const sounding = this._sounding(session);
        const musical = this._isMusical(session);
        if (sounding && musical)
            return {tier: 2, time: session.soundingSince, sounding: 1, tabId: session.tabId};
        if (sounding || musical)
            return {tier: 1, time: sounding ? session.soundingSince : session.lastSoundingAt, sounding: sounding ? 1 : 0, tabId: session.tabId};
        return {tier: 0, time: session.lastSoundingAt, sounding: 0, tabId: session.tabId};
    }

    /** Every kept session is sounding or within its grace period (see _pruneSessions). */
    _activeSession() {
        let best = null;
        let bestRank = null;
        for (const session of this._sessions.values()) {
            const rank = this._sessionRank(session);
            if (!bestRank ||
                rank.tier > bestRank.tier ||
                (rank.tier === bestRank.tier && (
                    rank.time > bestRank.time ||
                    (rank.time === bestRank.time && (
                        rank.sounding > bestRank.sounding ||
                        (rank.sounding === bestRank.sounding && rank.tabId > bestRank.tabId)
                    ))
                ))) {
                best = session;
                bestRank = rank;
            }
        }
        return best;
    }

    _mediaTime(session, now) {
        const media = session.media;
        if (media.paused || media.ended || media.stalled || media.adShowing)
            return media.currentTime;
        return media.currentTime + (now - media.sampledAt) / 1000 * media.playbackRate;
    }

    _advancing(session) {
        const media = session.media;
        return !media.paused && !media.ended && !media.stalled && !media.adShowing && media.playbackRate > 0;
    }

    // ----- video records and lyrics

    _video(videoId) {
        let record = this._videos.get(videoId);
        if (!record) {
            record = this._deps.store.loadVideo(videoId) ?? newVideoRecord(videoId);
            this._videos.set(videoId, record);
        }
        return record;
    }

    _effective(record) {
        const rejected = new Set(record.rejectedIds);
        if (record.chosenId !== null && !rejected.has(record.chosenId)) {
            const chosen = record.candidates.find(candidate => candidate.id === record.chosenId);
            if (chosen)
                return chosen;
        }
        const ranked = record.candidates.map(candidate => ({record: candidate, score: candidate.score, matches: candidate.matches, timed: candidate.timed}));
        const id = chooseAutomatic(ranked, record.rejectedIds);
        return id === null ? null : record.candidates.find(candidate => candidate.id === id);
    }

    _linesFor(candidate) {
        if (!candidate?.timed)
            return [];
        const key = `${candidate.id}`;
        let lines = this._lines.get(key);
        if (!lines) {
            lines = parseSyncedLyrics(candidate.syncedLyrics);
            this._lines.set(key, lines);
        }
        return lines;
    }

    _lookupWanted(record, identity, force, now) {
        if (force || !record.lookup || record.lookup.version !== SEARCH_VERSION)
            return true;
        const keys = buildLookupCandidates(identity).map(candidateKey);
        if (keys.some(key => !record.lookup.queries.includes(key)) && record.lookup.status !== 'timed')
            return true;
        if (record.lookup.status === 'error')
            return now - record.lookup.at > ERROR_RECHECK_MS;
        if (record.lookup.status === 'none' || record.lookup.status === 'plain')
            return now - record.lookup.at > MISS_RECHECK_MS;
        return false;
    }

    _requestLookups(session) {
        if (!session.identity)
            return;
        const record = this._video(session.videoId);
        if (session.identity.musical || record.userRequested)
            this._enqueue({videoId: session.videoId, identity: session.identity, force: false, current: true});
        if ((session.identity.musical || record.userRequested) && session.next) {
            const nextIdentity = this._video(session.next.videoId).identity ?? deriveNextIdentity(session.next);
            if (nextIdentity.musical)
                this._enqueue({videoId: session.next.videoId, identity: nextIdentity, force: false, current: false});
        }
    }

    /** @param {{videoId: string, identity: object, force: boolean, current: boolean, customCandidates?: Array<{artist: string, title: string}>}} request */
    _enqueue(request) {
        const now = this._deps.clock.now();
        const isCustom = Array.isArray(request.customCandidates) && request.customCandidates.length > 0;
        if (!isCustom && this._running?.videoId === request.videoId && !request.force)
            return;
        if (!isCustom && !this._lookupWanted(this._video(request.videoId), request.identity, request.force, now))
            return;
        let job = {...request, queuedAt: now};
        const existing = this._queue.findIndex(entry => entry.videoId === request.videoId);
        if (existing >= 0) {
            const earlier = this._queue[existing];
            job = {
                ...job,
                force: earlier.force || request.force,
                current: earlier.current || request.current,
                queuedAt: earlier.queuedAt,
                customCandidates: job.customCandidates ?? earlier.customCandidates,
            };
            this._queue.splice(existing, 1);
        }
        if (job.current)
            this._queue.unshift(job);
        else
            this._queue.push(job);
        this._pump();
    }

    /** Videos a kept session plays or plays next: the only ones worth a lookup. */
    _wantedVideos() {
        const wanted = new Set();
        for (const session of this._sessions.values()) {
            wanted.add(session.videoId);
            if (session.next)
                wanted.add(session.next.videoId);
        }
        return wanted;
    }

    _dropUnwantedJobs() {
        const wanted = this._wantedVideos();
        const kept = this._queue.filter(job => wanted.has(job.videoId));
        if (kept.length === this._queue.length)
            return;
        this._deps.log(`dropped ${this._queue.length - kept.length} queued lookups for videos no longer playing`);
        this._queue = kept;
    }

    _pump() {
        const {clock, log} = this._deps;
        if (this._running || !this._queue.length || this._waitingUntil > clock.now())
            return;
        const job = this._queue.shift();
        this._running = job;
        this._refresh();
        const startedAt = clock.now();
        this._runJob(job).then(({outcome, searched, cached}) => {
            log(`lookup ${job.videoId}: ${outcome}; ${searched} searched, ${cached} cached, ` +
                `${clock.now() - startedAt} ms after ${startedAt - job.queuedAt} ms queued`);
        }).catch(error => {
            log(`lookup for ${job.videoId} failed: ${error.message}`);
        }).finally(() => {
            this._running = null;
            this._refresh();
            this._pump();
        });
    }

    /**
     * Searches the job's queries in order until one settles the lookup.
     * @returns {Promise<{outcome: string, searched: number, cached: number}>}
     */
    async _runJob(job) {
        const {store, search, clock, log} = this._deps;
        const isCustom = Array.isArray(job.customCandidates) && job.customCandidates.length > 0;
        const candidates = isCustom ? job.customCandidates : buildLookupCandidates(job.identity);
        const duration = job.identity.durationSeconds;
        const answered = [];
        let searched = 0;
        let cachedCount = 0;
        let failures = 0;
        for (const candidate of candidates) {
            // The song can end or be skipped while a search is out; the
            // record stays unlooked-up, so a later play finishes the lookup.
            if (!this._wantedVideos().has(job.videoId))
                return {outcome: 'stopped, no longer playing', searched, cached: cachedCount};
            const key = candidateKey(candidate);
            const cached = store.loadSearch(key);
            let records;
            if (cached && !job.force && clock.now() - cached.at < SEARCH_CACHE_MS) {
                records = cached.records;
                cachedCount++;
            } else {
                const decision = takeBudget(this._budget, this._budgetWindows, clock.now());
                this._budget = decision.state;
                store.saveBudget(this._budget);
                if (!decision.allowed) {
                    this._waitFor(decision.retryAtMs, job, 'LRCLIB request budget spent');
                    return {outcome: 'waiting for the request budget', searched, cached: cachedCount};
                }
                searched++;
                try {
                    records = await search(candidate);
                } catch (error) {
                    if (error instanceof ProviderRateLimit) {
                        this._budget = pauseBudget(this._budget, error.retryAtMs);
                        store.saveBudget(this._budget);
                        this._waitFor(error.retryAtMs, job, 'LRCLIB refused for its rate limit (HTTP 429)');
                        return {outcome: 'paused by LRCLIB', searched, cached: cachedCount};
                    }
                    failures++;
                    log(`LRCLIB search "${candidate.artist}" / "${candidate.title}" failed: ${error.message}`);
                    continue;
                }
                store.saveSearch(key, {at: clock.now(), records});
            }
            answered.push({candidate, records});
            if (!isCustom && searchSettlesLookup(records, candidate, duration))
                break;
        }

        const record = this._video(job.videoId);
        const queries = candidates.map(candidateKey);
        const mergedQueries = isCustom
            ? [...new Set([...(record.lookup?.queries ?? []), ...queries])]
            : queries;
        if (!answered.length) {
            const status = failures ? 'error' : 'none';
            if (!isCustom || !record.lookup)
                record.lookup = {status, at: clock.now(), queries: mergedQueries, version: SEARCH_VERSION};
            store.saveVideo(record);
            return {outcome: status, searched, cached: cachedCount};
        }
        const ranked = rankRecords(answered, duration);
        const kept = ranked.slice(0, MAX_STORED_CANDIDATES).map(storedCandidate);
        if (isCustom) {
            for (const existing of record.candidates) {
                if (kept.some(candidate => candidate.id === existing.id))
                    continue;
                const pinned = existing.id === record.chosenId || existing.generated || existing.custom;
                if (pinned || kept.length < MAX_STORED_CANDIDATES)
                    kept.push(existing);
            }
        } else {
            for (const extra of record.candidates.filter(candidate => candidate.id === record.chosenId || candidate.generated || candidate.custom)) {
                if (!kept.some(candidate => candidate.id === extra.id))
                    kept.push(extra);
            }
        }
        record.candidates = kept;
        const rankedAll = kept.map(candidate => ({record: candidate, score: candidate.score, matches: candidate.matches, timed: candidate.timed}));
        const autoId = chooseAutomatic(isCustom ? rankedAll : ranked, []);
        const auto = kept.find(candidate => candidate.id === autoId);
        record.lookup = {status: auto ? (auto.timed ? 'timed' : 'plain') : 'none', at: clock.now(), queries: mergedQueries, version: SEARCH_VERSION};
        store.saveVideo(record);
        return {outcome: record.lookup.status, searched, cached: cachedCount};
    }

    // ----- automatic lyric timing / generation

    _cancelGeneration(reason) {
        const active = this._generating;
        if (!active)
            return;
        this._generating = null;
        this._deps.log(`generate ${active.videoId}: cancelled (${reason})`);
        active.handle.cancel();
    }

    _plainCandidateFor(record) {
        const effective = this._effective(record);
        if (effective && !effective.timed && !effective.instrumental && effective.plainLyrics)
            return effective;
        const rejected = new Set(record.rejectedIds);
        return record.candidates.find(candidate =>
            !candidate.generated && !candidate.timed && !candidate.instrumental &&
            candidate.plainLyrics && candidate.matches && !rejected.has(candidate.id)) ?? null;
    }

    _generationWanted(session, record, now) {
        if (!this._deps.generate || !session.identity)
            return false;
        const requestedNow = this._userRequestedNow === session.videoId;
        if (!this._sounding(session) && !requestedNow)
            return false;
        if (!session.identity.musical && !record.userRequested)
            return false;
        if (this._running?.videoId === session.videoId || this._queue.some(job => job.videoId === session.videoId))
            return false;
        const effective = this._effective(record);
        if (effective?.timed || effective?.instrumental)
            return false;
        const hasCustomPlain = Boolean(effective?.custom && !effective.timed && effective.plainLyrics);
        if (!hasCustomPlain && (!record.lookup || record.lookup.status === 'error'))
            return false;
        const gen = record.generated;
        if (gen && gen.version === GENERATE_VERSION) {
            if (gen.status === 'ready')
                return false;
            if (gen.status === 'skipped') {
                const duration = Number(session.identity.durationSeconds) || Number(session.media?.duration) || 0;
                const wasDurationSkip = Boolean(gen.maxDurationSeconds) || /^Video is longer than /u.test(gen.error ?? '');
                const nowWithinCap = wasDurationSkip && duration > 0
                    && (this._maxGenerateDurationSeconds <= 0 || duration <= this._maxGenerateDurationSeconds);
                if (!nowWithinCap)
                    return false;
            }
            if (gen.status === 'error' && now - gen.at <= GENERATE_ERROR_RECHECK_MS)
                return false;
        }
        return true;
    }

    _syncGeneration(session, now) {
        if (!this._deps.generate)
            return;
        if (this._userRequestedNow && (!session || session.videoId !== this._userRequestedNow))
            this._userRequestedNow = null;
        if (this._generating && !this._generating.force && (!session || session.videoId !== this._generating.videoId))
            this._cancelGeneration(session ? 'switched to another video' : 'playback ended');
        if (this._generating && session && session.videoId === this._generating.videoId && !this._generating.force) {
            if (this._effective(this._video(session.videoId))?.timed)
                this._cancelGeneration('timed lyrics available');
        }
        if (this._generating || !session)
            return;
        const record = this._video(session.videoId);
        if (!this._generationWanted(session, record, now))
            return;
        if (this._userRequestedNow === session.videoId)
            this._userRequestedNow = null;
        const duration = Number(session.identity.durationSeconds) || Number(session.media?.duration) || 0;
        if (this._maxGenerateDurationSeconds > 0 && duration > this._maxGenerateDurationSeconds) {
            const mins = Math.round(this._maxGenerateDurationSeconds / 60);
            record.generated = {
                version: GENERATE_VERSION,
                status: 'skipped',
                mode: null,
                at: now,
                error: `Video is longer than ${mins} minutes`,
                maxDurationSeconds: this._maxGenerateDurationSeconds,
                candidateId: null,
            };
            this._deps.store.saveVideo(record);
            this._deps.log(`generate ${session.videoId}: skipped (${record.generated.error})`);
            return;
        }
        this._startGeneration(session.videoId, session.identity, record, {
            force: false,
            startAt: this._mediaTime(session, now),
        });
    }

    _startGeneration(videoId, identity, record, {force, fromScratch = false, startAt = 0}) {
        const plainCandidate = fromScratch ? null : this._plainCandidateFor(record);
        const plainLyrics = plainCandidate?.plainLyrics ?? '';
        const startedAt = this._deps.clock.now();
        const job = {
            videoId,
            label: describeIdentity(identity) || videoId,
            force,
            hasPlain: Boolean(plainLyrics),
            stage: 'audio',
            partial: null,
            handle: null,
        };
        this._generating = job;
        const handle = this._deps.generate({
            videoId,
            identity,
            plainLyrics,
            force,
            startAt,
            onStage: stage => {
                if (this._generating !== job || job.stage === stage)
                    return;
                job.stage = stage;
                this._refresh();
            },
            onPartial: partial => {
                if (this._generating !== job || !partial?.lrc)
                    return;
                const lines = parseSyncedLyrics(partial.lrc);
                if (!lines.length)
                    return;
                job.partial = {
                    lrc: partial.lrc,
                    lines,
                    coveredRanges: Array.isArray(partial.coveredRanges) ? partial.coveredRanges : [],
                    lineCount: Number(partial.lineCount) || lines.length,
                };
                this._refresh();
            },
        });
        job.handle = handle;
        handle.promise.then(result => {
            if (this._generating !== job)
                return;
            this._generating = null;
            this._finishGeneration(videoId, identity, plainCandidate, result, {force, elapsedMs: this._deps.clock.now() - startedAt});
        }).catch(error => {
            if (this._generating !== job)
                return;
            this._generating = null;
            this._finishGeneration(videoId, identity, plainCandidate, {ok: false, error: error.message},
                {force, elapsedMs: this._deps.clock.now() - startedAt});
        });
    }

    _finishGeneration(videoId, identity, plainCandidate, result, {force, elapsedMs}) {
        const {store, clock, log} = this._deps;
        const now = clock.now();
        const record = this._video(videoId);
        if (result?.cancelled)
            return;
        if (!result?.ok || !result.lrc) {
            const status = result?.skip ? 'skipped' : 'error';
            const error = String(result?.error || 'Could not generate timed lyrics');
            record.generated = {version: GENERATE_VERSION, status, mode: null, at: now, error, candidateId: null};
            store.saveVideo(record);
            log(`generate ${videoId}: ${status} (${error}), ${elapsedMs} ms`);
            this._refresh();
            return;
        }

        const seq = `${now}-${++this._generateSeq}`;
        const candidateId = `gen:${result.mode}:${seq}`;
        const candidate = {
            id: candidateId,
            trackName: plainCandidate?.trackName || identity.title || identity.videoTitle || '',
            artistName: plainCandidate?.artistName || identity.artist || identity.channel || '',
            albumName: result.mode === 'aligned' ? 'Auto-timed from lyrics' : 'Auto-transcribed from audio',
            duration: Math.round(Number(result.duration) || Number(identity.durationSeconds) || 0),
            instrumental: false,
            plainLyrics: String(result.plainText ?? '').trim(),
            syncedLyrics: result.lrc,
            score: GENERATED_CANDIDATE_SCORE,
            matches: true,
            timed: true,
            generated: result.mode,
        };
        const previousGeneratedIds = new Set(record.candidates.filter(c => c.generated).map(c => c.id));
        record.candidates = [...record.candidates.filter(c => !c.generated), candidate];
        record.rejectedIds = record.rejectedIds.filter(id => !previousGeneratedIds.has(id) && id !== candidateId);
        if (force || previousGeneratedIds.has(record.chosenId) || (plainCandidate && record.chosenId === plainCandidate.id))
            record.chosenId = candidateId;
        record.generated = {
            version: GENERATE_VERSION,
            status: 'ready',
            mode: result.mode,
            at: now,
            error: '',
            candidateId,
        };
        store.saveVideo(record);
        this._deps.emit.videoUpdated?.(videoId);
        const alignedNote = result.coverage !== undefined ? `, ${Math.round(result.coverage * 100)}% aligned` : '';
        log(`generate ${videoId}: ${result.mode}, ${result.lineCount} lines${alignedNote}, ${elapsedMs} ms`);
        this._refresh();
    }

    _waitFor(retryAtMs, job, reason) {
        this._queue.unshift(job);
        this._waitingUntil = retryAtMs;
        this._deps.log(`${reason}; resuming lookups at ${new Date(retryAtMs).toISOString()}`);
        if (this._timers.budget !== null)
            this._deps.timers.clear(this._timers.budget);
        this._timers.budget = this._deps.timers.set(() => {
            this._timers.budget = null;
            this._waitingUntil = 0;
            this._pump();
        }, Math.max(0, retryAtMs - this._deps.clock.now()));
    }

    // ----- outputs

    _lyricsStatus(session, record, effective) {
        if (!session.identity)
            return 'idle';
        if (!session.identity.musical && !record.userRequested)
            return 'not-music';
        if (this._running?.videoId === session.videoId)
            return 'searching';
        if (this._queue.some(job => job.videoId === session.videoId))
            return this._waitingUntil ? 'waiting' : 'searching';
        if (this._generating?.videoId === session.videoId)
            return 'generating';
        if (effective)
            return effective.timed ? 'timed' : 'plain';
        if (!record.lookup)
            return 'searching';
        return record.lookup.status === 'error' ? 'error' : 'none';
    }

    _partialCovers(partial, mediaTime) {
        if (!partial?.lines?.length)
            return false;
        if (partial.coveredRanges.length)
            return partial.coveredRanges.some(([start, end]) => mediaTime >= start - 4.0 && mediaTime <= end + 2.0);
        return mediaTime >= partial.lines[0].time - 4.0 && mediaTime <= partial.lines[partial.lines.length - 1].time + 8.0;
    }

    _generationState(session, record, now) {
        const available = Boolean(this._deps.generate);
        const background = this._generating && this._generating.videoId !== session?.videoId
            ? {
                videoId: this._generating.videoId,
                label: this._generating.label,
                mode: this._generating.hasPlain ? 'aligned' : 'transcribed',
                stage: this._generating.stage,
                message: generationStageMessage(this._generating.hasPlain, this._generating.stage),
            }
            : null;
        if (!session || !record) {
            return {
                available,
                status: 'idle',
                mode: null,
                stage: null,
                message: '',
                ...(background ? {background} : {}),
            };
        }
        if (this._generating?.videoId === session.videoId) {
            const effective = this._effective(record);
            const previewing = Boolean(
                !effective?.timed
                && this._generating.partial
                && this._partialCovers(this._generating.partial, this._mediaTime(session, now)),
            );
            return {
                available,
                status: 'running',
                mode: this._generating.hasPlain ? 'aligned' : 'transcribed',
                stage: this._generating.stage,
                message: generationStageMessage(this._generating.hasPlain, this._generating.stage),
                force: Boolean(this._generating.force),
                ...(previewing ? {previewing: true} : {}),
            };
        }
        const gen = record.generated;
        if (!gen) {
            return {
                available,
                status: 'idle',
                mode: null,
                stage: null,
                message: '',
                ...(background ? {background} : {}),
            };
        }
        return {
            available,
            status: gen.status,
            mode: gen.mode ?? null,
            stage: null,
            message: gen.error ?? '',
            ...(background ? {background} : {}),
        };
    }

    _stateJson(now) {
        const session = this._activeSession();
        if (!session) {
            return JSON.stringify({active: false, sounding: false, videoId: null, identityText: '', musical: false,
                lyrics: 'idle', chosen: null, userChose: false, offsetSeconds: 0, candidates: [],
                publishAvailable: Boolean(this._deps.publish), publishedAt: null,
                generation: this._generationState(null, null, now), pitch: this._pitch, key: null});
        }
        const record = this._video(session.videoId);
        const effective = this._effective(record);
        const rejected = new Set(record.rejectedIds);
        return JSON.stringify({
            active: true,
            sounding: this._sounding(session),
            videoId: session.videoId,
            identityText: session.identity ? describeIdentity(session.identity) : '',
            musical: this._isMusical(session),
            lyrics: this._lyricsStatus(session, record, effective),
            chosen: effective ? {id: effective.id, label: candidateLabel(effective), timed: effective.timed} : null,
            userChose: record.chosenId !== null && effective?.id === record.chosenId,
            offsetSeconds: record.offsetSeconds,
            publishAvailable: Boolean(this._deps.publish),
            publishedAt: record.publishedAt ?? null,
            candidates: record.candidates.map(candidate => ({
                id: candidate.id,
                label: candidateLabel(candidate),
                timed: candidate.timed,
                lineCount: candidate.timed ? this._linesFor(candidate).filter(line => line.text).length : 0,
                matches: candidate.matches,
                rejected: rejected.has(candidate.id),
                current: effective?.id === candidate.id,
                ...(candidate.generated ? {generated: candidate.generated} : {}),
                ...(candidate.custom ? {custom: true} : {}),
            })),
            generation: this._generationState(session, record, now),
            pitch: this._pitch,
            key: this._songKey?.videoId === session.videoId ? {root: this._songKey.root, type: this._songKey.type} : null,
        });
    }

    _presenceJson() {
        const sounding = new Set();
        const open = new Set();
        for (const session of this._sessions.values()) {
            open.add(session.videoId);
            if (this._sounding(session))
                sounding.add(session.videoId);
        }
        return JSON.stringify({
            sounding: [...sounding].sort(),
            open: [...open].sort(),
        });
    }

    _lineAt(session, now) {
        if (!session || session.media.adShowing || session.media.ended)
            return {text: '', key: 'none', nextChangeAt: Infinity};
        const record = this._video(session.videoId);
        const effective = this._effective(record);
        const mediaTime = this._mediaTime(session, now);
        if (effective?.timed)
            return displayAt({lines: this._linesFor(effective), offsetSeconds: record.offsetSeconds, mediaTime});
        const partial = this._generating?.videoId === session.videoId ? this._generating.partial : null;
        if (partial && this._partialCovers(partial, mediaTime))
            return displayAt({lines: partial.lines, offsetSeconds: record.offsetSeconds, mediaTime});
        return {text: '', key: 'none', nextChangeAt: Infinity};
    }

    _refresh() {
        const {clock, timers, emit} = this._deps;
        const now = clock.now();
        this._pruneSessions(now);
        this._dropUnwantedJobs();
        const session = this._activeSession();
        this._syncGeneration(session, now);

        const state = this._stateJson(now);
        if (state !== this._lastState) {
            this._lastState = state;
            emit.state(JSON.parse(state));
        }

        if (emit.presence) {
            const presence = this._presenceJson();
            if (presence !== this._lastPresence) {
                this._lastPresence = presence;
                emit.presence(JSON.parse(presence));
            }
        }

        const line = this._lineAt(session, now);
        let ruby = null;
        if (this._furiganaEnabled && this._deps.furigana) {
            if (session) {
                const effective = this._effective(this._video(session.videoId));
                if (effective?.timed) {
                    const warmKey = `${session.videoId}:${effective.id}`;
                    if (warmKey !== this._furiganaWarmedKey) {
                        this._furiganaWarmedKey = warmKey;
                        const texts = this._linesFor(effective).map(entry => entry.text).filter(Boolean);
                        this._deps.furigana.warm(texts).then(added => {
                            if (added && this._furiganaEnabled)
                                this._refresh();
                        }).catch(() => {});
                    }
                }
            }
            if (line.text && KANJI_RE.test(line.text)) {
                ruby = this._deps.furigana.cached(line.text);
                if (!ruby) {
                    this._deps.furigana.annotate(line.text).then(segments => {
                        if (segments && this._furiganaEnabled)
                            this._refresh();
                    }).catch(() => {});
                }
            }
        }
        // A line is keyed by the session so a new video always transitions.
        const key = session ? `${session.videoId}:${line.key}` : 'none';
        const nextLine = ruby ? {text: line.text, key, ruby} : {text: line.text, key};
        const nextLineJson = JSON.stringify(nextLine);
        if (nextLineJson !== this._lastLineJson) {
            this._lastLine = nextLine;
            this._lastLineJson = nextLineJson;
            emit.line({...this._lastLine});
        }

        if (this._timers.line !== null) {
            timers.clear(this._timers.line);
            this._timers.line = null;
        }
        if (session && this._advancing(session) && Number.isFinite(line.nextChangeAt)) {
            const mediaNow = this._mediaTime(session, now);
            const delayMs = Math.max(0, Math.ceil((line.nextChangeAt - mediaNow) / session.media.playbackRate * 1000)) + 1;
            this._timers.line = timers.set(() => {
                this._timers.line = null;
                this._refresh();
            }, delayMs);
        }

        if (this._timers.activity !== null) {
            timers.clear(this._timers.activity);
            this._timers.activity = null;
        }
        const changeAt = this._nextPruneAt();
        if (Number.isFinite(changeAt)) {
            this._timers.activity = timers.set(() => {
                this._timers.activity = null;
                this._refresh();
            }, Math.max(0, changeAt - now) + 1);
        }
    }

    /** Wall time at which _pruneSessions next has a tab to drop, unless a report comes first. */
    _nextPruneAt() {
        let next = Infinity;
        for (const session of this._sessions.values()) {
            if (session.heartbeatMs !== null)
                next = Math.min(next, session.receivedAt + MISSED_HEARTBEATS * session.heartbeatMs);
            if (!this._sounding(session))
                next = Math.min(next, session.lastSoundingAt + SOUNDING_GRACE_MS);
        }
        return next;
    }
}
