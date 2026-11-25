import test from 'node:test';
import assert from 'node:assert/strict';

import {
    artistSimilarity, buildLookupCandidates, chooseAutomatic, cleanArtistName, cleanSongTitle,
    durationFitsPlain, durationFitsTimed, maxSpokenTimestampSeconds, normalizeComparisonText,
    rankRecords, recordMatchesIdentity, scoreRecord, searchSettlesLookup,
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
    assert.deepEqual(channelOnly, [
        {artist: 'Queen', title: 'Bohemian Rhapsody'},
        {artist: '', title: 'Bohemian Rhapsody'},
    ]);
});

const record = (id, trackName, artistName, duration, synced) => ({
    id, trackName, artistName, albumName: '', duration, instrumental: false,
    plainLyrics: 'words', syncedLyrics: synced ? '[00:01.00] words' : null,
});

test('scores keep title 0.6, artist 0.25, duration 0.15 with smooth decay beyond 20 s', () => {
    const candidate = {artist: 'Rick Astley', title: 'Never Gonna Give You Up'};
    assert.equal(scoreRecord(record(1, 'Never Gonna Give You Up', 'Rick Astley', 213, true), candidate, 213), 1);
    assert.equal(scoreRecord(record(1, 'Never Gonna Give You Up', 'Rick Astley', 223, true), candidate, 213), 0.6 + 0.25 + 0.075);
    assert.equal(scoreRecord(record(1, 'Never Gonna Give You Up', 'Rick Astley', 0, true), candidate, 213), 0.6 + 0.25 + 0.075);
    assert.equal(scoreRecord(record(1, 'Never Gonna Give You Up', '', 213, true), {artist: '', title: candidate.title}, 213), 0.6 + 0.55 * 0.25 + 0.15);
    const diff21 = scoreRecord(record(1, 'Never Gonna Give You Up', 'Rick Astley', 234, true), candidate, 213);
    const diff59 = scoreRecord(record(1, 'Never Gonna Give You Up', 'Rick Astley', 272, true), candidate, 213);
    const diff92 = scoreRecord(record(1, 'Never Gonna Give You Up', 'Rick Astley', 305, true), candidate, 213);
    assert.ok(diff21 > diff59 && diff59 > diff92, 'closer duration must always outrank farther duration');
});

test('identity match compares version-stripped titles and rejects gross duration mismatches', () => {
    assert.ok(recordMatchesIdentity(record(1, 'Help!', 'The Beatles', 140, true), {artist: 'The Beatles', title: 'Help! (Remastered 2009)'}));
    assert.ok(!recordMatchesIdentity(record(1, 'Help!', 'Other Band', 140, true), {artist: 'The Beatles', title: 'Help!'}));
    assert.ok(recordMatchesIdentity(record(1, 'Help!', 'The Beatles', 200, true), {artist: 'The Beatles', title: 'Help!'}, 225));
    assert.ok(!recordMatchesIdentity(record(1, 'Help!', 'The Beatles', 150, true), {artist: 'The Beatles', title: 'Help!'}, 7200));
    assert.ok(!recordMatchesIdentity(record(1, 'Help!', 'The Beatles', 90, true), {artist: 'The Beatles', title: 'Help!'}, 60));
    assert.equal(durationFitsPlain(record(1, 'Help!', 'The Beatles', 0, false), 200), true);
});

test('durationFitsTimed requires ±2 s duration match and no spoken lines past the track end', () => {
    assert.equal(durationFitsTimed(record(1, 'Song', 'Artist', 200, true), 200), true);
    assert.equal(durationFitsTimed(record(1, 'Song', 'Artist', 202, true), 200), true);
    assert.equal(durationFitsTimed(record(1, 'Song', 'Artist', 198.1, true), 200), true);
    assert.equal(durationFitsTimed(record(1, 'Song', 'Artist', 202.1, true), 200), false);
    assert.equal(durationFitsTimed(record(1, 'Song', 'Artist', 203, true), 200), false);
    assert.equal(durationFitsTimed(record(1, 'Song', 'Artist', 0, true), 200), false);
    assert.equal(durationFitsTimed(record(1, 'Song', 'Artist', 200, true), 0), true);

    const overrun = {...record(1, 'Song', 'Artist', 200, true), syncedLyrics: '[00:10.00] Line\n[03:45.00] Way past end'};
    assert.equal(maxSpokenTimestampSeconds(overrun.syncedLyrics), 225);
    assert.equal(durationFitsTimed(overrun, 200), false);

    // Trailing blank lines and credit lines past the end do not disqualify valid timing.
    const trailingCredits = {
        ...record(1, 'Song', 'Artist', 200, true),
        syncedLyrics: '[00:10.00] Line\n[03:15.00] Last sung line\n[03:25.00]\n[03:30.00] Songwriters: Someone',
    };
    assert.equal(maxSpokenTimestampSeconds(trailingCredits.syncedLyrics), 195);
    assert.equal(durationFitsTimed(trailingCredits, 200), true);
});

test('within-±2 s timed matches win over plain ones; moderate mismatches demote to plain; gross mismatches fail', () => {
    const candidate = {artist: 'Artist', title: 'Song'};
    const ranked = rankRecords([{candidate, records: [
        record(1, 'Song', 'Artist', 200, false),
        record(2, 'Song', 'Artist', 201.5, true),
        record(3, 'Song', 'Artist', 230, true),
        record(4, 'Song', 'Artist', 255, true),
        record(5, 'Song', 'Artist', 400, true),
        record(6, 'Other', 'Artist', 200, true),
    ]}], 200);
    assert.deepEqual(ranked.map(entry => entry.record.id), [2, 1, 3, 4, 5, 6]);
    assert.equal(ranked.find(e => e.record.id === 2).timed, true);
    assert.equal(ranked.find(e => e.record.id === 3).timed, false);
    assert.equal(ranked.find(e => e.record.id === 3).matches, true);
    assert.equal(ranked.find(e => e.record.id === 5).matches, false);
    assert.equal(chooseAutomatic(ranked, []), 2);
    assert.equal(chooseAutomatic(ranked, [2]), 1);
    assert.equal(chooseAutomatic(ranked, [1, 2]), 3);
    assert.equal(chooseAutomatic(ranked, [1, 2, 3, 4]), null);
});

test('a strong length-matched timed hit settles the lookup; a mismatched-length one does not', () => {
    const candidate = {artist: 'Artist', title: 'Song'};
    assert.ok(searchSettlesLookup([record(1, 'Song', 'Artist', 200, true)], candidate, 200));
    assert.ok(searchSettlesLookup([record(1, 'Song', 'Artist', 201.8, true)], candidate, 200));
    assert.ok(!searchSettlesLookup([record(1, 'Song', 'Artist', 200, false)], candidate, 200));
    assert.ok(!searchSettlesLookup([record(1, 'Song', 'Artist', 210, true)], candidate, 200));
    assert.ok(!searchSettlesLookup([record(1, 'Song', 'Artist', 260, true)], candidate, 200));
    assert.ok(!searchSettlesLookup([record(1, 'Song Two Three', 'Artist', 200, true)], candidate, 200));
});
