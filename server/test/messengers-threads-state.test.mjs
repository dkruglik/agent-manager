import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BindingStore } from '../src/messengers/store.js';
import { createMessengers } from '../src/messengers/index.js';
import { createThreads, quoteOf } from '../src/messengers/threads.js';
import { SlackAdapter, renderBlocks } from '../src/messengers/adapters/slack.js';
import { user, setup, msg, inThread, card, roots } from './messengers-threads-fixtures.mjs';

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

test('updating a binding to another channel or scope drops the thread state it no longer reaches', () => {
  const moved = onDisk([['b0', { type: 'session', id: 's1' }], ['b1', { type: 'session', id: 's2' }]]);
  moved.messengers.update('b0', { events: ['finished'], target: { channel: 'C9' } });
  const s = moved.read();
  for (const section of ['roots', 'threadMarks', 'recent']) {
    assert.equal(s.state(section, 'slack|C0|s1'), null, `${section} of s1 is gone from the old channel`);
    assert.notEqual(s.state(section, 'slack|C0|s2'), null, `${section} of s2 stays`);
  }
  const rescoped = onDisk([['b0', { type: 'session', id: 's1' }], ['b1', { type: 'session', id: 's2' }]]);
  rescoped.messengers.update('b0', { events: ['finished'], scope: { type: 'session', id: 's2' } });
  const r = rescoped.read();
  assert.equal(r.state('roots', 'slack|C0|s1'), null);
  assert.deepEqual(r.state('deliveredTs', 'slack|C0'), [{ ts: '1.2', sessionId: 's2' }]);
  const same = onDisk([['b0', { type: 'session', id: 's1' }]]);
  same.messengers.update('b0', { events: ['finished'], allowedUsers: ['U1', 'U2'] });
  assert.notEqual(same.read().state('roots', 'slack|C0|s1'), null, 'a change that keeps channel and scope keeps the state');
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
  assert.deepEqual(out, [{ queued: 's1' }, { queued: 's1' }]);
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
  assert.deepEqual(await t.send(msg('10.1', 'hello')), { queued: 's1' });
  assert.equal(t.host.prompts.length, 1);
  assert.equal(t.logs.filter((e) => e.event === 'thread-failed').length, 1);
  assert.deepEqual(roots(t), []);
  assert.deepEqual(t.store.state('deliveredTs', 'slack|C0'), [{ ts: '10.1', sessionId: 's1' }]);
  assert.deepEqual(t.store.state('recent', 'slack|C0|s1').texts, ['hello']);
});
