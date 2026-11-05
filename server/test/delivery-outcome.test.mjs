// How a chat prompt's delivery attempt is classified, per runtime
// (plans/slack_history.md "Per-runtime delivery"). Pure: no server, no pane.
//
// Run with: node test/delivery-outcome.test.mjs
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../src/api-errors.js';
import { attemptDelivery, classifyDeliveryError, cutForRemote, deliverToSession, earlyOutcome } from '../src/delivery-outcome.js';

const api = (code, extra = {}) => Object.assign(new ApiError(409, code, `message for ${code}`), extra);
const locked = () => Object.assign(new Error('locked'), { statusCode: 403, code: 'locked' });
const quiet = () => { const lines = []; return { lines, log: (...a) => lines.push(a) }; };

test('shared Codex: busy errors stay pending, an ambiguous send is submitted', () => {
  for (const code of ['codex-task-busy', 'codex-send-busy']) assert.equal(classifyDeliveryError('codex', api(code)), 'pending', code);
  // A stored `sending` receipt makes send() throw codex-send-uncertain.
  assert.equal(classifyDeliveryError('codex', api('codex-send-uncertain')), 'submitted');
  assert.equal(classifyDeliveryError('codex', api('codex-request-conflict')), 'submitted');
  assert.equal(classifyDeliveryError('codex', locked()), 'pending');
  assert.equal(classifyDeliveryError('codex', new Error('boom')), 'pending');
});

test('TUI: only an error marked typed is submitted', () => {
  assert.equal(classifyDeliveryError('tui', api('input-line-busy')), 'pending');
  assert.equal(classifyDeliveryError('tui', api('input-not-ready')), 'pending');
  assert.equal(classifyDeliveryError('tui', locked()), 'pending');
  assert.equal(classifyDeliveryError('tui', new Error('no flag')), 'pending');
  for (const code of ['input-not-ready', 'input-not-confirmed', 'input-not-submitted']) {
    assert.equal(classifyDeliveryError('tui', api(code, { typed: true })), 'submitted', code);
  }
  assert.equal(classifyDeliveryError('tui', api('input-not-ready', { typed: false })), 'pending');
});

test('remote: a throw from append is submitted, a lock abort before it is pending', () => {
  assert.equal(classifyDeliveryError('remote', new Error('disk full')), 'submitted');
  assert.equal(classifyDeliveryError('remote', locked()), 'pending');
});

test('attemptDelivery: a resolving send is delivered, with no reason', async () => {
  for (const runtime of ['codex', 'tui', 'remote']) {
    assert.deepEqual(await attemptDelivery(runtime, async () => 'whatever'), { state: 'delivered' }, runtime);
  }
});

test('attemptDelivery: classified errors resolve with the code as reason, never the message', async () => {
  const { lines, log } = quiet();
  const run = (error) => async () => { throw error; };
  assert.deepEqual(await attemptDelivery('codex', run(api('codex-task-busy')), { log }), { state: 'pending', reason: 'codex-task-busy' });
  assert.deepEqual(await attemptDelivery('codex', run(api('codex-send-uncertain')), { log }), { state: 'submitted', reason: 'codex-send-uncertain' });
  assert.deepEqual(await attemptDelivery('tui', run(api('input-not-ready', { typed: true })), { log }), { state: 'submitted', reason: 'input-not-ready' });
  assert.deepEqual(await attemptDelivery('tui', run(api('input-line-busy')), { log }), { state: 'pending', reason: 'input-line-busy' });
  assert.deepEqual(await attemptDelivery('tui', run(locked()), { log }), { state: 'pending', reason: 'locked' });
  assert.deepEqual(await attemptDelivery('remote', run(api('boom-code')), { log }), { state: 'submitted', reason: 'boom-code' });
  assert.deepEqual(lines, [], 'classified cases are not logged');
});

test('attemptDelivery: an unexpected error is pending, reason error, logged once without its text', async () => {
  const { lines, log } = quiet();
  const secret = 'prompt text with a token xoxb-123';
  const out = await attemptDelivery('tui', async () => { throw new TypeError(secret); }, { log });
  assert.deepEqual(out, { state: 'pending', reason: 'error' });
  assert.equal(lines.length, 1);
  assert.equal(JSON.stringify(lines).includes(secret), false);
});

test('attemptDelivery: a failure after the never-started commit is still delivered', async () => {
  let committed = false;
  const run = async () => { committed = true; throw api('launch-failed'); };
  assert.deepEqual(await attemptDelivery('tui', run, { committed: () => committed }), { state: 'delivered' });
  const before = async () => { throw api('locked-early'); };
  assert.equal((await attemptDelivery('tui', before, { committed: () => committed = false })).state, 'pending');
});

test('earlyOutcome: a pendingPrompt the composer stored is never overwritten', () => {
  const stored = { everStarted: false, pendingPrompt: 'from the web', cli: 'claude' };
  assert.deepEqual(earlyOutcome(stored, 'tui'), { state: 'pending', reason: 'pending-prompt-set' });
  assert.equal(earlyOutcome({ ...stored, everStarted: true }, 'tui'), null, 'started: sent with sendInput as usual');
  assert.equal(earlyOutcome({ everStarted: false, pendingPrompt: '', cli: 'claude' }, 'tui'), null);
  assert.equal(earlyOutcome({ everStarted: false, cli: 'claude' }, 'tui'), null);
});

test('earlyOutcome: a remote with no name waits', () => {
  assert.deepEqual(earlyOutcome({ cli: 'remote', remote: {} }, 'remote'), { state: 'pending', reason: 'remote-unnamed' });
  assert.equal(earlyOutcome({ cli: 'remote', remote: { name: 'box' } }, 'remote'), null);
});

test('cutForRemote: text within the limit is untouched, longer text ends in a visible line, still within the limit', () => {
  assert.equal(cutForRemote('short', 100), 'short');
  assert.equal(cutForRemote('x'.repeat(100), 100), 'x'.repeat(100));
  const cut = cutForRemote('x'.repeat(40 * 1024), 32 * 1024);
  assert.ok(cut.length <= 32 * 1024);
  assert.match(cut, /^x+\n\[truncated: the Slack message was longer than 32 KB\]$/);
});

// The wiring host.deliver delegates to, with the send paths faked.
const wiring = (over = {}) => {
  const calls = [];
  const io = {
    shared: () => false, remote: () => false, limit: 32 * 1024, log: () => {},
    touch: (id) => calls.push(['touch', id]),
    sendCodex: async (s, m) => { calls.push(['codex', m]); },
    sendLocal: async (s, text, onCommitted) => { calls.push(['local', text]); onCommitted(); },
    ...over,
  };
  return { io, calls };
};
const req = { text: 'hi', requestId: 'r1' };

test('deliverToSession: a never-started withPrompt session is delivered once pendingPrompt is written, even if the launch then fails', async () => {
  const { io, calls } = wiring({ sendLocal: async (s, text, onCommitted) => { onCommitted(); throw api('launch-failed'); } });
  assert.deepEqual(await deliverToSession({ id: 's', cli: 'claude', everStarted: false }, req, io), { state: 'delivered' });
  assert.deepEqual(calls, [['touch', 's']]);
});

test('deliverToSession: a pendingPrompt already stored is left alone and nothing is sent', async () => {
  const { io, calls } = wiring();
  const out = await deliverToSession({ id: 's', cli: 'claude', everStarted: false, pendingPrompt: 'from web' }, req, io);
  assert.deepEqual(out, { state: 'pending', reason: 'pending-prompt-set' });
  assert.deepEqual(calls, []);
});

test('deliverToSession: shared Codex gets the id, remote text is cut, pending outcomes are not touched', async () => {
  const codex = wiring({ shared: () => true });
  assert.deepEqual(await deliverToSession({ id: 'c', cli: 'codex' }, req, codex.io), { state: 'delivered' });
  assert.deepEqual(codex.calls[0], ['codex', { text: 'hi', attachments: [], requestId: 'r1' }]);

  const remote = wiring({ remote: () => true, limit: 2048 });
  await deliverToSession({ id: 'r', cli: 'remote', remote: { name: 'box' } }, { text: 'y'.repeat(5000), requestId: 'r2' }, remote.io);
  const sent = remote.calls.find((c) => c[0] === 'local')[1];
  assert.ok(sent.length <= 2048);
  assert.ok(sent.endsWith('[truncated: the Slack message was longer than 2 KB]'));

  const busy = wiring({ shared: () => true, sendCodex: async () => { throw api('codex-task-busy'); } });
  assert.deepEqual(await deliverToSession({ id: 'c', cli: 'codex' }, req, busy.io), { state: 'pending', reason: 'codex-task-busy' });
  assert.deepEqual(busy.calls, []);
});

// ---- after a restart: wait for the revive result, then for a ready prompt ----
import { bootRevive, readyAfterRevive } from '../src/delivery-outcome.js';

function readyIo({ result = 'sent', detector = true, running = true, readyAfter = 0 } = {}) {
  const io = {
    calls: [], polls: 0,
    result: async () => result,
    detector: () => detector,
    running: () => running,
    promptReady: () => { io.polls += 1; return io.polls > readyAfter; },
    sleep: async () => {},
  };
  return io;
}

test('readyAfterRevive: waits for a ready prompt when the CLI has a detector and the pane runs', async () => {
  const io = readyIo({ readyAfter: 3 });
  assert.equal(await readyAfterRevive({ id: 's1', cli: 'claude' }, io), 'sent');
  assert.equal(io.polls, 4);
});

test('readyAfterRevive: gave-up still waits for an empty prompt when the pane is running', async () => {
  const io = readyIo({ result: 'gave-up', readyAfter: 2 });
  assert.equal(await readyAfterRevive({ id: 's1', cli: 'claude' }, io), 'gave-up');
  assert.ok(io.polls >= 1);
});

test('readyAfterRevive: a CLI without a prompt detector, or a pane that is not running, does not wait', async () => {
  for (const extra of [{ detector: false }, { running: false }]) {
    const io = readyIo({ readyAfter: 99, ...extra });
    assert.equal(await readyAfterRevive({ id: 's1', cli: 'gemini' }, io), 'sent');
    assert.equal(io.polls, 0);
  }
  const skipped = readyIo({ result: 'skipped', detector: false });
  assert.equal(await readyAfterRevive({ id: 's1', cli: 'fx' }, skipped), 'skipped');
});

test('readyAfterRevive: the wait is bounded and stops when the lock signal aborts', async () => {
  const bounded = readyIo({ readyAfter: Infinity });
  bounded.logs = [];
  bounded.log = (e) => bounded.logs.push(e);
  let t = 0;
  bounded.now = () => (t += 1000);
  await assert.rejects(
    () => readyAfterRevive({ id: 's1', cli: 'claude' }, bounded, { readyMs: 5000 }),
    (e) => e.code === 'prompt-not-ready',
  );
  assert.ok(bounded.polls >= 1 && bounded.polls < 10);
  assert.equal(bounded.logs[0]?.event, 'ready-timeout');
  const aborted = readyIo({ readyAfter: Infinity });
  const c = new AbortController();
  aborted.sleep = async () => c.abort();
  await readyAfterRevive({ id: 's1', cli: 'claude' }, aborted, { signal: c.signal });
  assert.equal(aborted.polls, 1);
});

test('bootRevive: a locked Space skips every session instead of leaving waiters hanging', async () => {
  const calls = [];
  const out = await bootRevive({ locked: true, skipAll: () => calls.push('skipAll'), revive: async () => { calls.push('revive'); return [1]; } });
  assert.deepEqual(calls, ['skipAll']);
  assert.deepEqual(out, []);
  const open = await bootRevive({ locked: false, skipAll: () => calls.push('skipAll2'), revive: async () => { calls.push('revive'); return [1]; } });
  assert.deepEqual(calls, ['skipAll', 'revive']);
  assert.deepEqual(open, [1]);
});
