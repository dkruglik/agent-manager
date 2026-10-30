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
