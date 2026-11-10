// Hands each YouTube video the owner starts hearing, and the lyrics the
// overlay settles on for it, to a local ytarchive service, which archives
// it from there. Nothing about the hand-off reaches the overlay or the
// menus; what goes wrong goes to the log (docs/architecture.md,
// "ytarchive hand-off").
//
// It watches LyricsCore's published state, the summary the overlay gets:
// the video being heard and its chosen lyrics. A video is added once ever;
// its lyrics are sent again only when the chosen lyrics change. What
// ytarchive has not taken waits in an outbox, tried again at the next
// change and at service start, never on a timer.

// Part of each sent-lyrics key, so a change to lrcText() sends every
// song's file again the next time it plays.
export const LRC_FORMAT = 1;
export const MAX_OUTBOX = 500;

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
     *   client: {add(videoId: string): Promise<void>, lyrics(videoId: string, lrc: string|null): Promise<void>},
     *   lyricsFor: (videoId: string) => object|null,
     *   log: (message: string) => void,
     * }} deps  lyricsFor answers the stored candidate the overlay uses for a video
     */
    constructor(deps) {
        for (const name of ['store', 'client', 'lyricsFor', 'log']) {
            if (!deps[name])
                throw new Error(`ArchiveSync needs ${name}`);
        }
        this._deps = deps;
        this._outbox = null;
        this._lastSignature = '';
        this._unreachable = false;
        this._chain = Promise.resolve();
    }

    /** Sends what an earlier run could not. */
    start() {
        return this._run(() => this._flush());
    }

    /**
     * Called with every state the core publishes, while it refreshes the
     * overlay, so all work here is deferred to the chain.
     * @param {{active: boolean, sounding: boolean, videoId: string|null, chosen: {id: number}|null}} state
     */
    observe(state) {
        if (!state.active || !state.videoId)
            return Promise.resolve();
        const signature = `${state.videoId} ${state.sounding ? 'heard' : 'quiet'} ${state.chosen?.id ?? 'none'}`;
        if (signature === this._lastSignature)
            return Promise.resolve();
        this._lastSignature = signature;
        const {videoId, sounding} = state;
        return this._run(async () => {
            const record = this._record(videoId);
            // Until it is heard a video is not added; once added, a lyrics
            // choice made while paused counts too.
            const due = record.added ? this._lyricsNow(videoId).key !== record.lyricsKey : sounding;
            if (due)
                this._enqueue(videoId);
            await this._flush();
        });
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
}
