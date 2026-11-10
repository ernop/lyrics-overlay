// Forwards YouTube tab reports to the local lyrics service with the tab's
// id, tells it when a reporting tab goes away, and carries out its
// commands (a click on the lyric selects the song's tab). Nothing leaves
// this computer: the only destination is the service on this machine.
'use strict';

// *.localhost is always this machine. The name, not 127.0.0.1, because the
// host permission an install granted for it survives updates; the port is
// the one in settings.example.json (tests/firefox-service-url.test.mjs).
const SERVICE = 'http://lyrics.localhost:8792';
// Tabs that have reported since this event page started; a tab whose video
// runs reports every few seconds, which keeps this page alive while it matters.
const reportingTabs = new Set();
let unreachable = false;
let listening = false;

function noteUnreachable(error) {
    // The service is stopped. Reports are snapshots, so nothing is
    // retried: the next event sends a fresh one.
    if (!unreachable)
        console.warn(`lyrics service unreachable: ${error.message}`);
    unreachable = true;
}

/** @returns {Promise<Response|null>} null when the service cannot be reached */
async function request(path, body) {
    let response;
    try {
        response = await fetch(`${SERVICE}${path}`, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            body: JSON.stringify(body),
            cache: 'no-store',
        });
    } catch (error) {
        noteUnreachable(error);
        return null;
    }
    unreachable = false;
    return response;
}

async function post(path, body) {
    const response = await request(path, body);
    if (response && !response.ok)
        console.error(`lyrics service refused ${path}: ${response.status} ${await response.text()}`);
}

/** Selects the tab; the desktop raises its window by the title it reports. */
async function focusTab(tabId) {
    try {
        const tab = await browser.tabs.update(tabId, {active: true});
        const window = await browser.windows.get(tab.windowId);
        return {ok: true, windowTitle: window.title};
    } catch (error) {
        return {ok: false, error: error.message};
    }
}

/**
 * Keeps one request open to the service, which answers it with a command
 * or empty after its hold, and asks again. It runs while this page lives;
 * reports and keep-alives start it again after the service was unreachable
 * or another browser took its place.
 */
async function listenForCommands() {
    if (listening)
        return;
    listening = true;
    try {
        for (;;) {
            const response = await request('/api/commands', {});
            if (!response)
                return;
            if (response.status === 204)
                continue;
            if (response.status === 409) {
                console.info('another browser is listening for lyrics service commands');
                return;
            }
            if (!response.ok) {
                console.error(`lyrics service ended command listening: ${response.status} ${await response.text()}`);
                return;
            }
            const command = await response.json();
            if (command.op !== 'focusTab')
                throw new Error(`the lyrics service sent an unknown command: ${command.op}`);
            await post('/api/command-result', {id: command.id, ...await focusTab(command.tabId)});
        }
    } finally {
        listening = false;
    }
}

browser.runtime.onMessage.addListener((message, sender) => {
    const tab = sender.tab;
    if (!tab)
        return;
    if (message.type === 'report') {
        reportingTabs.add(tab.id);
        const report = message.report;
        if (tab.mutedInfo?.muted)
            report.media.muted = true;
        post('/api/report', {tabId: tab.id, ...report});
        listenForCommands();
    } else if (message.type === 'keepAlive') {
        listenForCommands();
    } else if (message.type === 'gone') {
        reportingTabs.delete(tab.id);
        post('/api/gone', {tabId: tab.id});
    }
});

browser.tabs.onRemoved.addListener(tabId => {
    if (reportingTabs.delete(tabId))
        post('/api/gone', {tabId});
});

// Muting the tab silences the video without a media event.
browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if ('mutedInfo' in changeInfo && reportingTabs.has(tabId))
        browser.tabs.sendMessage(tabId, {type: 'reportNow'});
}, {properties: ['mutedInfo']});
