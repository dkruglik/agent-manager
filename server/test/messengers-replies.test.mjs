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

// A channel that reaches several agents: only a named agent gets the message; an
// unaddressed one is skipped without a reply in the channel (logged only).
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
  const log = t.logs.find((e) => e.reason === 'no-agent-named');
  assert.ok(log && !JSON.stringify(log).includes('run the tests'), 'logged without the text');
});

test('a named agent gets the message and only that agent; an unknown name is skipped', async () => {
  const t = several();
  assert.deepEqual(await t.bridge.handleReply('slack', text(1, 'alpha: hi')), { prompted: 's1' });
  assert.deepEqual(await t.bridge.handleReply('slack', text(2, '@beta hi')), { prompted: 's2' });
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
  assert.deepEqual(await t.bridge.handleReply('slack', text(2, 'beta: hello')), { prompted: 's2' });
});

test('a session binding plus a group reaching another agent: unaddressed is skipped, named still goes', async () => {
  const t = several();
  t.store.removeBinding('b1');
  t.store.putBinding({ adapter: 'slack', target: { channel: 'C0' }, events: [], allowedUsers: ['U1'], approvals: false, createdAt: 'x', id: 'bg', scope: { type: 'group', id: 'g1' } });
  t.host.sessions = () => [{ id: 's1', name: 'alpha', cli: 'codex', state: 'working', inputRequired: null }, { id: 's2', name: 'beta', cli: 'codex', state: 'working', inputRequired: null, groupId: 'g1' }];
  assert.deepEqual(await t.bridge.handleReply('slack', text(1, 'hello')), { refused: 'no-agent-named' });
  assert.equal(t.prompts.length, 0, 'the one direct agent does not take it');
  assert.equal(t.posts.length, 0);
  assert.deepEqual(await t.bridge.handleReply('slack', text(2, 'beta: hello')), { prompted: 's2' });
  assert.deepEqual(await t.bridge.handleReply('slack', text(3, 'alpha: hello')), { prompted: 's1' });
});

test('a single session binding still takes an unaddressed message', async () => {
  const t = setup();
  const prompts = [];
  t.host.prompt = async (s, body) => { prompts.push(body); };
  assert.deepEqual(await t.bridge.handleReply('slack', text(1, 'alpha hello')), { prompted: 's1' });
  assert.deepEqual(prompts, ['alpha hello']);
});

// The host takes a UUID as the request id (shared Codex rejects anything else), and the
// id must follow the Slack message (adapter, channel, ts), not the event that delivered it.
const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;

async function requestIdOf(t, event) {
  const seen = [];
  t.host.prompt = async (s, body, opts) => { seen.push(opts); };
  assert.deepEqual(await t.bridge.handleReply('slack', event), { prompted: 's1' });
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
  const retried = await requestIdOf(t, { ...text(1, 'run the tests'), ...msg, messageId: 'Ev2-retry' });
  assert.equal(retried, first, 'the same message delivered under another event id (after a restart, when the in-memory duplicate list no longer holds it) keeps the id');

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
