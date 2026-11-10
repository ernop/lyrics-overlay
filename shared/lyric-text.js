// Song identity comparison, lookup candidates and LRCLIB record ranking.
// Adopted from voice-wei's player-lyrics.js (scores, thresholds, timed-first
// choice) and refined for YouTube metadata: Unicode-aware comparison,
// version-qualifier stripping, multi-artist credits and VEVO channel names.

export const MIN_TITLE_IDENTITY_SCORE = 0.6;
export const MIN_ARTIST_IDENTITY_SCORE = 0.6;
export const MIN_ACCEPT_SCORE = 0.58;
export const EXACT_TIMED_EARLY_STOP_SCORE = 0.98;
// A timed identity match this strong ends the candidate walk: later
// candidates are noisier spellings of the same song.
export const STRONG_TIMED_STOP_SCORE = 0.85;
export const MAX_LOOKUP_CANDIDATES = 4;

const NOISE_TOKENS = new Set([
    'feat', 'featuring', 'ft', 'official', 'video', 'audio', 'lyrics', 'lyric',
    'topic', 'remaster', 'remastered',
]);

export function normalizeWhitespace(text) {
    return String(text ?? '').replace(/\s+/gu, ' ').trim();
}

export function normalizeComparisonText(value) {
    const tokens = String(value ?? '')
        .normalize('NFKD')
        .replace(/\p{M}+/gu, '')
        .toLowerCase()
        .replace(/&/gu, ' and ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .split(' ')
        .filter(Boolean);
    const meaningful = tokens.filter(token => !NOISE_TOKENS.has(token));
    // A title made only of noise words ("Lyrics") still has an identity.
    return (meaningful.length ? meaningful : tokens).join(' ');
}

export function tokenSimilarity(a, b) {
    const left = normalizeComparisonText(a);
    const right = normalizeComparisonText(b);
    if (!left || !right)
        return 0;
    if (left === right)
        return 1;
    const tokensA = new Set(left.split(' '));
    const tokensB = new Set(right.split(' '));
    let shared = 0;
    for (const token of tokensA) {
        if (tokensB.has(token))
            shared++;
    }
    return shared / new Set([...tokensA, ...tokensB]).size;
}

const ARTIST_SEPARATOR = /\s*(?:,|&|×|\/|;|\+|\bx\b|\band\b|\bfeat\.?|\bfeaturing\b|\bft\.?|\bwith\b|\bvs\.?)\s*/iu;

export function primaryArtist(name) {
    return normalizeWhitespace(String(name ?? '').split(ARTIST_SEPARATOR)[0]);
}

export function artistSimilarity(recordArtist, wantedArtist) {
    return Math.max(
        tokenSimilarity(recordArtist, wantedArtist),
        tokenSimilarity(primaryArtist(recordArtist), primaryArtist(wantedArtist)));
}

export function cleanSongTitle(text) {
    return normalizeWhitespace(String(text ?? '')
        .replace(/\[(?:official|lyrics?|audio|video|hd|4k|mv|m\/v)[^\]]*\]/giu, '')
        .replace(/\((?:official|lyrics?|audio|video|hd|4k|mv|m\/v)[^)]*\)/giu, '')
        .replace(/[([]\s*(?:feat\.?|featuring|ft\.?|with)\s[^)\]]*[)\]]/giu, '')
        .replace(/\s(?:feat\.?|featuring|ft\.?)\s.*$/iu, '')
        .replace(/\s+\|\s+.*$/u, '')
        .replace(/\s*\/\s*lyrics?$/iu, '')
        .replace(/^["“”'‘’]+|["“”'‘’]+$/gu, ''));
}

// "Help! (Remastered 2009)", "Song - 2015 Remaster", "Song [Live]": the
// recording's qualifiers, which lyric databases usually omit.
export function stripVersionQualifiers(title) {
    return normalizeWhitespace(String(title ?? '')
        .replace(/\s*[([][^)\]]*[)\]]/gu, '')
        .replace(/\s+[-–—]\s+[^-–—]*\b(?:remaster(?:ed)?|version|mix|edit|live|acoustic|mono|stereo|demo|single|radio|bonus|session|take|recorded)\b.*$/iu, ''));
}

export function cleanArtistName(text) {
    const raw = normalizeWhitespace(String(text ?? '')
        .replace(/\s*-\s*topic$/iu, '')
        .replace(/\bofficial\b/giu, ''));
    const withoutVevo = raw.replace(/\s*VEVO$/u, '');
    if (withoutVevo !== raw && !/\s/u.test(withoutVevo))
        return withoutVevo.replace(/(\p{Ll})(\p{Lu})/gu, '$1 $2');
    return normalizeWhitespace(withoutVevo);
}

// A double-quoted phrase names the song when nothing but a separator, a
// bracket or the end follows it: 'Artist "Song" (Live)', '"Song" - British
// folk song'. A quoted nickname inside a name ('"Weird Al" Yankovic - …')
// is followed by more name, so it falls through to the separator parse.
const QUOTED_SONG = /["“]([^"“”]+)["”](?=\s*(?:$|[-–—:|([]))/u;

export function extractArtistTitleFromVideoTitle(title) {
    const text = String(title ?? '');
    const quoted = QUOTED_SONG.exec(text);
    if (quoted) {
        const before = text.slice(0, quoted.index).replace(/[\s\-–—:|]+$/u, '');
        return {artist: before.trim(), title: quoted[1].trim()};
    }
    for (const separator of [' - ', ' – ', ' — ', ': ']) {
        const parts = text.split(separator).map(part => part.trim()).filter(Boolean);
        if (parts.length >= 2)
            return {artist: parts[0], title: parts.slice(1).join(separator)};
    }
    return {artist: '', title: text.trim()};
}

export function candidateKey(candidate) {
    return `${normalizeComparisonText(candidate.artist)}|${normalizeComparisonText(candidate.title)}`;
}

function addCandidate(candidates, artist, title) {
    const candidate = {artist: cleanArtistName(artist), title: cleanSongTitle(title)};
    if (!candidate.title || candidates.length >= MAX_LOOKUP_CANDIDATES)
        return;
    const key = candidateKey(candidate);
    if (!candidates.some(existing => candidateKey(existing) === key))
        candidates.push(candidate);
}

/**
 * Searches to run for a song, most specific first.
 * @param {{reliable: boolean, artist: string, title: string, videoTitle: string, channel: string}} identity
 */
export function buildLookupCandidates(identity) {
    const candidates = [];
    if (identity.reliable && identity.artist && identity.title) {
        addCandidate(candidates, identity.artist, identity.title);
        addCandidate(candidates, identity.artist, stripVersionQualifiers(identity.title));
        addCandidate(candidates, primaryArtist(identity.artist), stripVersionQualifiers(identity.title));
        return candidates;
    }
    const parsed = extractArtistTitleFromVideoTitle(identity.videoTitle);
    const channel = cleanArtistName(identity.channel);
    const artist = parsed.artist || channel;
    const title = parsed.title;
    addCandidate(candidates, artist, title);
    addCandidate(candidates, artist, stripVersionQualifiers(cleanSongTitle(title)));
    if (parsed.artist && channel && normalizeComparisonText(channel) !== normalizeComparisonText(parsed.artist))
        addCandidate(candidates, channel, title);
    if (parsed.artist)
        addCandidate(candidates, stripVersionQualifiers(cleanSongTitle(parsed.title)), parsed.artist);
    if (!candidates.length)
        addCandidate(candidates, '', identity.videoTitle);
    return candidates;
}

export function recordTitle(record) {
    return record.trackName || record.name || '';
}

export function recordHasTimed(record) {
    return typeof record.syncedLyrics === 'string' && record.syncedLyrics.trim() !== '';
}

function titleSimilarity(record, title) {
    return Math.max(
        tokenSimilarity(recordTitle(record), title),
        tokenSimilarity(stripVersionQualifiers(recordTitle(record)), stripVersionQualifiers(title)));
}

export function recordMatchesIdentity(record, candidate) {
    if (titleSimilarity(record, candidate.title) < MIN_TITLE_IDENTITY_SCORE)
        return false;
    if (!candidate.artist)
        return true;
    return artistSimilarity(record.artistName || '', candidate.artist) >= MIN_ARTIST_IDENTITY_SCORE;
}

export function scoreRecord(record, candidate, expectedDurationSeconds) {
    const titleScore = titleSimilarity(record, candidate.title);
    const artistScore = candidate.artist ? artistSimilarity(record.artistName || '', candidate.artist) : 0.55;
    const duration = Number(record.duration) || 0;
    let durationScore = 0.5;
    if (expectedDurationSeconds > 0 && duration > 0)
        durationScore = Math.max(0, 1 - Math.abs(duration - expectedDurationSeconds) / 20);
    return titleScore * 0.6 + artistScore * 0.25 + durationScore * 0.15;
}

export function isExactStrongTimedMatch(record, candidate, expectedDurationSeconds) {
    if (!candidate.artist || expectedDurationSeconds <= 0 || !recordHasTimed(record))
        return false;
    if (normalizeComparisonText(recordTitle(record)) !== normalizeComparisonText(candidate.title))
        return false;
    if (normalizeComparisonText(record.artistName || '') !== normalizeComparisonText(candidate.artist))
        return false;
    return scoreRecord(record, candidate, expectedDurationSeconds) >= EXACT_TIMED_EARLY_STOP_SCORE;
}

/** True when this search's answer makes the remaining candidates pointless. */
export function searchSettlesLookup(records, candidate, expectedDurationSeconds) {
    return records.some(record => isExactStrongTimedMatch(record, candidate, expectedDurationSeconds) ||
        (recordHasTimed(record) && recordMatchesIdentity(record, candidate) &&
            scoreRecord(record, candidate, expectedDurationSeconds) >= STRONG_TIMED_STOP_SCORE));
}

/**
 * Every distinct record from the answered searches, scored against the
 * candidate that fits it best, strongest first.
 * @param {Array<{candidate: {artist: string, title: string}, records: object[]}>} answered
 */
export function rankRecords(answered, expectedDurationSeconds) {
    const byId = new Map();
    for (const {candidate, records} of answered) {
        for (const record of records) {
            const ranked = {
                record,
                score: scoreRecord(record, candidate, expectedDurationSeconds),
                matches: recordMatchesIdentity(record, candidate),
                timed: recordHasTimed(record),
            };
            const existing = byId.get(record.id);
            if (!existing || rankOrder(ranked, existing) < 0)
                byId.set(record.id, ranked);
        }
    }
    return [...byId.values()].sort(rankOrder);
}

function rankOrder(a, b) {
    if (a.matches !== b.matches)
        return a.matches ? -1 : 1;
    if (a.score !== b.score)
        return b.score - a.score;
    if (a.timed !== b.timed)
        return a.timed ? -1 : 1;
    return 0;
}

/**
 * voice-wei's rule: among identity matches, timed lyrics win when they
 * clear the acceptance score; otherwise the best match must clear it.
 * @returns {number|null} the chosen record id
 */
export function chooseAutomatic(ranked, rejectedIds) {
    const rejected = new Set(rejectedIds);
    let best = null;
    let bestTimed = null;
    for (const entry of ranked) {
        if (!entry.matches || rejected.has(entry.record.id))
            continue;
        if (!best || entry.score > best.score)
            best = entry;
        if (entry.timed && (!bestTimed || entry.score > bestTimed.score))
            bestTimed = entry;
    }
    const chosen = bestTimed && bestTimed.score >= MIN_ACCEPT_SCORE ? bestTimed : best;
    if (!chosen || chosen.score < MIN_ACCEPT_SCORE)
        return null;
    return chosen.record.id;
}
