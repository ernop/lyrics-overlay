// The service's page (http://lyrics.localhost:8792/): what is playing, which lyrics
// were matched and how they were chosen. Read-only; the shell menu owns
// every control. While the tab is visible the page fetches its body
// (/status-body) every REFRESH_MS, so a lookup that finishes shows.

import {LYRICS_STATUS_TEXT} from '../shared/lyrics-status.js';

const REFRESH_MS = 1000;

function escapeHtml(value) {
    return String(value)
        .replaceAll('&', '&amp;')
        .replaceAll('<', '&lt;')
        .replaceAll('>', '&gt;')
        .replaceAll('"', '&quot;');
}

function row(label, value) {
    return `<div class="row"><span class="value">${escapeHtml(value)}</span><span class="label">${escapeHtml(label)}</span></div>`;
}

/** The page's live part: what plays, the lookup, the line and the lyric sets. */
export function renderStatusBody(state, line) {
    const rows = state.active
        ? [
            row('playing', state.identityText || state.videoId),
            row('lyrics', LYRICS_STATUS_TEXT[state.lyrics]),
            row('matched', state.chosen ? `${state.chosen.label}${state.userChose ? ' (your choice)' : ''}` : 'none'),
            row('timing', `${state.offsetSeconds > 0 ? '+' : ''}${state.offsetSeconds.toFixed(1)} s`),
            row('line', line.text || '(blank)'),
        ]
        : [row('playing', 'Nothing on YouTube')];
    if (state.pitch.capturing || state.pitch.error)
        rows.push(row('pitch', state.pitch.error || ['Microphone on', state.pitch.microphone].filter(Boolean).join(': ')));
    const candidates = state.candidates.map(candidate => `<li>${escapeHtml(candidate.label)}` +
        ` <b>${candidate.timed ? 'timed' : 'untimed'}${candidate.matches ? '' : ', weak match'}` +
        `${candidate.rejected ? ', marked wrong' : ''}${candidate.current ? ', showing' : ''}</b></li>`).join('');
    return `${rows.join('')}${candidates ? `<h2>Lyric sets found</h2><ul>${candidates}</ul>` : ''}`;
}

const UNREACHABLE = row('service', 'Not answering; is lyrics-overlay.service running?');

export function renderStatusPage(state, line) {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Lyrics overlay</title>
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<style>
body { margin: 0; padding: 2vw 3vw; background: #000; color: #fff; font: 18px/1.4 system-ui, sans-serif; }
h1 { font-size: 30px; font-weight: 800; margin: 0 0 16px; }
h2 { font-size: 22px; font-weight: 800; margin: 24px 0 8px; }
.row { display: flex; gap: 14px; align-items: baseline; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.value { font-size: 22px; font-weight: 700; overflow: hidden; text-overflow: ellipsis; }
.label { font-size: 15px; order: -1; min-width: 5em; }
ul { margin: 0; padding-left: 1.2em; }
li { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style></head>
<body><h1>Lyrics overlay</h1><main id="status">${renderStatusBody(state, line)}</main>
<script>
'use strict';
const status = document.getElementById('status');
// Rewriting unchanged HTML would drop a text selection every second.
let shown = null;
async function refresh() {
    if (document.hidden)
        return;
    let html = ${JSON.stringify(UNREACHABLE)};
    try {
        const response = await fetch('/status-body', {cache: 'no-store'});
        if (response.ok)
            html = await response.text();
    } catch {
        // The service is stopped or restarting; the page says so.
    }
    if (html !== shown) {
        shown = html;
        status.innerHTML = html;
    }
}
setInterval(refresh, ${REFRESH_MS});
document.addEventListener('visibilitychange', refresh);
</script>
</body></html>`;
}
