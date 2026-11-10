// Song identity from the raw YouTube metadata the browser extension reports.
// Each source is named and ranked; the first that names both song and
// artist wins:
//   topic          "Provided to YouTube by" auto-generated descriptions
//   youtube-music  music.youtube.com media session and player-bar byline
//   music-card     the "Music" card in a video's description
//   video-title    "Artist - Song (Official Video)" parsing plus channel
// Only the first three are reliable enough to search on directly.

import {cleanArtistName, cleanSongTitle, extractArtistTitleFromVideoTitle, normalizeWhitespace} from './lyric-text.js';

const TOPIC_PREFIX = 'Provided to YouTube by';

/** @returns {{title: string, artist: string, album: string, year: string}|null} */
export function parseTopicDescription(description) {
    const text = String(description ?? '');
    if (!text.trimStart().startsWith(TOPIC_PREFIX))
        return null;
    const paragraphs = text.split(/\n\s*\n/u).map(paragraph => paragraph.trim()).filter(Boolean);
    const credit = paragraphs[1] ?? '';
    const parts = credit.split(' · ').map(part => part.trim()).filter(Boolean);
    if (parts.length < 2)
        return null;
    const albumParagraph = paragraphs[2] ?? '';
    const album = /^(℗|©|Released on:)/u.test(albumParagraph) || albumParagraph.includes('\n') ? '' : albumParagraph;
    const year = (/℗\s*(\d{4})/u.exec(text) ?? /Released on:\s*(\d{4})/u.exec(text) ?? [])[1] ?? '';
    return {title: parts[0], artist: parts.slice(1).join(', '), album, year};
}

/** "Artist • Album • 1987" (songs) or "Artist • 1.2M views • 3K likes" (videos). */
export function parseYtMusicByline(byline) {
    const parts = String(byline ?? '').split('•').map(part => normalizeWhitespace(part)).filter(Boolean);
    const result = {artist: parts[0] ?? '', album: '', year: ''};
    if (parts.length >= 3 && /^\d{4}$/u.test(parts[parts.length - 1])) {
        result.year = parts[parts.length - 1];
        result.album = parts.slice(1, -1).join(' • ');
    }
    return result;
}

/** "3:24", "1:02:03" or "3 minutes, 24 seconds" to seconds; 0 when unknown. */
export function parseDurationText(text) {
    const value = String(text ?? '').trim();
    const clock = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/u.exec(value);
    if (clock) {
        const [, a, b, c] = clock;
        return c === undefined ? Number(a) * 60 + Number(b) : Number(a) * 3600 + Number(b) * 60 + Number(c);
    }
    let seconds = 0;
    for (const [, amount, unit] of value.matchAll(/(\d+)\s*(hour|minute|second)s?/giu))
        seconds += Number(amount) * {hour: 3600, minute: 60, second: 1}[unit.toLowerCase()];
    return seconds;
}

// Words by which a video title calls itself a piece of music, for uploads
// YouTube files under another category with no music card or Topic channel
// ('"The Lantern on the Hill" - British Folk song').
const MUSIC_TITLE = new RegExp([
    String.raw`\b(?:songs?|ballads?|hymns?|carols?|shant(?:y|ies)|lullab(?:y|ies)|anthems?|arias?|madrigals?)\b`,
    String.raw`\b(?:lyrics|lyric video|official (?:music )?video(?! game)|official audio|music video)\b`,
    String.raw`[([]\s*(?:[\p{L}-]+\s+)?cover\s*[)\]]`,
].join('|'), 'iu');

export function titleNamesMusic(title) {
    return MUSIC_TITLE.test(String(title ?? ''));
}

export function isMusical(raw) {
    return raw.host === 'music.youtube.com' ||
        raw.category === 'Music' ||
        Boolean(raw.musicVideoType) ||
        parseTopicDescription(raw.description) !== null ||
        raw.musicCards.length > 0 ||
        /\s-\sTopic$/u.test(raw.author) ||
        titleNamesMusic(raw.title);
}

function videoTitleIdentity(videoTitle, channel) {
    const parsed = extractArtistTitleFromVideoTitle(videoTitle);
    return {
        artist: cleanArtistName(parsed.artist || channel),
        title: cleanSongTitle(parsed.title),
    };
}

/**
 * @param {{host: string, videoId: string, title: string, author: string,
 *   lengthSeconds: number, category: string, musicVideoType: string,
 *   description: string, musicCards: Array<{title: string, artist: string, album: string}>,
 *   mediaSession: {title: string, artist: string, album: string}|null, ytmByline: string}} raw
 */
export function deriveIdentity(raw) {
    const base = {
        videoTitle: raw.title,
        channel: raw.author,
        durationSeconds: Number(raw.lengthSeconds) || 0,
        musical: isMusical(raw),
    };
    const topic = parseTopicDescription(raw.description);
    if (topic)
        return {...base, ...topic, source: 'topic', reliable: true};

    if (raw.host === 'music.youtube.com' && raw.mediaSession?.title && raw.mediaSession.artist) {
        const byline = parseYtMusicByline(raw.ytmByline);
        return {
            ...base,
            title: raw.mediaSession.title,
            artist: raw.mediaSession.artist,
            album: raw.mediaSession.album || byline.album,
            year: byline.year,
            source: 'youtube-music',
            reliable: raw.musicVideoType !== 'MUSIC_VIDEO_TYPE_UGC',
        };
    }

    const card = raw.musicCards.find(entry => entry.title && entry.artist);
    if (card)
        return {...base, title: card.title, artist: card.artist, album: card.album, year: '', source: 'music-card', reliable: true};

    return {...base, ...videoTitleIdentity(raw.title, raw.author), album: '', year: '', source: 'video-title', reliable: false};
}

/**
 * Identity for the upcoming video, known only from its list entry. An
 * entry naming no artist (a bare title, as youtube.com's autoplay pick
 * has no channel) is as likely a vlog as a song, so it counts as musical
 * only when its title calls it music, or once it plays and shows its own
 * metadata.
 * @param {{videoId: string, title: string, byline: string, durationSeconds: number, host: string}} next
 */
export function deriveNextIdentity(next) {
    const base = {videoTitle: next.title, channel: next.byline, durationSeconds: next.durationSeconds, album: '', year: ''};
    if (next.host === 'music.youtube.com' || /\s-\sTopic$/u.test(next.byline))
        return {...base, title: next.title, artist: cleanArtistName(next.byline), musical: true, source: 'next-listing', reliable: true};
    const parsed = videoTitleIdentity(next.title, next.byline);
    return {...base, ...parsed, musical: parsed.artist !== '' || titleNamesMusic(next.title), source: 'video-title', reliable: false};
}

/** voice-wei's "Artist - Song - Year - Album", skipping unknowns. */
export function describeIdentity({artist, title, year, album}) {
    return [artist, title, year, album]
        .map(part => normalizeWhitespace(part))
        .filter(Boolean)
        .join(' - ');
}
