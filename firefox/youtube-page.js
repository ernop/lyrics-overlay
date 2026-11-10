// Reads what the lyrics service needs from YouTube and YouTube Music page
// data. Every function takes plain values, so tests feed captured fixtures
// and the content script passes the page's objects (through
// wrappedJSObject). Page objects are read with property gets and index
// loops only: page code cannot call back into content-script functions,
// so array methods like find() or map() fail on them.
//
// Structures verified on the live sites 2026-11-09:
//   player.getPlayerResponse().videoDetails / .microformat.playerMicroformatRenderer
//   ytd-watch-flexy .data, the watch-next response (youtube.com only):
//     .currentVideoEndpoint.watchEndpoint.videoId
//     .engagementPanels[].engagementPanelSectionListRenderer.content
//       .structuredDescriptionContentRenderer.items[].horizontalCardListRenderer
//       .cards[].videoAttributeViewModel {title, subtitle, secondarySubtitle.content}
//     .contents.twoColumnWatchNextResults.playlist.playlist {currentIndex, contents[].playlistPanelVideoRenderer}
//   #movie_player .ytp-next-button [href, data-tooltip-text, data-duration]
//     (the player's own next video; the watch-next response's autoplay
//     renderer is missing in most sessions)
//   ytmusic-player-queue-item[selected] .data (playlistPanelVideoRenderer)
'use strict';

globalThis.LyricsYouTubePage = (() => {
    const VIDEO_ID = /^[A-Za-z0-9_-]{6,20}$/u;
    const MAX_MUSIC_CARDS = 5;

    function plain(value) {
        return typeof value === 'string' ? value : '';
    }

    /** YouTube's text shapes: "x", {simpleText}, {content}, {runs: [{text}]}. */
    function text(value) {
        if (typeof value === 'string')
            return value;
        if (!value || typeof value !== 'object')
            return '';
        if (typeof value.simpleText === 'string')
            return value.simpleText;
        if (typeof value.content === 'string')
            return value.content;
        const runs = value.runs;
        if (!runs || typeof runs.length !== 'number')
            return '';
        let joined = '';
        for (let i = 0; i < runs.length; i++)
            joined += plain(runs[i]?.text);
        return joined;
    }

    /** "4:22" or "1:02:03" to seconds; 0 when absent or unreadable. */
    function clockSeconds(value) {
        const match = /^(\d+):(\d{1,2})(?::(\d{1,2}))?$/u.exec(value.trim());
        if (!match)
            return 0;
        const [, a, b, c] = match;
        return c === undefined ? Number(a) * 60 + Number(b) : Number(a) * 3600 + Number(b) * 60 + Number(c);
    }

    function videoId(value) {
        return typeof value === 'string' && VIDEO_ID.test(value) ? value : null;
    }

    /** The loaded video, or null before the player has one. */
    function readPlayer(playerResponse) {
        const details = playerResponse?.videoDetails;
        const id = videoId(details?.videoId);
        if (!id)
            return null;
        return {
            videoId: id,
            title: plain(details.title),
            author: plain(details.author),
            lengthSeconds: Number(details.lengthSeconds) || 0,
            category: plain(playerResponse.microformat?.playerMicroformatRenderer?.category),
            musicVideoType: plain(details.musicVideoType),
            description: plain(details.shortDescription),
        };
    }

    function watchNextVideoId(watchNext) {
        return videoId(watchNext?.currentVideoEndpoint?.watchEndpoint?.videoId);
    }

    function isMusicList(list) {
        return text(list?.header?.richListHeaderRenderer?.title) === 'Music' ||
            list?.footerButton?.buttonViewModel?.iconName === 'MUSIC';
    }

    /** The description's "Music" section: song, artist and album per card. */
    function readMusicCards(watchNext) {
        const cards = [];
        const panels = watchNext?.engagementPanels;
        for (let p = 0; p < (panels?.length ?? 0); p++) {
            const items = panels[p]?.engagementPanelSectionListRenderer?.content?.structuredDescriptionContentRenderer?.items;
            for (let i = 0; i < (items?.length ?? 0); i++) {
                const list = items[i]?.horizontalCardListRenderer;
                if (!isMusicList(list))
                    continue;
                for (let c = 0; c < (list.cards?.length ?? 0) && cards.length < MAX_MUSIC_CARDS; c++) {
                    const card = list.cards[c]?.videoAttributeViewModel;
                    if (card)
                        cards.push({title: text(card.title), artist: text(card.subtitle), album: text(card.secondarySubtitle)});
                }
            }
        }
        return cards;
    }

    function readMediaSession(metadata) {
        if (!metadata)
            return null;
        return {title: plain(metadata.title), artist: plain(metadata.artist), album: plain(metadata.album)};
    }

    function sameText(a, b) {
        return a.trim().toLowerCase() === b.trim().toLowerCase();
    }

    /**
     * Metadata for the loaded video, or null while the page's other data is
     * missing or still describes the previous video; a later report (page
     * data event, track change, heartbeat) carries it. Waiting keeps the
     * first lookup from running on a half-loaded identity.
     * @param {{host: string, watchPage: boolean, player: ReturnType<typeof readPlayer>,
     *          watchNext: object|null, mediaSession: {title: string, artist: string, album: string}|null,
     *          ytmTitle: string, ytmByline: string}} page
     */
    function buildMetadata({host, watchPage, player, watchNext, mediaSession, ytmTitle, ytmByline}) {
        const watchNextCurrent = Boolean(watchNext) && watchNextVideoId(watchNext) === player.videoId;
        // Off the watch page (the miniplayer) the description may never load.
        if (host === 'www.youtube.com' && watchPage && !watchNextCurrent)
            return null;
        if (host === 'music.youtube.com' &&
            (!mediaSession || !sameText(mediaSession.title, player.title) || !sameText(ytmTitle, player.title)))
            return null;
        return {
            host,
            videoId: player.videoId,
            title: player.title,
            author: player.author,
            lengthSeconds: player.lengthSeconds,
            category: player.category,
            musicVideoType: player.musicVideoType,
            description: player.description,
            musicCards: watchNextCurrent ? readMusicCards(watchNext) : [],
            mediaSession,
            ytmByline: host === 'music.youtube.com' ? ytmByline.replace(/\s+/gu, ' ').trim() : '',
        };
    }

    function listEntry(host, renderer) {
        const id = videoId(renderer?.videoId);
        if (!id)
            return null;
        return {
            host,
            videoId: id,
            title: text(renderer.title),
            byline: text(renderer.shortBylineText),
            durationSeconds: clockSeconds(text(renderer.lengthText)),
        };
    }

    /**
     * The video youtube.com will play next: the next entry of the playing
     * playlist, else, with autoplay on, the player's own pick from its next
     * button, which names no channel. Watch data left over from another
     * video (the miniplayer) says nothing about the playlist position.
     * @param {{watchNext: object|null, currentVideoId: string, autoplayOn: boolean,
     *          nextButton: {href: string, title: string, duration: string}|null}} page
     */
    function nextFromWatchPage({watchNext, currentVideoId, autoplayOn, nextButton}) {
        if (watchNext && watchNextVideoId(watchNext) === currentVideoId) {
            const playlist = watchNext.contents?.twoColumnWatchNextResults?.playlist?.playlist;
            const index = playlist?.currentIndex;
            if (typeof index === 'number' && playlist.contents && index + 1 < playlist.contents.length)
                return listEntry('www.youtube.com', playlist.contents[index + 1]?.playlistPanelVideoRenderer);
        }
        if (!autoplayOn || !nextButton)
            return null;
        const id = videoId(/[?&]v=([^&#]+)/u.exec(nextButton.href)?.[1]);
        if (!id)
            return null;
        return {host: 'www.youtube.com', videoId: id, title: nextButton.title, byline: '', durationSeconds: clockSeconds(nextButton.duration)};
    }

    /**
     * The track YouTube Music will play next, from its queue.
     * @param {Array<{selected: boolean, data: object}>} queue in display order
     */
    function nextFromQueue(queue) {
        for (let i = 0; i < queue.length - 1; i++) {
            if (queue[i].selected)
                return listEntry('music.youtube.com', queue[i + 1].data);
        }
        return null;
    }

    return Object.freeze({readPlayer, readMediaSession, buildMetadata, readMusicCards, nextFromWatchPage, nextFromQueue});
})();
