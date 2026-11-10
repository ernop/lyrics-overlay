// The service's side of the session-bus contract (shared/dbus-interface.js)
// that the GNOME Shell extension uses.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {BUS_NAME, INTERFACE_XML, OBJECT_PATH} from '../shared/dbus-interface.js';

function reply(invocation, result) {
    invocation.return_value(new GLib.Variant('(s)', [JSON.stringify(result)]));
}

/**
 * @param {{core: import('./core.js').LyricsCore,
 *          pitch: import('./pitch-capture.js').PitchCapture,
 *          browser: import('./browser-commands.js').BrowserCommands,
 *          onNameLost: (busClosed: boolean) => void, log: (message: string) => void}} options
 */
export function exportService({core, pitch, browser, onNameLost, log}) {
    let connection = null;
    // The mic follows the one shell client that asked for it: when that
    // client leaves the bus (shell disabled on lock, logout), capture stops.
    let pitchClient = null;

    const releasePitchClient = () => {
        if (pitchClient) {
            Gio.bus_unwatch_name(pitchClient.watchId);
            pitchClient = null;
        }
    };

    const impl = {
        GetState() {
            return JSON.stringify(core.state());
        },
        GetLine() {
            return JSON.stringify(core.line());
        },
        CommandAsync([json], invocation) {
            let command;
            try {
                command = JSON.parse(json);
            } catch {
                invocation.return_dbus_error('net.fuseki.LyricsOverlay1.Error.BadCommand', 'command is not JSON');
                return;
            }
            let result;
            if (command.op === 'pitch') {
                const sender = invocation.get_sender();
                if (command.wanted) {
                    if (pitchClient?.sender !== sender) {
                        releasePitchClient();
                        const watchId = Gio.bus_watch_name_on_connection(connection, sender, Gio.BusNameWatcherFlags.NONE,
                            null, () => {
                                log('pitch client left the bus; stopping the microphone');
                                releasePitchClient();
                                pitch.want(false, true);
                            });
                        pitchClient = {sender, watchId};
                    }
                } else if (pitchClient?.sender === sender) {
                    releasePitchClient();
                }
                pitch.want(Boolean(command.wanted), Boolean(command.immediate));
                result = {ok: true};
            } else {
                result = core.command(command);
            }
            reply(invocation, result);
        },
        // Answered when the browser has selected the tab (with the title
        // its window then shows), or when it cannot.
        FocusSongAsync(_parameters, invocation) {
            const tabId = core.activeTabId();
            if (tabId === null) {
                reply(invocation, {ok: false, error: 'no song is playing'});
                return;
            }
            browser.send({op: 'focusTab', tabId}).then(result => reply(invocation, result));
        },
    };

    const exported = Gio.DBusExportedObject.wrapJSObject(INTERFACE_XML, impl);
    const ownerId = Gio.bus_own_name(Gio.BusType.SESSION, BUS_NAME, Gio.BusNameOwnerFlags.DO_NOT_QUEUE,
        acquired => {
            connection = acquired;
            exported.export(acquired, OBJECT_PATH);
        },
        () => log(`owns ${BUS_NAME}`),
        // GIO passes no connection when the bus itself went away (logout).
        lostOn => onNameLost(lostOn === null));

    const emit = (signal, value) => exported.emit_signal(signal, new GLib.Variant('(s)', [JSON.stringify(value)]));
    return {
        emitState: state => emit('StateChanged', state),
        emitLine: line => emit('LineChanged', line),
        emitPitch: frames => emit('PitchFrames', frames),
        close() {
            releasePitchClient();
            exported.unexport();
            Gio.bus_unown_name(ownerId);
        },
    };
}
