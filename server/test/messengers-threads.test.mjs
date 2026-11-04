import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MessengerBridge } from '../src/messengers/bridge.js';
import { BindingStore } from '../src/messengers/store.js';
import { createMessengers } from '../src/messengers/index.js';
import { createThreads, quoteOf } from '../src/messengers/threads.js';
import { requestIdFor } from '../src/messengers/replies.js';
import { SlackAdapter, renderBlocks } from '../src/messengers/adapters/slack.js';

// Bot-owned threads, routing and the delivery side effects of a chat prompt.
// A fake adapter and host stand in for Slack and Agent Manager.

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const user = { id: 'U1', name: 'alice' };
const ask = { key: 'q1', kind: 'question', questions: [{ id: 'a', text: 'Which one?' }] };

function setup({ allowedUsers = ['U1'], link = null, sessions = ['s1'], bindings = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-messengers-threads-'));
  const clock = { t: 1_000_000 };
  const now = () => clock.t;
  const store = new BindingStore(path.join(root, 'messengers.json'), { now });
  const names = { s1: 'alpha', s2: 'beta' };
  const host = {
    prompts: [], answers: [], isLocked: false, group: Object.fromEntries(sessions.map((id) => [id, 'g1'])),
    list: sessions.map((id) => ({ id, name: names[id], cli: 'codex', state: 'working', inputRequired: null })),
    sessions: () => host.list.map((s) => ({ ...s })),
    groupOf: (id) => (host.group[id] ? { id: host.group[id], name: 'proj' } : null),
    locked: () => host.isLocked, link: link ? (s) => `${link}/#session=${s.id}` : () => null,
    sourceKey: (s) => `src-${s.id}`, requests: async () => [], digest: async () => null,
    answer: async (s, key, response) => { host.answers.push({ id: s.id, key, response }); },
    prompt: async (s, text, opts) => { host.prompts.push({ id: s.id, text, requestId: opts.requestId }); },
  };
  const posts = [];
  const ephemerals = [];
  const slack = {
    configured: () => true, start(h) { h.onStatus({ connected: true, error: null }); },
    async post(target, card) { const ref = { channel: target.channel, ts: `t${posts.length + 1}` }; posts.push({ target, card, ref }); return ref; },
    async update() {},
    async postEphemeral(e) { ephemerals.push(e); },
  };
  const logs = [];
  const mk = (adapters) => new MessengerBridge({ host, store, adapters, now, log: (e) => logs.push(e), tickMs: 1e9, settleMs: 0, digestEveryMs: 0 });
  const bridge = mk(new Map([['slack', slack]]));
  bridge.statuses.set('slack', { connected: true, error: null });
  const base = { adapter: 'slack', target: { channel: 'C0' }, events: ['input-required'], allowedUsers, approvals: false, createdAt: 'x' };
  const bind = (id, scope, extra = {}) => store.putBinding({ ...base, id, scope, ...extra });
  for (const b of bindings || [{ id: 'b0', scope: { type: 'group', id: 'g1' } }]) bind(b.id, b.scope, b.extra);
  return { root, clock, store, host, slack, posts, ephemerals, logs, bridge, bind, mk, send: (r) => bridge.handleReply('slack', r) };
}

const msg = (ts, body, extra = {}) => ({ channel: 'C0', ts, thread: null, user, messageId: `m${ts}`, text: body, ...extra });
const inThread = (thread, ts, body, extra = {}) => msg(ts, body, { thread, ...extra });
const card = (t, key, extra = {}) => t.store.putPosted(`b0|s1|${key}`, {
  bindingId: 'b0', sessionId: 's1', key, kind: 'input', status: 'open', adapter: 'slack',
  ref: { channel: 'C0', ts: `card-${key}` }, item: ask, partial: {}, ...extra,
});
const roots = (t, session = 's1') => t.store.state('roots', `slack|C0|${session}`) || [];

test('a reply in an open question card\'s thread answers it', async () => {
  const t = setup();
  card(t, 'q1');
  assert.deepEqual(await t.send(inThread('card-q1', '10.1', 'the first')), { answered: 'q1' });
  assert.deepEqual(t.host.answers.map((a) => [a.id, a.response]), [['s1', { answers: { a: 'the first' } }]]);
  assert.equal(t.host.prompts.length, 0);
});

test('a reply in a closed question card\'s thread is a prompt to that card\'s session', async () => {
  const t = setup({ sessions: ['s1', 's2'] });
  card(t, 'q1', { status: 'closed', sessionId: 's2' });
  assert.deepEqual(await t.send(inThread('card-q1', '10.1', 'more please')), { prompted: 's2' });
  assert.deepEqual(t.host.prompts.map((p) => [p.id, p.text]), [['s2', 'more please']]);
  assert.equal(t.host.answers.length, 0);
  // A button press on the closed card is still refused, not turned into a prompt.
  t.store.putPosted('b0|s1|q1', { ...t.store.posted('b0|s1|q1'), item: { ...ask, choices: [{ value: 'accept', label: 'Yes' }] } });
  const press = { channel: 'C0', ts: 'card-q1', thread: null, user, messageId: 'p1', optionId: 'd:accept' };
  assert.deepEqual(await t.send(press), { refused: 'closed' });
  assert.equal(t.posts.at(-1).card.body, 'This request is already closed.');
});

test('a reply in a finished card\'s thread is a prompt to that card\'s session', async () => {
  const t = setup();
  t.store.putPosted('b0|s1|done:1', { bindingId: 'b0', sessionId: 's1', key: 'done:1', kind: 'finished', status: 'closed', adapter: 'slack', ref: { channel: 'C0', ts: 'card-done' } });
  assert.deepEqual(await t.send(inThread('card-done', '10.1', 'next step')), { prompted: 's1' });
  assert.deepEqual(t.host.prompts.map((p) => p.text), ['next step']);
  assert.equal(t.posts.length, 0, 'a card thread gets no quote and no root');
});

test('a card thread whose record was pruned is not routed', async () => {
  const t = setup();
  t.store.putPosted('b0|s1|done:1', { bindingId: 'b0', sessionId: 's1', key: 'done:1', kind: 'finished', status: 'closed', adapter: 'slack', ref: { channel: 'C0', ts: 'card-done' } });
  t.clock.t += 8 * DAY;
  t.store.putPosted('b0|s1|done:2', { bindingId: 'b0', sessionId: 's1', key: 'done:2', kind: 'finished', status: 'closed', adapter: 'slack', ref: { channel: 'C0', ts: 'card-new' } });
  assert.deepEqual(await t.send(inThread('card-done', '10.1', 'hello?')), { ignored: 'no-target' });
  assert.equal(t.host.prompts.length, 0);
});

test('a top-level message is quoted into a bot-owned root and recorded', async () => {
  const t = setup({ link: 'http://am' });
  assert.deepEqual(await t.send(msg('10.1', 'run the <tests>\nthen stop')), { prompted: 's1' });
  assert.equal(t.posts.length, 2, 'a root and one quote, no "Sent to" notice');
  const [rootPost, quote] = t.posts;
  assert.equal(rootPost.target.thread, null);
  assert.equal(rootPost.card.title, '🧵 alpha · codex');
  assert.equal(rootPost.card.link, 'http://am/#session=s1');
  assert.equal(quote.target.thread, rootPost.ref.ts, 'the quote goes under the root');
  assert.equal(quote.card.mrkdwn, '*U1*\n> run the &lt;tests&gt;\n> then stop');
  assert.ok(!t.posts.some((p) => /Sent to/.test(JSON.stringify(p.card))));
  assert.deepEqual(roots(t), [{ ts: rootPost.ref.ts, at: 1_000_000, count: 1 }]);
  assert.deepEqual(t.store.state('deliveredTs', 'slack|C0'), [{ ts: '10.1', sessionId: 's1' }]);
  assert.equal(t.store.state('channelMarks', 'slack|C0'), '10.1');
  assert.deepEqual(t.store.state('recent', 'slack|C0|s1'), { lastSrc: 'src-s1', texts: ['run the <tests>\nthen stop'] });
});

test('the root carries no link when none is configured', async () => {
  const t = setup();
  await t.send(msg('10.1', 'hi'));
  assert.equal(t.posts[0].card.link, null);
});

test('a second message reuses the root, and a failed quote still counts as delivered', async () => {
  const t = setup();
  await t.send(msg('10.1', 'one'));
  const rootTs = roots(t)[0].ts;
  t.clock.t += 5000;
  await t.send(msg('10.2', 'two'));
  assert.equal(t.posts.length, 3, 'one root, two quotes');
  assert.deepEqual(roots(t), [{ ts: rootTs, at: 1_005_000, count: 2 }]);
  t.slack.post = async () => { throw new Error('slack chat.postMessage: ratelimited'); };
  assert.deepEqual(await t.send(msg('10.3', 'three')), { prompted: 's1' });
  assert.ok(t.logs.some((e) => e.event === 'thread-failed'));
  assert.equal(t.store.state('channelMarks', 'slack|C0'), '10.3');
  assert.equal(t.store.state('deliveredTs', 'slack|C0').length, 3);
  assert.ok(!JSON.stringify(t.logs).includes('three'), 'no message text in the log');
});

test('a reply under a delivered top-level ts routes, and does not move the root count', async () => {
  const t = setup({ sessions: ['s1', 's2'] });
  await t.send(msg('10.1', 'beta: first'));
  assert.deepEqual(await t.send(inThread('10.1', '10.2', 'and more')), { prompted: 's2' });
  assert.deepEqual(t.host.prompts.map((p) => [p.id, p.text]), [['s2', 'first'], ['s2', 'and more']]);
  assert.equal(roots(t, 's2')[0].count, 1, 'the delivered message is not under the root');
});

test('a reply under the current root routes; a name prefix there does not re-address it', async () => {
  const t = setup({ sessions: ['s1', 's2'] });
  await t.send(msg('10.1', 'alpha: first'));
  const rootTs = roots(t)[0].ts;
  assert.deepEqual(await t.send(inThread(rootTs, '10.2', 'beta: not for you')), { prompted: 's1' });
  assert.deepEqual(t.host.prompts.at(-1), { id: 's1', text: 'beta: not for you', requestId: requestIdFor('slack', 'C0', '10.2') });
  assert.equal(roots(t)[0].count, 2, 'the quote and the reply');
  assert.equal(t.store.state('threadMarks', 'slack|C0|s1'), '10.2');
  assert.equal(t.store.state('channelMarks', 'slack|C0'), '10.1', 'a reply is not a top-level message');
  assert.equal(t.store.state('recent', 'slack|C0|s1').texts.length, 2);
});

test('a thread reply that matches nothing is ignored', async () => {
  const t = setup();
  assert.deepEqual(await t.send(inThread('9.9', '10.2', 'alpha: hello')), { ignored: 'no-target' });
  assert.equal(t.host.prompts.length, 0);
});

test('the first binding that reaches the session and allows the sender wins', async () => {
  const t = setup({
    allowedUsers: ['U9'],
    bindings: [
      { id: 'b0', scope: { type: 'session', id: 's1' } },
      { id: 'b1', scope: { type: 'group', id: 'g1' }, extra: { allowedUsers: ['U1'] } },
      { id: 'b2', scope: { type: 'session', id: 's1' }, extra: { allowedUsers: ['U1'] } },
    ],
  });
  assert.deepEqual(await t.send(msg('10.1', 'hello')), { prompted: 's1' }, 'three bindings, one agent: it takes the message');
  assert.equal(t.logs.find((e) => e.event === 'prompted').binding, 'b1', 'b0 does not allow U1');
});

test('a sender no binding allows is refused, and nothing is said in the channel', async () => {
  const t = setup({ allowedUsers: ['U9'] });
  assert.deepEqual(await t.send(msg('10.1', 'hello')), { refused: 'user-not-allowed' });
  assert.equal(t.posts.length, 0);
  assert.equal(t.ephemerals.length, 0);
});

test('a session that left every binding in the channel is refused, even under its root', async () => {
  const t = setup();
  await t.send(msg('10.1', 'first'));
  const rootTs = roots(t)[0].ts;
  t.host.group = {};
  assert.deepEqual(await t.send(inThread(rootTs, '10.2', 'still there?')), { refused: 'not-in-channel' });
  assert.deepEqual(await t.send(inThread('10.1', '10.3', 'still there?')), { refused: 'not-in-channel' });
  assert.equal(t.host.prompts.length, 1);
  assert.ok(t.logs.some((e) => e.reason === 'not-in-channel'));
});

test('roots past 20 do not route, and a root rotates at 200 messages', async () => {
  const t = setup();
  const seeded = Array.from({ length: 20 }, (_, i) => ({ ts: `r${i}`, at: t.clock.t, count: i === 19 ? 200 : 1 }));
  t.store.patchState({ roots: { 'slack|C0|s1': seeded } });
  await t.send(msg('10.1', 'new top-level'));
  const list = roots(t);
  assert.equal(list.length, 20, 'capped');
  assert.deepEqual(list.map((r) => r.ts).slice(0, 2), ['r1', 'r2'], 'the oldest dropped');
  assert.equal(list.at(-1).ts, t.posts[0].ref.ts, 'a new root was appended');
  assert.equal(list.at(-1).count, 1);
  assert.equal(list.at(-2).count, 200, 'the full root is not touched');
  assert.deepEqual(await t.send(inThread('r0', '10.2', 'old')), { ignored: 'no-target' }, 'the dropped root no longer routes');
  assert.deepEqual(await t.send(inThread('r1', '10.3', 'old but kept')), { prompted: 's1' });
});

test('a root rotates for a top-level message after 12 hours idle, and not before', async () => {
  const t = setup();
  await t.send(msg('10.1', 'one'));
  t.clock.t += 12 * HOUR - 1;
  await t.send(msg('10.2', 'two'));
  assert.equal(roots(t).length, 1, 'just under 12 h: same root');
  t.clock.t += 12 * HOUR;
  await t.send(msg('10.3', 'three'));
  assert.equal(roots(t).length, 2);
  assert.equal(roots(t)[1].count, 1);
  // A reply in the old thread after a long idle does not open a new root.
  const oldRoot = roots(t)[0].ts;
  t.clock.t += 30 * HOUR;
  await t.send(inThread(oldRoot, '10.4', 'late'));
  assert.equal(roots(t).length, 2);
});

test('with two agents an unaddressed message gets one ephemeral notice per user and hour', async () => {
  const t = setup({ sessions: ['s1', 's2'] });
  assert.deepEqual(await t.send(msg('10.1', 'run the tests')), { refused: 'no-agent-named' });
  assert.deepEqual(t.ephemerals, [{ channel: 'C0', user: 'U1', text: 'Not delivered. Address an agent with `name:`.' }]);
  await t.send(msg('10.2', 'hello?'));
  assert.equal(t.ephemerals.length, 1, 'a second one within the hour gets none');
  await t.send(msg('10.3', 'x', { user: { id: 'U2' } }));
  assert.equal(t.ephemerals.length, 1, 'U2 is not allowed: nothing is said');
  t.clock.t += HOUR;
  await t.send(msg('10.4', 'again'));
  assert.equal(t.ephemerals.length, 2);
  assert.equal(t.posts.length, 0, 'nothing in the channel');
  assert.equal(t.host.prompts.length, 0);
  assert.ok(!JSON.stringify(t.logs).includes('run the tests'));
});

test('a notice that cannot be sent is logged and does not break the refusal', async () => {
  const t = setup({ sessions: ['s1', 's2'] });
  t.slack.postEphemeral = async () => { throw new Error('slack chat.postEphemeral: not_in_channel'); };
  assert.deepEqual(await t.send(msg('10.1', 'hi')), { refused: 'no-agent-named' });
  assert.equal(t.logs.find((e) => e.event === 'notice-failed').error, 'slack chat.postEphemeral: not_in_channel');
});

test('a group binding of one takes an unaddressed message; a session binding does too', async () => {
  const t = setup();
  assert.deepEqual(await t.send(msg('10.1', 'plain words')), { prompted: 's1' });
  assert.equal(t.ephemerals.length, 0);
  const u = setup({ bindings: [{ id: 'b0', scope: { type: 'session', id: 's1' } }, { id: 'b1', scope: { type: 'session', id: 's1' } }] });
  assert.deepEqual(await u.send(msg('10.1', 'plain words')), { prompted: 's1' }, 'two bindings, one agent');
});

test('a name inside a top-level message still addresses one agent of several', async () => {
  const t = setup({ sessions: ['s1', 's2'] });
  assert.deepEqual(await t.send(msg('10.1', '@Beta: do it')), { prompted: 's2' });
  assert.deepEqual(t.host.prompts.map((p) => p.text), ['do it']);
});

test('the channel gets one notice when it goes from one agent to several, and a restart does not repeat it', async () => {
  const t = setup();
  await t.bridge.tick();
  assert.equal(t.posts.length, 0);
  assert.equal(t.store.state('reach', 'slack|C0'), 1);
  t.host.list.push({ id: 's2', name: 'beta', cli: 'codex', state: 'working', inputRequired: null });
  t.host.group.s2 = 'g1';
  await t.bridge.tick();
  const notices = t.posts.filter((p) => p.card.kind === 'notice');
  assert.equal(notices.length, 1);
  assert.equal(notices[0].target.thread, null, 'a top-level post');
  assert.match(notices[0].card.body, /`name:`/);
  await t.bridge.tick();
  const restarted = t.mk(new Map([['slack', t.slack]]));
  restarted.statuses.set('slack', { connected: true, error: null });
  await restarted.tick();
  assert.equal(t.posts.filter((p) => p.card.kind === 'notice').length, 1);
  assert.equal(t.store.state('reach', 'slack|C0'), 2);
});

test('the last 3 texts are kept, each cut at 2 KB, and a quote is cut too', async () => {
  const t = setup();
  const long = 'x'.repeat(5000);
  for (const [i, body] of ['a', 'b', long, 'd'].entries()) await t.send(msg(`10.${i + 1}`, body));
  const { texts, lastSrc } = t.store.state('recent', 'slack|C0|s1');
  assert.deepEqual(texts.map((x) => x.length), [1, 2048, 1]);
  assert.equal(lastSrc, 'src-s1');
  assert.ok(t.posts.every((p) => (p.card.mrkdwn || '').length < 2200));
  assert.equal(t.host.prompts[2].text.length, 5000, 'the agent still gets the whole text');
});

test('routing takes an outbox lookup for a top-level message still waiting', () => {
  const t = setup();
  const threads = createThreads({
    host: t.host, store: t.store, adapters: new Map(), scope: () => [], log: () => {},
    outbox: (adapter, channel, ts) => (ts === 'waiting.1' ? 's1' : null),
  });
  const bindings = t.store.bindings();
  assert.equal(threads.route('slack', bindings, inThread('waiting.1', '1.2', 'hi')).sessionId, 's1');
  assert.deepEqual(threads.route('slack', bindings, inThread('other', '1.2', 'hi')), { ignored: 'no-target' });
});

// Removing a binding goes through createMessengers.remove, which cleans thread state.
function onDisk(bindings) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-messengers-forget-'));
  const file = path.join(dir, 'messengers.json');
  const b = (id, scope, channel = 'C0') => ({ id, adapter: 'slack', target: { channel }, scope, events: [], allowedUsers: ['U1'], approvals: false, createdAt: 'x' });
  const per = (v) => ({ 'slack|C0|s1': v, 'slack|C0|s2': v });
  fs.writeFileSync(file, JSON.stringify({
    bindings: bindings.map((x) => b(...x)), posted: {}, seen: {}, saved: {},
    roots: per([{ ts: 'r', at: 1, count: 1 }]), threadMarks: per('9.9'), channelMarks: { 'slack|C0': '9.9' },
    deliveredTs: { 'slack|C0': [{ ts: '1.1', sessionId: 's1' }, { ts: '1.2', sessionId: 's2' }] },
    recent: per({ lastSrc: 'x', texts: ['t'] }), reach: { 'slack|C0': 2 },
  }));
  const host = { groupOf: (id) => ({ id: 'g1', name: 'proj' }), sessions: () => [], locked: () => false, link: () => null };
  const messengers = createMessengers({ host, dataDir: dir, config: {} });
  const read = () => new BindingStore(file);
  return { messengers, read };
}

test('removing the only binding that reaches a session deletes its thread state, and keeps the other session\'s', () => {
  const { messengers, read } = onDisk([['b0', { type: 'session', id: 's1' }], ['b1', { type: 'session', id: 's2' }]]);
  messengers.remove('b0');
  const s = read();
  for (const section of ['roots', 'threadMarks', 'recent']) {
    assert.equal(s.state(section, 'slack|C0|s1'), null, `${section} of s1 is gone`);
    assert.notEqual(s.state(section, 'slack|C0|s2'), null, `${section} of s2 stays`);
  }
  assert.deepEqual(s.state('deliveredTs', 'slack|C0'), [{ ts: '1.2', sessionId: 's2' }]);
  assert.equal(s.state('channelMarks', 'slack|C0'), '9.9', 'the channel still has a binding');
  messengers.remove('b1');
  const empty = read();
  assert.deepEqual(['roots', 'threadMarks', 'recent', 'deliveredTs', 'channelMarks', 'reach'].map((x) => empty.stateKeys(x).length), [0, 0, 0, 0, 0, 0]);
});

test('a second binding in the channel that still reaches the session keeps its thread state', () => {
  const { messengers, read } = onDisk([['b0', { type: 'session', id: 's1' }], ['b1', { type: 'group', id: 'g1' }]]);
  messengers.remove('b0');
  const s = read();
  for (const section of ['roots', 'threadMarks', 'recent']) assert.notEqual(s.state(section, 'slack|C0|s1'), null, section);
  assert.equal(s.state('deliveredTs', 'slack|C0').length, 2);
});

test('Slack: postEphemeral calls chat.postEphemeral, and a card can carry ready mrkdwn', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return { json: async () => ({ ok: true }) }; };
  const slack = new SlackAdapter({ botToken: 'xoxb-1', appToken: 'xapp-1', fetchImpl });
  await slack.postEphemeral({ channel: 'C0', user: 'U1', text: 'hello `name:`' });
  assert.equal(calls[0].url, 'https://slack.com/api/chat.postEphemeral');
  assert.deepEqual(calls[0].body, { channel: 'C0', user: 'U1', text: 'hello `name:`' });
  const blocks = renderBlocks({ mrkdwn: '*U1*\n> hi' });
  assert.deepEqual(blocks, [{ type: 'section', text: { type: 'mrkdwn', text: '*U1*\n> hi' } }]);
});

// ---- review fixes ----

const approval = { key: 'p1', kind: 'permission', details: 'ls', choices: [{ value: 'accept', label: 'Approve once' }, { value: 'decline', label: 'Deny' }] };
const press = (who) => ({ channel: 'C0', ts: 'card-p1', thread: null, user: who, messageId: `p-${who.id}`, optionId: 'd:accept' });
const approvalCard = (t, bindingId) => t.store.putPosted(`${bindingId}|s1|p1`, {
  bindingId, sessionId: 's1', key: 'p1', kind: 'input', status: 'open', adapter: 'slack', ref: { channel: 'C0', ts: 'card-p1' }, item: approval, partial: {},
});

test('a card is answered under its own binding: another binding that allows the sender does not approve it', async () => {
  const t = setup({ bindings: [
    { id: 'b0', scope: { type: 'session', id: 's1' }, extra: { allowedUsers: ['U1'], approvals: true } },
    { id: 'b1', scope: { type: 'session', id: 's1' }, extra: { allowedUsers: ['U2'], approvals: true } },
  ] });
  approvalCard(t, 'b0');
  assert.deepEqual(await t.send(press({ id: 'U2', name: 'bob' })), { refused: 'user-not-allowed' });
  assert.equal(t.host.answers.length, 0, 'nothing was approved');
  assert.equal(t.store.posted('b0|s1|p1').status, 'open');
  assert.deepEqual(await t.send(press(user)), { answered: 'p1' }, 'the card\'s own user still can');
});

test('a card\'s binding decides approvals, not an earlier binding that also allows the sender', async () => {
  const t = setup({ bindings: [
    { id: 'b0', scope: { type: 'session', id: 's1' }, extra: { approvals: false } },
    { id: 'b1', scope: { type: 'session', id: 's1' }, extra: { approvals: true } },
  ] });
  approvalCard(t, 'b1');
  assert.deepEqual(await t.send(press(user)), { answered: 'p1' });
  assert.deepEqual(t.host.answers.map((a) => a.response), [{ decision: 'accept' }]);
});

test('a card whose binding is gone falls back to the first allowing binding', async () => {
  const t = setup({ bindings: [{ id: 'b0', scope: { type: 'session', id: 's1' }, extra: { approvals: true } }] });
  approvalCard(t, 'bX');
  assert.deepEqual(await t.send(press(user)), { answered: 'p1' });
});

const slowPost = (t, gate) => {
  const post = t.slack.post;
  t.slack.post = async (...a) => { await gate(); return post(...a); };
};

test('two top-level messages at once open one root and are both quoted under it', async () => {
  const t = setup();
  slowPost(t, () => new Promise((r) => setImmediate(r)));
  const out = await Promise.all([t.send(msg('10.1', 'one')), t.send(msg('10.2', 'two'))]);
  assert.deepEqual(out, [{ prompted: 's1' }, { prompted: 's1' }]);
  assert.equal(roots(t).length, 1, 'one root');
  assert.equal(roots(t)[0].count, 2);
  assert.equal(t.posts.filter((p) => p.card.kind === 'root').length, 1);
  assert.equal(t.posts.filter((p) => p.card.kind === 'quote' && p.target.thread === roots(t)[0].ts).length, 2);
});

test('a binding removed while a delivery is in flight leaves no thread state behind', async () => {
  const t = setup({ bindings: [{ id: 'b0', scope: { type: 'session', id: 's1' } }] });
  const posting = Promise.withResolvers();
  const release = Promise.withResolvers();
  slowPost(t, async () => { posting.resolve(); await release.promise; });
  const sent = t.send(msg('10.1', 'one'));
  await posting.promise;
  const removed = t.store.binding('b0');
  t.store.removeBinding('b0');
  t.bridge.threads.forget(removed);
  release.resolve();
  await sent;
  for (const section of ['roots', 'threadMarks', 'channelMarks', 'deliveredTs', 'recent', 'reach']) {
    assert.deepEqual(t.store.stateKeys(section), [], `${section} stays empty`);
  }
});

test('the quote names the sender without pinging them', () => {
  assert.equal(quoteOf({ id: 'U123' }, 'hi'), '*U123*\n> hi');
  assert.equal(quoteOf({ id: 'U1<!channel>' }, 'hi'), '*U1channel*\n> hi', 'the id is cut to letters and digits');
});

test('markup in user text is inert in the posted quote', async () => {
  const hostile = '<!channel> <@U2> &amp; <!here|x>';
  assert.equal(quoteOf(user, hostile), '*U1*\n> &lt;!channel&gt; &lt;@U2&gt; &amp;amp; &lt;!here|x&gt;');
  const t = setup();
  await t.send(msg('10.1', `${hostile}\n<!everyone>`));
  const { mrkdwn } = t.posts.find((p) => p.card.kind === 'quote').card;
  assert.ok(!/<[!@]/.test(mrkdwn), 'no live mention or broadcast');
  assert.ok(mrkdwn.includes('&lt;!everyone&gt;'));
  assert.equal(t.host.prompts[0].text, `${hostile}\n<!everyone>`, 'the agent still gets the text as written');
});

test('the watermarks never move backwards', async () => {
  const t = setup();
  await t.send(msg('1700000000.000200', 'newer'));
  await t.send(msg('1700000000.000100', 'older, delivered late'));
  await t.send(msg('1700000000.000009', 'oldest'));
  assert.equal(t.store.state('channelMarks', 'slack|C0'), '1700000000.000200');
  await t.send(msg('1700000001.000000', 'a second later'));
  assert.equal(t.store.state('channelMarks', 'slack|C0'), '1700000001.000000');
  const rootTs = roots(t)[0].ts;
  await t.send(inThread(rootTs, '1700000005.000200', 'r1'));
  await t.send(inThread(rootTs, '1700000005.000100', 'r2'));
  assert.equal(t.store.state('threadMarks', 'slack|C0|s1'), '1700000005.000200');
  await t.send(inThread(rootTs, '1700000005.000300', 'r3'));
  assert.equal(t.store.state('threadMarks', 'slack|C0|s1'), '1700000005.000300');
});

test('the delivered set keeps the newest 50 and a repeated ts appears once', async () => {
  const t = setup();
  const ts = (i) => `1700000000.${String(i).padStart(6, '0')}`;
  for (let i = 1; i <= 52; i += 1) await t.send(msg(ts(i), `m${i}`));
  const set = () => t.store.state('deliveredTs', 'slack|C0');
  assert.equal(set().length, 50);
  assert.deepEqual([set()[0].ts, set().at(-1).ts], [ts(3), ts(52)], 'the oldest two dropped');
  // The same Slack message redelivered under another event id is quoted again but listed once.
  await t.send({ ...msg(ts(52), 'm52'), messageId: 'retry' });
  assert.equal(set().filter((e) => e.ts === ts(52)).length, 1);
  assert.equal(set().length, 50);
});

test('a root that cannot be posted still delivers the message, with no root recorded', async () => {
  const t = setup();
  t.slack.post = async () => { throw new Error('slack chat.postMessage: channel_not_found'); };
  assert.deepEqual(await t.send(msg('10.1', 'hello')), { prompted: 's1' });
  assert.equal(t.host.prompts.length, 1);
  assert.equal(t.logs.filter((e) => e.event === 'thread-failed').length, 1);
  assert.deepEqual(roots(t), []);
  assert.deepEqual(t.store.state('deliveredTs', 'slack|C0'), [{ ts: '10.1', sessionId: 's1' }]);
  assert.deepEqual(t.store.state('recent', 'slack|C0|s1').texts, ['hello']);
});
