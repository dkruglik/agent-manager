import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { requestIdFor } from '../src/messengers/replies.js';
import { createRow } from '../src/messengers/outbox-files.js';
import { DAY, HOUR, bob, setup, msg } from './messengers-outbox-fixtures.mjs';

// The outbox: delivery outcomes, restarts, permissions and ordering.

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
  assert.equal(t.files().length, 1, 'a row inside deliver is not expired at its day: its bytes may be going out');
  t.clock.t += HOUR;
  await t.bridge.drain();
  assert.deepEqual(t.files(), [], 'a send hung past the grace hour is expired');
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

