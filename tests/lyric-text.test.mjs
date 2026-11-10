import test from 'node:test';
import assert from 'node:assert/strict';

import {
    artistSimilarity, buildLookupCandidates, chooseAutomatic, cleanArtistName, cleanSongTitle,
    normalizeComparisonText, rankRecords, recordMatchesIdentity, scoreRecord, searchSettlesLookup,
    stripVersionQualifiers, tokenSimilarity,
} from '../shared/lyric-text.js';

test('comparison text ignores accents, punctuation, ampersands and noise words', () => {
    assert.equal(normalizeComparisonText('Beyoncé – Halo (Official Video)'), 'beyonce halo');
    assert.equal(normalizeComparisonText('Simon & Garfunkel'), 'simon and garfunkel');
    assert.equal(normalizeComparisonText('Lyrics'), 'lyrics');
    assert.equal(normalizeComparisonText('紅蓮華'), '紅蓮華');
});

test('token similarity is Jaccard over normalized tokens', () => {
    assert.equal(tokenSimilarity('Never Gonna Give You Up', 'never gonna give you up!'), 1);
    assert.equal(tokenSimilarity('a b', 'b c'), 1 / 3);
    assert.equal(tokenSimilarity('', 'x'), 0);
});

test('artist similarity accepts a matching first credited artist', () => {
    assert.equal(artistSimilarity('Lil Nas X & Billy Ray Cyrus', 'Lil Nas X'), 1);
    assert.ok(artistSimilarity('Paul Simon', 'Simon & Garfunkel') < 0.6);
});

test('song titles lose video labels and featured credits', () => {
    assert.equal(cleanSongTitle('Never Gonna Give You Up (Official Video) (4K Remaster)'), 'Never Gonna Give You Up');
    assert.equal(cleanSongTitle('Song (Remastered 2009)'), 'Song (Remastered 2009)');
    assert.equal(cleanSongTitle('Song (feat. Someone Else)'), 'Song');
    assert.equal(cleanSongTitle('Song feat. Someone Else'), 'Song');
    assert.equal(cleanSongTitle('Soft Cell Song | Live at Wembley'), 'Soft Cell Song');
    assert.equal(cleanSongTitle('“Quoted Title”'), 'Quoted Title');
});

test('version qualifiers are stripped for the fallback search', () => {
    assert.equal(stripVersionQualifiers('Help! (Remastered 2009)'), 'Help!');
    assert.equal(stripVersionQualifiers('Here Comes The Sun - Remastered 2019'), 'Here Comes The Sun');
    assert.equal(stripVersionQualifiers('Never Gonna Give You Up (7" Mix)'), 'Never Gonna Give You Up');
    assert.equal(stripVersionQualifiers('Up - Down'), 'Up - Down');
});

test('artist names lose Topic, Official and VEVO, splitting VEVO camel case', () => {
    assert.equal(cleanArtistName('Rick Astley - Topic'), 'Rick Astley');
    assert.equal(cleanArtistName('RickAstleyVEVO'), 'Rick Astley');
    assert.equal(cleanArtistName('Queen Official'), 'Queen');
    assert.equal(cleanArtistName('McFly'), 'McFly');
});

test('reliable identities search artist and title, then the bare title', () => {
    const candidates = buildLookupCandidates({
        reliable: true, artist: 'The Beatles', title: 'Help! (Remastered 2009)', videoTitle: 'Help! (Remastered 2009)', channel: 'The Beatles - Topic',
    });
    assert.deepEqual(candidates, [
        {artist: 'The Beatles', title: 'Help! (Remastered 2009)'},
        {artist: 'The Beatles', title: 'Help!'},
    ]);
});

test('video titles produce parsed, stripped, channel and swapped candidates', () => {
    const candidates = buildLookupCandidates({
        reliable: false, artist: '', title: '',
        videoTitle: 'Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)', channel: 'RickAstleyVEVO',
    });
    assert.deepEqual(candidates, [
        {artist: 'Rick Astley', title: 'Never Gonna Give You Up'},
        {artist: 'Never Gonna Give You Up', title: 'Rick Astley'},
    ]);
    const remaster = buildLookupCandidates({reliable: false, artist: '', title: '', videoTitle: 'Band - Song (Remastered 2009)', channel: 'Label Records'});
    assert.deepEqual(remaster, [
        {artist: 'Band', title: 'Song (Remastered 2009)'},
        {artist: 'Band', title: 'Song'},
        {artist: 'Label Records', title: 'Song (Remastered 2009)'},
        {artist: 'Song', title: 'Band'},
    ]);
    const channelOnly = buildLookupCandidates({reliable: false, artist: '', title: '', videoTitle: 'Bohemian Rhapsody', channel: 'Queen Official'});
    assert.deepEqual(channelOnly, [{artist: 'Queen', title: 'Bohemian Rhapsody'}]);
});

const record = (id, trackName, artistName, duration, synced) => ({
    id, trackName, artistName, albumName: '', duration, instrumental: false,
    plainLyrics: 'words', syncedLyrics: synced ? '[00:01.00] words' : null,
});

test('scores keep voice-wei weights: title 0.6, artist 0.25, duration 0.15', () => {
    const candidate = {artist: 'Rick Astley', title: 'Never Gonna Give You Up'};
    assert.equal(scoreRecord(record(1, 'Never Gonna Give You Up', 'Rick Astley', 213, true), candidate, 213), 1);
    assert.equal(scoreRecord(record(1, 'Never Gonna Give You Up', 'Rick Astley', 223, true), candidate, 213), 0.6 + 0.25 + 0.075);
    assert.equal(scoreRecord(record(1, 'Never Gonna Give You Up', 'Rick Astley', 0, true), candidate, 213), 0.6 + 0.25 + 0.075);
    assert.equal(scoreRecord(record(1, 'Never Gonna Give You Up', '', 213, true), {artist: '', title: candidate.title}, 213), 0.6 + 0.55 * 0.25 + 0.15);
});

test('identity match compares version-stripped titles too', () => {
    assert.ok(recordMatchesIdentity(record(1, 'Help!', 'The Beatles', 140, true), {artist: 'The Beatles', title: 'Help! (Remastered 2009)'}));
    assert.ok(!recordMatchesIdentity(record(1, 'Help!', 'Other Band', 140, true), {artist: 'The Beatles', title: 'Help!'}));
});

test('timed identity matches win over stronger plain ones; rejections are skipped', () => {
    const candidate = {artist: 'Artist', title: 'Song'};
    const ranked = rankRecords([{candidate, records: [
        record(1, 'Song', 'Artist', 200, false),
        record(2, 'Song', 'Artist', 230, true),
        record(3, 'Other', 'Artist', 200, true),
    ]}], 200);
    assert.deepEqual(ranked.map(entry => entry.record.id), [1, 2, 3]);
    assert.equal(chooseAutomatic(ranked, []), 2);
    assert.equal(chooseAutomatic(ranked, [2]), 1);
    assert.equal(chooseAutomatic(ranked, [1, 2]), null);
});

test('a strong timed match settles the lookup; a weak one does not', () => {
    const candidate = {artist: 'Artist', title: 'Song'};
    assert.ok(searchSettlesLookup([record(1, 'Song', 'Artist', 200, true)], candidate, 200));
    assert.ok(!searchSettlesLookup([record(1, 'Song', 'Artist', 200, false)], candidate, 200));
    assert.ok(!searchSettlesLookup([record(1, 'Song Two Three', 'Artist', 260, true)], candidate, 200));
});
