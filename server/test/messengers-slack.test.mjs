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
const settle = () => new Promise((r) => setTimeout(r, 10));

test('a frame that is not JSON is logged, without its content', async () => {
  const t = setup();
  t.adapter.start(t.hooks);
  await settle();
  FakeWs.all[0].emit('message', Buffer.from('xoxb-secret {not json'));
  await settle();
  assert.deepEqual(t.logs, [{ event: 'bad-frame' }]);
});

test('starting twice opens one socket', async () => {
  const t = setup();
  t.adapter.start(t.hooks);
  t.adapter.start(t.hooks);
  await settle();
  assert.equal(FakeWs.all.length, 1);
});

test('stopping while a connect is in flight opens no socket afterwards', async () => {
  const gate = Promise.withResolvers();
  let first = true;
  const t = setup();
  const inner = t.adapter.fetchImpl;
  t.adapter.fetchImpl = async (url, init) => { if (first && url.endsWith('auth.test')) { first = false; await gate.promise; } return inner(url, init); };
  t.adapter.start(t.hooks);
  await settle();
  await t.adapter.stop();
  gate.resolve();
  await settle();
  assert.equal(FakeWs.all.length, 0);
  assert.deepEqual(t.calls, ['auth.test'], 'it did not go on to open a connection either');

  // A restart while the old connect is still in flight is not mistaken for it.
  const gate2 = Promise.withResolvers();
  const u = setup();
  const inner2 = u.adapter.fetchImpl;
  let held = true;
  u.adapter.fetchImpl = async (url, init) => { if (held && url.endsWith('auth.test')) { held = false; await gate2.promise; } return inner2(url, init); };
  u.adapter.start(u.hooks);
  await settle();
  await u.adapter.stop();
  u.adapter.start(u.hooks);
  await settle();
  gate2.resolve();
  await settle();
  assert.equal(FakeWs.all.length, 1, 'only the new start connected');
});

test('a socket that goes silent is dropped and reconnected', async () => {
  const cleared = new Set();
  const t = setup({ clearTimer: (h) => cleared.add(h) });
  t.adapter.start(t.hooks);
  await settle();
  const ws = FakeWs.all[0];
  ws.emit('message', Buffer.from('{"type":"hello"}'));
  await settle();
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
  await settle();
  assert.equal(FakeWs.all.length, 2, 'reconnected');
});

async function waitFor(predicate, what) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}
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
  await waitFor(() => FakeWs.all.length === 1, 'the first socket');
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
  await waitFor(() => FakeWs.all.length === 1, 'the first socket');
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
  await waitFor(() => FakeWs.all.length === 1, 'the first socket');
  await t.adapter.stop();
  assert.equal(reconnects(t).length, 0, 'closing during stop schedules nothing');
  t.adapter.reconnectLater('late failure');
  assert.equal(reconnects(t).length, 0);
  assert.equal(FakeWs.all.length, 1);
});

test('a slash command whose handler throws is still acked, with a generic reply', async () => {
  const t = setup();
  t.hooks.onCommand = async () => { throw new Error('EACCES /home/op/.am/data'); };
  t.adapter.start(t.hooks);
  await waitFor(() => FakeWs.all.length === 1, 'the first socket');
  const ws = FakeWs.all[0];
  const sent = [];
  ws.send = (s) => sent.push(JSON.parse(s));
  ws.emit('message', Buffer.from(JSON.stringify({ type: 'slash_commands', envelope_id: 'e1', payload: { channel_id: 'C1', user_id: 'U1', text: 'status' } })));
  await waitFor(() => sent.length === 1, 'the ack');
  assert.equal(sent[0].envelope_id, 'e1');
  assert.equal(sent[0].payload.response_type, 'ephemeral');
  assert.doesNotMatch(sent[0].payload.text, /EACCES|home/, 'the error text stays out of chat');
  assert.deepEqual(t.logs.find((e) => e.event === 'command-failed'), { event: 'command-failed', error: 'EACCES /home/op/.am/data' });
});
