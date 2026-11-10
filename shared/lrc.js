// LRC parsing: "[mm:ss.xx]text" lines into time-sorted {time, text}.
// A line may carry several leading time tags (a repeated chorus); word
// timing tags "<mm:ss.xx>" inside the text are dropped.
//
// Some files carry their credits as timed lines ("Songwriters: A / B",
// "作词 : A", or a bare "SONGWRITERS" heading over a line of names). Those
// are not lyrics, so they parse as blank lines: their times still end the
// line before them, and the display never shows them.

const LEADING_TAG = /^\s*\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/u;
const WORD_TAG = /<\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?>/gu;

// Words that only ever label credits, so they may stand alone as a heading.
const HEADING_LABELS = [
    'songwriters?', 'writers?', 'written by', 'lyricists?', 'composers?', 'composed by',
    'producers?', 'produced by', 'arrangers?', 'arranged by', 'credits',
    '作词', '作詞', '作曲', '编曲', '編曲', '填词', '填詞', '制作人', '製作人', '监制', '監製',
];
// Words a lyric could sing alone, so they count only when names follow a colon.
const NAMED_ONLY_LABELS = ['lyrics(?: by)?', 'music(?: by)?', 'mixed by', 'mastered by', 'source'];

const CREDIT_HEADING = new RegExp(`^(?:${HEADING_LABELS.join('|')})\\s*[:：]?$`, 'iu');
const CREDIT_WITH_NAMES = new RegExp(`^(?:${[...HEADING_LABELS, ...NAMED_ONLY_LABELS].join('|')})\\s*[:：]\\s*\\S`, 'iu');

/** @returns {Array<{time: number, text: string}>} */
export function parseSyncedLyrics(lrcText) {
    const lines = [];
    for (const rawLine of String(lrcText ?? '').split(/\r?\n/u)) {
        const times = [];
        let rest = rawLine;
        let match;
        while ((match = LEADING_TAG.exec(rest)) !== null) {
            const fractionMs = Number((match[3] ?? '0').padEnd(3, '0'));
            times.push(Number(match[1]) * 60 + Number(match[2]) + fractionMs / 1000);
            rest = rest.slice(match[0].length);
        }
        if (!times.length)
            continue;
        const text = rest.replace(WORD_TAG, '').replace(/\s+/gu, ' ').trim();
        for (const time of times)
            lines.push({time, text});
    }
    // Array.prototype.sort is stable, so equal times keep file order.
    return withoutCredits(lines.sort((a, b) => a.time - b.time));
}

/** Blanks credit lines, and the names under a bare heading up to the next blank line. */
function withoutCredits(lines) {
    let underHeading = false;
    return lines.map(line => {
        if (!line.text) {
            underHeading = false;
            return line;
        }
        if (CREDIT_HEADING.test(line.text)) {
            underHeading = true;
            return {time: line.time, text: ''};
        }
        if (underHeading || CREDIT_WITH_NAMES.test(line.text))
            return {time: line.time, text: ''};
        return line;
    });
}
