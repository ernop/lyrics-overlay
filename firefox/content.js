// Reports the YouTube player's state to the local lyrics service, through
// the background script: on media events, when an ad starts or ends, when
// the page's track details settle, and every HEARTBEAT_MS while the video is
// neither paused nor ended. Each report states that promise (heartbeatMs),
// and the service drops a tab that breaks it: a browser that quit or
// crashed cannot say goodbye. Firefox only: page data is read through
// wrappedJSObject.
'use strict';

(() => {
    const HEARTBEAT_MS = 5_000;
    // The service keeps a stopped song on screen for two minutes
    // (SOUNDING_GRACE_MS in service/core.js), and a click on its lyric needs
    // the background page, which Firefox stops after 30 s without events.
    const STOPPED_SHOWN_MS = 120_000;
    const KEEP_ALIVE_MS = 20_000;
    const HOST = location.hostname;
    const MEDIA_EVENTS = ['play', 'playing', 'pause', 'seeked', 'ratechange', 'ended', 'volumechange',
        'waiting', 'emptied', 'loadeddata', 'durationchange'];
    const page = globalThis.LyricsYouTubePage;

    let heartbeat = 0;
    let keepAlive = 0;
    let scheduled = false;
    let watchedPlayer = null;
    let adShowing = false;
    let trackText = '';

    const finite = value => (Number.isFinite(value) ? value : 0);

    function mainVideo(target) {
        return target?.localName === 'video' && target.closest('#movie_player') !== null;
    }

    function ytmTrackElements() {
        return {
            title: document.querySelector('ytmusic-player-bar .title'),
            byline: document.querySelector('ytmusic-player-bar yt-formatted-string.byline'),
        };
    }

    function ytmQueue() {
        const items = document.querySelectorAll('ytmusic-player-queue-item');
        const queue = [];
        for (const item of items)
            queue.push({selected: item.hasAttribute('selected'), data: item.wrappedJSObject.data});
        return queue;
    }

    function buildReport() {
        const playerElement = document.getElementById('movie_player');
        const video = playerElement?.querySelector('video');
        if (!video)
            return null;
        const player = playerElement.wrappedJSObject;
        const info = page.readPlayer(player.getPlayerResponse?.());
        const showingAd = playerElement.classList.contains('ad-showing');
        const report = {
            sampledAt: Date.now(),
            media: {
                videoId: info ? info.videoId : null,
                currentTime: finite(video.currentTime),
                duration: finite(video.duration),
                paused: video.paused,
                ended: video.ended,
                stalled: !video.paused && video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA,
                playbackRate: finite(video.playbackRate),
                muted: video.muted,
                volume: finite(video.volume),
                adShowing: showingAd,
            },
        };
        // During an ad the media session and player bar describe the ad.
        if (!info || showingAd)
            return report;
        // The player's own getWatchNextResponse() fills in later than this
        // on a fresh page load, and no event marks when it does.
        const watchNext = HOST === 'www.youtube.com'
            ? (document.querySelector('ytd-watch-flexy')?.wrappedJSObject.data ?? null) : null;
        const track = ytmTrackElements();
        const metadata = page.buildMetadata({
            host: HOST,
            watchPage: location.pathname === '/watch',
            player: info,
            watchNext,
            mediaSession: page.readMediaSession(navigator.mediaSession.metadata),
            ytmTitle: track.title?.textContent ?? '',
            ytmByline: track.byline?.textContent ?? '',
        });
        if (!metadata)
            return report;
        report.metadata = metadata;
        if (HOST === 'music.youtube.com') {
            report.next = page.nextFromQueue(ytmQueue());
        } else {
            const nextButton = playerElement.querySelector('.ytp-next-button');
            report.next = page.nextFromWatchPage({
                watchNext,
                currentVideoId: info.videoId,
                autoplayOn: playerElement.querySelector('.ytp-autonav-toggle-button')?.getAttribute('aria-checked') === 'true',
                nextButton: nextButton && {
                    href: nextButton.getAttribute('href') ?? '',
                    title: nextButton.getAttribute('data-tooltip-text') ?? '',
                    duration: nextButton.getAttribute('data-duration') ?? '',
                },
            });
        }
        return report;
    }

    function send() {
        scheduled = false;
        clearTimeout(heartbeat);
        clearInterval(keepAlive);
        const report = buildReport();
        if (!report)
            return;
        const running = !report.media.paused && !report.media.ended;
        report.heartbeatMs = running ? HEARTBEAT_MS : null;
        browser.runtime.sendMessage({type: 'report', report});
        if (running) {
            heartbeat = setTimeout(schedule, HEARTBEAT_MS);
            return;
        }
        const stoppedAt = Date.now();
        keepAlive = setInterval(() => {
            if (Date.now() - stoppedAt >= STOPPED_SHOWN_MS)
                clearInterval(keepAlive);
            else
                browser.runtime.sendMessage({type: 'keepAlive'});
        }, KEEP_ALIVE_MS);
    }

    /** Coalesces the events of one task into a single report. */
    function schedule() {
        if (scheduled)
            return;
        scheduled = true;
        queueMicrotask(send);
    }

    const playerObserver = new MutationObserver(() => {
        const showing = watchedPlayer.classList.contains('ad-showing');
        if (showing !== adShowing) {
            adShowing = showing;
            schedule();
        }
    });

    const trackObserver = new MutationObserver(() => {
        const {title, byline} = ytmTrackElements();
        const current = `${title?.textContent ?? ''}\n${byline?.textContent ?? ''}`;
        if (current !== trackText) {
            trackText = current;
            schedule();
        }
    });

    function watchPlayer(playerElement) {
        if (playerElement === watchedPlayer)
            return;
        watchedPlayer = playerElement;
        adShowing = playerElement.classList.contains('ad-showing');
        playerObserver.disconnect();
        playerObserver.observe(playerElement, {attributes: true, attributeFilter: ['class']});
        if (HOST === 'music.youtube.com') {
            trackObserver.disconnect();
            const {title, byline} = ytmTrackElements();
            for (const element of [title, byline]) {
                if (element)
                    trackObserver.observe(element, {childList: true, characterData: true, subtree: true});
            }
        }
    }

    function onMediaEvent(event) {
        if (!mainVideo(event.target))
            return;
        watchPlayer(event.target.closest('#movie_player'));
        schedule();
    }

    for (const type of MEDIA_EVENTS)
        document.addEventListener(type, onMediaEvent, true);
    // youtube.com stamps the watch page's data (description music cards,
    // playlist, autoplay) seconds after the video starts, and sets
    // ytd-watch-flexy's video-id attribute in the same task.
    // yt-page-data-updated fires before the data is there.
    const watchPageObserver = new MutationObserver(records => {
        if (watchedPlayer && records.some(record => record.target.localName === 'ytd-watch-flexy'))
            schedule();
    });
    if (HOST === 'www.youtube.com')
        watchPageObserver.observe(document, {subtree: true, attributes: true, attributeFilter: ['video-id']});
    window.addEventListener('pagehide', () => browser.runtime.sendMessage({type: 'gone'}));
    window.addEventListener('pageshow', event => {
        if (event.persisted && watchedPlayer)
            schedule();
    });
    browser.runtime.onMessage.addListener(message => {
        if (message.type === 'reportNow' && watchedPlayer)
            schedule();
    });

    const existing = document.querySelector('#movie_player video');
    if (existing) {
        watchPlayer(existing.closest('#movie_player'));
        schedule();
    }
})();
