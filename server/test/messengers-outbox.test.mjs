import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { requestIdFor } from '../src/messengers/replies.js';
import { addDeliveredId, addSubmittedId, DELIVERED_IDS_MAX } from '../src/messengers/delivery-state.js';
import { DAY, alice, setup, msg, inThread } from './messengers-outbox-fixtures.mjs';

// The outbox: row files, duplicates, routing and expiry.

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

test('submittedIds are never evicted from the channel set', () => {
  let ids = [];
  for (let i = 0; i < DELIVERED_IDS_MAX + 5; i += 1) ids = addSubmittedId(ids, `id-${i}`);
  assert.equal(ids.length, DELIVERED_IDS_MAX + 5);
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

test('after a submitted row expires, a Slack redelivery with the same ts is ignored', async () => {
  const t = setup();
  t.host.outcome = () => ({ state: 'submitted', reason: 'typed' });
  await t.send(msg('10.1', 'hello'));
  await t.bridge.drain();
  assert.equal(t.host.deliveries.length, 1);
  t.store.patchState({ submittedIds: { 'slack|C0': [requestIdFor('slack', 'C0', '10.1')] } });
  t.clock.t += DAY + 1;
  await t.bridge.drain();
  assert.deepEqual(t.files(), []);
  const res = await t.send({ ...msg('10.1', 'hello'), messageId: 'redeliver-1' });
  assert.deepEqual(res, { ignored: 'duplicate' });
  await t.bridge.drain();
  assert.equal(t.host.deliveries.length, 1);
});

