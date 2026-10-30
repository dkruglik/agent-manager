import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MessengerBridge } from '../src/messengers/bridge.js';
import { BindingStore } from '../src/messengers/store.js';
import { hookItem } from '../src/messengers/claude-approvals.js';

// Hook decisions on the bridge: what is kept while one is in flight, which
// bindings get its cards, and how it ends.

const perm = { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } };
const flush = () => new Promise((r) => setImmediate(r));
const user = { id: 'U1', name: 'alice' };

function setup(bindings = [{ events: ['input-required'], approvals: true }]) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-messengers-hooks-'));
  const store = new BindingStore(path.join(root, 'messengers.json'), { now: () => 1 });
  const host = {
    sessions: () => [{ id: 's1', name: 'alpha', cli: 'claude', state: 'working', inputRequired: null }],
    groupOf: () => ({ id: 'g1', name: 'proj' }), locked: () => false, link: () => null,
    requests: async () => [], digest: async () => null, answer: async () => {}, prompt: async () => {},
  };
  const posts = [];
  const updates = [];
  const slack = {
    configured: () => true, start() {}, stop: async () => {},
    async post(target, card) { const ref = { channel: target.channel, ts: `t${posts.length + 1}` }; posts.push({ target, card, ref }); return ref; },
    async update(ref, card) { updates.push({ ref, card }); },
  };
  const timers = new Map();
  let n = 0;
  const bridge = new MessengerBridge({
    host, store, adapters: new Map([['slack', slack]]), tickMs: 1e9,
    setTimer: (fn, ms) => { timers.set(++n, { fn, ms }); return n; }, clearTimer: (id) => { timers.delete(id); },
  });
  bindings.forEach((b, i) => store.putBinding({
    id: `b${i}`, adapter: 'slack', target: { channel: `C${i}` }, scope: { type: 'group', id: 'g1' },
    allowedUsers: ['U1'], createdAt: 'x', ...b,
  }));
  bridge.statuses.set('slack', { connected: true, error: null });
  return { bridge, posts, updates, timers };
}

test('a settled hook decision leaves no text behind', async () => {
  const answered = setup();
  const waiting = answered.bridge.awaitDecision('s1', hookItem(perm));
  await flush();
  const click = { channel: 'C0', ts: answered.posts[0].ref.ts, thread: null, user, messageId: 'm1', optionId: 'd:accept' };
  await answered.bridge.handleReply('slack', click);
  assert.equal((await waiting).by, 'alice');
  assert.equal(answered.bridge.hooks.settledText.size, 0, 'answered');

  const timedOut = setup();
  const late = timedOut.bridge.awaitDecision('s1', hookItem(perm));
  await flush();
  timedOut.timers.values().next().value.fn();
  assert.equal(await late, null);
  await flush();
  assert.equal(timedOut.bridge.hooks.settledText.size, 0, 'timed out');
});

test('a decision settled while its card is still being posted closes that card with the text', async () => {
  const t = setup();
  const release = Promise.withResolvers();
  const post = t.bridge.adapters.get('slack').post;
  t.bridge.adapters.get('slack').post = async (...a) => { await release.promise; return post(...a); };
  const waiting = t.bridge.awaitDecision('s1', hookItem(perm));
  await flush();
  t.timers.values().next().value.fn();
  assert.equal(await waiting, null);
  release.resolve();
  await flush();
  await flush();
  assert.equal(t.updates.at(-1).card.resolved.text, 'No answer in time — answer in the terminal.');
  assert.equal(t.bridge.hooks.settledText.size, 0);
});

test('stop settles every waiting hook decision with null and starts no second interval', async () => {
  const t = setup();
  const waiting = t.bridge.awaitDecision('s1', hookItem(perm));
  await flush();
  const started = [];
  const realSet = globalThis.setInterval;
  globalThis.setInterval = (...a) => { const h = realSet(...a); started.push(h); return h; };
  try { t.bridge.start(); t.bridge.start(); } finally { globalThis.setInterval = realSet; }
  assert.equal(started.length, 1, 'one interval');
  await t.bridge.stop();
  assert.equal(await waiting, null);
  assert.equal(t.bridge.pending.size, 0);
  await flush();
  assert.equal(t.updates.at(-1).card.resolved.text, 'Agent Manager is stopping — answer in the terminal.');
});

test('the decision timer does not keep the process alive', async () => {
  const t = setup();
  const handle = { unref() { handle.unrefd = true; } };
  t.bridge.setTimer = () => handle;
  const waiting = t.bridge.awaitDecision('s1', hookItem(perm));
  await flush();
  assert.equal(handle.unrefd, true);
  await t.bridge.stop();
  await waiting;
});

test('approval cards go only to bindings that include input-required', async () => {
  const t = setup([{ events: ['finished'], approvals: true }, { events: ['input-required', 'finished'], approvals: true }]);
  const waiting = t.bridge.awaitDecision('s1', hookItem(perm));
  await flush();
  assert.deepEqual(t.posts.map((p) => p.target.channel), ['C1']);
  await t.bridge.stop();
  await waiting;

  const only = setup([{ events: ['finished'], approvals: true }]);
  assert.equal(await only.bridge.awaitDecision('s1', hookItem(perm)), null, 'nothing qualifies, so the terminal keeps the dialog');
  assert.equal(only.posts.length, 0);
});
