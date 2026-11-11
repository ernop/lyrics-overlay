// Shape check for browser reports. Everything the extension sends passes
// through here before the core sees it; anything malformed is refused.

import {isAddonVersion} from './addon-version.js';

const VIDEO_ID = /^[A-Za-z0-9_-]{6,20}$/u;
const HOSTS = new Set(['www.youtube.com', 'music.youtube.com']);
const MAX_CLOCK_SKEW_MS = 10 * 60 * 1000;
const HEARTBEAT_RANGE_MS = {min: 1000, max: 60_000};

class ReportError extends Error {}

function text(value, field, maxLength) {
    if (typeof value !== 'string')
        throw new ReportError(`${field} must be text`);
    return value.slice(0, maxLength);
}

function number(value, field) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        throw new ReportError(`${field} must be a finite number`);
    return value;
}

function flag(value, field) {
    if (typeof value !== 'boolean')
        throw new ReportError(`${field} must be true or false`);
    return value;
}

function videoId(value, field) {
    if (typeof value !== 'string' || !VIDEO_ID.test(value))
        throw new ReportError(`${field} is not a YouTube video id`);
    return value;
}

function host(value, field) {
    if (!HOSTS.has(value))
        throw new ReportError(`${field} is not a YouTube host`);
    return value;
}

function parseMedia(media) {
    if (!media || typeof media !== 'object')
        throw new ReportError('media is missing');
    return {
        videoId: media.videoId === null ? null : videoId(media.videoId, 'media.videoId'),
        currentTime: number(media.currentTime, 'media.currentTime'),
        duration: number(media.duration, 'media.duration'),
        paused: flag(media.paused, 'media.paused'),
        ended: flag(media.ended, 'media.ended'),
        stalled: flag(media.stalled, 'media.stalled'),
        playbackRate: number(media.playbackRate, 'media.playbackRate'),
        muted: flag(media.muted, 'media.muted'),
        volume: number(media.volume, 'media.volume'),
        adShowing: flag(media.adShowing, 'media.adShowing'),
    };
}

/** The page's promise: its next report comes within this many ms, or null when it waits for a change. */
function heartbeat(value) {
    if (value === null)
        return null;
    if (!Number.isInteger(value) || value < HEARTBEAT_RANGE_MS.min || value > HEARTBEAT_RANGE_MS.max)
        throw new ReportError(`heartbeatMs must be null or a whole number from ${HEARTBEAT_RANGE_MS.min} to ${HEARTBEAT_RANGE_MS.max}`);
    return value;
}

function parseMetadata(metadata) {
    if (!Array.isArray(metadata.musicCards))
        throw new ReportError('metadata.musicCards must be a list');
    const session = metadata.mediaSession;
    return {
        host: host(metadata.host, 'metadata.host'),
        videoId: videoId(metadata.videoId, 'metadata.videoId'),
        title: text(metadata.title, 'metadata.title', 400),
        author: text(metadata.author, 'metadata.author', 200),
        lengthSeconds: number(metadata.lengthSeconds, 'metadata.lengthSeconds'),
        category: text(metadata.category, 'metadata.category', 100),
        musicVideoType: text(metadata.musicVideoType, 'metadata.musicVideoType', 100),
        description: text(metadata.description, 'metadata.description', 5000),
        musicCards: metadata.musicCards.slice(0, 5).map((card, index) => ({
            title: text(card?.title, `metadata.musicCards[${index}].title`, 300),
            artist: text(card?.artist, `metadata.musicCards[${index}].artist`, 300),
            album: text(card?.album, `metadata.musicCards[${index}].album`, 300),
        })),
        mediaSession: session === null ? null : {
            title: text(session?.title, 'metadata.mediaSession.title', 300),
            artist: text(session?.artist, 'metadata.mediaSession.artist', 300),
            album: text(session?.album, 'metadata.mediaSession.album', 300),
        },
        ytmByline: text(metadata.ytmByline, 'metadata.ytmByline', 400),
    };
}

function parseNext(next) {
    if (next === null)
        return null;
    return {
        host: host(next.host, 'next.host'),
        videoId: videoId(next.videoId, 'next.videoId'),
        title: text(next.title, 'next.title', 400),
        byline: text(next.byline, 'next.byline', 200),
        durationSeconds: number(next.durationSeconds, 'next.durationSeconds'),
    };
}

/** The reporting add-on's version; null from an add-on before 1.3.0, which sends none. */
function addonVersion(value) {
    if (value === undefined)
        return null;
    if (!isAddonVersion(value))
        throw new ReportError('addonVersion must be up to four dot-separated whole numbers');
    return value;
}

/**
 * @returns {{tabId: number, addonVersion: string|null,
 *            message: {sampledAt: number, heartbeatMs: number|null, media: object, metadata?: object, next?: object|null}}}
 */
export function parseReport(body, nowMs) {
    if (!body || typeof body !== 'object')
        throw new ReportError('report must be an object');
    if (!Number.isInteger(body.tabId) || body.tabId < 0)
        throw new ReportError('tabId must be a non-negative integer');
    const sampledAt = number(body.sampledAt, 'sampledAt');
    if (Math.abs(sampledAt - nowMs) > MAX_CLOCK_SKEW_MS)
        throw new ReportError('sampledAt is not a current time');
    const message = {sampledAt, heartbeatMs: heartbeat(body.heartbeatMs), media: parseMedia(body.media)};
    if (body.metadata !== undefined)
        message.metadata = parseMetadata(body.metadata);
    if (body.next !== undefined)
        message.next = parseNext(body.next);
    return {tabId: body.tabId, addonVersion: addonVersion(body.addonVersion), message};
}

export function parseGone(body) {
    if (!body || !Number.isInteger(body.tabId) || body.tabId < 0)
        throw new ReportError('tabId must be a non-negative integer');
    return body.tabId;
}

// A Wayland window title must fit one protocol message.
const MAX_WINDOW_TITLE_LENGTH = 4000;

/**
 * The extension's outcome for a focusTab command: the title its window
 * shows once the tab is selected, or why it could not select the tab.
 * @returns {{id: number, result: {ok: true, windowTitle: string}|{ok: false, error: string}}}
 */
export function parseCommandResult(body) {
    if (!body || typeof body !== 'object')
        throw new ReportError('command result must be an object');
    if (!Number.isInteger(body.id) || body.id < 1)
        throw new ReportError('id must be a positive integer');
    if (!flag(body.ok, 'ok'))
        return {id: body.id, result: {ok: false, error: text(body.error, 'error', 300)}};
    if (typeof body.windowTitle !== 'string' || !body.windowTitle || body.windowTitle.length > MAX_WINDOW_TITLE_LENGTH)
        throw new ReportError(`windowTitle must be text of 1 to ${MAX_WINDOW_TITLE_LENGTH} characters`);
    return {id: body.id, result: {ok: true, windowTitle: body.windowTitle}};
}

export function isReportError(error) {
    return error instanceof ReportError;
}
