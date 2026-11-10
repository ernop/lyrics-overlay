// Fixed-window request budget. A call is allowed only when every window
// still has room; the refusal says when the earliest blocking window ends.
// LRCLIB publishes no rate limit, so its windows are a politeness cap far
// above real use (1-4 searches per new song, songs last minutes). When
// LRCLIB itself refuses (HTTP 429), the budget closes until the time it
// names; the pause is stored with the counts, so a restart honors it.

export const LRCLIB_WINDOWS = Object.freeze([
    {seconds: 60, limit: 20},
    {seconds: 3600, limit: 200},
    {seconds: 86400, limit: 1000},
]);

/** The pause after a refusal that names no time. */
export const RATE_LIMIT_DEFAULT_PAUSE_MS = 60_000;
/** A refusal naming a later time still reopens after a day, the longest window. */
export const RATE_LIMIT_LONGEST_PAUSE_MS = 86_400_000;

/** The provider refused a request for its rate limit; ask again at retryAtMs. */
export class ProviderRateLimit extends Error {
    /** @param {number} retryAtMs */
    constructor(retryAtMs) {
        super(`rate limited until ${new Date(retryAtMs).toISOString()}`);
        this.retryAtMs = retryAtMs;
    }
}

/**
 * When a refused request may be repeated. Retry-After holds either a number
 * of seconds or an HTTP date (RFC 9110, section 10.2.3).
 * @param {string|null} header
 * @param {number} nowMs
 */
export function retryAtFromHeader(header, nowMs) {
    const value = (header ?? '').trim();
    let retryAtMs = nowMs + RATE_LIMIT_DEFAULT_PAUSE_MS;
    if (/^\d+$/u.test(value))
        retryAtMs = nowMs + Number(value) * 1000;
    else if (value && Number.isFinite(Date.parse(value)))
        retryAtMs = Math.max(nowMs, Date.parse(value));
    return Math.min(retryAtMs, nowMs + RATE_LIMIT_LONGEST_PAUSE_MS);
}

/**
 * @param {{counts: Object<string, {start: number, count: number}>, pausedUntil: number}} state
 * @param {ReadonlyArray<{seconds: number, limit: number}>} windows
 * @param {number} nowMs
 * @returns {{allowed: boolean, retryAtMs: number, state: object}}
 */
export function takeBudget(state, windows, nowMs) {
    if (state.pausedUntil > nowMs)
        return {allowed: false, retryAtMs: state.pausedUntil, state};
    const counts = {};
    let retryAtMs = 0;
    for (const {seconds, limit} of windows) {
        const lengthMs = seconds * 1000;
        const start = Math.floor(nowMs / lengthMs) * lengthMs;
        const previous = state.counts[String(seconds)];
        const count = previous && previous.start === start ? previous.count : 0;
        counts[String(seconds)] = {start, count};
        if (count >= limit)
            retryAtMs = Math.max(retryAtMs, start + lengthMs);
    }
    if (retryAtMs)
        return {allowed: false, retryAtMs, state: {counts, pausedUntil: state.pausedUntil}};
    for (const entry of Object.values(counts))
        entry.count++;
    return {allowed: true, retryAtMs: 0, state: {counts, pausedUntil: state.pausedUntil}};
}

/** Closes the budget until untilMs, keeping any later pause already set. */
export function pauseBudget(state, untilMs) {
    return {counts: state.counts, pausedUntil: Math.max(state.pausedUntil, untilMs)};
}

export function emptyBudgetState() {
    return {counts: {}, pausedUntil: 0};
}

/** A stored state, or null for none; files written before pauses existed have no pausedUntil. */
export function loadedBudgetState(stored) {
    if (stored === null)
        return emptyBudgetState();
    const pausedUntil = stored.pausedUntil ?? 0;
    if (!stored.counts || typeof stored.counts !== 'object' || !Number.isFinite(pausedUntil))
        throw new Error('the stored LRCLIB budget is malformed');
    return {counts: stored.counts, pausedUntil};
}
