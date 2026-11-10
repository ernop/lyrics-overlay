// The words for each lookup state in the service's state (`lyrics`),
// shown by both the status page and the indicator menu.

export const LYRICS_STATUS_TEXT = Object.freeze({
    'idle': 'Waiting for song details',
    'not-music': 'Not a music video; no lookup made',
    'searching': 'Looking up lyrics',
    'waiting': 'Lookups paused for LRCLIB’s request limits',
    'timed': 'Timed lyrics',
    'plain': 'Only untimed lyrics found',
    'none': 'No lyrics found',
    'error': 'Lookup failed; tried again after 10 minutes',
});
