import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { DAY, HOUR, setup, msg } from './messengers-outbox-fixtures.mjs';

// The outbox: stale edits of a pending row, edit bookkeeping on a failed write, and submitted ids at expiry.

const edited = (ts, editTs, body) => msg(ts, body, { messageId: `ev-edit-${ts}-${editTs}`, edit: { ts, editTs } });
const submittedIds = (t) => t.store.state('submittedIds', 'slack|C0') ?? [];

test('an older edit of a still-pending message does not replace a newer one', async () => {
  const t = setup();
  await t.send(msg('10.1', 'original'));
  assert.deepEqual(await t.send(edited('10.1', '12.0', 'newer')), { edited: 's1' });
  assert.deepEqual(await t.send(edited('10.1', '11.0', 'older')), { ignored: 'stale-edit' });
  assert.equal(t.row('10.1').body, 'newer');
  assert.deepEqual(await t.send(edited('10.1', '13.0', 'newest')), { edited: 's1' });
  await t.bridge.drain();
  assert.deepEqual(t.host.deliveries.map((d) => d.text), ['newest']);
});

test('a failed row write leaves editTs unchanged so the same edit can be retried', async () => {
  const t = setup();
  await t.send(msg('10.1', 'original'));
  await t.send(edited('10.1', '11.0', 'first'));
  fs.chmodSync(t.dir, 0o500);
  try {
    await assert.rejects(t.send(edited('10.1', '12.0', 'second')));
  } finally { fs.chmodSync(t.dir, 0o700); }
  assert.equal(t.row('10.1').body, 'first');
  assert.deepEqual(await t.send(edited('10.1', '12.0', 'second')), { edited: 's1' }, 'not refused as stale');
  assert.equal(t.row('10.1').body, 'second');
});

test('a row that expires mid-send and then returns submitted leaves no submitted id behind', async () => {
  const t = setup();
  let open;
  const wait = new Promise((r) => { open = r; });
  t.host.deliver = async () => { await wait; return { state: 'submitted', reason: 'input-not-confirmed' }; };
  await t.send(msg('10.1', 'hello'));
  const draining = t.bridge.drain();
  await new Promise((r) => setImmediate(r));
  t.clock.t += DAY + HOUR + 1;
  await t.bridge.drain();
  open();
  await draining;
  assert.deepEqual(t.files(), []);
  assert.deepEqual(submittedIds(t), []);
});

test('an expired submitted row keeps its submitted id until the settled id is written', async () => {
  const t = setup();
  t.host.outcome = () => ({ state: 'submitted', reason: 'input-not-confirmed' });
  await t.send(msg('10.1', 'hello'));
  await t.bridge.drain();
  assert.equal(submittedIds(t).length, 1);
  const real = t.store.patchState.bind(t.store);
  t.store.patchState = (patch) => {
    if ('settledIds' in patch) throw Object.assign(new Error('no space'), { code: 'ENOSPC' });
    return real(patch);
  };
  t.clock.t += DAY + 1;
  await t.bridge.drain();
  assert.equal(t.files().length, 1, 'the file stays while the settle fails');
  assert.equal(submittedIds(t).length, 1, 'a restart still sees the row as submitted');
  t.store.patchState = real;
  await t.bridge.drain();
  assert.deepEqual(t.files(), []);
  assert.deepEqual(submittedIds(t), []);
});
