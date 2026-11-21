// Hands each YouTube video the owner starts hearing, and the lyrics the
// overlay settles on for it, to a local ytarchive service, which archives
// it from there, and tells ytarchive when the owner stops hearing a video
// so a live stream clip can finish cleanly. Nothing about the hand-off
// reaches the overlay or the menus; what goes wrong goes to the log
// (docs/architecture.md, "ytarchive hand-off").
//
// A video is added once ever; its lyrics are sent again only when the
// chosen lyrics change. What ytarchive has not taken waits in an outbox,
// tried again at the next change and at service start, never on a timer.
// Stop signals are real-time only and never queued in the outbox.

// Part of each sent-lyrics key, so a change to lrcText() sends every
// song's file again the next time it plays.
export const LRC_FORMAT = 1;
export const MAX_OUTBOX = 500;
// A paused or muted video counts as stopped after this long (so a brief
// pause or ad does not cut a live recording); closing or switching tabs
// sends the stop immediately.
export const STOP_PAUSE_MS = 60_000;

/** ytarchive refused the request itself (HTTP 4xx); asking again would not help. */
export class ArchiveRefused extends Error {}

function lrcLength(seconds) {
    const whole = Math.round(seconds);
    return `${String(Math.floor(whole / 60)).padStart(2, '0')}:${String(whole % 60).padStart(2, '0')}`;
}

/** An LRC file for a stored lyrics candidate (see core.js storedCandidate), or '' without words. */
export function lrcText(candidate) {
    if (!candidate || candidate.instrumental)
        return '';
    const body = ((candidate.timed ? candidate.syncedLyrics : candidate.plainLyrics) ?? '').trim();
    if (!body)
        return '';
    const tags = [['ar', candidate.artistName], ['ti', candidate.trackName], ['al', candidate.albumName],
        ['length', candidate.duration ? lrcLength(candidate.duration) : '']];
    const header = tags
        .map(([name, value]) => [name, String(value ?? '').replace(/[\s\]]+/gu, ' ').trim()])
        .filter(([, value]) => value)
        .map(([name, value]) => `[${name}:${value}]`);
    return `${[...header, body].join('\n')}\n`;
}

function sentKey(candidate, lrc) {
    return lrc ? `${LRC_FORMAT}:${candidate.id}` : '';
}

export class ArchiveSync {
    /**
     * @param {{
     *   store: {loadArchiveRecord(videoId: string): {version: number, videoId: string, added: boolean, lyricsKey: string}|null,
     *           saveArchiveRecord(record: {version: number, videoId: string, added: boolean, lyricsKey: string}): void,
     *           loadArchiveOutbox(): string[]|null, saveArchiveOutbox(videoIds: string[]): void},
     *   client: {add(videoId: string): Promise<void>, lyrics(videoId: string, lrc: string|null): Promise<void>,
     *            stop(videoId: string): Promise<void>},
     *   lyricsFor: (videoId: string) => object|null,
     *   timers: {set(callback: () => void, delayMs: number): unknown, clear(handle: unknown): void},
     *   stopPauseMs?: number,
     *   log: (message: string) => void,
     * }} deps  lyricsFor answers the stored candidate the overlay uses for a video
     */
    constructor(deps) {
        for (const name of ['store', 'client', 'lyricsFor', 'timers', 'log']) {
            if (!deps[name])
                throw new Error(`ArchiveSync needs ${name}`);
        }
        this._deps = deps;
        this._stopPauseMs = deps.stopPauseMs ?? STOP_PAUSE_MS;
        this._outbox = null;
        this._lastSignature = '';
        this._unreachable = false;
        this._chain = Promise.resolve();
        this._hasPresence = false;
        /** @type {Map<string, {timer: unknown}>} */
        this._hearing = new Map();
    }

    /** Sends what an earlier run could not. */
    start() {
        return this._run(() => this._flush());
    }

    /** Clears pending stop-pause timers on service shutdown. */
    shutdown() {
        for (const entry of this._hearing.values()) {
            if (entry.timer !== null) {
                this._deps.timers.clear(entry.timer);
                entry.timer = null;
            }
        }
        this._hearing.clear();
    }

    /**
     * Called with every state the core publishes, while it refreshes the
     * overlay, so all work here is deferred to the chain.
     * @param {{active: boolean, sounding: boolean, videoId: string|null, chosen: {id: number}|null}} state
     */
    observe(state) {
        if (!state.active || !state.videoId) {
            this._lastSignature = '';
            if (!this._hasPresence)
                return this._updatePresence({sounding: [], open: []});
            return this._chain;
        }
        const signature = `${state.videoId} ${state.sounding ? 'heard' : 'quiet'} ${state.chosen?.id ?? 'none'}`;
        if (signature !== this._lastSignature) {
            this._lastSignature = signature;
            const {videoId, sounding} = state;
            this._run(async () => {
                const record = this._record(videoId);
                // Until it is heard a video is not added; once added, a lyrics
                // choice made while paused counts too.
                const due = record.added ? this._lyricsNow(videoId).key !== record.lyricsKey : sounding;
                if (due)
                    this._enqueue(videoId);
                await this._flush();
            });
        }
        if (!this._hasPresence) {
            return this._updatePresence({
                sounding: state.sounding ? [state.videoId] : [],
                open: [state.videoId],
            });
        }
        return this._chain;
    }

    observeVideoLyrics(videoId) {
        if (!videoId)
            return this._chain;
        return this._run(async () => {
            const record = this._record(videoId);
            if (record.added && this._lyricsNow(videoId).key !== record.lyricsKey) {
                this._enqueue(videoId);
                await this._flush();
            }
        });
    }

    /**
     * Tracks all open and sounding YouTube tabs from LyricsCore so background
     * tabs (such as a webcam behind a music tab) also get added when heard and
     * send /api/played-stop when closed or silent past STOP_PAUSE_MS.
     * @param {{sounding: string[], open: string[]}} presence
     */
    observePresence(presence) {
        this._hasPresence = true;
        return this._updatePresence(presence);
    }

    _updatePresence({sounding, open}) {
        const soundingSet = new Set(sounding);
        const openSet = new Set(open);

        for (const videoId of soundingSet) {
            const entry = this._hearing.get(videoId);
            if (!entry) {
                this._hearing.set(videoId, {timer: null});
                if (this._hasPresence) {
                    this._run(async () => {
                        if (!this._record(videoId).added) {
                            this._enqueue(videoId);
                            await this._flush();
                        }
                    });
                }
            } else if (entry.timer !== null) {
                this._deps.timers.clear(entry.timer);
                entry.timer = null;
            }
        }

        for (const [videoId, entry] of [...this._hearing.entries()]) {
            if (!openSet.has(videoId)) {
                if (entry.timer !== null) {
                    this._deps.timers.clear(entry.timer);
                    entry.timer = null;
                }
                this._hearing.delete(videoId);
                this._run(() => this._sendStop(videoId));
            } else if (!soundingSet.has(videoId) && entry.timer === null) {
                entry.timer = this._deps.timers.set(() => {
                    entry.timer = null;
                    if (!this._hearing.has(videoId))
                        return;
                    this._hearing.delete(videoId);
                    this._run(() => this._sendStop(videoId));
                }, this._stopPauseMs);
            }
        }

        return this._chain;
    }

    _run(step) {
        this._chain = this._chain.then(step).catch(error => {
            this._deps.log(`ytarchive hand-off failed: ${error.message}`);
        });
        return this._chain;
    }

    _record(videoId) {
        return this._deps.store.loadArchiveRecord(videoId) ?? {version: 1, videoId, added: false, lyricsKey: ''};
    }

    _lyricsNow(videoId) {
        const candidate = this._deps.lyricsFor(videoId);
        const lrc = lrcText(candidate);
        return {candidate, lrc, key: sentKey(candidate, lrc)};
    }

    _loadOutbox() {
        this._outbox ??= this._deps.store.loadArchiveOutbox() ?? [];
        return this._outbox;
    }

    _enqueue(videoId) {
        const outbox = this._loadOutbox();
        if (outbox.includes(videoId))
            return;
        outbox.push(videoId);
        if (outbox.length > MAX_OUTBOX) {
            const dropped = outbox.splice(0, outbox.length - MAX_OUTBOX);
            this._deps.log(`ytarchive outbox full; dropped ${dropped.length} oldest videos (${dropped.join(', ')})`);
        }
        this._deps.store.saveArchiveOutbox(outbox);
    }

    async _flush() {
        const outbox = this._loadOutbox();
        while (outbox.length) {
            const videoId = outbox[0];
            try {
                await this._sync(videoId);
            } catch (error) {
                if (!(error instanceof ArchiveRefused)) {
                    if (!this._unreachable)
                        this._deps.log(`ytarchive unreachable (${error.message}); ${outbox.length} waiting, tried again at the next change`);
                    this._unreachable = true;
                    return;
                }
                this._deps.log(`ytarchive refused ${videoId}: ${error.message}`);
            }
            if (this._unreachable)
                this._deps.log('ytarchive reachable again');
            this._unreachable = false;
            outbox.shift();
            this._deps.store.saveArchiveOutbox(outbox);
        }
    }

    async _sync(videoId) {
        const {store, client, log} = this._deps;
        const record = this._record(videoId);
        if (!record.added) {
            await client.add(videoId);
            record.added = true;
            store.saveArchiveRecord(record);
            log(`ytarchive: added ${videoId}`);
        }
        const {candidate, lrc, key} = this._lyricsNow(videoId);
        if (key === record.lyricsKey)
            return;
        await client.lyrics(videoId, lrc || null);
        record.lyricsKey = key;
        store.saveArchiveRecord(record);
        log(lrc ? `ytarchive: ${candidate.timed ? 'timed' : 'plain'} lyrics for ${videoId}` : `ytarchive: removed the lyrics for ${videoId}`);
    }

    async _sendStop(videoId) {
        const {client, log} = this._deps;
        if (!this._record(videoId).added)
            return;
        try {
            await client.stop(videoId);
            log(`ytarchive: stopped ${videoId}`);
        } catch (error) {
            if (error instanceof ArchiveRefused)
                log(`ytarchive refused stop for ${videoId}: ${error.message}`);
            else
                log(`ytarchive stop for ${videoId} failed: ${error.message}`);
        }
    }
}
