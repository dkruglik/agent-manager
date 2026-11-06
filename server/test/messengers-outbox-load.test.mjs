import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MessengerBridge } from '../src/messengers/bridge.js';
import { BindingStore } from '../src/messengers/store.js';
import { requestIdFor } from '../src/messengers/replies.js';

// An unreadable outbox directory must not look like an empty one. This file is
// alone so mocking fs.readdirSync cannot race another suite.

test('an unreadable outbox is refused until a later drain can read it', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-outbox-load-'));
  const now = () => 1_000_000;
  const store = new BindingStore(path.join(root, 'messengers.json'), { now });
  store.putBinding({
    id: 'b0', adapter: 'slack', target: { channel: 'C0' }, scope: { type: 'group', id: 'g1' },
    events: ['input-required'], allowedUsers: ['U1'], approvals: false, createdAt: 'x',
  });
  const host = {
    deliveries: [],
    sessions: () => [{ id: 's1', name: 'alpha', cli: 'claude', state: 'working', inputRequired: null }],
    groupOf: () => ({ id: 'g1', name: 'proj' }),
    locked: () => false, lockState: () => ({ locked: false, reason: null }), onLock: () => () => {},
    ready: async () => 'skipped', lockScope: () => ({ signal: new AbortController().signal, release() {} }),
    link: () => null, sourceKey: () => 'src', requests: async () => [], digest: async () => null, answer: async () => {},
    async deliver(s, { text, requestId }) {
      host.deliveries.push({ text, requestId });
      return { state: 'delivered' };
    },
  };
  const slack = {
    configured: () => true, start() {}, async update() {}, async postEphemeral() {},
    async post(target) { return { channel: target.channel, ts: 't1' }; },
  };
  const logs = [];
  const first = new MessengerBridge({
    host, store, adapters: new Map([['slack', slack]]), now, dataDir: root, log: (e) => logs.push(e), tickMs: 1e9,
  });
  const ts = '10.1';
  await first.handleReply('slack', {
    channel: 'C0', ts, thread: null, user: { id: 'U1', name: 'alice' }, messageId: 'm1', text: 'keep me',
  });
  const dir = path.join(root, 'messenger-outbox');
  const real = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (p, opts) => {
    if (path.resolve(String(p)) === path.resolve(dir)) {
      const err = new Error('denied');
      err.code = 'EACCES';
      throw err;
    }
    return real.call(fs, p, opts);
  });
  const blocked = new MessengerBridge({
    host, store: new BindingStore(path.join(root, 'messengers.json'), { now }),
    adapters: new Map([['slack', slack]]), now, dataDir: root, log: (e) => logs.push(e), tickMs: 1e9,
  });
  assert.ok(logs.some((e) => e.event === 'outbox-unreadable' && e.error === 'EACCES'));
  await assert.rejects(
    () => blocked.handleReply('slack', {
      channel: 'C0', ts: '10.2', thread: null, user: { id: 'U1' }, messageId: 'm2', text: 'later',
    }),
    (e) => e.persist === true,
  );
  t.mock.restoreAll();
  await blocked.drain();
  assert.equal(host.deliveries.some((d) => d.requestId === requestIdFor('slack', 'C0', ts)), true);
});
