import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { requestIdFor, editRequestIdFor } from '../src/messengers/replies.js';
import { PREAMBLE_HEAD } from '../src/messengers/outbox.js';
import { DAY, alice, setup, msg } from './messengers-outbox-fixtures.mjs';

// The outbox: readiness, edits and deletes, claims.

test('a redelivery that arrives while the first is still being persisted is not acked as a duplicate', async () => {
  const t = setup();
  fs.writeFileSync(t.dir, 'not a directory');
  const results = await Promise.allSettled([t.send(msg('10.1', 'hello')), t.send(msg('10.1', 'hello'))]);
  assert.deepEqual(results.map((r) => r.status), ['rejected', 'rejected']);
});

// ---- after a restart: the drain waits for the revive result ----

test('the first send of a session waits for host.ready; later rows do not wait again', async () => {
  const t = setup();
  let release;
  t.host.readyImpl = () => new Promise((r) => { release = () => r('sent'); });
  await t.send(msg('10.1', 'one'));
  await t.send(msg('10.2', 'two'));
  const draining = t.bridge.drain();
  await new Promise((r) => setImmediate(r));
  assert.equal(t.host.deliveries.length, 0, 'nothing is sent before ready resolves');
  release();
  await draining;
  assert.deepEqual(t.host.deliveries.map((d) => d.text), ['one', 'two']);
  await t.send(msg('10.3', 'three'));
  await t.bridge.drain();
  assert.deepEqual(t.host.readyCalls, ['s1'], 'asked once per session');
});

test('a gave-up result sends without waiting; the outbox never sends the continue text itself', async () => {
  const t = setup();
  t.host.readyImpl = async () => 'gave-up';
  await t.send(msg('10.1', 'one'));
  await t.bridge.drain();
  assert.deepEqual(t.host.deliveries.map((d) => d.text), ['one']);
  assert.ok(!t.host.deliveries.some((d) => d.text.startsWith('[Agent Manager:')));
});

test('a session whose ready() is stuck blocks neither another session nor expiry', async () => {
  const t = setup({ sessions: ['s1', 's2'] });
  t.host.readyImpl = (s) => (s.id === 's1' ? new Promise(() => {}) : Promise.resolve('skipped'));
  await t.send(msg('10.1', 'alpha: stuck'));
  await t.send(msg('10.2', 'beta: fine'));
  void t.bridge.drain();
  await new Promise((r) => setImmediate(r));
  await t.bridge.drain();
  assert.deepEqual(t.host.deliveries.map((d) => d.text), ['fine']);
  t.clock.t += DAY + 1;
  await t.bridge.drain();
  assert.deepEqual(t.files(), []);
  assert.ok(t.posts.some((p) => p.card.body === 'Not delivered — still waiting after 24h.'));
});

test('a submitted row is not sent after a restart', async () => {
  const t = setup();
  t.host.outcome = () => ({ state: 'submitted', reason: 'typed' });
  await t.send(msg('10.1', 'one'));
  await t.bridge.drain();
  const again = t.make({ fresh: true });
  await again.drain();
  await again.drain();
  assert.equal(t.host.deliveries.length, 1);
  assert.equal(t.files().length, 1, 'kept until its 24 hours are up');
});

// Edits and deletes of a Slack message (message_changed / message_deleted), as the adapter reports them.
const edited = (ts, editTs, body, extra = {}) => msg(ts, body, { messageId: `ev-edit-${ts}-${editTs}`, edit: { ts, editTs }, ...extra });
const deleted = (ts, extra = {}) => ({ channel: 'C0', ts, thread: null, user: alice, messageId: `ev-del-${ts}`, deleted: { ts }, ...extra });
const EDIT_HEAD = 'Edited in Slack (replaces the earlier message):\n';
const DELETED_LINE = 'The Slack message was deleted after it was sent to the agent.';

test('an edit of a pending message replaces the frozen text in the same row and keeps its id', async () => {
  const t = setup();
  await t.send(msg('10.1', 'old text'));
  const before = t.row('10.1');
  await t.send(edited('10.1', '11.0', 'new text'));
  const row = t.row('10.1');
  assert.equal(row.requestId, before.requestId);
  assert.equal(row.createdAt, before.createdAt);
  assert.equal(row.text, 'new text');
  assert.equal(row.body, 'new text');
  assert.equal(t.files().length, 1, 'no second row');
  await t.bridge.drain();
  assert.deepEqual(t.host.deliveries.map((d) => [d.text, d.requestId]), [['new text', before.requestId]]);
  assert.ok(!t.logs.some((e) => JSON.stringify(e).includes('new text')), 'the text is never logged');
});

test('an edit of a pending message recomputes the preamble exactly once', async () => {
  const t = setup();
  await t.send(msg('10.1', 'first'));
  await t.bridge.drain();
  t.host.src = 'src-2';
  await t.send(msg('20.1', 'second'));
  assert.ok(t.row('20.1').text.startsWith(PREAMBLE_HEAD), 'the first write carries the preamble');
  await t.send(edited('20.1', '21.0', 'second, fixed'));
  const { text } = t.row('20.1');
  assert.ok(text.startsWith(PREAMBLE_HEAD) && text.endsWith('\n\nsecond, fixed'));
  assert.equal(text.split(PREAMBLE_HEAD).length, 2);
});

test('an edit of a delivered message writes a row under the edit id and is not refused by the delivered ids', async () => {
  const t = setup();
  await t.send(msg('10.1', 'old text'));
  await t.bridge.drain();
  assert.deepEqual(t.files(), []);
  const result = await t.send(edited('10.1', '11.0', 'new text'));
  assert.deepEqual(result, { queued: 's1' });
  const id = editRequestIdFor('slack', 'C0', '10.1', '11.0');
  assert.notEqual(id, requestIdFor('slack', 'C0', '10.1'));
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/, 'a version 8 UUID');
  assert.deepEqual(t.files(), [`${id}.json`]);
  await t.bridge.drain();
  assert.equal(t.host.deliveries.at(-1).text, `${EDIT_HEAD}new text`);
  assert.equal(t.host.deliveries.at(-1).requestId, id);
  assert.deepEqual(await t.send(edited('10.1', '11.0', 'new text', { messageId: 'redelivered' })), { ignored: 'duplicate' }, 'the same edit twice is one edit');
  assert.deepEqual((await t.send(edited('10.1', '12.0', 'newer'))), { queued: 's1' }, 'a second edit has its own id');
});

test('an edit of a submitted message writes a new row and leaves the submitted file untouched', async () => {
  const t = setup();
  t.host.outcome = () => ({ state: 'submitted', reason: 'input-not-confirmed' });
  await t.send(msg('10.1', 'old text'));
  await t.bridge.drain();
  const file = path.join(t.dir, `${requestIdFor('slack', 'C0', '10.1')}.json`);
  const bytes = fs.readFileSync(file, 'utf8');
  assert.equal(JSON.parse(bytes).state, 'submitted');
  assert.deepEqual(await t.send(edited('10.1', '11.0', 'new text')), { queued: 's1' });
  assert.equal(fs.readFileSync(file, 'utf8'), bytes, 'the submitted row file is byte for byte the same');
  assert.equal(t.files().length, 2);
  t.host.outcome = () => ({ state: 'delivered' });
  await t.bridge.drain();
  assert.equal(t.host.deliveries.at(-1).text, `${EDIT_HEAD}new text`);
  assert.equal(fs.readFileSync(file, 'utf8'), bytes);
});

test('an edit of a message that was never accepted is ignored with a log line', async () => {
  const t = setup();
  assert.deepEqual(await t.send(edited('99.1', '100.0', 'secret rewrite')), { ignored: 'unknown-message' });
  assert.deepEqual(t.files(), []);
  assert.ok(t.logs.some((e) => e.event === 'edit-ignored'));
  assert.ok(!t.logs.some((e) => JSON.stringify(e).includes('secret rewrite')));
});

test('a deleted pending message is dropped and never sent', async () => {
  const t = setup();
  await t.send(msg('10.1', 'oops'));
  await t.send(deleted('10.1'));
  assert.deepEqual(t.files(), []);
  await t.bridge.drain();
  assert.deepEqual(t.host.deliveries, []);
  assert.ok(!t.posts.some((p) => p.card.body === DELETED_LINE), 'nothing was sent, so there is nothing to explain');
});

test('a delete after delivery or submission leaves the row and posts one line', async () => {
  const t = setup();
  await t.send(msg('10.1', 'sent'));
  await t.bridge.drain();
  await t.send(deleted('10.1'));
  assert.equal(t.posts.filter((p) => p.card.body === DELETED_LINE).length, 1);
  t.host.outcome = () => ({ state: 'submitted', reason: 'input-not-confirmed' });
  await t.send(msg('10.2', 'maybe sent'));
  await t.bridge.drain();
  await t.send(deleted('10.2'));
  assert.equal(t.files().length, 1, 'the submitted row stays');
  assert.equal(t.posts.filter((p) => p.card.body === DELETED_LINE).length, 2);
  assert.deepEqual(await t.send(deleted('55.5')), { ignored: 'unknown-message' });
});

test('the request id is claimed before the send and released when the send stays pending', async () => {
  const t = setup();
  const id = requestIdFor('slack', 'C0', '10.1');
  let during = null;
  t.host.deliver = async (s, { text, requestId }) => {
    during = t.store.state('deliveredIds', 'slack|C0');
    t.host.deliveries.push({ id: s.id, text, requestId });
    return { state: 'pending', reason: 'busy' };
  };
  await t.send(msg('10.1', 'hi'));
  await t.bridge.drain();
  assert.ok(during?.includes(id));
  assert.equal(t.store.state('deliveredIds', 'slack|C0'), null);
  assert.equal(t.files().length, 1);
});

test('a new pane launch waits for ready again', async () => {
  const t = setup();
  t.host.launch = 'run-1';
  t.host.runId = () => t.host.launch;
  await t.send(msg('10.1', 'a'));
  await t.bridge.drain();
  await t.send(msg('10.2', 'b'));
  await t.bridge.drain();
  assert.deepEqual(t.host.readyCalls, ['s1']);
  t.host.launch = 'run-2';
  await t.send(msg('10.3', 'c'));
  await t.bridge.drain();
  assert.deepEqual(t.host.readyCalls, ['s1', 's1']);
});

test('a prompt that is not ready yet stays pending', async () => {
  const t = setup();
  t.host.readyImpl = async () => { const e = new Error('prompt not ready'); e.code = 'prompt-not-ready'; throw e; };
  await t.send(msg('10.1', 'hi'));
  await t.bridge.drain();
  assert.equal(t.host.deliveries.length, 0);
  assert.equal(t.files().length, 1);
  assert.equal(t.row('10.1').state, 'pending');
  assert.equal(t.logs.some((e) => e.event === 'held' && e.reason === 'prompt-not-ready'), true);
  t.host.readyImpl = async () => 'sent';
  await t.bridge.drain();
  assert.equal(t.host.readyCalls.length, 2, 'the timed-out wait was not cached as ready');
  assert.equal(t.host.deliveries.length, 1);
});

test('an edit that arrives while the send is in flight stays unacked', async () => {
  const t = setup();
  let release;
  const gate = new Promise((r) => { release = r; });
  t.host.outcome = () => gate.then(() => ({ state: 'delivered' }));
  await t.send(msg('10.1', 'old'));
  const draining = t.bridge.drain();
  for (let i = 0; i < 20 && t.host.deliveries.length === 0; i++) await new Promise((r) => setImmediate(r));
  assert.equal(t.host.deliveries.length, 1);
  await assert.rejects(() => t.send(edited('10.1', '11.0', 'new')), (e) => e.persist === true);
  release();
  await draining;
  assert.equal((await t.send(edited('10.1', '11.0', 'new'))).queued, 's1');
});
