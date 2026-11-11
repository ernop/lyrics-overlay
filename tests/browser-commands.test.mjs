import test from 'node:test';
import assert from 'node:assert/strict';

import {ANSWER_MS, BrowserCommands, DELIVER_MS, HOLD_MS} from '../service/browser-commands.js';

function harness() {
    let now = 0;
    let nextHandle = 1;
    const pending = [];
    const logs = [];
    const commands = new BrowserCommands({
        timers: {
            set(callback, delayMs) {
                const handle = nextHandle++;
                pending.push({handle, at: now + delayMs, callback});
                return handle;
            },
            clear(handle) {
                const index = pending.findIndex(timer => timer.handle === handle);
                assert.ok(index >= 0, `cleared timer ${handle}, which is not pending`);
                pending.splice(index, 1);
            },
            now: () => now,
        },
        log: message => logs.push(message),
    });
    return {
        commands, logs,
        timersPending: () => pending.length,
        advance(ms) {
            const target = now + ms;
            for (;;) {
                pending.sort((a, b) => a.at - b.at);
                const due = pending[0];
                if (!due || due.at > target)
                    break;
                pending.shift();
                now = due.at;
                due.callback();
            }
            now = target;
        },
        /** An extension request; records what it was answered with. */
        listen() {
            const request = {answers: []};
            commands.listen(outcome => request.answers.push(outcome));
            return request;
        },
    };
}

const settled = async promise => {
    let value;
    promise.then(result => { value = result; });
    await new Promise(resolve => setImmediate(resolve));
    return value;
};

test('a command answers the waiting request at once, and the extension answer resolves it', async () => {
    const h = harness();
    const request = h.listen();
    const sent = h.commands.send({op: 'focusTab', tabId: 7});
    assert.deepEqual(request.answers, [{command: {op: 'focusTab', tabId: 7, id: 1}}]);
    assert.equal(h.commands.answer(1, {ok: true, windowTitle: 'Song - YouTube — Mozilla Firefox'}), true);
    assert.deepEqual(await settled(sent), {ok: true, windowTitle: 'Song - YouTube — Mozilla Firefox'});
    assert.equal(h.timersPending(), 0);
});

test('a command waits briefly for the extension to ask, then fails as unheard', async () => {
    const h = harness();
    const late = h.commands.send({op: 'focusTab', tabId: 7});
    h.advance(DELIVER_MS - 1);
    const request = h.listen();
    assert.deepEqual(request.answers, [{command: {op: 'focusTab', tabId: 7, id: 1}}]);
    h.commands.answer(1, {ok: true, windowTitle: 'A'});
    assert.deepEqual(await settled(late), {ok: true, windowTitle: 'A'});

    const unheard = h.commands.send({op: 'focusTab', tabId: 7});
    h.advance(DELIVER_MS);
    assert.deepEqual(await settled(unheard), {ok: false, error: 'the browser extension is not listening'});
    assert.equal(h.timersPending(), 0);
    assert.deepEqual(h.logs, ['no browser add-on heard command 2: the last request ended 1.5 s ago (it carried a command)']);
});

test('an unheard command is logged as such when no add-on has ever asked', async () => {
    const h = harness();
    const unheard = h.commands.send({op: 'focusTab', tabId: 7});
    h.advance(DELIVER_MS);
    assert.deepEqual(await settled(unheard), {ok: false, error: 'the browser extension is not listening'});
    assert.deepEqual(h.logs, ['no browser add-on heard command 1: none has asked for commands since the service started']);
});

test('a delivered command the extension never answers fails, and its late answer is refused', async () => {
    const h = harness();
    h.listen();
    const sent = h.commands.send({op: 'focusTab', tabId: 7});
    h.advance(ANSWER_MS);
    assert.deepEqual(await settled(sent), {ok: false, error: 'the browser extension did not answer'});
    assert.equal(h.commands.answer(1, {ok: true, windowTitle: 'A'}), false);
    assert.deepEqual(h.logs, ['the browser answered command 1, which is no longer waiting']);
});

test('a newer command replaces a pending one, and an answer before delivery is refused', async () => {
    const h = harness();
    const first = h.commands.send({op: 'focusTab', tabId: 7});
    const second = h.commands.send({op: 'focusTab', tabId: 8});
    assert.deepEqual(await settled(first), {ok: false, error: 'replaced by a newer command'});
    assert.equal(h.commands.answer(2, {ok: true, windowTitle: 'A'}), false, 'not yet delivered');
    const request = h.listen();
    assert.deepEqual(request.answers, [{command: {op: 'focusTab', tabId: 8, id: 2}}]);
    h.commands.answer(2, {ok: false, error: 'No tab with id: 8.'});
    assert.deepEqual(await settled(second), {ok: false, error: 'No tab with id: 8.'});
});

test('a request ends empty when a newer one replaces it or its hold ends, saying which', async () => {
    const h = harness();
    const first = h.listen();
    const second = h.listen();
    assert.deepEqual(first.answers, [{ended: 'replaced'}]);
    h.advance(HOLD_MS);
    assert.deepEqual(second.answers, [{ended: 'hold'}]);
    assert.equal(h.timersPending(), 0);
    const unheard = h.commands.send({op: 'focusTab', tabId: 7});
    h.advance(DELIVER_MS);
    assert.deepEqual(await settled(unheard), {ok: false, error: 'the browser extension is not listening'});
    assert.deepEqual(h.logs, ['no browser add-on heard command 1: the last request ended 1.5 s ago (its hold ran out)']);
});
