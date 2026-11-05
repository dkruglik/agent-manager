import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { SlackAdapter } from '../src/messengers/adapters/slack.js';

// The Slack adapter's socket: malformed frames, start/stop, silent connections.

export class FakeWs extends EventEmitter {
  constructor(url) { super(); this.url = url; this.closed = false; FakeWs.all.push(this); }
  send() {}
  ping() { this.pings = (this.pings || 0) + 1; }
  close() { this.closed = true; this.emit('close'); }
  static all = [];
}

function setup(over = {}) {
  FakeWs.all = [];
  const timers = [];
  const logs = [];
  const statuses = [];
  const calls = [];
  const fetchImpl = async (url) => {
    const method = url.split('/').pop();
    calls.push(method);
    const out = { 'auth.test': { ok: true, user_id: 'UBOT' }, 'apps.connections.open': { ok: true, url: 'wss://x' } }[method];
    return { status: 200, json: async () => out };
  };
  const adapter = new SlackAdapter({
    botToken: 'xoxb-1', appToken: 'xapp-1', fetchImpl, WebSocketImpl: FakeWs,
    setTimer: (fn, ms) => { const t = { fn, ms, cleared: false, unref() { t.unrefd = true; } }; timers.push(t); return t; },
    ...over,
  });
  const hooks = { onReply: async () => {}, onCommand: async () => '', onStatus: (s) => statuses.push(s), log: (e) => logs.push(e) };
  return { adapter, hooks, timers, logs, statuses, calls };
}
async function waitFor(predicate, what) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}
// Every fake here resolves at once, so once the microtasks queued so far have
// run (before setImmediate fires) nothing more is in flight: used to show that
// something did NOT happen, where there is no condition to wait for.
const drained = () => new Promise((r) => setImmediate(r));
const firstSocket = () => waitFor(() => FakeWs.all.length === 1, 'the first socket');

test('a frame that is not JSON is logged, without its content', async () => {
  const t = setup();
  t.adapter.start(t.hooks);
  await firstSocket();
  FakeWs.all[0].emit('message', Buffer.from('xoxb-secret {not json'));
  await waitFor(() => t.logs.length > 0, 'the log line');
  assert.deepEqual(t.logs, [{ event: 'bad-frame' }]);
});

test('starting twice opens one socket', async () => {
  const t = setup();
  t.adapter.start(t.hooks);
  t.adapter.start(t.hooks);
  await firstSocket();
  await drained();
  assert.equal(FakeWs.all.length, 1);
  assert.deepEqual(t.calls, ['auth.test', 'apps.connections.open']);
});

// Holds the first auth.test until `gate` resolves; `released` settles once it has answered.
function holdAuth(t, gate) {
  const inner = t.adapter.fetchImpl;
  const released = Promise.withResolvers();
  let held = true;
  t.adapter.fetchImpl = async (url, init) => {
    if (held && url.endsWith('auth.test')) {
      held = false;
      await gate.promise;
      const res = await inner(url, init);
      released.resolve();
      return res;
    }
    return inner(url, init);
  };
  return released.promise;
}

test('stopping while a connect is in flight opens no socket afterwards', async () => {
  const gate = Promise.withResolvers();
  const t = setup();
  const released = holdAuth(t, gate);
  t.adapter.start(t.hooks); // auth.test is asked at once and held
  await t.adapter.stop();
  gate.resolve();
  await released;
  await drained();
  assert.equal(FakeWs.all.length, 0);
  assert.deepEqual(t.calls, ['auth.test'], 'it did not go on to open a connection either');

  // A restart while the old connect is still in flight is not mistaken for it.
  const gate2 = Promise.withResolvers();
  const u = setup();
  const released2 = holdAuth(u, gate2);
  u.adapter.start(u.hooks);
  await u.adapter.stop();
  u.adapter.start(u.hooks);
  await waitFor(() => FakeWs.all.length === 1, 'the new start to connect');
  gate2.resolve();
  await released2;
  await drained();
  assert.equal(FakeWs.all.length, 1, 'only the new start connected');
});

test('a socket that goes silent is dropped and reconnected', async () => {
  const cleared = new Set();
  const t = setup({ clearTimer: (h) => cleared.add(h) });
  t.adapter.start(t.hooks);
  await firstSocket();
  const ws = FakeWs.all[0];
  ws.emit('message', Buffer.from('{"type":"hello"}'));
  await waitFor(() => t.statuses.at(-1)?.connected === true, 'hello');
  const silent = t.timers.filter((x) => x.ms === 120_000);
  const live = silent.at(-1);
  assert.ok(cleared.has(silent[0]), 'each frame restarts the clock');
  assert.ok(t.timers.every((x) => x.unrefd), 'timers never keep the process alive');
  const ping = t.timers.find((x) => x.ms === 30_000);
  ping.fn();
  assert.equal(ws.pings, 1, 'pings every 30 s');
  const before = t.timers.length;
  live.fn();
  assert.deepEqual(t.logs.at(-1), { event: 'socket-silent' });
  assert.deepEqual(t.statuses.at(-1), { connected: false, error: 'no frames for 2 minutes' });
  assert.ok(t.timers.length > before, 'a reconnect is scheduled');
  t.timers.at(-1).fn();
  await waitFor(() => FakeWs.all.length === 2, 'the reconnect');
});

const reconnects = (t) => t.timers.filter((x) => x.ms !== 30_000 && x.ms !== 120_000);
const lastStatus = (t) => t.statuses.at(-1);

// Fires the newest reconnect timer and waits for the socket it opens.
async function reconnect(t) {
  const sockets = FakeWs.all.length;
  reconnects(t).at(-1).fn();
  await waitFor(() => FakeWs.all.length === sockets + 1, 'the reconnect');
  return FakeWs.all.at(-1);
}

test('a closed socket schedules reconnects with exponential delay capped at 60 s', async () => {
  const t = setup();
  t.adapter.start(t.hooks);
  await firstSocket();
  let ws = FakeWs.all[0];
  const delays = [];
  for (let i = 0; i < 9; i++) {
    ws.close();
    assert.deepEqual(lastStatus(t), { connected: false, error: 'socket closed' });
    delays.push(reconnects(t).at(-1).ms);
    ws = await reconnect(t);
  }
  assert.deepEqual(delays, [1000, 2000, 4000, 8000, 16_000, 32_000, 60_000, 60_000, 60_000]);
});

test('a disconnect frame reconnects like a close, and hello resets the delay', async () => {
  const t = setup();
  t.adapter.start(t.hooks);
  await firstSocket();
  let ws = FakeWs.all[0];
  const frame = (msg) => ws.emit('message', Buffer.from(JSON.stringify(msg)));
  const delays = [];
  for (let i = 0; i < 3; i++) {
    frame({ type: 'disconnect', reason: 'refresh_requested' });
    await waitFor(() => lastStatus(t)?.error === 'refresh requested', 'the disconnect');
    assert.equal(ws.closed, true, 'the old socket is closed');
    assert.deepEqual(lastStatus(t), { connected: false, error: 'refresh requested' });
    delays.push(reconnects(t).at(-1).ms);
    ws = await reconnect(t);
  }
  assert.deepEqual(delays, [1000, 2000, 4000]);
  frame({ type: 'hello' });
  await waitFor(() => lastStatus(t)?.connected === true, 'hello');
  frame({ type: 'disconnect' });
  await waitFor(() => lastStatus(t)?.connected === false, 'the next disconnect');
  assert.equal(reconnects(t).at(-1).ms, 1000, 'hello reset the attempt counter');
});

test('no reconnect is scheduled after stop()', async () => {
  const t = setup();
  t.adapter.start(t.hooks);
  await firstSocket();
  await t.adapter.stop();
  assert.equal(reconnects(t).length, 0, 'closing during stop schedules nothing');
  t.adapter.reconnectLater('late failure');
  assert.equal(reconnects(t).length, 0);
  assert.equal(FakeWs.all.length, 1);
});

test('a slash command whose handler throws is still acked, with a generic reply', async () => {
  const t = setup();
  t.hooks.onCommand = async () => { throw Object.assign(new Error('EACCES /home/op/.am/data'), { code: 'EACCES' }); };
  t.adapter.start(t.hooks);
  await firstSocket();
  const ws = FakeWs.all[0];
  const sent = [];
  ws.send = (s) => sent.push(JSON.parse(s));
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'slash_commands', envelope_id: 'e1', payload: { channel_id: 'C1', user_id: 'U1', text: 'status' } })));
  await waitFor(() => sent.length === 1, 'the ack');
  assert.equal(sent[0].envelope_id, 'e1');
  assert.equal(sent[0].payload.response_type, 'ephemeral');
  assert.doesNotMatch(sent[0].payload.text, /EACCES|home/, 'the error text stays out of chat');
  assert.deepEqual(t.logs.find((e) => e.event === 'command-failed'), { event: 'command-failed', error: 'EACCES' });
});

test('a Slack API error carries a public message; a network error does not', async () => {
  const t = setup({ fetchImpl: async () => ({ status: 200, json: async () => ({ ok: false, error: 'channel_not_found' }) }) });
  const api = await t.adapter.post({ channel: 'C1' }, { title: 't' }).catch((e) => e);
  assert.equal(api.publicMessage, 'slack chat.postMessage: channel_not_found');
  const down = setup({ fetchImpl: async () => { throw new TypeError('fetch failed'); } });
  const net = await down.adapter.post({ channel: 'C1' }, { title: 't' }).catch((e) => e);
  assert.equal(net.publicMessage, undefined);
});

// Timers that honour clearTimer, so firing every live one shows what would really run.
function liveTimers(t) {
  const cleared = new Set();
  t.adapter.clearTimer = (h) => cleared.add(h);
  return { live: () => t.timers.filter((x) => !cleared.has(x)), silent: () => t.timers.filter((x) => x.ms === 120_000 && !cleared.has(x)) };
}

test('any frame, ping or pong restarts the silence clock', async () => {
  const t = setup();
  const clock = liveTimers(t);
  t.adapter.start(t.hooks);
  await firstSocket();
  const ws = FakeWs.all[0];
  for (const fire of [() => ws.emit('pong'), () => ws.emit('ping'), () => ws.emit('message', Buffer.from('{"type":"hello"}'))]) {
    const [before] = clock.silent();
    fire();
    const after = clock.silent();
    assert.equal(after.length, 1, 'one silence clock at a time');
    assert.notEqual(after[0], before, 'a new clock replaced the old one');
  }
  await waitFor(() => lastStatus(t)?.connected === true, 'hello');
  clock.silent()[0].fn();
  assert.deepEqual(t.logs.at(-1), { event: 'socket-silent' });
});

test('a late close or frame on a replaced socket leaves the new one alone', async () => {
  const t = setup();
  const clock = liveTimers(t);
  t.adapter.start(t.hooks);
  await firstSocket();
  const old = FakeWs.all[0];
  old.emit('message', Buffer.from('{"type":"disconnect"}'));
  const fresh = await reconnect(t);
  fresh.emit('message', Buffer.from('{"type":"hello"}'));
  await waitFor(() => lastStatus(t)?.connected === true, 'hello');
  const [watching] = clock.silent();
  const scheduled = reconnects(t).length;
  old.emit('message', Buffer.from('{"type":"hello"}'));
  old.emit('pong');
  old.emit('message', Buffer.from('{"type":"disconnect"}'));
  old.emit('close');
  await drained();
  assert.deepEqual(clock.silent(), [watching], 'the new socket keeps its silence clock');
  assert.equal(reconnects(t).length, scheduled, 'no reconnect for the old socket');
  assert.equal(lastStatus(t).connected, true);
  assert.equal(t.adapter.socket, fresh);
});

test('stop() then start() connects once; a reconnect left from before stop does nothing', async () => {
  const t = setup();
  t.adapter.start(t.hooks);
  await firstSocket();
  FakeWs.all[0].close(); // schedules a reconnect
  const leftover = reconnects(t).at(-1);
  await t.adapter.stop();
  t.adapter.start(t.hooks);
  await waitFor(() => FakeWs.all.length === 2, 'the restart');
  FakeWs.all[1].emit('message', Buffer.from('{"type":"hello"}'));
  await waitFor(() => lastStatus(t)?.connected === true, 'hello');
  leftover.fn();
  await drained();
  assert.equal(FakeWs.all.length, 2, 'the old reconnect opened no second socket');
  assert.equal(t.adapter.socket, FakeWs.all[1]);
});
