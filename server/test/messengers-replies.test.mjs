import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MessengerBridge } from '../src/messengers/bridge.js';
import { BindingStore } from '../src/messengers/store.js';
import { ApiError } from '../src/api-errors.js';

// Inbound replies: what is said back in chat, what is logged, and that a card
// is answered once.

const typed = { key: 'req1', kind: 'permission', details: '{"command":"ls"}', choices: [{ value: 'accept', label: 'Approve once' }, { value: 'decline', label: 'Deny' }] };
const user = { id: 'U1', name: 'alice' };

function setup({ approvals = true, allowedUsers = ['U1'] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-messengers-replies-'));
  const store = new BindingStore(path.join(root, 'messengers.json'), { now: () => 1000 });
  const host = {
    isLocked: false, gone: false, answers: [],
    sessions: () => (host.gone ? [] : [{ id: 's1', name: 'alpha', cli: 'codex', state: 'working', inputRequired: null }]),
    groupOf: () => ({ id: 'g1', name: 'proj' }), locked: () => host.isLocked, link: () => null,
    requests: async () => [], digest: async () => null,
    answer: async (...a) => { host.answers.push(a); }, prompt: async () => {},
  };
  const posts = [];
  const slack = {
    configured: () => true, start() {}, failPosts: false,
    async post(target, card) {
      if (slack.failPosts) throw new Error('slack chat.postMessage: channel_not_found');
      const ref = { channel: target.channel, ts: `t${posts.length + 1}` };
      posts.push({ target, card, ref });
      return ref;
    },
    async update() {},
  };
  const logs = [];
  const bridge = new MessengerBridge({ host, store, adapters: new Map([['slack', slack]]), log: (e) => logs.push(e), tickMs: 1e9 });
  store.putBinding({
    id: 'b0', adapter: 'slack', target: { channel: 'C0' }, scope: { type: 'session', id: 's1' },
    events: ['input-required'], allowedUsers, approvals, createdAt: 'x',
  });
  store.putPosted('b0|s1|req1', {
    bindingId: 'b0', sessionId: 's1', key: 'req1', kind: 'input', status: 'open', adapter: 'slack',
    ref: { channel: 'C0', ts: 'card1' }, item: typed, partial: {},
  });
  return { bridge, host, slack, store, posts, logs, root };
}

const press = (n, optionId = 'd:accept', who = user) => ({ channel: 'C0', ts: 'card1', thread: null, user: who, messageId: `m${n}`, optionId });
const text = (n, body) => ({ channel: 'C0', ts: `x${n}`, thread: null, user, messageId: `m${n}`, text: body });

test('internal error text stays out of chat; user-facing errors are shown', async () => {
  const t = setup();
  t.host.answer = async () => { throw new Error('ECONNREFUSED /home/op/.codex/app-server.sock'); };
  const out = await t.bridge.handleReply('slack', press(1));
  assert.ok(out.error);
  assert.equal(t.posts.at(-1).card.body, '⚠️ Could not deliver that — see the server log.');
  assert.equal(t.logs.find((e) => e.event === 'reply-failed').error, 'ECONNREFUSED /home/op/.codex/app-server.sock', 'the full error is logged');

  t.host.prompt = async () => { throw new ApiError(409, 'busy', 'alpha is busy right now.'); };
  await t.bridge.handleReply('slack', text(2, 'alpha: hello'));
  assert.equal(t.posts.at(-1).card.body, '⚠️ alpha is busy right now.');
  t.host.prompt = async () => { throw new ApiError(500, 'internal-error', 'disk full at /home/op/.am/data'); };
  await t.bridge.handleReply('slack', text(4, 'alpha: again'));
  assert.equal(t.posts.at(-1).card.body, '⚠️ Could not deliver that — see the server log.', 'a 5xx ApiError is masked like any internal error');

  t.bridge.store.putPosted('b0|s1|hook:gone', { ...t.store.posted('b0|s1|req1'), key: 'hook:gone', ref: { channel: 'C0', ts: 'card2' }, item: { ...typed, key: 'hook:gone' } });
  await t.bridge.handleReply('slack', { ...press(3), ts: 'card2' });
  assert.match(t.posts.at(-1).card.body, /no longer waiting — answer in the terminal/);
});

test('a notice that cannot be posted is logged, not lost silently', async () => {
  const t = setup({ allowedUsers: ['U1'] });
  t.slack.failPosts = true;
  const out = await t.bridge.handleReply('slack', press(1, 'd:accept', { id: 'U9', name: 'mallory' }));
  assert.deepEqual(out, { refused: 'user-not-allowed' });
  const failed = t.logs.find((e) => e.event === 'notice-failed');
  assert.deepEqual([failed.adapter, failed.channel, failed.error], ['slack', 'C0', 'slack chat.postMessage: channel_not_found']);
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

test('a top-level channel message prompts the one session-scoped binding, and is ignored when two compete', async () => {
  const t = setup();
  const prompts = [];
  t.host.prompt = async (s, body) => { prompts.push({ id: s.id, body }); };
  assert.deepEqual(await t.bridge.handleReply('slack', text(1, 'run the tests')), { prompted: 's1' });
  assert.deepEqual(prompts, [{ id: 's1', body: 'run the tests' }]);

  t.store.putBinding({
    id: 'b1', adapter: 'slack', target: { channel: 'C0' }, scope: { type: 'session', id: 's1' },
    events: ['input-required'], allowedUsers: ['U1'], approvals: false, createdAt: 'x',
  });
  assert.deepEqual(await t.bridge.handleReply('slack', text(2, 'and again')), { ignored: 'no-target' });
  assert.equal(prompts.length, 1, 'nothing was sent to either session');
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
  t.bridge.replies.cards.close = async () => { throw new Error('EACCES messengers.json'); };
  const out = await t.bridge.handleReply('slack', press(1));
  assert.deepEqual(out, { answered: 'req1' });
  assert.equal(t.host.answers.length, 1);
  assert.equal(t.logs.find((e) => e.event === 'close-failed')?.error, 'EACCES messengers.json');
  assert.ok(!t.posts.some((p) => /Could not deliver/.test(p.card.body)), 'the user is not told it failed');
  assert.ok(!t.logs.some((e) => e.event === 'reply-failed'));
});
