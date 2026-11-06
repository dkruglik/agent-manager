import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { BindingStore } from '../src/messengers/store.js';
import { ApiError } from '../src/api-errors.js';
import { typed, user, setup, press, text } from './messengers-replies-fixtures.mjs';

test('internal error text stays out of chat; user-facing errors are shown', async () => {
  const t = setup();
  t.host.answer = async () => { throw Object.assign(new Error('ECONNREFUSED /home/op/.codex/app-server.sock'), { code: 'ECONNREFUSED' }); };
  const out = await t.bridge.handleReply('slack', press(1));
  assert.ok(out.error);
  assert.equal(t.posts.at(-1).card.body, '⚠️ Could not deliver that — see the server log.');
  assert.equal(t.logs.find((e) => e.event === 'reply-failed').error, 'ECONNREFUSED', 'the code is logged (rule 13)');
  assert.ok(!JSON.stringify(t.logs).includes('/home/op'), 'not the message, which can quote terminal text');

  // A prompt is delivered by the drain after the ack: its errors are held for retry and logged, never shown in chat.
  t.host.prompt = async () => { throw new ApiError(409, 'busy', 'disk full at /home/op/.am/data'); };
  const posted = t.posts.length;
  await t.bridge.handleReply('slack', text(2, 'alpha: hello'));
  await t.bridge.drain();
  assert.equal(t.posts.length, posted, 'nothing about the failed delivery is posted');
  assert.equal(t.logs.find((e) => e.event === 'deliver-failed').error, 'busy', 'the code, not the message');
  assert.ok(!JSON.stringify(t.logs.filter((e) => e.event === 'deliver-failed')).includes('/home/op'), 'no error message text is logged');

  t.bridge.store.putPosted('b0|s1|gone', { ...t.store.posted('b0|s1|req1'), key: 'gone', ref: { channel: 'C0', ts: 'card2' }, item: { ...typed, key: 'gone', source: 'hook' } });
  await t.bridge.handleReply('slack', { ...press(3), ts: 'card2' });
  assert.match(t.posts.at(-1).card.body, /no longer waiting — answer in the terminal/, 'a hook item nobody waits for is refused, whatever its key');
});

test('a typed request whose key happens to start with hook: is still answered by the session', async () => {
  const t = setup();
  t.host.answer = async (...a) => { t.host.answers.push(a); };
  t.bridge.store.putPosted('b0|s1|hook:x', { ...t.store.posted('b0|s1|req1'), key: 'hook:x', ref: { channel: 'C0', ts: 'card3' }, item: { ...typed, key: 'hook:x' } });
  assert.deepEqual(await t.bridge.handleReply('slack', { ...press(5), ts: 'card3' }), { answered: 'hook:x' });
  assert.deepEqual(t.host.answers.map(([s, key, response]) => [s.id, key, response]), [['s1', 'hook:x', { decision: 'accept' }]]);
});

test('a notice that cannot be posted is logged, not lost silently', async () => {
  const t = setup({ allowedUsers: ['U1'] });
  t.slack.failPosts = true;
  const out = await t.bridge.handleReply('slack', press(1, 'd:accept', { id: 'U9', name: 'mallory' }));
  assert.deepEqual(out, { refused: 'user-not-allowed' });
  const failed = t.logs.find((e) => e.event === 'notice-failed');
  assert.deepEqual([failed.adapter, failed.channel, failed.error], ['slack', 'C0', 'Error'], 'the error name is logged, not its message');
});

test('every refusal is logged once, without the message text', async () => {
  const closed = setup();
  closed.store.putPosted('b0|s1|req1', { ...closed.store.posted('b0|s1|req1'), status: 'closed' });
  await closed.bridge.handleReply('slack', press(1));
  const off = setup({ approvals: false });
  await off.bridge.handleReply('slack', press(2));
  const locked = setup();
  locked.host.isLocked = true;
  await locked.bridge.handleReply('slack', press(3));
  const gone = setup();
  gone.host.gone = true;
  await gone.bridge.handleReply('slack', text(4, 'secret words'));
  const tooLong = setup();
  tooLong.store.putPosted('b0|s1|req1', { ...tooLong.store.posted('b0|s1|req1'), item: { ...typed, details: 'x'.repeat(2000) } });
  await tooLong.bridge.handleReply('slack', press(5));
  const reasons = [closed, off, locked, gone, tooLong].map((t) => t.logs.filter((e) => e.event === 'refused').map((e) => e.reason));
  assert.deepEqual(reasons, [['closed'], ['approvals-off'], ['locked'], ['no-session'], ['too-long']]);
  assert.ok(!JSON.stringify(gone.logs).includes('secret words'));
});

test('a closed input card keeps no tool input on disk but is still closed with its details', async () => {
  const t = setup();
  const item = { ...typed, toolInput: { command: 'ls' } };
  t.store.putPosted('b0|s1|req1', { ...t.store.posted('b0|s1|req1'), item });
  const updates = [];
  t.slack.update = async (ref, card) => { updates.push(card); };
  await t.bridge.handleReply('slack', press(1));
  const closed = t.store.posted('b0|s1|req1');
  assert.equal(closed.status, 'closed');
  assert.equal('details' in closed.item, false);
  assert.equal('toolInput' in closed.item, false);
  assert.equal(closed.item.kind, 'permission');
  assert.ok(!fs.readFileSync(path.join(t.root, 'messengers.json'), 'utf8').includes('"ls"'));
  assert.equal(updates.at(-1).details, typed.details, 'the closed card in chat still shows what was decided');
  assert.match(updates.at(-1).resolved.text, /Approve once/);
});

test('two presses together answer a typed card once', async () => {
  const t = setup();
  const release = Promise.withResolvers();
  t.host.answer = async (...a) => { t.host.answers.push(a); await release.promise; };
  const first = t.bridge.handleReply('slack', press(1, 'd:accept'));
  const second = t.bridge.handleReply('slack', press(2, 'd:decline', { id: 'U1', name: 'bob' }));
  await new Promise((r) => setImmediate(r));
  release.resolve();
  const outcomes = await Promise.all([first, second]);
  assert.equal(t.host.answers.length, 1, 'host.answer ran once');
  assert.deepEqual(outcomes.map((o) => Object.keys(o)[0]).sort(), ['answered', 'refused']);
  assert.equal(t.store.posted('b0|s1|req1').status, 'closed');

  // A failed answer gives the card back, so the press can be retried.
  const u = setup();
  u.host.answer = async () => { throw new Error('app-server down'); };
  await u.bridge.handleReply('slack', press(3));
  assert.equal(u.store.posted('b0|s1|req1').status, 'open');
});

test('an agent is addressed only with "name:" or "@name", not by a bare first word', () => {
  const t = setup();
  const byName = (body) => t.bridge.replies.byName(t.store.bindings(), body);
  assert.equal(byName('alpha: hello')?.text, 'hello');
  assert.equal(byName('@alpha hello')?.text, 'hello');
  assert.equal(byName('@alpha: hello')?.text, 'hello');
  assert.equal(byName('Alpha:hello')?.text, 'hello', 'case-insensitive, no space needed after the colon');
  assert.equal(byName('alpha hello there'), null, 'a message that merely starts with an agent name is not addressed to it');
  assert.equal(byName('alpha'), null);
});

test('a top-level channel message prompts the one session-scoped binding, also when a second binding reaches the same agent', async () => {
  const t = setup();
  const prompts = [];
  t.host.prompt = async (s, body) => { prompts.push({ id: s.id, body }); };
  assert.deepEqual(await t.bridge.handleReply('slack', text(1, 'run the tests')), { queued: 's1' });
  await t.bridge.drain();
  assert.deepEqual(prompts, [{ id: 's1', body: 'run the tests' }]);

  t.store.putBinding({
    id: 'b1', adapter: 'slack', target: { channel: 'C0' }, scope: { type: 'session', id: 's1' },
    events: ['input-required'], allowedUsers: ['U1'], approvals: false, createdAt: 'x',
  });
  // Two bindings, one agent: the channel still reaches exactly one session, so it takes the message.
  assert.deepEqual(await t.bridge.handleReply('slack', text(2, 'and again')), { queued: 's1' });
  await t.bridge.drain();
  assert.equal(prompts.length, 2);
});

test('an answer in flight is claimed in memory only, and a failed answer leaves the card answerable', async () => {
  const t = setup();
  const onDisk = () => new BindingStore(path.join(t.root, 'messengers.json')).posted('b0|s1|req1').status;
  const statusDuring = [];
  let fail = true;
  t.host.answer = async () => {
    statusDuring.push(onDisk());
    if (fail) throw new Error('app-server down');
  };
  const first = await t.bridge.handleReply('slack', press(1));
  assert.ok(first.error);
  assert.deepEqual(statusDuring, ['open'], 'a crash mid-answer leaves nothing stuck on disk');
  assert.equal(t.store.posted('b0|s1|req1').status, 'open', 'rolled back');
  fail = false;
  assert.deepEqual(await t.bridge.handleReply('slack', press(2)), { answered: 'req1' }, 'answerable again');
});

test('a card that cannot be closed after a delivered answer is logged, not reported as undelivered', async () => {
  const t = setup();
  t.bridge.replies.cards.close = async () => { throw Object.assign(new Error('EACCES messengers.json'), { code: 'EACCES' }); };
  const out = await t.bridge.handleReply('slack', press(1));
  assert.deepEqual(out, { answered: 'req1' });
  assert.equal(t.host.answers.length, 1);
  assert.equal(t.logs.find((e) => e.event === 'close-failed')?.error, 'EACCES');
  assert.ok(!t.posts.some((p) => /Could not deliver/.test(p.card.body)), 'the user is not told it failed');
  assert.ok(!t.logs.some((e) => e.event === 'reply-failed'));
});

// A channel that reaches several agents: only a named agent gets the message; an
// unaddressed one is skipped without a reply in the channel (logged only).

test('a message whose handling threw can be redelivered: it is not remembered as handled', async () => {
  const t = setup();
  const { outbox } = t.bridge.replies;
  const real = outbox.accept.bind(outbox);
  let fail = true;
  outbox.accept = async (...a) => { if (fail) throw Object.assign(new Error('outbox write failed'), { persist: true }); return real(...a); };
  const r = text(7, 'alpha: hello');
  await assert.rejects(() => t.bridge.handleReply('slack', r), /outbox write failed/);
  fail = false;
  const again = await t.bridge.handleReply('slack', r);
  assert.notDeepEqual(again, { ignored: 'duplicate' }, 'the retry runs instead of being acked as a duplicate');
  assert.deepEqual(await t.bridge.handleReply('slack', r), { ignored: 'duplicate' }, 'a handled message is still a duplicate');
});

test('a throw before the prompt path (routing) also leaves the message retryable', async () => {
  const t = setup();
  const { threads } = t.bridge.replies;
  const real = threads.route.bind(threads);
  let fail = true;
  threads.route = (...a) => { if (fail) throw new Error('state unreadable'); return real(...a); };
  const r = text(8, 'alpha: hello');
  await assert.rejects(() => t.bridge.handleReply('slack', r), /state unreadable/);
  fail = false;
  assert.notDeepEqual(await t.bridge.handleReply('slack', r), { ignored: 'duplicate' });
});
