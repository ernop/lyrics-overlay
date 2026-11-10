import test from 'node:test';
import assert from 'node:assert/strict';

import {LYRICS_STATUS_TEXT} from '../shared/lyrics-status.js';
import {renderStatusBody, renderStatusPage} from '../service/status-page.js';

const state = overrides => ({
    active: true, sounding: true, videoId: 'abcdefghijk', identityText: 'Band - Song', musical: true,
    lyrics: 'timed', chosen: {label: 'Band - Song (3:20)'}, userChose: false, offsetSeconds: 0.5,
    candidates: [], pitch: {capturing: false, error: '', microphone: ''}, ...overrides,
});

test('every lookup state reads as its words', () => {
    for (const [status, words] of Object.entries(LYRICS_STATUS_TEXT))
        assert.match(renderStatusBody(state({lyrics: status}), {text: ''}), new RegExp(`>${words.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}<`, 'u'), status);
});

test('the pitch row names the microphone it hears', () => {
    const body = renderStatusBody(state({pitch: {capturing: true, error: '', microphone: 'Desk Mic Analog Stereo'}}), {text: ''});
    assert.match(body, />Microphone on: Desk Mic Analog Stereo</u);
    assert.match(renderStatusBody(state({pitch: {capturing: false, error: 'pw-record exited with status 1', microphone: ''}}), {text: ''}),
        />pw-record exited with status 1</u);
});

test('values are escaped and the page refreshes only its body', () => {
    const page = renderStatusPage(state({identityText: '<b>Band</b> & "Song"'}), {text: 'Line'});
    assert.match(page, /&lt;b&gt;Band&lt;\/b&gt; &amp; &quot;Song&quot;/u);
    assert.match(page, /fetch\('\/status-body'/u);
    assert.doesNotMatch(page, /#[0-9a-f]{3,6}\b(?<!#000|#fff)/iu, 'no colors besides pure black and white');
});
