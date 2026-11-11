// Forwards YouTube tab reports to the local lyrics service with the tab's
// id, tells it when a reporting tab goes away, and carries out its
// commands (a click on the lyric selects the song's tab; a right press
// shows the one settings tab). Nothing leaves this computer: the only
// destination is the service on this machine.
'use strict';

// *.localhost is always this machine. The name, not 127.0.0.1, because the
// host permission an install granted for it survives updates; the port is
// the one in settings.example.json (tests/firefox-service-url.test.mjs).
const SERVICE = 'http://lyrics.localhost:8792';
// The settings page's address and access: settings-access.js.
const GRANT_PAGE = browser.runtime.getURL('grant.html');
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

/** Resolves once the tab has loaded, when its window shows the page's title. */
function loaded(tabId) {
    return new Promise(resolve => {
        const listener = (_tabId, changeInfo) => {
            if (changeInfo.status !== 'complete')
                return;
            browser.tabs.onUpdated.removeListener(listener);
            resolve();
        };
        browser.tabs.onUpdated.addListener(listener, {tabId, properties: ['status']});
        browser.tabs.get(tabId).then(tab => {
            if (tab.status === 'complete')
                listener(tabId, {status: 'complete'});
        });
    });
}

/**
 * Selects the tab showing page (found by the match pattern tabs), opening
 * it when none is open, so there is only ever one; the desktop raises its
 * window by the title this reports.
 */
async function showTab(page, tabs) {
    const origin = new URL(page).origin;
    const existing = (await browser.tabs.query({url: tabs})).find(tab => new URL(tab.url).origin === origin);
    let tab;
    if (existing) {
        tab = await browser.tabs.update(existing.id, {active: true});
    } else {
        tab = await browser.tabs.create({url: page, active: true});
        await loaded(tab.id);
    }
    const window = await browser.windows.get(tab.windowId);
    return {ok: true, windowTitle: window.title};
}

/**
 * Shows the settings tab. Without access to localhost the add-on cannot
 * tell which tab that is, so it shows the page that asks for the access.
 */
async function openSettings() {
    try {
        if (!(await browser.permissions.contains(SETTINGS_ACCESS)))
            return await showTab(GRANT_PAGE, GRANT_PAGE);
        return await showTab(SETTINGS_PAGE, SETTINGS_TABS);
    } catch (error) {
        return {ok: false, error: error.message};
    }
}

// Asked at once after the update that added the access, while the user is
// still at the browser that just installed it.
browser.runtime.onInstalled.addListener(async ({reason}) => {
    if (reason === 'update' && !(await browser.permissions.contains(SETTINGS_ACCESS)))
        await showTab(GRANT_PAGE, GRANT_PAGE);
});

const COMMANDS = {
    focusTab: command => focusTab(command.tabId),
    openSettings: () => openSettings(),
};

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
            const carryOut = Object.hasOwn(COMMANDS, command.op) ? COMMANDS[command.op] : null;
            const result = carryOut ? await carryOut(command)
                : {ok: false, error: `this browser extension does not know the command ${command.op}`};
            await post('/api/command-result', {id: command.id, ...result});
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
