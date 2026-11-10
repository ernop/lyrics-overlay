import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

import {parseReport} from '../service/report-schema.js';
import {deriveIdentity, deriveNextIdentity} from '../shared/song-identity.js';

// The content script's classic-script reader, run in this realm.
vm.runInThisContext(fs.readFileSync(new URL('../firefox/youtube-page.js', import.meta.url), 'utf8'));
const page = globalThis.LyricsYouTubePage;

// Shapes captured from the live sites (signed out), trimmed to what is read.
const PLAYER = {
    videoDetails: {
        videoId: 'dQw4w9WgXcQ', title: 'Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)',
        author: 'Rick Astley', lengthSeconds: '213', shortDescription: 'The official video for “Never Gonna Give You Up” by Rick Astley.',
        channelId: 'UCuAXFkgsw1L7xaCfnd5JJOw',
    },
    microformat: {playerMicroformatRenderer: {category: 'Music', lengthSeconds: '213'}},
};

const musicList = {
    horizontalCardListRenderer: {
        header: {richListHeaderRenderer: {title: {simpleText: 'Music'}, subtitle: {simpleText: '1 song'}}},
        cards: [{videoAttributeViewModel: {
            title: 'Never Gonna Give You Up (7" Mix)', subtitle: 'Rick Astley',
            secondarySubtitle: {content: 'Whenever You Need Somebody'}, imageStyle: 'VIDEO_ATTRIBUTE_IMAGE_STYLE_SQUARE',
        }}],
        footerButton: {buttonViewModel: {iconName: 'MUSIC', titleFormatted: {content: 'Music'}}},
    },
};
const gamesList = {
    horizontalCardListRenderer: {
        header: {richListHeaderRenderer: {title: {simpleText: 'Gaming'}}},
        cards: [{videoAttributeViewModel: {title: 'Some Game', subtitle: '2020', secondarySubtitle: {content: ''}}}],
    },
};

function watchNext({videoId = 'dQw4w9WgXcQ', playlist = null} = {}) {
    return {
        currentVideoEndpoint: {watchEndpoint: {videoId}},
        engagementPanels: [
            {engagementPanelSectionListRenderer: {content: {sectionListRenderer: {}}}},
            {engagementPanelSectionListRenderer: {content: {structuredDescriptionContentRenderer: {
                items: [{videoDescriptionHeaderRenderer: {}}, gamesList, musicList],
            }}}},
        ],
        contents: {twoColumnWatchNextResults: playlist ? {playlist: {playlist}} : {}},
    };
}

const NEXT_BUTTON = {
    href: 'https://www.youtube.com/watch?v=yPYZpwSpKmA',
    title: 'Rick Astley - Together Forever (Official Video) [4K Remaster]', duration: '3:24',
};

const MIX = {
    playlistId: 'RDdQw4w9WgXcQ', currentIndex: 0, isInfinite: true,
    contents: [
        {playlistPanelVideoRenderer: {videoId: 'dQw4w9WgXcQ', title: {simpleText: 'Rick Astley - Never Gonna Give You Up'}, selected: true}},
        {playlistPanelVideoRenderer: {
            videoId: 'djV11Xbc914', title: {simpleText: 'a-ha - Take On Me (Official Video) [4K]'},
            shortBylineText: {runs: [{text: 'a-ha'}]}, lengthText: {simpleText: '4:04'}, selected: false,
        }},
    ],
};

const YTM_PLAYER = {
    videoDetails: {videoId: 'dQw4w9WgXcQ', title: 'Never Gonna Give You Up', author: 'Rick Astley', lengthSeconds: '213', musicVideoType: 'MUSIC_VIDEO_TYPE_ATV'},
    microformat: {microformatDataRenderer: {}},
};
const YTM_SESSION = {title: 'Never Gonna Give You Up', artist: 'Rick Astley', album: 'Whenever You Need Somebody'};
const YTM_QUEUE = [
    {selected: true, data: {videoId: 'dQw4w9WgXcQ', title: {runs: [{text: 'Never Gonna Give You Up'}]}}},
    {selected: false, data: {
        videoId: 'queuenext01', title: {runs: [{text: 'Next Song'}]},
        shortBylineText: {runs: [{text: 'Other Band'}]}, lengthText: {runs: [{text: '3:18'}]},
    }},
];

test('the player response gives the loaded video', () => {
    assert.deepEqual(page.readPlayer(PLAYER), {
        videoId: 'dQw4w9WgXcQ', title: 'Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)',
        author: 'Rick Astley', lengthSeconds: 213, category: 'Music', musicVideoType: '',
        description: 'The official video for “Never Gonna Give You Up” by Rick Astley.',
    });
    assert.equal(page.readPlayer(YTM_PLAYER).category, '');
    assert.equal(page.readPlayer(YTM_PLAYER).musicVideoType, 'MUSIC_VIDEO_TYPE_ATV');
    assert.equal(page.readPlayer(undefined), null);
    assert.equal(page.readPlayer({videoDetails: {videoId: 'not an id!'}}), null);
});

test('only the description Music section yields cards', () => {
    assert.deepEqual(page.readMusicCards(watchNext()), [
        {title: 'Never Gonna Give You Up (7" Mix)', artist: 'Rick Astley', album: 'Whenever You Need Somebody'},
    ]);
    assert.deepEqual(page.readMusicCards({}), []);
});

test('youtube.com metadata waits for the watch data of the loaded video', () => {
    const base = {host: 'www.youtube.com', watchPage: true, player: page.readPlayer(PLAYER), mediaSession: null, ytmTitle: '', ytmByline: ''};
    assert.equal(page.buildMetadata({...base, watchNext: null}), null, 'the description has not loaded yet');
    assert.equal(page.buildMetadata({...base, watchNext: watchNext({videoId: 'djV11Xbc914'})}), null, 'still the previous video');

    const metadata = page.buildMetadata({...base, watchNext: watchNext()});
    assert.equal(metadata.musicCards.length, 1);
    const identity = deriveIdentity(metadata);
    assert.equal(identity.source, 'music-card');
    assert.equal(identity.artist, 'Rick Astley');
    assert.equal(identity.album, 'Whenever You Need Somebody');

    // The miniplayer, off the watch page, goes ahead without the description.
    const miniplayer = {...base, watchPage: false};
    assert.deepEqual(page.buildMetadata({...miniplayer, watchNext: null}).musicCards, []);
    assert.deepEqual(page.buildMetadata({...miniplayer, watchNext: watchNext({videoId: 'djV11Xbc914'})}).musicCards, []);
});

test('YouTube Music metadata waits until the media session and player bar show the loaded track', () => {
    const base = {
        host: 'music.youtube.com', watchPage: true, player: page.readPlayer(YTM_PLAYER), watchNext: null,
        mediaSession: YTM_SESSION, ytmTitle: 'Never Gonna Give You Up', ytmByline: ' Rick Astley •\n Whenever You Need Somebody • 1987 ',
    };
    assert.equal(page.buildMetadata({...base, mediaSession: {...YTM_SESSION, title: 'Previous Song'}}), null);
    assert.equal(page.buildMetadata({...base, mediaSession: null}), null);
    assert.equal(page.buildMetadata({...base, ytmTitle: 'Previous Song'}), null);

    const metadata = page.buildMetadata(base);
    assert.equal(metadata.ytmByline, 'Rick Astley • Whenever You Need Somebody • 1987');
    const identity = deriveIdentity(metadata);
    assert.deepEqual([identity.source, identity.title, identity.artist, identity.album, identity.year],
        ['youtube-music', 'Never Gonna Give You Up', 'Rick Astley', 'Whenever You Need Somebody', '1987']);
});

test('the next youtube.com video is the next playlist entry, else the player\'s autoplay pick', () => {
    const takeOnMe = {host: 'www.youtube.com', videoId: 'djV11Xbc914', title: 'a-ha - Take On Me (Official Video) [4K]', byline: 'a-ha', durationSeconds: 244};
    const together = {host: 'www.youtube.com', videoId: 'yPYZpwSpKmA', title: NEXT_BUTTON.title, byline: '', durationSeconds: 204};
    const base = {currentVideoId: 'dQw4w9WgXcQ', autoplayOn: false, nextButton: NEXT_BUTTON};
    const lastEntry = watchNext({playlist: {...MIX, currentIndex: 1}});

    assert.deepEqual(page.nextFromWatchPage({...base, watchNext: watchNext({playlist: MIX})}), takeOnMe);
    assert.deepEqual(page.nextFromWatchPage({...base, watchNext: watchNext(), autoplayOn: true}), together);
    assert.equal(page.nextFromWatchPage({...base, watchNext: watchNext()}), null, 'autoplay off');
    assert.equal(page.nextFromWatchPage({...base, watchNext: lastEntry}), null, 'the playlist ends');
    assert.deepEqual(page.nextFromWatchPage({...base, watchNext: lastEntry, autoplayOn: true}), together, 'autoplay continues');
    assert.equal(page.nextFromWatchPage({...base, watchNext: watchNext({videoId: 'otherVideo1', playlist: MIX})}), null,
        'watch data of another video says nothing about the playlist position');

    // Inside a playlist the button's link carries the list first and, briefly, no duration.
    const inList = {href: 'https://www.youtube.com/watch?list=RDdQw4w9WgXcQ&v=yPYZpwSpKmA', title: NEXT_BUTTON.title, duration: ''};
    assert.deepEqual(page.nextFromWatchPage({...base, watchNext: null, autoplayOn: true, nextButton: inList}), {...together, durationSeconds: 0});
    assert.equal(page.nextFromWatchPage({...base, watchNext: null, autoplayOn: true, nextButton: {href: '', title: '', duration: ''}}), null);
    assert.equal(page.nextFromWatchPage({...base, watchNext: null, autoplayOn: true, nextButton: null}), null);
    assert.equal(deriveNextIdentity(takeOnMe).title, 'Take On Me');
});

test('the next YouTube Music track is the queue entry after the selected one', () => {
    assert.deepEqual(page.nextFromQueue(YTM_QUEUE),
        {host: 'music.youtube.com', videoId: 'queuenext01', title: 'Next Song', byline: 'Other Band', durationSeconds: 198});
    assert.equal(page.nextFromQueue([{...YTM_QUEUE[0], selected: false}, {...YTM_QUEUE[1], selected: true}]), null);
    assert.equal(page.nextFromQueue([]), null);
});

test('a report assembled from page data passes the service schema', () => {
    const player = page.readPlayer(PLAYER);
    const metadata = page.buildMetadata({host: 'www.youtube.com', watchPage: true, player, watchNext: watchNext({playlist: MIX}), mediaSession: null, ytmTitle: '', ytmByline: ''});
    const now = Date.now();
    const report = {
        tabId: 12, sampledAt: now, heartbeatMs: 5000,
        media: {videoId: player.videoId, currentTime: 10.5, duration: 213, paused: false, ended: false, stalled: false,
            playbackRate: 1, muted: false, volume: 1, adShowing: false},
        metadata,
        next: page.nextFromWatchPage({watchNext: watchNext({playlist: MIX}), currentVideoId: player.videoId, autoplayOn: true, nextButton: NEXT_BUTTON}),
    };
    const parsed = parseReport(JSON.parse(JSON.stringify(report)), now);
    assert.equal(parsed.message.metadata.musicCards[0].artist, 'Rick Astley');
    assert.equal(parsed.message.next.videoId, 'djV11Xbc914');
});
