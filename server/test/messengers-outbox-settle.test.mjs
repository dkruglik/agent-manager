import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import fs from 'node:fs';
import { requestIdFor, editRequestIdFor } from '../src/messengers/replies.js';
import { DAY, setup, msg } from './messengers-outbox-fixtures.mjs';

// The outbox when its own bookkeeping or file deletes fail, and when a row changes while it waits.

const idOf = (ts) => requestIdFor('slack', 'C0', ts);
const edited = (ts, editTs, body) => msg(ts, body, { messageId: `ev-edit-${ts}-${editTs}`, edit: { ts, editTs } });
const deleted = (ts) => ({ channel: 'C0', ts, thread: null, user: { id: 'U1' }, messageId: `ev-del-${ts}`, deleted: { ts } });
const EDIT_HEAD = 'Edited in Slack (replaces the earlier message):\n';
const gate = () => { let open; const wait = new Promise((r) => { open = r; }); return { wait, open }; };

// Makes the writes of one state section fail once the send has started, like a store that ran out of space.
function breakStore(t, section) {
  const real = t.store.patchState.bind(t.store);
  const deliver = t.host.deliver.bind(t.host);
  let broken = false;
  t.host.deliver = async (...a) => { broken = true; return deliver(...a); };
  t.store.patchState = (patch) => {
    if (broken && section in patch) throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
    return real(patch);
  };
  return () => { t.store.patchState = real; };
}

test('a delivered-id write that fails after the send neither sends again nor loses the delivery record', async () => {
  const t = setup();
  const fix = breakStore(t, 'deliveredIds');
  await t.send(msg('10.1', 'hello'));
  await t.bridge.drain();
  await t.bridge.drain();
  await t.bridge.drain();
  assert.equal(t.host.deliveries.length, 1, 'sent once');
  fix();
  await t.bridge.drain();
  assert.equal(t.host.deliveries.length, 1);
  assert.deepEqual(t.files(), [], 'the row is gone');
  assert.equal(t.store.state('channelMarks', 'slack|C0'), '10.1', 'the delivery was recorded');
});

test('a failed submittedIds write after a submitted send is retried, and the text is not sent again', async () => {
  const t = setup();
  const fix = breakStore(t, 'submittedIds');
  await t.send(msg('10.1', 'hello'));
  t.host.outcome = () => ({ state: 'submitted', reason: 'typed' });
  await t.bridge.drain();
  await t.bridge.drain();
  assert.equal(t.host.deliveries.length, 1);
  assert.ok(t.store.state('deliveredIds', 'slack|C0').includes(idOf('10.1')), 'the claim is kept while the record is owed');
  fix();
  await t.bridge.drain();
  assert.equal(t.host.deliveries.length, 1);
  assert.ok(t.store.state('submittedIds', 'slack|C0').includes(idOf('10.1')), 'recorded as submitted');
  assert.equal(t.row('10.1').state, 'submitted');
  const again = t.make({ fresh: true });
  await again.drain();
  assert.equal(t.host.deliveries.length, 1, 'not after a restart either');
});

test('a row dropped without being delivered stays dropped when its file could not be deleted', async () => {
  const t = setup();
  t.host.outcome = () => ({ state: 'pending', reason: 'busy' });
  await t.send(msg('10.1', 'hello'));
  mock.method(fs, 'unlinkSync', (p, ...rest) => {
    if (String(p).endsWith(`${idOf('10.1')}.json`)) throw Object.assign(new Error('injected'), { code: 'EIO' });
    return fs.unlinkSync.mock.original(p, ...rest);
  });
  try {
    assert.deepEqual(await t.send(deleted('10.1')), { dropped: 1 });
    assert.equal(t.files().length, 1, 'the file is still there');
    const again = t.make({ fresh: true });
    t.host.outcome = () => ({ state: 'delivered' });
    await again.drain();
    assert.equal(t.host.deliveries.length, 0, 'a restart does not send what was deleted');
  } finally { mock.restoreAll(); }
  await t.bridge.drain();
  assert.deepEqual(t.files(), [], 'the delete is retried');
});

test('an edit while the row waits for ready replaces the text; a delete drops the row', async () => {
  const t = setup();
  const g = gate();
  t.host.readyImpl = () => g.wait;
  await t.send(msg('10.1', 'first'));
  await t.send(msg('10.2', 'second'));
  const draining = t.bridge.drain();
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(await t.send(edited('10.1', '11.0', 'first, fixed')), { edited: 's1' });
  assert.deepEqual(await t.send(deleted('10.2')), { dropped: 1 });
  g.open('skipped');
  await draining;
  await t.bridge.drain();
  assert.deepEqual(t.host.deliveries.map((d) => d.text), ['first, fixed']);
});

test('a second edit of a delivered message replaces the waiting edit row', async () => {
  const t = setup();
  await t.send(msg('10.1', 'one'));
  await t.bridge.drain();
  t.host.outcome = () => ({ state: 'pending', reason: 'busy' });
  assert.deepEqual(await t.send(edited('10.1', '11.0', 'two')), { queued: 's1' });
  assert.deepEqual(await t.send(edited('10.1', '12.0', 'three')), { edited: 's1' });
  assert.deepEqual(t.files(), [`${editRequestIdFor('slack', 'C0', '10.1', '11.0')}.json`]);
  t.host.outcome = () => ({ state: 'delivered' });
  await t.bridge.drain();
  assert.deepEqual(t.host.deliveries.map((d) => d.text), ['one', `${EDIT_HEAD}three`]);
});
