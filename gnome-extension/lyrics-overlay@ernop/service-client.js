// Session-bus client for the lyrics service. The service may start, stop
// or restart at any time; state is null while it is absent.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

import {BUS_NAME, INTERFACE_XML, OBJECT_PATH} from './shared/dbus-interface.js';

const LyricsProxy = Gio.DBusProxy.makeProxyWrapper(INTERFACE_XML);

export const NO_LINE = Object.freeze({text: '', key: 'none'});

function isCancelled(error) {
    return error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED);
}

export class ServiceClient {
    /**
     * @param {{onState: (state: object|null) => void, onLine: (line: {text: string, key: string}) => void,
     *          onPitch: (frames: object) => void}} handlers
     */
    constructor(handlers) {
        this._handlers = handlers;
        this._watchId = 0;
        this._proxy = null;
        this._signalIds = [];
        this._cancellable = null;
        // Signals that arrive while the first Get calls are in flight are
        // newer than those replies; a counter tells the replies to stand down.
        this._stateEpoch = 0;
        this._lineEpoch = 0;
    }

    start() {
        this._watchId = Gio.bus_watch_name(Gio.BusType.SESSION, BUS_NAME, Gio.BusNameWatcherFlags.NONE,
            () => this._connect(), () => this._disconnect());
    }

    stop() {
        if (this._watchId) {
            Gio.bus_unwatch_name(this._watchId);
            this._watchId = 0;
        }
        this._dropProxy();
    }

    command(command) {
        if (!this._proxy)
            return;
        this._proxy.CommandAsync(JSON.stringify(command)).catch(error => {
            if (!isCancelled(error))
                console.error(`lyrics-overlay: command ${command.op} failed: ${error.message}`);
        });
    }

    /**
     * Asks the browser, through the service, to bring the playing tab forward.
     * @returns {Promise<{ok: true, windowTitle: string}|{ok: false, error: string}>}
     */
    async focusSong() {
        if (!this._proxy)
            return {ok: false, error: 'the lyrics service is not running'};
        const [json] = await this._proxy.FocusSongAsync();
        return JSON.parse(json);
    }

    _connect() {
        this._dropProxy();
        const cancellable = new Gio.Cancellable();
        this._cancellable = cancellable;
        LyricsProxy(Gio.DBus.session, BUS_NAME, OBJECT_PATH, (proxy, error) => {
            if (cancellable.is_cancelled())
                return;
            if (error) {
                console.error(`lyrics-overlay: cannot reach the service: ${error.message}`);
                return;
            }
            this._proxy = proxy;
            this._signalIds = [
                proxy.connectSignal('StateChanged', (_proxy, _sender, [json]) => {
                    this._stateEpoch++;
                    this._handlers.onState(JSON.parse(json));
                }),
                proxy.connectSignal('LineChanged', (_proxy, _sender, [json]) => {
                    this._lineEpoch++;
                    this._handlers.onLine(JSON.parse(json));
                }),
                proxy.connectSignal('PitchFrames', (_proxy, _sender, [json]) => this._handlers.onPitch(JSON.parse(json))),
            ];
            this._fetch('GetStateAsync', () => this._stateEpoch, json => this._handlers.onState(JSON.parse(json)));
            this._fetch('GetLineAsync', () => this._lineEpoch, json => this._handlers.onLine(JSON.parse(json)));
        }, cancellable, Gio.DBusProxyFlags.DO_NOT_LOAD_PROPERTIES);
    }

    _fetch(method, epoch, apply) {
        const proxy = this._proxy;
        const asked = epoch();
        proxy[method]().then(([json]) => {
            if (this._proxy === proxy && epoch() === asked)
                apply(json);
        }).catch(error => {
            if (!isCancelled(error))
                console.error(`lyrics-overlay: ${method} failed: ${error.message}`);
        });
    }

    _disconnect() {
        this._dropProxy();
        this._handlers.onState(null);
        this._handlers.onLine(NO_LINE);
    }

    _dropProxy() {
        this._cancellable?.cancel();
        this._cancellable = null;
        if (this._proxy) {
            for (const id of this._signalIds)
                this._proxy.disconnectSignal(id);
            this._signalIds = [];
            this._proxy = null;
        }
    }
}
