import assert from 'node:assert/strict';
import test from 'node:test';
import { requestIdFor } from '../src/messengers/replies.js';
import { typed, user, setup, press, text } from './messengers-replies-fixtures.mjs';

function several({ allowedUsers = ['U1'], group = false } = {}) {
  const t = setup({ allowedUsers });
  const mk = (id, name) => ({ id, name, cli: 'codex', state: 'working', inputRequired: null });
  t.host.sessions = () => [mk('s1', 'alpha'), mk('s2', 'beta')];
  t.prompts = [];
  t.host.prompt = async (s, body) => { t.prompts.push({ id: s.id, body }); };
  const base = { adapter: 'slack', target: { channel: 'C0' }, events: [], allowedUsers, approvals: false, createdAt: 'x' };
  if (group) {
    t.store.removeBinding('b0');
    t.store.putBinding({ ...base, id: 'bg', scope: { type: 'group', id: 'g1' } });
    t.host.sessions = () => [{ ...mk('s1', 'alpha'), groupId: 'g1' }, { ...mk('s2', 'beta'), groupId: 'g1' }];
  } else {
    t.store.putBinding({ ...base, id: 'b1', scope: { type: 'session', id: 's2' } });
  }
  return t;
}

test('an unaddressed message in a channel with several agents is skipped silently', async () => {
  const t = several();
  const out = await t.bridge.handleReply('slack', text(1, 'run the tests'));
  assert.deepEqual(out, { refused: 'no-agent-named' });
  assert.equal(t.prompts.length, 0, 'sent to no agent');
  assert.equal(t.posts.length, 0, 'nothing is said in the channel');
  assert.equal(t.ephemerals.length, 1, 'the sender alone is told, once');
  const log = t.logs.find((e) => e.reason === 'no-agent-named');
  assert.ok(log && !JSON.stringify(log).includes('run the tests'), 'logged without the text');
});

test('a named agent gets the message and only that agent; an unknown name is skipped', async () => {
  const t = several();
  assert.deepEqual(await t.bridge.handleReply('slack', text(1, 'alpha: hi')), { queued: 's1' });
  assert.deepEqual(await t.bridge.handleReply('slack', text(2, '@beta hi')), { queued: 's2' });
  await t.bridge.drain();
  assert.deepEqual(t.prompts, [{ id: 's1', body: 'hi' }, { id: 's2', body: 'hi' }], 'each message reached one agent');
  const posted = t.posts.length;
  assert.deepEqual(await t.bridge.handleReply('slack', text(3, 'ghost: hi')), { refused: 'no-agent-named' });
  assert.equal(t.prompts.length, 2);
  assert.equal(t.posts.length, posted, 'the skipped message adds nothing to the channel');
});

test('a sender who is not allowed is skipped the same way', async () => {
  const t = several({ allowedUsers: ['U9'] });
  assert.deepEqual(await t.bridge.handleReply('slack', text(1, 'hello')), { refused: 'user-not-allowed' });
  assert.equal(t.posts.length, 0);
  assert.equal(t.prompts.length, 0);
  assert.ok(t.logs.some((e) => e.event === 'refused' && e.reason === 'user-not-allowed'));
});

test('a group binding covering two sessions skips an unaddressed message too', async () => {
  const t = several({ group: true });
  assert.deepEqual(await t.bridge.handleReply('slack', text(1, 'hello')), { refused: 'no-agent-named' });
  assert.equal(t.posts.length, 0);
  assert.equal(t.prompts.length, 0);
  assert.deepEqual(await t.bridge.handleReply('slack', text(2, 'beta: hello')), { queued: 's2' });
});

test('a session binding plus a group reaching another agent: unaddressed is skipped, named still goes', async () => {
  const t = several();
  t.store.removeBinding('b1');
  t.store.putBinding({ adapter: 'slack', target: { channel: 'C0' }, events: [], allowedUsers: ['U1'], approvals: false, createdAt: 'x', id: 'bg', scope: { type: 'group', id: 'g1' } });
  t.host.sessions = () => [{ id: 's1', name: 'alpha', cli: 'codex', state: 'working', inputRequired: null }, { id: 's2', name: 'beta', cli: 'codex', state: 'working', inputRequired: null, groupId: 'g1' }];
  assert.deepEqual(await t.bridge.handleReply('slack', text(1, 'hello')), { refused: 'no-agent-named' });
  assert.equal(t.prompts.length, 0, 'the one direct agent does not take it');
  assert.equal(t.posts.length, 0);
  assert.deepEqual(await t.bridge.handleReply('slack', text(2, 'beta: hello')), { queued: 's2' });
  assert.deepEqual(await t.bridge.handleReply('slack', text(3, 'alpha: hello')), { queued: 's1' });
});

test('a single session binding still takes an unaddressed message', async () => {
  const t = setup();
  const prompts = [];
  t.host.prompt = async (s, body) => { prompts.push(body); };
  assert.deepEqual(await t.bridge.handleReply('slack', text(1, 'alpha hello')), { queued: 's1' });
  await t.bridge.drain();
  assert.deepEqual(prompts, ['alpha hello']);
});

// The host takes a UUID as the request id (shared Codex rejects anything else), and the
// id must follow the Slack message (adapter, channel, ts), not the event that delivered it.
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

async function requestIdOf(t, event) {
  const seen = [];
  t.host.prompt = async (s, body, opts) => { seen.push(opts); };
  assert.deepEqual(await t.bridge.handleReply('slack', event), { queued: 's1' });
  await t.bridge.drain();
  assert.equal(seen.length, 1);
  return seen[0].requestId;
}

test('a Slack prompt passes the host a UUID request id', async () => {
  const t = setup();
  const id = await requestIdOf(t, { ...text(1, 'run the tests'), ts: '1700000000.000100' });
  assert.match(id, UUID);
});

test('the request id follows the message, not the delivering event', async () => {
  const t = setup();
  const msg = { channel: 'C0', ts: '1700000000.000100' };
  const first = await requestIdOf(t, { ...text(1, 'run the tests'), ...msg, messageId: 'Ev1' });
  const retried = await t.bridge.handleReply('slack', { ...text(1, 'run the tests'), ...msg, messageId: 'Ev2-retry' });
  assert.deepEqual(retried, { ignored: 'duplicate' }, 'the same message under another event id is refused by its request id, not delivered twice');

  const other = setup();
  assert.equal(await requestIdOf(other, { ...text(1, 'run the tests'), ...msg, messageId: 'Ev9' }), first, 'a fresh router agrees');

  const next = await requestIdOf(t, { ...text(3, 'run the tests'), channel: 'C0', ts: '1700000000.000200' });
  assert.notEqual(next, first, 'another message in the channel is another request');
});

test('the same ts in another channel is another request', async () => {
  const t = setup();
  t.store.putBinding({
    id: 'b2', adapter: 'slack', target: { channel: 'C1' }, scope: { type: 'session', id: 's1' },
    events: ['input-required'], allowedUsers: ['U1'], approvals: false, createdAt: 'x',
  });
  const ts = '1700000000.000100';
  const here = await requestIdOf(t, { ...text(1, 'hi'), channel: 'C0', ts });
  const there = await requestIdOf(t, { ...text(2, 'hi'), channel: 'C1', ts });
  assert.notEqual(there, here);
});

test('a message without ts is not prompted', async () => {
  const t = setup();
  const prompts = [];
  t.host.prompt = async (...a) => { prompts.push(a); };
  assert.deepEqual(await t.bridge.handleReply('slack', { ...text(1, 'hi'), ts: undefined }), { ignored: 'no-ts' });
  assert.equal(prompts.length, 0);
  assert.deepEqual(t.logs.filter((e) => e.reason === 'no-ts'), [{ event: 'refused', reason: 'no-ts', binding: 'b0', session: 's1' }]);
});

test('two replies in the same finished-card thread are two requests', async () => {
  const t = setup();
  t.store.putPosted('b0|s1|done1', {
    bindingId: 'b0', sessionId: 's1', key: 'done1', kind: 'finished', status: 'closed', adapter: 'slack',
    ref: { channel: 'C0', ts: 'card2' }, item: typed, partial: {},
  });
  const reply = (n, ts) => ({ ...text(n, 'next step'), thread: 'card2', ts });
  const a = await requestIdOf(t, reply(1, '1700000000.000100'));
  const b = await requestIdOf(t, reply(2, '1700000000.000200'));
  assert.match(a, UUID);
  assert.notEqual(b, a);
});

test('the prompted log carries the request id the host received', async () => {
  const t = setup();
  const id = await requestIdOf(t, { ...text(1, 'run the tests'), ts: '1700000000.000100' });
  const entry = t.logs.find((e) => e.event === 'prompted');
  assert.equal(entry.requestId, id);
  assert.ok(!JSON.stringify(t.logs).includes('run the tests'), 'no message text in the log');
});

test('deliver-failed carries the request id when sending a prompt failed', async () => {
  const t = setup();
  let sent;
  t.host.prompt = async (s, body, opts) => { sent = opts.requestId; throw new Error('boom'); };
  await t.bridge.handleReply('slack', { ...text(1, 'hi'), ts: '1700000000.000100' });
  await t.bridge.drain();
  assert.equal(t.logs.find((e) => e.event === 'deliver-failed').requestId, sent);
});

test('reply-failed has no request id when no prompt was sent', async () => {
  const t = setup();
  t.host.answer = async () => { throw new Error('boom'); };
  await t.bridge.handleReply('slack', press(1));
  const entry = t.logs.find((e) => e.event === 'reply-failed');
  assert.ok(entry);
  assert.ok(!('requestId' in entry));
});

test('the request id for a known message is fixed', () => {
  const id = requestIdFor('slack', 'C0', '1700000000.000100');
  assert.match(id, UUID);
  assert.equal(id.split('-')[2][0], '8', 'version 8');
  assert.equal(id, '50d10fd0-3547-846d-8167-1698d7e79833');
});

test('the same channel and ts under another adapter is another request id', () => {
  assert.notEqual(requestIdFor('other', 'C0', '1700000000.000100'), requestIdFor('slack', 'C0', '1700000000.000100'));
});
