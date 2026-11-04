import assert from 'node:assert/strict';
import test from 'node:test';
import { backfill } from '../src/messengers/backfill.js';
import { alice, bob, setup, msg } from './messengers-outbox-fixtures.mjs';

// A message that was refused, or dropped before it reached the agent, is settled: the history read on the
// next reconnect must not deliver it later, and must not repeat the notice the sender already got.

const LOCKED = { locked: true, reason: 'public-space' };
const OPEN = { locked: false, reason: null };
const fromHistory = (m) => ({ ...m, messageId: `C0:${m.ts}` }); // a history copy has no Slack event id

async function reconnect(t, ...messages) {
  t.store.patchState({ channelMarks: { 'slack|C0': '5.0' } });
  const adapter = { history: async () => messages.map(fromHistory), postEphemeral: async () => {} };
  const accept = (id, r) => t.bridge.handleReply(id, r);
  return backfill({ adapterId: 'slack', adapter, store: t.store, now: () => t.clock.t, accept, log: () => {} });
}

test('a message refused while locked is not delivered or answered again by the backfill after the unlock', async () => {
  const t = setup();
  t.host.isLocked = true;
  assert.deepEqual(await t.send(msg('10.1', 'hello')), { refused: 'locked' });
  assert.equal(t.posts.length, 1, 'the sender was told once');
  t.host.isLocked = false;
  await reconnect(t, msg('10.1', 'hello'));
  await t.bridge.drain();
  assert.deepEqual(t.files(), []);
  assert.equal(t.host.deliveries.length, 0);
  assert.equal(t.posts.length, 1, 'no second notice');
});

test('a row dropped by a lock landing is not delivered by the backfill after the unlock', async () => {
  const t = setup();
  await t.send(msg('10.1', 'hello'));
  t.host.isLocked = true;
  await t.bridge.outbox.noteLock(LOCKED);
  t.host.isLocked = false;
  await t.bridge.outbox.noteLock(OPEN);
  assert.equal(t.posts.length, 1, 'one line: not delivered (locked)');
  await reconnect(t, msg('10.1', 'hello'));
  await t.bridge.drain();
  assert.deepEqual(t.files(), []);
  assert.equal(t.host.deliveries.length, 0);
  assert.equal(t.posts.length, 1);
});

test('an unaddressed message that was skipped is not delivered once the channel has a single agent', async () => {
  const t = setup({ sessions: ['s1', 's2'] });
  assert.deepEqual(await t.send(msg('10.1', 'hello')), { refused: 'no-agent-named' });
  t.host.list = t.host.list.slice(0, 1);
  await reconnect(t, msg('10.1', 'hello'));
  assert.deepEqual(t.files(), []);
});

test('a message from a user who was not allowed is not delivered once they are', async () => {
  const t = setup();
  const sent = msg('10.1', 'hello', { user: bob });
  assert.deepEqual(await t.send(sent), { refused: 'user-not-allowed' });
  t.bind('b0', { allowedUsers: [alice.id, bob.id] });
  await reconnect(t, sent);
  assert.deepEqual(t.files(), []);
});

test('a row refused at delivery is settled: allowing the sender again does not bring it back', async () => {
  const t = setup();
  await t.send(msg('10.1', 'old'));
  t.bind('b0', { allowedUsers: [bob.id] });
  await t.bridge.drain();
  assert.deepEqual(t.files(), [], 'dropped at delivery');
  assert.equal(t.posts.length, 1, 'with one line');
  t.bind('b0', { allowedUsers: [alice.id] });
  await reconnect(t, msg('10.1', 'old'));
  await t.bridge.drain();
  assert.deepEqual(t.files(), []);
  assert.equal(t.host.deliveries.length, 0);
});
