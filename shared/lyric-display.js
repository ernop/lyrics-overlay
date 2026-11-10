// What the one-line overlay shows at a media time: voice-wei's car display
// (player-lyrics.js lyricDisplayTextAt over the led line index), without
// its opening identity line (owner, 2026-11-10).
// - Before a line, after a long enough intro or instrumental gap: the line
//   prefixed with the whole seconds remaining.
// - Otherwise: the line about to be sung, led by LEAD_SECONDS.
// - Once the lyrics are over (a blank line with nothing sung after it, or
//   LAST_LINE_HOLD_SECONDS past a final line that has no end marker):
//   nothing, so a finished song never leaves a stale line up.
// Times are media seconds; a song's offset shifts the lyric file's clock.

export const LEAD_SECONDS = 0.75;
export const COUNTDOWN_MIN_SECONDS = 3;
export const LAST_LINE_HOLD_SECONDS = 8;
export const OFFSET_STEP_SECONDS = 0.5;

const NOTHING = {text: '', key: 'none', nextChangeAt: Infinity};

export function nudgedOffset(offsetSeconds, deltaSeconds) {
    return Math.round((offsetSeconds + deltaSeconds) * 10) / 10;
}

/** Index of the last line starting at or before `time`, or -1. */
export function lineIndexAt(lines, time) {
    let low = 0;
    let high = lines.length - 1;
    let found = -1;
    while (low <= high) {
        const mid = (low + high) >> 1;
        if (lines[mid].time <= time) {
            found = mid;
            low = mid + 1;
        } else {
            high = mid - 1;
        }
    }
    return found;
}

/**
 * The line to show for a (led) index: that line when it has text,
 * otherwise the next line with text, otherwise -1 (the lyrics are over).
 */
export function titleLineIndexAt(lines, index) {
    for (let i = Math.max(index, 0); i < lines.length; i++) {
        if (lines[i].text.trim())
            return i;
    }
    return -1;
}

/**
 * @param {{lines: Array<{time: number, text: string}>, offsetSeconds: number,
 *          mediaTime: number}} input
 * @returns {{text: string, key: string, nextChangeAt: number}} nextChangeAt
 *   is the media time of the next possible change (Infinity when none).
 */
export function displayAt({lines, offsetSeconds, mediaTime}) {
    const ledIndex = lineIndexAt(lines, mediaTime + offsetSeconds + LEAD_SECONDS);
    const shownIndex = titleLineIndexAt(lines, ledIndex);
    if (shownIndex < 0)
        return NOTHING;
    let nextChangeAt = ledIndex + 1 < lines.length
        ? lines[ledIndex + 1].time - offsetSeconds - LEAD_SECONDS
        : Infinity;
    const line = lines[shownIndex].text.trim();
    const key = `line:${shownIndex}`;

    if (shownIndex === lines.length - 1 && shownIndex === ledIndex) {
        const holdEnd = lines[shownIndex].time - offsetSeconds + LAST_LINE_HOLD_SECONDS;
        return mediaTime < holdEnd ? {text: line, key, nextChangeAt: holdEnd} : NOTHING;
    }
    if (shownIndex > ledIndex) {
        const lineAt = lines[shownIndex].time - offsetSeconds;
        let gapStart = ledIndex;
        while (gapStart > 0 && !lines[gapStart - 1].text.trim())
            gapStart--;
        const waitedSince = ledIndex < 0 ? 0 : lines[gapStart].time - offsetSeconds;
        if (lineAt - waitedSince >= COUNTDOWN_MIN_SECONDS) {
            const wait = Math.ceil(lineAt - mediaTime);
            if (wait >= 1) {
                nextChangeAt = Math.min(nextChangeAt, lineAt - (wait - 1));
                return {text: `${wait} ${line}`, key, nextChangeAt};
            }
        }
    }
    return {text: line, key, nextChangeAt};
}
