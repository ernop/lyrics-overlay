// Lyrics overlay service: `gjs -m service/main.js [--settings <path>]`.
// Run by the lyrics-overlay.service systemd user unit.

import GLib from 'gi://GLib';
import GLibUnix from 'gi://GLibUnix';
import Gio from 'gi://Gio';
import System from 'system';

import {ArchiveSync} from './archive-sync.js';
import {BrowserCommands} from './browser-commands.js';
import {LyricsCore} from './core.js';
import {exportService} from './dbus.js';
import {loadStaticFiles, startHttp} from './http.js';
import {createLrclibSearch} from './lrclib.js';
import {PitchCapture} from './pitch-capture.js';
import {SettingsStore} from './settings-store.js';
import {SongKey} from './song-key.js';
import {JsonStore} from './store.js';
import {createYtarchiveClient} from './ytarchive.js';

const serviceDir = GLib.path_get_dirname(GLib.filename_from_uri(import.meta.url)[0]);
const projectDir = GLib.path_get_dirname(serviceDir);

function log(message) {
    printerr(`lyrics-overlay: ${message}`);
}

function readSettings(path) {
    const [, contents] = GLib.file_get_contents(path);
    const settings = JSON.parse(new TextDecoder().decode(contents));
    for (const [name, type] of [['port', 'number'], ['hostname', 'string'], ['lrclibBaseUrl', 'string'],
        ['stateDir', 'string']]) {
        if (typeof settings[name] !== type)
            throw new Error(`${path}: "${name}" must be a ${type}`);
    }
    if (settings.ytarchiveUrl !== null && typeof settings.ytarchiveUrl !== 'string')
        throw new Error(`${path}: "ytarchiveUrl" must be an address or null`);
    return settings;
}

function settingsPath() {
    const index = System.programArgs.indexOf('--settings');
    if (index >= 0 && System.programArgs[index + 1])
        return System.programArgs[index + 1];
    return GLib.build_filenamev([projectDir, 'settings.json']);
}

const settings = readSettings(settingsPath());
const loop = new GLib.MainLoop(null, false);
const store = new JsonStore(settings.stateDir);
log(`pruned ${store.pruneSearches(Date.now())} expired searches`);
const runtimeDir = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'lyrics-overlay']);
GLib.mkdir_with_parents(runtimeDir, 0o700);
const look = new SettingsStore({
    schemaSourceDir: GLib.build_filenamev([projectDir, 'gnome-extension', 'lyrics-overlay@ernop', 'schemas']),
    compiledDir: GLib.build_filenamev([runtimeDir, 'schemas']),
});

const timers = {
    set: (callback, delayMs) => GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.round(delayMs), () => {
        callback();
        return GLib.SOURCE_REMOVE;
    }),
    clear: id => GLib.source_remove(id),
};

let bus = null;
let archive = null;
let songKey = null;
// The song's key is heard while the microphone runs for a sounding song
// and the panel stands out a detected scale.
const syncSongKey = state => {
    const listening = state.pitch.capturing && state.active && state.sounding && look.get('pitch-scale') === 'detect';
    songKey?.listen(listening ? state.videoId : null);
};
const core = new LyricsCore({
    store,
    search: createLrclibSearch(settings.lrclibBaseUrl),
    clock: {now: () => Date.now()},
    timers,
    emit: {
        state: state => {
            bus?.emitState(state);
            archive?.observe(state);
            syncSongKey(state);
        },
        line: line => bus?.emitLine(line),
    },
    log,
});
if (settings.ytarchiveUrl !== null) {
    archive = new ArchiveSync({
        store,
        client: createYtarchiveClient(settings.ytarchiveUrl),
        lyricsFor: videoId => core.lyricsFor(videoId),
        log,
    });
    archive.start();
}

const pitch = new PitchCapture({
    settings: look,
    runtimeDir,
    onFrames: frames => bus?.emitPitch(frames),
    onStatus: status => core.setPitchStatus(status),
    log,
});
songKey = new SongKey({store, onKey: key => core.setSongKey(key), log});
look.onChanged(name => {
    if (name === 'pitch-scale')
        syncSongKey(core.state());
});

const browser = new BrowserCommands({timers, log});

let exitCode = 0;
bus = exportService({
    core,
    pitch,
    browser,
    onNameLost: busClosed => {
        if (busClosed) {
            log('the session bus closed (logout); stopping');
        } else {
            log('could not own the D-Bus name (another instance running?)');
            exitCode = 1;
        }
        loop.quit();
    },
    log,
});
const http = startHttp({port: settings.port, hostname: settings.hostname, files: loadStaticFiles(projectDir),
    core, browser, settings: look, pitch, log});

for (const signal of [2, 15]) {
    GLibUnix.signal_add(GLib.PRIORITY_DEFAULT, signal, () => {
        loop.quit();
        return GLib.SOURCE_REMOVE;
    });
}

loop.run();
http.disconnect();
songKey.shutdown();
pitch.shutdown();
bus.close();
// After a logout the bus is gone, and with it anything left to send.
if (!Gio.DBus.session.is_closed())
    Gio.DBus.session.flush_sync(null);
System.exit(exitCode);
