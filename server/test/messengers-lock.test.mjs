import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MessengerBridge } from '../src/messengers/bridge.js';
import { BindingStore } from '../src/messengers/store.js';
import { requestIdFor } from '../src/messengers/replies.js';

// The privacy lock and the outbox: a real lock deletes the waiting prompts, `checking` saves and holds them.
// The lock reaches the messenger modules only through the host (lockState, onLock, lockScope).

const alice = { id: 'U1', name: 'alice' };
const REAL = { locked: true, reason: 'public-space' };
const CHECKING = { locked: true, reason: 'checking' };
const OPEN = { locked: false, reason: null };

function setup({ lock = OPEN, root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-messengers-lock-')) } = {}) {
  const clock = { t: 1_000_000 };
  const now = () => clock.t;
  const listeners = new Set();
  const scopes = new Set();
  const host = {
    lock, deliveries: [], released: 0, outcome: () => ({ state: 'delivered' }),
    list: [{ id: 's1', name: 'alpha', cli: 'claude', state: 'working', inputRequired: null }],
    sessions: () => host.list.map((s) => ({ ...s })),
    groupOf: () => ({ id: 'g1', name: 'proj' }),
    locked: () => host.lock.locked, lockState: () => ({ ...host.lock }),
    onLock(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    lockScope() {
      const c = new AbortController();
      const scope = { signal: c.signal, release: () => { host.released += 1; scopes.delete(c); } };
      scopes.add(c);
      if (host.lock.locked && host.lock.reason !== 'checking') c.abort(new Error('locked'));
      return scope;
    },
    setLock(next) {
      host.lock = next;
      if (next.locked && next.reason !== 'checking') for (const c of [...scopes]) c.abort(new Error('locked'));
      for (const fn of [...listeners]) fn({ ...next });
    },
    link: () => null, sourceKey: () => 'src', requests: async () => [], digest: async () => null, answer: async () => {},
    async deliver(s, { text, requestId, signal }) {
      host.deliveries.push({ id: s.id, text, requestId, signal });
      return host.outcome(s, signal);
    },
  };
  const posts = [];
  const slack = {
    configured: () => true, start(h) { h.onStatus({ connected: true, error: null }); },
    async post(target, card) { const ref = { channel: target.channel, ts: `t${posts.length + 1}` }; posts.push({ target, card, ref }); return ref; },
    async update() {}, async postEphemeral() {},
  };
  const store = new BindingStore(path.join(root, 'messengers.json'), { now });
  const logs = [];
  const make = () => {
    const bridge = new MessengerBridge({ host, store, adapters: new Map([['slack', slack]]), now, dataDir: root, log: (e) => logs.push(e), tickMs: 1e9, settleMs: 0 });
    bridge.statuses.set('slack', { connected: true, error: null });
    return bridge;
  };
  store.putBinding({
    id: 'b0', adapter: 'slack', target: { channel: 'C0' }, scope: { type: 'group', id: 'g1' },
    events: ['input-required'], allowedUsers: ['U1'], approvals: false, createdAt: 'x',
  });
  const dir = path.join(root, 'messenger-outbox');
  const files = () => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : []);
  const bridge = make();
  return { host, posts, logs, make, bridge, files, dir, send: (r, b = bridge) => b.handleReply('slack', r) };
}

const msg = (ts, body, extra = {}) => ({ channel: 'C0', ts, thread: null, user: alice, messageId: `m${ts}`, text: body, ...extra });
const lockedLines = (t) => t.posts.filter((p) => p.card.body === 'Not delivered (locked).');

test('a real lock writes no row and the sender gets the locked notice', async () => {
  const t = setup({ lock: REAL });
  assert.deepEqual(await t.send(msg('10.1', 'hello')), { refused: 'locked' });
  assert.deepEqual(t.files(), []);
  assert.equal(t.posts.at(-1).card.body, 'Agent Manager is locked; nothing was sent.');
});

test('an event during checking is saved, held, and delivered only once unlocked', async () => {
  const t = setup({ lock: CHECKING });
  assert.deepEqual(await t.send(msg('10.1', 'hello')), { queued: 's1' });
  assert.equal(t.files().length, 1);
  await t.bridge.drain();
  assert.equal(t.host.deliveries.length, 0, 'not drained while checking');
  assert.equal(t.files().length, 1, 'nothing deleted');
  t.host.setLock(OPEN);
  await t.bridge.drain();
  assert.equal(t.host.deliveries.length, 1);
  assert.deepEqual(t.files(), []);
});

test('a checking startup deletes nothing', async () => {
  const t = setup({ lock: CHECKING });
  await t.send(msg('10.1', 'hello'));
  const again = t.make();
  again.start();
  await again.stop();
  assert.equal(t.files().length, 1);
  assert.equal(lockedLines(t).length, 0);
});

const landings = {
  'unlocked to a real lock': { before: OPEN, change: (t) => t.host.setLock(REAL) },
  'checking to a real lock': { before: CHECKING, change: (t) => t.host.setLock(REAL) },
};
for (const [name, { before, change }] of Object.entries(landings)) {
  test(`${name} deletes pending rows; none is sent after unlock; one line per thread`, async () => {
    const t = setup({ lock: before });
    t.bridge.start();
    await t.send(msg('10.1', 'one'));
    await t.send(msg('10.2', 'two', { thread: '10.1' }));
    await t.send(msg('10.3', 'three', { thread: '10.1' }));
    assert.equal(t.files().length, 3);
    change(t);
    assert.deepEqual(t.files(), []);
    assert.equal(lockedLines(t).length, 0, 'nothing is posted while locked');
    t.host.setLock(OPEN);
    await t.bridge.drain();
    assert.equal(t.host.deliveries.length, 0);
    assert.deepEqual(lockedLines(t).map((p) => p.target.thread).sort(), ['10.1'], 'one line for the thread');
    t.host.setLock(OPEN);
    assert.equal(lockedLines(t).length, 1, 'not repeated');
    await t.bridge.stop();
  });
}

test('a real lock found by start() deletes pending rows', async () => {
  const t = setup({ lock: OPEN });
  await t.send(msg('10.1', 'one'));
  t.host.lock = REAL; // the verdict arrived before the bridge subscribed
  const again = t.make();
  again.start();
  assert.deepEqual(t.files(), []);
  t.host.setLock(OPEN);
  await again.drain();
  assert.equal(t.host.deliveries.length, 0);
  assert.equal(lockedLines(t).length, 1, 'rows deleted by this process are remembered and get their line after unlock');
  await again.stop();
});

test('a submitted row survives a real lock', async () => {
  const t = setup();
  t.bridge.start();
  t.host.outcome = () => ({ state: 'submitted', reason: 'typed' });
  await t.send(msg('10.1', 'one'));
  await t.bridge.drain();
  t.host.setLock(REAL);
  assert.equal(t.files().length, 1);
  await t.bridge.stop();
});

test('a send in flight when the lock lands is aborted through its scope and ends deleted', async () => {
  const t = setup();
  t.bridge.start();
  t.host.outcome = (s, signal) => new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve({ state: 'pending', reason: 'locked' }));
  });
  await t.send(msg('10.1', 'one'));
  const draining = t.bridge.drain();
  await new Promise((r) => setImmediate(r));
  assert.equal(t.host.deliveries.length, 1);
  assert.equal(t.host.deliveries[0].signal.aborted, false);
  t.host.setLock(REAL);
  await draining;
  assert.ok(t.host.deliveries[0].signal.aborted);
  assert.deepEqual(t.files(), []);
  assert.equal(t.host.released, 1, 'the scope is released');
  t.host.setLock(OPEN);
  await t.bridge.drain();
  assert.equal(t.host.deliveries.length, 1, 'never sent after unlock');
  assert.equal(lockedLines(t).length, 1);
  await t.bridge.stop();
});

test('the messenger modules reach the lock only through the host', () => {
  const root = path.join(import.meta.dirname, '..', 'src', 'messengers');
  const sources = [];
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name)); else if (e.name.endsWith('.js')) sources.push(path.join(d, e.name)); } };
  walk(root);
  assert.ok(sources.length > 5);
  for (const file of sources) {
    const imports = [...fs.readFileSync(file, 'utf8').matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
    for (const spec of imports) {
      assert.ok(!/visibility/.test(spec), `${path.basename(file)} imports ${spec}`);
      assert.ok(!/^(\.\.\/)+index\.js$/.test(spec), `${path.basename(file)} imports ${spec}`);
    }
  }
});

test('a restart during a real lock loses the notice: the rows are already gone', async () => {
  const t = setup();
  t.bridge.start();
  await t.send(msg('10.1', 'one'));
  t.host.setLock(REAL);
  await t.bridge.stop();
  const again = t.make();
  again.start();
  t.host.setLock(OPEN);
  assert.equal(lockedLines(t).length, 0);
  await again.stop();
});
