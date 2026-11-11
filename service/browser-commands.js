// Commands from the desktop to the browser extension, which cannot be
// called: its background script keeps one request open (POST /api/commands),
// a command answers that request, and the extension posts the outcome back
// (POST /api/command-result). A command no extension collects within
// DELIVER_MS, or that is not done within ANSWER_MS, fails: a tab switch
// landing seconds after the click would pull a window forward unasked.
//
// Free of GNOME code so it runs under both gjs and node (tests).

export const DELIVER_MS = 1500;
export const ANSWER_MS = 3000;
// The server learns that a held request's connection dropped only when it
// answers it, so a command can go to a request whose browser is gone; it
// then fails as unanswered. Answering every request empty after HOLD_MS
// bounds how long a dead one can hold the place of a live one.
export const HOLD_MS = 25_000;

/**
 * How a held request ends: with a command, or empty because its hold ran
 * out (ask again) or a newer request took its place (another browser is
 * listening; asking again at once would only take the place back).
 * @typedef {{command: object}|{ended: 'hold'|'replaced'}} ListenOutcome
 */

export class BrowserCommands {
    /**
     * @param {{timers: {set(callback: () => void, delayMs: number): unknown, clear(handle: unknown): void, now(): number},
     *          log: (message: string) => void}} deps
     */
    constructor(deps) {
        for (const name of ['timers', 'log']) {
            if (!deps[name])
                throw new Error(`BrowserCommands needs ${name}`);
        }
        this._timers = deps.timers;
        this._log = deps.log;
        this._nextId = 1;
        /** @type {{deliver: (outcome: ListenOutcome) => void, timer: unknown}|null} */
        this._listener = null;
        /** @type {{id: number, command: object, delivered: boolean, timer: unknown, resolve: (result: object) => void}|null} */
        this._pending = null;
        // Explains an unheard command: an add-on that never asks (one older
        // than the command channel) looks the same as one that stopped asking.
        /** @type {{at: number, how: string}|null} */
        this._lastRequestEnd = null;
    }

    /**
     * Sends one command; a newer command replaces one still pending.
     * @param {{op: string}} command
     * @returns {Promise<{ok: true}|{ok: false, error: string}>} the extension's result, or why there is none
     */
    send(command) {
        if (this._pending)
            this._finish({ok: false, error: 'replaced by a newer command'});
        return new Promise(resolve => {
            const id = this._nextId++;
            const pending = {id, command: {...command, id}, delivered: false, timer: null, resolve};
            this._pending = pending;
            pending.timer = this._timers.set(() => {
                pending.timer = null;
                this._log(`no browser add-on heard command ${id}: ${this._describeLastRequest()}`);
                this._finish({ok: false, error: 'the browser extension is not listening'});
            }, DELIVER_MS);
            if (this._listener)
                this._deliver();
        });
    }

    /**
     * An open request from the extension; deliver is called once.
     * @param {(outcome: ListenOutcome) => void} deliver
     */
    listen(deliver) {
        this._closeListener('replaced');
        const listener = {deliver, timer: null};
        this._listener = listener;
        listener.timer = this._timers.set(() => {
            listener.timer = null;
            this._closeListener('hold');
        }, HOLD_MS);
        if (this._pending && !this._pending.delivered)
            this._deliver();
    }

    /**
     * The extension's outcome for command id.
     * @returns {boolean} false when that command is no longer waiting
     */
    answer(id, result) {
        if (this._pending?.id !== id || !this._pending.delivered) {
            this._log(`the browser answered command ${id}, which is no longer waiting`);
            return false;
        }
        this._finish(result);
        return true;
    }

    _describeLastRequest() {
        if (!this._lastRequestEnd)
            return 'none has asked for commands since the service started';
        const {at, how} = this._lastRequestEnd;
        return `the last request ended ${((this._timers.now() - at) / 1000).toFixed(1)} s ago (${how})`;
    }

    _deliver() {
        const pending = this._pending;
        const listener = this._listener;
        this._listener = null;
        this._clearTimer(listener);
        this._lastRequestEnd = {at: this._timers.now(), how: 'it carried a command'};
        pending.delivered = true;
        this._clearTimer(pending);
        pending.timer = this._timers.set(() => {
            pending.timer = null;
            this._finish({ok: false, error: 'the browser extension did not answer'});
        }, ANSWER_MS);
        listener.deliver({command: pending.command});
    }

    /** @param {'hold'|'replaced'} why */
    _closeListener(why) {
        const listener = this._listener;
        if (!listener)
            return;
        this._listener = null;
        this._clearTimer(listener);
        this._lastRequestEnd = {at: this._timers.now(), how: why === 'hold' ? 'its hold ran out' : 'a newer request took its place'};
        listener.deliver({ended: why});
    }

    _finish(result) {
        const pending = this._pending;
        this._pending = null;
        this._clearTimer(pending);
        pending.resolve(result);
    }

    _clearTimer(holder) {
        if (holder.timer === null)
            return;
        this._timers.clear(holder.timer);
        holder.timer = null;
    }
}
