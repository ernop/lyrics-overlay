// The lyrics service's decisions, free of GNOME and network code so they
// run under both gjs (service/main.js) and node (tests).
//
// Inputs: playback reports from the browser extension, commands from the
// shell extension. Outputs: a state summary and the one line to show, each
// emitted only when it changes. All persistence goes through `store`;
// LRCLIB is reached only through `search`, behind the shared budget.

import {LRCLIB_WINDOWS, ProviderRateLimit, loadedBudgetState, pauseBudget, takeBudget} from '../shared/budget.js';
import {parseSyncedLyrics} from '../shared/lrc.js';
import {OFFSET_STEP_SECONDS, displayAt, nudgedOffset} from '../shared/lyric-display.js';
import {
    buildLookupCandidates, candidateKey, chooseAutomatic, rankRecords, searchSettlesLookup,
} from '../shared/lyric-text.js';
import {deriveIdentity, deriveNextIdentity, describeIdentity} from '../shared/song-identity.js';

export const SEARCH_VERSION = 1;
// The indicator stays this long after YouTube stops sounding.
export const SOUNDING_GRACE_MS = 120_000;
// A tab that promised a heartbeat (report heartbeatMs) and misses this many
// is gone: the browser quit, crashed or slept without saying goodbye.
export const MISSED_HEARTBEATS = 3;
// LRCLIB answers change only when someone contributes lyrics.
export const SEARCH_CACHE_MS = 7 * 24 * 3600 * 1000;
export const MISS_RECHECK_MS = 7 * 24 * 3600 * 1000;
export const ERROR_RECHECK_MS = 10 * 60 * 1000;
export const MAX_STORED_CANDIDATES = 10;

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
    return {version: 1, videoId, identity: null, lookup: null, candidates: [], chosenId: null, rejectedIds: [], offsetSeconds: 0, userRequested: false};
}

export class LyricsCore {
    /**
     * @param {{
     *   store: {loadVideo(id: string): object|null, saveVideo(record: object): void,
     *           loadSearch(key: string): {at: number, records: object[]}|null,
     *           saveSearch(key: string, entry: {at: number, records: object[]}): void,
     *           loadBudget(): object|null, saveBudget(state: object): void},
     *   search: (candidate: {artist: string, title: string}) => Promise<object[]>,
     *   clock: {now(): number},
     *   timers: {set(callback: () => void, delayMs: number): unknown, clear(handle: unknown): void},
     *   emit: {state(state: object): void, line(line: {text: string, key: string}): void},
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
        this._budget = loadedBudgetState(deps.store.loadBudget());
        this._sessions = new Map();
        this._videos = new Map();
        this._lines = new Map();
        this._queue = [];
        this._running = null;
        this._waitingUntil = 0;
        this._timers = {line: null, activity: null, budget: null};
        this._lastState = '';
        this._lastLine = {text: '', key: 'none'};
        this._pitch = {capturing: false, error: '', microphone: ''};
        /** @type {{videoId: string, root: number, type: 'major'|'minor'}|null} */
        this._songKey = null;
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
            session = {tabId, videoId: media.videoId, identity: null, next: null, media: null, heartbeatMs: null, receivedAt: now, lastSoundingAt: 0};
            this._sessions.set(tabId, session);
        }
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
        // heard (and the one after it) is worth a lookup.
        if (this._sounding(session)) {
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
        case 'choose':
            if (!record || !record.candidates.some(candidate => candidate.id === command.id))
                return {ok: false};
            record.chosenId = command.id;
            record.rejectedIds = record.rejectedIds.filter(id => id !== command.id);
            break;
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
            this._deps.store.saveVideo(record);
            this._enqueue({videoId: session.videoId, identity: session.identity, force: command.op === 'searchAgain', current: true});
            this._refresh();
            return {ok: true};
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

    /** Every kept session is sounding or within its grace period (see _pruneSessions). */
    _activeSession() {
        let best = null;
        for (const session of this._sessions.values()) {
            const sounding = this._sounding(session);
            if (!best || (sounding && !best.sounding) ||
                (sounding === best.sounding && session.lastSoundingAt > best.session.lastSoundingAt))
                best = {session, sounding};
        }
        return best ? best.session : null;
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
        if (session.identity.musical && session.next) {
            const nextIdentity = this._video(session.next.videoId).identity ?? deriveNextIdentity(session.next);
            if (nextIdentity.musical)
                this._enqueue({videoId: session.next.videoId, identity: nextIdentity, force: false, current: false});
        }
    }

    /** @param {{videoId: string, identity: object, force: boolean, current: boolean}} request */
    _enqueue(request) {
        const now = this._deps.clock.now();
        if (this._running?.videoId === request.videoId && !request.force)
            return;
        if (!this._lookupWanted(this._video(request.videoId), request.identity, request.force, now))
            return;
        let job = {...request, queuedAt: now};
        const existing = this._queue.findIndex(entry => entry.videoId === request.videoId);
        if (existing >= 0) {
            const earlier = this._queue[existing];
            job = {...job, force: earlier.force || request.force, current: earlier.current || request.current, queuedAt: earlier.queuedAt};
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
        const candidates = buildLookupCandidates(job.identity);
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
            if (searchSettlesLookup(records, candidate, duration))
                break;
        }

        const record = this._video(job.videoId);
        const queries = candidates.map(candidateKey);
        if (!answered.length) {
            record.lookup = {status: failures ? 'error' : 'none', at: clock.now(), queries, version: SEARCH_VERSION};
            store.saveVideo(record);
            return {outcome: record.lookup.status, searched, cached: cachedCount};
        }
        const ranked = rankRecords(answered, duration);
        const kept = ranked.slice(0, MAX_STORED_CANDIDATES).map(storedCandidate);
        const chosen = record.candidates.find(candidate => candidate.id === record.chosenId);
        if (chosen && !kept.some(candidate => candidate.id === chosen.id))
            kept.push(chosen);
        record.candidates = kept;
        const autoId = chooseAutomatic(ranked, []);
        const auto = kept.find(candidate => candidate.id === autoId);
        record.lookup = {status: auto ? (auto.timed ? 'timed' : 'plain') : 'none', at: clock.now(), queries, version: SEARCH_VERSION};
        store.saveVideo(record);
        return {outcome: record.lookup.status, searched, cached: cachedCount};
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
        if (effective)
            return effective.timed ? 'timed' : 'plain';
        if (!record.lookup)
            return 'searching';
        return record.lookup.status === 'error' ? 'error' : 'none';
    }

    _stateJson(now) {
        const session = this._activeSession();
        if (!session) {
            return JSON.stringify({active: false, sounding: false, videoId: null, identityText: '', musical: false,
                lyrics: 'idle', chosen: null, userChose: false, offsetSeconds: 0, candidates: [], pitch: this._pitch, key: null});
        }
        const record = this._video(session.videoId);
        const effective = this._effective(record);
        const rejected = new Set(record.rejectedIds);
        return JSON.stringify({
            active: true,
            sounding: this._sounding(session),
            videoId: session.videoId,
            identityText: session.identity ? describeIdentity(session.identity) : '',
            musical: Boolean(session.identity?.musical),
            lyrics: this._lyricsStatus(session, record, effective),
            chosen: effective ? {id: effective.id, label: candidateLabel(effective), timed: effective.timed} : null,
            userChose: record.chosenId !== null && effective?.id === record.chosenId,
            offsetSeconds: record.offsetSeconds,
            candidates: record.candidates.map(candidate => ({
                id: candidate.id,
                label: candidateLabel(candidate),
                timed: candidate.timed,
                matches: candidate.matches,
                rejected: rejected.has(candidate.id),
                current: effective?.id === candidate.id,
            })),
            pitch: this._pitch,
            key: this._songKey?.videoId === session.videoId ? {root: this._songKey.root, type: this._songKey.type} : null,
        });
    }

    _lineAt(session, now) {
        if (!session || session.media.adShowing || session.media.ended)
            return {text: '', key: 'none', nextChangeAt: Infinity};
        const record = this._video(session.videoId);
        const lines = this._linesFor(this._effective(record));
        return displayAt({lines, offsetSeconds: record.offsetSeconds, mediaTime: this._mediaTime(session, now)});
    }

    _refresh() {
        const {clock, timers, emit} = this._deps;
        const now = clock.now();
        this._pruneSessions(now);
        this._dropUnwantedJobs();
        const session = this._activeSession();

        const state = this._stateJson(now);
        if (state !== this._lastState) {
            this._lastState = state;
            emit.state(JSON.parse(state));
        }

        const line = this._lineAt(session, now);
        // A line is keyed by the session so a new video always transitions.
        const key = session ? `${session.videoId}:${line.key}` : 'none';
        if (line.text !== this._lastLine.text || key !== this._lastLine.key) {
            this._lastLine = {text: line.text, key};
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
