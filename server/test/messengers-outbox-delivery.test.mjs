import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MessengerBridge } from '../src/messengers/bridge.js';
import { BindingStore } from '../src/messengers/store.js';
import { deliverToSession } from '../src/delivery-outcome.js';
import { ApiError } from '../src/api-errors.js';
import { requestIdFor } from '../src/messengers/replies.js';

// Outbox drain wired to real deliverToSession classification (not a mocked host.outcome).

const alice = { id: 'U1', name: 'alice' };
const msg = (ts, body) => ({ channel: 'C0', ts, thread: null, user: alice, messageId: `m${ts}`, text: body });

function setup({ codexSend = async () => {} } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-outbox-delivery-'));
  const host = {
    deliveries: [],
    isLocked: false,
    sessions: () => [{ id: 's1', name: 'alpha', cli: 'codex', state: 'working', inputRequired: null }],
    list: [{ id: 's1', name: 'alpha', cli: 'codex', state: 'working', inputRequired: null }],
    groupOf: () => ({ id: 'g1', name: 'proj' }),
    locked: () => host.isLocked,
    lockState: () => ({ locked: host.isLocked, reason: host.isLocked ? 'public-space' : null }),
    onLock: () => () => {},
    ready: async () => 'skipped',
    lockScope: () => ({ signal: new AbortController().signal, release() {} }),
    link: () => null,
    sourceKey: () => 'src-1',
    requests: async () => [],
    digest: async () => null,
    answer: async () => {},
    async deliver(s, { text, requestId }) {
      return deliverToSession(s, { text, requestId }, {
        shared: () => true,
        remote: () => false,
        limit: 32_000,
        log: () => {},
        touch: () => {},
        sendCodex: codexSend,
        sendLocal: async () => {},
      });
    },
  };
  const posts = [];
  const slack = {
    configured: () => true,
    start(h) { h.onStatus({ connected: true, error: null }); },
    async post(target, card) {
      const ref = { channel: target.channel, ts: `t${posts.length + 1}` };
      posts.push({ target, card, ref });
      return ref;
    },
    async update() {},
    async postEphemeral() {},
  };
  const logs = [];
  const store = new BindingStore(path.join(root, 'messengers.json'));
  const bridge = new MessengerBridge({
    host, store, adapters: new Map([['slack', slack]]), dataDir: root,
    log: (e) => logs.push(e), tickMs: 1e9, settleMs: 0, digestEveryMs: 0,
  });
  bridge.statuses.set('slack', { connected: true, error: null });
  store.putBinding({
    id: 'b0', adapter: 'slack', target: { channel: 'C0' }, scope: { type: 'group', id: 'g1' },
    events: ['input-required'], allowedUsers: ['U1'], approvals: false, createdAt: 'x',
  });
  const dir = path.join(root, 'messenger-outbox');
  const row = (ts) => JSON.parse(fs.readFileSync(path.join(dir, `${requestIdFor('slack', 'C0', ts)}.json`), 'utf8'));
  return {
    root, host, bridge, store, logs, row,
    send: (r) => bridge.handleReply('slack', r),
  };
}

test('deliverToSession codex-task-busy leaves the outbox row pending for a later drain', async () => {
  let calls = 0;
  const t = setup({
    codexSend: async (session, message) => {
      calls += 1;
      if (calls === 1) throw new ApiError(409, 'codex-task-busy', 'busy');
      t.host.deliveries.push({ id: session.id, text: message.text, requestId: message.requestId });
    },
  });
  await t.send(msg('10.1', 'run tests'));
  await t.bridge.drain();
  assert.equal(t.host.deliveries.length, 0);
  assert.equal(t.row('10.1').state, 'pending');
  await t.bridge.drain();
  assert.equal(t.host.deliveries.length, 1);
  assert.deepEqual(fs.readdirSync(path.join(t.root, 'messenger-outbox')), []);
});

test('deliverToSession codex-send-uncertain rewrites the row submitted on disk', async () => {
  const t = setup({
    codexSend: async () => { throw new ApiError(502, 'codex-send-uncertain', 'uncertain'); },
  });
  await t.send(msg('10.1', 'maybe sent'));
  await t.bridge.drain();
  assert.equal(t.host.deliveries.length, 0);
  assert.equal(t.row('10.1').state, 'submitted');
  await t.bridge.drain();
  assert.equal(t.host.deliveries.length, 0);
});
