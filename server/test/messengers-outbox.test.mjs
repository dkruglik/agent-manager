import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MessengerBridge } from '../src/messengers/bridge.js';
import { BindingStore } from '../src/messengers/store.js';
import { requestIdFor } from '../src/messengers/replies.js';
import { addDeliveredId, DELIVERED_IDS_MAX } from '../src/messengers/delivery-state.js';
import { createRow } from '../src/messengers/outbox-files.js';

// The outbox: a Slack prompt is a row file before it is acknowledged, and the
// drain delivers it later. A fake host and adapter stand in for the app and Slack.

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const alice = { id: 'U1', name: 'alice' };
const bob = { id: 'U2', name: 'bob' };

function setup({ allowedUsers = ['U1'], sessions = ['s1'], root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-messengers-outbox-')) } = {}) {
  const clock = { t: 1_000_000 };
  const now = () => clock.t;
  const store = new BindingStore(path.join(root, 'messengers.json'), { now });
  const names = { s1: 'alpha', s2: 'beta' };
  const host = {
    deliveries: [], isLocked: false, src: 'src-1', outcome: () => ({ state: 'delivered' }),
    list: sessions.map((id) => ({ id, name: names[id], cli: 'claude', state: 'working', inputRequired: null })),
    sessions: () => host.list.map((s) => ({ ...s })),
    groupOf: () => ({ id: 'g1', name: 'proj' }),
    locked: () => host.isLocked, lockState: () => ({ locked: host.isLocked, reason: host.isLocked ? 'public-space' : null }), onLock: () => () => {}, lockScope: () => ({ signal: new AbortController().signal, release() {} }), link: () => null, sourceKey: () => host.src,
    requests: async () => [], digest: async () => null, answer: async () => {},
    async deliver(s, { text, requestId }) {
      host.deliveries.push({ id: s.id, text, requestId });
      return host.outcome(s, host.deliveries.length);
    },
  };
  const posts = [];
  const slack = {
    configured: () => true, start(h) { h.onStatus({ connected: true, error: null }); },
    async post(target, card) { const ref = { channel: target.channel, ts: `t${posts.length + 1}` }; posts.push({ target, card, ref }); return ref; },
    async update() {}, async postEphemeral() {},
  };
  const logs = [];
  // `fresh` reads messengers.json again, like a restarted process.
  const make = ({ fresh = false } = {}) => {
    const st = fresh ? new BindingStore(path.join(root, 'messengers.json'), { now }) : store;
    const bridge = new MessengerBridge({ host, store: st, adapters: new Map([['slack', slack]]), now, dataDir: root, log: (e) => logs.push(e), tickMs: 1e9, settleMs: 0, digestEveryMs: 0 });
    bridge.statuses.set('slack', { connected: true, error: null });
    return bridge;
  };
  const bridge = make();
  const bind = (id, extra = {}) => store.putBinding({
    id, adapter: 'slack', target: { channel: 'C0' }, scope: { type: 'group', id: 'g1' },
    events: ['input-required'], allowedUsers, approvals: false, createdAt: 'x', ...extra,
  });
  bind('b0');
  const dir = path.join(root, 'messenger-outbox');
  const files = () => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : []);
  const row = (ts) => JSON.parse(fs.readFileSync(path.join(dir, `${requestIdFor('slack', 'C0', ts)}.json`), 'utf8'));
  return { root, clock, store, host, slack, posts, logs, bridge, make, bind, dir, files, row, send: (r) => bridge.handleReply('slack', r) };
}

const msg = (ts, body, extra = {}) => ({ channel: 'C0', ts, thread: null, user: alice, messageId: `m${ts}`, text: body, ...extra });
const inThread = (thread, ts, body, extra = {}) => msg(ts, body, { thread, ...extra });

test('a row is a 0600 file in a 0700 directory with the frozen fields', async () => {
  const t = setup();
  assert.deepEqual(await t.send(msg('10.1', 'run the tests')), { queued: 's1' }, 'accepted, not yet delivered');
  assert.equal(t.host.deliveries.length, 0, 'delivery waits for the drain');
  assert.equal(fs.statSync(t.dir).mode & 0o777, 0o700);
  const file = path.join(t.dir, `${requestIdFor('slack', 'C0', '10.1')}.json`);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(t.files(), [`${requestIdFor('slack', 'C0', '10.1')}.json`]);
  const row = t.row('10.1');
  assert.deepEqual(
    { ...row, createdAt: typeof row.createdAt },
    {
      requestId: requestIdFor('slack', 'C0', '10.1'), adapter: 'slack', channel: 'C0', ts: '10.1', thread: null, topLevel: true,
      sessionId: 's1', bindingId: 'b0', user: alice, text: 'run the tests', body: 'run the tests', via: 'only', state: 'pending', createdAt: 'number',
    },
  );
  assert.ok(!t.logs.some((e) => JSON.stringify(e).includes('run the tests')), 'the text is never logged');
});

test('a symlink planted at a row path is not followed, and the event is not accepted', async () => {
  const t = setup();
  const victim = path.join(t.root, 'victim.txt');
  fs.writeFileSync(victim, 'keep');
  fs.mkdirSync(t.dir, { recursive: true, mode: 0o700 });
  fs.symlinkSync(victim, path.join(t.dir, `${requestIdFor('slack', 'C0', '10.1')}.json`));
  await assert.rejects(t.send(msg('10.1', 'hello')));
  assert.equal(fs.readFileSync(victim, 'utf8'), 'keep');
  // The rows are read with O_NOFOLLOW too: a planted link is skipped at startup, not read.
  const opened = [];
  const real = fs.openSync;
  mock.method(fs, 'openSync', (p, flags, ...rest) => { opened.push([String(p), flags]); return real(p, flags, ...rest); });
  t.make();
  mock.restoreAll();
  const link = opened.find(([p]) => p.endsWith(`${requestIdFor('slack', 'C0', '10.1')}.json`));
  assert.ok(link, 'the planted file was looked at');
  assert.ok(link[1] & fs.constants.O_NOFOLLOW, 'opened with O_NOFOLLOW');
  assert.ok(fs.lstatSync(path.join(t.dir, `${requestIdFor('slack', 'C0', '10.1')}.json`)).isSymbolicLink(), 'and left alone');
});

test('a write opens its file with O_NOFOLLOW and O_EXCL', async () => {
  const t = setup();
  const opened = [];
  const real = fs.openSync;
  mock.method(fs, 'openSync', (p, flags, ...rest) => { opened.push([String(p), flags]); return real(p, flags, ...rest); });
  await t.send(msg('10.1', 'hello'));
  mock.restoreAll();
  const w = opened.find(([p, f]) => p.includes('messenger-outbox') && p.endsWith('.json') && typeof f === 'number' && (f & fs.constants.O_CREAT));
  assert.ok(w, 'the row file was created');
  assert.ok(w[1] & fs.constants.O_NOFOLLOW);
  assert.ok(w[1] & fs.constants.O_EXCL);
});

test('startup loads the directory once into an index; a tick does not list it again', async () => {
  const t = setup();
  await t.send(msg('10.1', 'first'));
  t.host.outcome = () => ({ state: 'pending', reason: 'busy' });
  const reads = [];
  const real = fs.readdirSync;
  mock.method(fs, 'readdirSync', (p, ...rest) => { reads.push(String(p)); return real(p, ...rest); });
  const bridge = t.make();
  const onDir = () => reads.filter((p) => p.endsWith('messenger-outbox')).length;
  assert.equal(onDir(), 1, 'listed once at construction');
  await bridge.drain();
  await bridge.tick();
  await bridge.drain();
  mock.restoreAll();
  assert.equal(onDir(), 1, 'no listing on a tick');
  assert.equal(t.host.deliveries.length, 2, 'the loaded row is delivered (retried) by the new bridge');
  assert.equal(t.host.deliveries[0].text, 'first');
});

test('a malformed row file is skipped with one log line and kept', async () => {
  const t = setup();
  fs.mkdirSync(t.dir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(t.dir, 'junk.json'), '{not json', { mode: 0o600 });
  fs.writeFileSync(path.join(t.dir, 'odd.json'), JSON.stringify({ requestId: 'odd', text: 5 }), { mode: 0o600 });
  const bridge = t.make();
  assert.equal(t.logs.filter((e) => e.event === 'row-malformed').length, 2, 'one line per bad file');
  await bridge.drain();
  assert.equal(t.host.deliveries.length, 0);
  assert.deepEqual(fs.readdirSync(t.dir).sort(), ['junk.json', 'odd.json'], 'neither deleted');
});

test('a failed write is not accepted and the same event can be retried', async () => {
  const t = setup();
  fs.mkdirSync(t.root, { recursive: true });
  fs.writeFileSync(t.dir, 'not a directory');
  await assert.rejects(t.send(msg('10.1', 'hello')));
  fs.rmSync(t.dir);
  assert.deepEqual(await t.send(msg('10.1', 'hello')), { queued: 's1' }, 'the redelivered event is not mistaken for a duplicate');
  assert.equal(t.files().length, 1);
});

test('after delivery the row is gone and the records stay', async () => {
  const t = setup();
  await t.send(msg('10.1', 'first'));
  await t.send(msg('10.2', 'second'));
  await t.send(msg('10.3', 'third'));
  await t.send(msg('10.4', 'fourth'));
  await t.bridge.drain();
  assert.deepEqual(t.files(), []);
  assert.deepEqual(t.host.deliveries.map((d) => d.text), ['first', 'second', 'third', 'fourth'], 'in ts order');
  assert.equal(t.store.state('channelMarks', 'slack|C0'), '10.4');
  assert.deepEqual(t.store.state('deliveredTs', 'slack|C0').map((e) => e.ts), ['10.1', '10.2', '10.3', '10.4']);
  assert.deepEqual(t.store.state('recent', 'slack|C0|s1'), { lastSrc: 'src-1', texts: ['second', 'third', 'fourth'] });
  const ids = t.store.state('deliveredIds', 'slack|C0');
  assert.deepEqual(ids, ['10.1', '10.2', '10.3', '10.4'].map((ts) => requestIdFor('slack', 'C0', ts)));
  assert.ok(t.posts.some((p) => p.target.thread === null && p.card.kind === 'root'), 'the top-level message was quoted into a root');
  assert.ok(t.logs.some((e) => e.event === 'prompted' && e.requestId === requestIdFor('slack', 'C0', '10.1')));
});

test('a retry of a delivered or waiting request id writes no row', async () => {
  const t = setup();
  await t.send(msg('10.1', 'hello'));
  assert.deepEqual(await t.send(msg('10.1', 'hello', { messageId: 'other-event' })), { ignored: 'duplicate' }, 'row exists');
  await t.bridge.drain();
  assert.deepEqual(t.files(), []);
  assert.deepEqual(await t.send(msg('10.1', 'hello', { messageId: 'third-event' })), { ignored: 'duplicate' }, 'already delivered');
  assert.deepEqual(t.files(), []);
  assert.equal(t.host.deliveries.length, 1);
  assert.equal(t.logs.filter((e) => e.event === 'duplicate').length, 2);
  // A fresh process remembers the delivered ids too.
  const again = t.make();
  assert.deepEqual(await again.handleReply('slack', msg('10.1', 'hello', { messageId: 'fourth-event' })), { ignored: 'duplicate' });
});

test('the delivered-id set keeps the newest 500', () => {
  let ids = [];
  for (let i = 0; i < DELIVERED_IDS_MAX + 5; i += 1) ids = addDeliveredId(ids, `id${i}`);
  assert.equal(ids.length, 500);
  assert.equal(ids[0], 'id5');
  assert.equal(ids.at(-1), 'id504');
  assert.equal(addDeliveredId(['a', 'b'], 'a').length, 2, 'no repeats');
});

test('a reply under a still-waiting top-level message routes to its session', async () => {
  const t = setup({ sessions: ['s1', 's2'] });
  t.host.outcome = () => ({ state: 'pending', reason: 'busy' });
  assert.deepEqual(await t.send(msg('10.1', '@beta first')), { queued: 's2' });
  assert.deepEqual(await t.send(inThread('10.1', '10.2', 'and this')), { queued: 's2' }, 'rule 1: the live outbox index');
  await t.bridge.drain();
  t.host.outcome = () => ({ state: 'submitted', reason: 'typed' });
  const out = await t.send(inThread('10.1', '10.3', 'still routes while submitted'));
  assert.deepEqual(out, { queued: 's2' });
});

test('pending is dropped after 24 hours with one line and is never sent again', async () => {
  const t = setup();
  t.host.outcome = () => ({ state: 'pending', reason: 'busy' });
  await t.send(msg('10.1', 'hello'));
  await t.bridge.drain();
  await t.bridge.drain();
  assert.equal(t.host.deliveries.length, 2, 'retried every drain');
  t.clock.t += DAY - 1;
  await t.bridge.drain();
  assert.equal(t.host.deliveries.length, 3);
  t.clock.t += 2;
  await t.bridge.drain();
  await t.bridge.drain();
  assert.equal(t.host.deliveries.length, 3, 'not sent on day two');
  assert.deepEqual(t.files(), []);
  const lines = t.posts.filter((p) => p.card.body === 'Not delivered — still waiting after 24h.');
  assert.equal(lines.length, 1);
  assert.equal(lines[0].target.thread, '10.1', 'in the message thread');
});

test('submitted is never sent again and drops silently after 24 hours', async () => {
  const t = setup();
  t.host.outcome = () => ({ state: 'submitted', reason: 'typed' });
  await t.send(msg('10.1', 'hello'));
  await t.bridge.drain();
  assert.equal(t.row('10.1').state, 'submitted', 'rewritten on disk');
  await t.bridge.drain();
  await t.bridge.tick();
  assert.equal(t.host.deliveries.length, 1);
  assert.equal(t.files().length, 1);
  const before = t.posts.length;
  t.clock.t += DAY + 1;
  await t.bridge.drain();
  assert.deepEqual(t.files(), []);
  assert.equal(t.posts.length, before, 'nothing posted');
  assert.equal(t.logs.filter((e) => e.event === 'expired').length, 1);
  assert.equal(t.host.deliveries.length, 1);
  assert.equal(t.store.state('deliveredIds', 'slack|C0'), null, 'a submitted row is not delivered');
});

test('a rejected deliver is pending with reason error; locked holds the row', async () => {
  const t = setup();
  t.host.outcome = () => { throw new Error('boom'); };
  await t.send(msg('10.1', 'hello'));
  await t.bridge.drain();
  assert.equal(t.files().length, 1);
  assert.equal(t.row('10.1').state, 'pending');
  t.host.outcome = () => ({ state: 'delivered' });
  t.host.isLocked = true;
  await t.bridge.drain();
  assert.equal(t.host.deliveries.length, 1, 'locked: not tried');
  assert.equal(t.files().length, 1);
  t.host.isLocked = false;
  await t.bridge.drain();
  assert.deepEqual(t.files(), []);
});

test('a source change attaches the stored texts as a preamble, frozen across retries', async () => {
  const t = setup();
  await t.send(msg('10.1', 'one'));
  await t.send(msg('10.2', 'two\nlines'));
  for (let i = 0; i < 2; i += 1) await t.bridge.drain();
  assert.deepEqual(t.host.deliveries.map((d) => d.text), ['one', 'two\nlines'], 'same source: no preamble');
  t.host.src = 'src-2';
  t.host.outcome = (s, n) => (n === 3 ? { state: 'pending', reason: 'busy' } : { state: 'delivered' });
  await t.send(msg('10.3', 'three'));
  assert.equal(t.row('10.3').text, 'Earlier messages from Slack (the conversation restarted since):\n> one\n> two\n> lines\n\nthree');
  await t.bridge.drain();
  t.host.src = 'src-3'; // a later change does not rebuild it
  await t.bridge.drain();
  const [first, retry] = t.host.deliveries.slice(2);
  assert.equal(first.text, retry.text, 'identical bytes');
  assert.equal(first.requestId, retry.requestId);
  assert.deepEqual(t.store.state('recent', 'slack|C0|s1'), { lastSrc: 'src-3', texts: ['one', 'two\nlines', 'three'] }, 'the stored text is the Slack text, not the preamble');
});

test('no preamble without a stored source, and with the user id prefix when several users may write', async () => {
  const t = setup({ allowedUsers: ['U1', 'U2'] });
  await t.send(msg('10.1', 'one'));
  assert.equal(t.row('10.1').text, 'Slack user U1: one', 'first message: nothing stored, so no preamble');
  assert.ok(!t.row('10.1').text.startsWith('[Agent Manager:'));
  await t.bridge.drain();
  t.host.src = 'src-2';
  await t.send(msg('10.2', 'two', { user: bob }));
  assert.equal(t.row('10.2').text, 'Earlier messages from Slack (the conversation restarted since):\n> one\n\nSlack user U2: two');
  const solo = setup();
  await solo.send(msg('10.1', 'plain'));
  assert.equal(solo.row('10.1').text, 'plain');
});

test('removing the only binding that reaches a session deletes its rows; a second binding keeps them', async () => {
  const t = setup();
  t.host.outcome = () => ({ state: 'pending', reason: 'busy' });
  await t.send(msg('10.1', 'hello'));
  t.bind('b1', { scope: { type: 'session', id: 's1' } });
  const b0 = t.store.binding('b0');
  t.store.removeBinding('b0');
  t.bridge.threads.forget(b0);
  assert.equal(t.files().length, 1, 'b1 still reaches s1');
  const b1 = t.store.binding('b1');
  t.store.removeBinding('b1');
  t.bridge.threads.forget(b1);
  assert.deepEqual(t.files(), []);
  await t.bridge.drain();
  assert.equal(t.host.deliveries.length, 0);
});

test('a row whose sender lost permission is dropped at delivery with one line', async () => {
  const t = setup();
  await t.send(msg('10.1', 'hello'));
  t.bind('b0', { allowedUsers: ['U9'] });
  await t.bridge.drain();
  assert.equal(t.host.deliveries.length, 0);
  assert.deepEqual(t.files(), []);
  const line = t.posts.filter((p) => /^Not delivered — /.test(p.card.body || ''));
  assert.equal(line.length, 1);
  assert.equal(line[0].target.thread, '10.1');
  assert.ok(t.logs.some((e) => e.event === 'refused' && e.reason === 'user-not-allowed'));
});

test('a pending row holds back the later rows of its session only', async () => {
  const t = setup({ sessions: ['s1', 's2'] });
  t.host.outcome = (s) => (s.id === 's1' ? { state: 'pending', reason: 'busy' } : { state: 'delivered' });
  await t.send(msg('10.1', 'alpha: a1'));
  await t.send(msg('10.2', 'alpha: a2'));
  await t.send(msg('10.3', 'beta: b1'));
  await t.bridge.drain();
  assert.deepEqual(t.host.deliveries.map((d) => d.text), ['a1', 'b1'], 'a2 waits behind a1');
});

// ---- review fixes ----

const idOf = (ts) => requestIdFor('slack', 'C0', ts);
const failOnce = (name, match) => {
  const real = fs[name];
  let hit = false;
  mock.method(fs, name, (...a) => {
    if (!hit && match(...a)) { hit = true; throw Object.assign(new Error('injected'), { code: 'EIO' }); }
    return real(...a);
  });
};

test('a delivered message is never re-sent after a restart, even when its row could not be deleted', async () => {
  const t = setup();
  await t.send(msg('10.1', 'hello'));
  failOnce('unlinkSync', (p) => String(p).endsWith(`${idOf('10.1')}.json`));
  await t.bridge.drain();
  mock.restoreAll();
  assert.equal(t.host.deliveries.length, 1);
  assert.equal(t.files().length, 1, 'the delete failed');
  const again = t.make({ fresh: true });
  await again.drain();
  assert.equal(t.host.deliveries.length, 1, 'not sent again');
  assert.deepEqual(t.files(), [], 'the leftover file is removed');
  assert.ok(t.logs.some((e) => e.event === 'already-delivered' && e.requestId === idOf('10.1')));
});

test('a crash between recording the id and deleting the row does not send it again', async () => {
  const t = setup();
  await t.send(msg('10.1', 'hello'));
  t.store.patchState({ deliveredIds: { 'slack|C0': [idOf('10.1')] } });
  const again = t.make({ fresh: true });
  await again.drain();
  assert.equal(t.host.deliveries.length, 0);
  assert.deepEqual(t.files(), []);
});

test('the id is checked again right before a send', async () => {
  const t = setup();
  await t.send(msg('10.1', 'hello'));
  t.store.patchState({ deliveredIds: { 'slack|C0': [idOf('10.1')] } });
  await t.bridge.drain();
  assert.equal(t.host.deliveries.length, 0);
  assert.deepEqual(t.files(), []);
});

test('a submitted row whose rewrite failed is not sent after a restart, and expires', async () => {
  const t = setup();
  t.host.outcome = () => ({ state: 'submitted', reason: 'typed' });
  await t.send(msg('10.1', 'hello'));
  failOnce('renameSync', (a) => String(a).includes(idOf('10.1')));
  await t.bridge.drain();
  assert.equal(t.row('10.1').state, 'pending', 'the file still says pending');
  const again = t.make({ fresh: true });
  await again.drain();
  assert.equal(t.host.deliveries.length, 1, 'not sent again');
  mock.restoreAll();
  await again.drain();
  assert.equal(t.row('10.1').state, 'submitted', 'the rewrite is retried on a later tick');
  const before = t.posts.length;
  t.clock.t += DAY + 1;
  await again.drain();
  assert.deepEqual(t.files(), []);
  assert.equal(t.posts.length, before, 'expires silently');
  assert.equal(t.host.deliveries.length, 1);
});

test('a write that fails after the file was created removes it, so a redelivery can write it', async () => {
  const t = setup();
  failOnce('fsyncSync', () => true);
  await assert.rejects(t.send(msg('10.1', 'hello')));
  mock.restoreAll();
  assert.deepEqual(t.files(), [], 'no half-written row is left');
  assert.deepEqual(await t.send(msg('10.1', 'hello')), { queued: 's1' });
  assert.equal(t.files().length, 1);
});

test('a stuck session does not stop the others, and its expiry still runs', async () => {
  const t = setup({ sessions: ['s1', 's2'] });
  t.host.outcome = (s) => (s.id === 's1' ? new Promise(() => {}) : { state: 'delivered' });
  await t.send(msg('10.1', 'alpha: stuck'));
  const stuck = t.bridge.drain();
  await new Promise((r) => setImmediate(r));
  await t.send(msg('10.2', 'beta: fine'));
  await t.bridge.drain();
  assert.deepEqual(t.host.deliveries.map((d) => d.text), ['stuck', 'fine']);
  await t.bridge.drain();
  assert.equal(t.host.deliveries.filter((d) => d.id === 's1').length, 1, 'a session already sending is skipped');
  t.clock.t += DAY + 1;
  await t.bridge.drain();
  assert.deepEqual(t.files(), []);
  assert.ok(t.posts.some((p) => p.card.body === 'Not delivered — still waiting after 24h.'));
  assert.ok(stuck);
});

test('deliver-failed logs a code or name, never the error message', async () => {
  const t = setup();
  t.host.outcome = () => { throw Object.assign(new Error('disk full at /home/op/.am/data'), { code: 'ENOSPC' }); };
  await t.send(msg('10.1', 'hello'));
  await t.bridge.drain();
  assert.equal(t.logs.find((e) => e.event === 'deliver-failed').error, 'ENOSPC');
  assert.ok(!JSON.stringify(t.logs).includes('/home/op'));
});

test('only the first of several waiting rows carries the preamble', async () => {
  const t = setup();
  await t.send(msg('10.1', 'one'));
  await t.bridge.drain();
  t.host.src = 'src-2';
  t.host.outcome = () => ({ state: 'pending', reason: 'busy' });
  await t.send(msg('10.2', 'two'));
  await t.send(msg('10.3', 'three'));
  assert.ok(t.row('10.2').text.startsWith('Earlier messages from Slack'));
  assert.equal(t.row('10.3').text, 'three');
});

test('row ids must be UUIDs, so a name cannot leave the directory', () => {
  const t = setup();
  assert.throws(() => createRow(t.dir, { requestId: '../evil', text: 'x' }), /request id/);
});

test('a symlinked outbox directory disables writes; a loose one is tightened; leftover temp files go', async () => {
  const t = setup();
  const real = path.join(t.root, 'elsewhere');
  fs.mkdirSync(real);
  fs.symlinkSync(real, t.dir);
  const bridge = t.make();
  await assert.rejects(bridge.handleReply('slack', msg('10.1', 'hello')));
  assert.deepEqual(fs.readdirSync(real), [], 'nothing written through the link');
  assert.ok(t.logs.some((e) => e.event === 'outbox-unsafe'));
  fs.rmSync(t.dir);
  fs.mkdirSync(t.dir, { mode: 0o755 });
  fs.chmodSync(t.dir, 0o755);
  fs.writeFileSync(path.join(t.dir, `${idOf('10.9')}.json.abc.tmp`), 'x');
  t.make();
  assert.equal(fs.statSync(t.dir).mode & 0o777, 0o700);
  assert.deepEqual(fs.readdirSync(t.dir), [], 'the temp file is gone');
});

test('a redelivery that arrives while the first is still being persisted is not acked as a duplicate', async () => {
  const t = setup();
  fs.writeFileSync(t.dir, 'not a directory');
  const results = await Promise.allSettled([t.send(msg('10.1', 'hello')), t.send(msg('10.1', 'hello'))]);
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected']);
});
