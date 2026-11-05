import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MessengerBridge } from '../src/messengers/bridge.js';
import { BindingStore } from '../src/messengers/store.js';
import { backfill } from '../src/messengers/backfill.js';
import { requestIdFor } from '../src/messengers/replies.js';

// Backfill after a socket connect: what Slack held while the server was away, read from the
// watermarks and sent through the same path as a live event. No test talks to Slack.

const NOW = 5_000_000_000; // ms
const OLD = '4990000.100000'; // 10000 s before NOW: past the 1 hour limit
const OLD2 = '4990001.100000';
const NEW1 = '4999000.100000'; // 1000 s before NOW
const NEW2 = '4999001.100000';
const m = (ts, user = 'U1', extra = {}) => ({ channel: 'C0', ts, thread: null, user: { id: user }, messageId: `C0:${ts}`, text: `text ${ts}`, ...extra });

function rig({ marks = true, bindings = ['C0'] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-messengers-backfill-'));
  const store = new BindingStore(path.join(root, 'messengers.json'), { now: () => NOW });
  bindings.forEach((channel, i) => store.putBinding({
    id: `b${i}`, adapter: 'slack', target: { channel }, scope: { type: 'group', id: 'g1' },
    events: ['input-required'], allowedUsers: ['U1', 'U2'], approvals: false, createdAt: 'x',
  }));
  if (marks) {
    store.patchState({
      channelMarks: { 'slack|C0': '100.0' }, threadMarks: { 'slack|C0|s1': '200.0' },
      roots: { 'slack|C0|s1': [{ ts: '300.0', at: 1, count: 0 }] }, deliveredTs: { 'slack|C0': [{ ts: '400.0', sessionId: 's1' }] },
    });
  }
  const fetches = [];
  const ephemerals = [];
  const logs = [];
  const answers = { fn: () => [] };
  const adapter = {
    async history(args) { fetches.push(args); return answers.fn(args); },
    async postEphemeral(e) { ephemerals.push(e); },
  };
  const accepted = [];
  const ctx = { adapterId: 'slack', adapter, store, now: () => NOW, log: (e) => logs.push(e), accept: async (id, r) => { accepted.push(r); return { queued: 's1' }; } };
  return { root, store, fetches, ephemerals, logs, answers, ctx, accepted };
}

test('backfill reads the channel from its watermark and each known thread from the session watermark', async () => {
  const t = rig();
  await backfill(t.ctx);
  assert.deepEqual(t.fetches, [
    { channel: 'C0', oldest: '100.0' },
    { channel: 'C0', thread: '300.0', oldest: '200.0' },
    { channel: 'C0', thread: '400.0', oldest: '200.0' },
  ]);
});

test('without a watermark nothing is fetched', async () => {
  const t = rig({ marks: false });
  await backfill(t.ctx);
  assert.deepEqual(t.fetches, []);
  const u = rig({ bindings: ['C0', 'C1'] });
  u.store.patchState({ channelMarks: { 'slack|C0': '100.0' } }); // C1 has none; C0 has roots but no thread mark
  u.store.patchState({ roots: { 'slack|C0|s1': [{ ts: '300.0', at: 1, count: 0 }] }, threadMarks: { 'slack|C0|s1': null } });
  await backfill(u.ctx);
  assert.deepEqual(u.fetches, [{ channel: 'C0', oldest: '100.0' }]);
});

test('a thread ts that is both a root and a delivered ts is fetched once', async () => {
  const t = rig();
  t.store.patchState({ deliveredTs: { 'slack|C0': [{ ts: '300.0', sessionId: 's1' }] } });
  await backfill(t.ctx);
  assert.equal(t.fetches.filter((f) => f.thread === '300.0').length, 1);
});

test('messages older than an hour are not delivered; each user gets one ephemeral notice', async () => {
  const t = rig();
  t.answers.fn = ({ thread }) => (thread ? [] : [m(OLD), m(OLD2), m(OLD, 'U2', { ts: '4990002.1', messageId: 'x' }), m(NEW1), m(NEW2, 'U9')]);
  const out = await backfill(t.ctx);
  assert.deepEqual(t.accepted.map((r) => r.ts), [NEW1, NEW2], 'only the newer messages go on');
  assert.deepEqual(t.ephemerals.map((e) => [e.channel, e.user, e.text]).sort(), [
    ['C0', 'U1', '2 messages you sent while Agent Manager was offline were not delivered.'],
    ['C0', 'U2', '1 message you sent while Agent Manager was offline was not delivered.'],
  ]);
  assert.equal(out.skipped, 3);
});

test('a skipped message is announced once, not again on the next reconnect', async () => {
  const t = rig();
  t.answers.fn = ({ thread }) => (thread ? [] : [m(OLD), m(OLD2), m(NEW1)]);
  await backfill(t.ctx);
  assert.equal(t.ephemerals.length, 1);
  await backfill(t.ctx);
  assert.equal(t.ephemerals.length, 1, 'no second notice for the same messages');
  t.answers.fn = ({ thread }) => (thread ? [] : [m(OLD), m(OLD2), m('4990003.1')]);
  await backfill(t.ctx);
  assert.deepEqual(t.ephemerals.map((e) => e.text), [
    '2 messages you sent while Agent Manager was offline were not delivered.',
    '1 message you sent while Agent Manager was offline was not delivered.',
  ]);
});

test('a notice that could not be posted is tried again on the next reconnect', async () => {
  const t = rig();
  t.answers.fn = ({ thread }) => (thread ? [] : [m(OLD)]);
  const post = t.ctx.adapter.postEphemeral;
  t.ctx.adapter.postEphemeral = async () => { throw new Error('rate limited'); };
  await backfill(t.ctx);
  t.ctx.adapter.postEphemeral = post;
  await backfill(t.ctx);
  assert.equal(t.ephemerals.length, 1);
});

test('a user no binding allows gets no notice, and a message already delivered is not counted as missed', async () => {
  const t = rig();
  const delivered = requestIdFor('slack', 'C0', OLD);
  t.store.patchState({ deliveredIds: { 'slack|C0': [delivered] } });
  t.answers.fn = ({ thread }) => (thread ? [] : [m(OLD), m(OLD2, 'U9')]);
  await backfill(t.ctx);
  assert.deepEqual(t.ephemerals, []);
  assert.deepEqual(t.accepted, []);
});

test('replies under a root and under a delivered ts are sent too, in ts order, with a skipped old reply counted', async () => {
  const t = rig();
  t.answers.fn = ({ thread }) => {
    if (thread === '300.0') return [{ ...m(NEW2), thread: '300.0' }, { ...m(OLD), thread: '300.0' }];
    if (thread === '400.0') return [{ ...m(NEW1), thread: '400.0' }];
    return [];
  };
  await backfill(t.ctx);
  assert.deepEqual(t.accepted.map((r) => [r.ts, r.thread]), [[NEW2, '300.0'], [NEW1, '400.0']]);
  assert.equal(t.ephemerals.length, 1, 'one notice for the channel, not one per thread');
  assert.match(t.ephemerals[0].text, /^1 message you sent/);
});

test('a failed fetch is not an empty history: the rest is read, then backfill throws', async () => {
  const t = rig();
  t.answers.fn = ({ thread }) => { if (thread === '300.0') throw new Error('slack conversations.replies: ratelimited'); return thread ? [m(NEW2)] : [m(NEW1)]; };
  let n = 0;
  t.ctx.accept = async (id, r) => { t.accepted.push(r); if (++n === 1) throw new Error('outbox write failed'); return {}; };
  await assert.rejects(() => backfill(t.ctx), (e) => e.event === 'backfill-failed');
  assert.deepEqual(t.accepted.map((r) => r.ts), [NEW1, NEW2]);
  assert.ok(t.logs.some((e) => e.event === 'backfill-failed' && e.thread === '300.0'));
  assert.ok(t.logs.some((e) => e.event === 'backfill-accept-failed'));
  assert.ok(t.logs.some((e) => e.event === 'backfill'));
  assert.ok(!JSON.stringify(t.logs).includes('text 4999'));
});

test('skipped ids have their own cap: announcing them never evicts settled ids', async () => {
  const t = rig({ marks: false });
  const settled = Array.from({ length: 500 }, (_, i) => `slack:C0:${i}`);
  t.store.patchState({ channelMarks: { 'slack|C0': '100.0' }, settledIds: { 'slack|C0': settled } });
  t.answers.fn = () => [m(OLD), m(OLD2)];
  await backfill(t.ctx);
  assert.equal(t.ephemerals.length, 1);
  assert.deepEqual(t.store.state('settledIds', 'slack|C0'), settled, 'settled ids are untouched');
  assert.equal(t.store.state('skippedIds', 'slack|C0').length, 2);
  await backfill(t.ctx);
  assert.equal(t.ephemerals.length, 1, 'not announced again on the next connect');
  const full = Array.from({ length: 500 }, (_, i) => `slack:C0:s${i}`);
  t.store.patchState({ skippedIds: { 'slack|C0': full } });
  t.answers.fn = () => [m('4990002.100000')];
  await backfill(t.ctx);
  const kept = t.store.state('skippedIds', 'slack|C0');
  assert.equal(kept.length, 500, 'capped on its own');
  assert.ok(!kept.includes('slack:C0:s0') && kept.includes(requestIdFor('slack', 'C0', '4990002.100000')));
});

test('a thread read (oldest first) cut off at the page limit keeps the pages it read and logs a warning', async () => {
  const t = rig({ marks: false });
  t.store.patchState({ channelMarks: { 'slack|C0': null }, threadMarks: { 'slack|C0|s1': '200.0' }, roots: { 'slack|C0|s1': [{ ts: '300.0', at: 1, count: 0 }] }, deliveredTs: { 'slack|C0': null } });
  t.answers.fn = () => { throw Object.assign(new Error('history read hit the page limit'), { event: 'history-truncated', partial: [m(NEW1), m(NEW2)] }); };
  const total = await backfill(t.ctx);
  assert.deepEqual(t.accepted.map((r) => r.ts), [NEW1, NEW2], 'what was read is delivered');
  assert.equal(total.accepted, 2);
  assert.ok(t.logs.some((e) => e.event === 'backfill-truncated' && e.kept === 2));
  assert.ok(!t.logs.some((e) => e.event === 'backfill-failed'));
  assert.ok(!JSON.stringify(t.logs).includes('text 4999'));
});

test('a failed accept is not a successful backfill: backfill throws so the next connect retries', async () => {
  const t = rig({ marks: false });
  t.store.patchState({ channelMarks: { 'slack|C0': '100.0' } });
  t.answers.fn = () => [m(NEW1), m(NEW2)];
  t.ctx.accept = async (id, r) => { t.accepted.push(r); throw new Error('outbox write failed'); };
  await assert.rejects(() => backfill(t.ctx), (e) => e.event === 'backfill-failed' && e.acceptFailed);
  assert.equal(t.accepted.length, 2);
  assert.equal(t.logs.filter((e) => e.event === 'backfill-accept-failed').length, 2);
});

// With a real bridge behind accept: the delivered-id set makes a second pass a no-op.
test('backfill through the bridge is idempotent with the delivered ids', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-messengers-backfill-bridge-'));
  const store = new BindingStore(path.join(root, 'messengers.json'), { now: () => NOW });
  const host = {
    deliveries: [],
    sessions: () => [{ id: 's1', name: 'alpha', cli: 'claude', state: 'working', inputRequired: null }],
    groupOf: () => ({ id: 'g1', name: 'proj' }),
    locked: () => false, lockState: () => ({ locked: false, reason: null }), onLock: () => () => {}, ready: async () => 'skipped',
    lockScope: () => ({ signal: new AbortController().signal, release() {} }), link: () => null, sourceKey: () => 'src',
    requests: async () => [], digest: async () => null, answer: async () => {},
    async deliver(s, { text, requestId }) { host.deliveries.push({ text, requestId }); return { state: 'delivered' }; },
  };
  const slack = {
    configured: () => true, start() {}, async update() {}, async postEphemeral() {},
    async post(target) { return { channel: target.channel, ts: `t${Math.random()}` }; },
  };
  const bridge = new MessengerBridge({ host, store, adapters: new Map([['slack', slack]]), now: () => NOW, dataDir: root, log: () => {}, tickMs: 1e9, settleMs: 0, digestEveryMs: 0 });
  bridge.statuses.set('slack', { connected: true, error: null });
  store.putBinding({ id: 'b0', adapter: 'slack', target: { channel: 'C0' }, scope: { type: 'group', id: 'g1' }, events: ['input-required'], allowedUsers: ['U1'], approvals: false, createdAt: 'x' });
  store.patchState({ channelMarks: { 'slack|C0': '100.0' } });
  const history = { async history() { return [m(NEW1), m(NEW2)]; } };
  const ctx = { adapterId: 'slack', adapter: { ...slack, ...history }, store, now: () => NOW, log: () => {}, accept: (id, r) => bridge.handleReply(id, r) };
  await backfill(ctx);
  await bridge.drain();
  assert.deepEqual(host.deliveries.map((d) => d.text), [`text ${NEW1}`, `text ${NEW2}`]);
  assert.equal(store.state('channelMarks', 'slack|C0'), NEW2);
  await backfill(ctx); // the same history again, e.g. after the next connect
  await bridge.drain();
  assert.equal(host.deliveries.length, 2, 'nothing is sent twice');
});

// The bridge wires an adapter's onConnect to one backfill pass.
function connectRig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-messengers-backfill-connect-'));
  const store = new BindingStore(path.join(root, 'messengers.json'), { now: () => NOW });
  const host = {
    sessions: () => [{ id: 's1', name: 'alpha', cli: 'claude', state: 'working', inputRequired: null }],
    groupOf: () => ({ id: 'g1', name: 'proj' }),
    locked: () => false, lockState: () => ({ locked: false, reason: null }), onLock: () => () => {}, ready: async () => 'skipped',
    lockScope: () => ({ signal: new AbortController().signal, release() {} }), link: () => null, sourceKey: () => 'src',
    requests: async () => [], digest: async () => null, answer: async () => {}, deliver: async () => ({ state: 'delivered' }),
  };
  const hooks = {};
  const fetches = [];
  const gate = { release: null, wait: null };
  const slack = {
    configured: () => true, start(h) { hooks.h = h; }, async stop() {}, async update() {}, async postEphemeral() {},
    async post(target) { return { channel: target.channel, ts: 't1' }; },
    async history(args) { fetches.push(args); if (gate.wait) await gate.wait; return [m(NEW1)]; },
  };
  const bridge = new MessengerBridge({ host, store, adapters: new Map([['slack', slack]]), now: () => NOW, dataDir: root, log: () => {}, tickMs: 1e9, settleMs: 0, digestEveryMs: 0 });
  store.putBinding({ id: 'b0', adapter: 'slack', target: { channel: 'C0' }, scope: { type: 'group', id: 'g1' }, events: ['input-required'], allowedUsers: ['U1'], approvals: false, createdAt: 'x' });
  store.patchState({ channelMarks: { 'slack|C0': '100.0' } });
  const dir = path.join(root, 'messenger-outbox');
  const rows = () => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : []);
  return { bridge, hooks, fetches, gate, rows, root };
}
const waitUntil = async (fn) => { for (let i = 0; i < 500 && !fn(); i++) await new Promise((r) => setTimeout(r, 2)); };

test('the bridge runs one backfill pass when the adapter reports a connect', async () => {
  const t = connectRig();
  t.bridge.start();
  assert.equal(typeof t.hooks.h.onConnect, 'function');
  t.hooks.h.onConnect();
  await waitUntil(() => t.rows().length === 1);
  assert.deepEqual(t.fetches, [{ channel: 'C0', oldest: '100.0' }]);
  assert.deepEqual(t.rows(), [`${requestIdFor('slack', 'C0', NEW1)}.json`], 'the newer message is a row');
  await t.bridge.stop();
});

test('a backfill still running after stop() writes no row', async () => {
  const t = connectRig();
  t.gate.wait = new Promise((r) => { t.gate.release = r; });
  t.bridge.start();
  const done = t.hooks.h.onConnect();
  await waitUntil(() => t.fetches.length === 1);
  await t.bridge.stop();
  t.gate.release();
  await done;
  assert.deepEqual(t.rows(), []);
});
