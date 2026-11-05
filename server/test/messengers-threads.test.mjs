import assert from 'node:assert/strict';
import test from 'node:test';
import { requestIdFor } from '../src/messengers/replies.js';
import { HOUR, DAY, user, ask, setup, msg, inThread, card, roots } from './messengers-threads-fixtures.mjs';

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
  assert.deepEqual(await t.send(inThread('card-q1', '10.1', 'more please')), { queued: 's2' });
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
  assert.deepEqual(await t.send(inThread('card-done', '10.1', 'next step')), { queued: 's1' });
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
  assert.deepEqual(await t.send(msg('10.1', 'run the <tests>\nthen stop')), { queued: 's1' });
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
  assert.deepEqual(await t.send(msg('10.3', 'three')), { queued: 's1' });
  assert.ok(t.logs.some((e) => e.event === 'thread-failed'));
  assert.equal(t.store.state('channelMarks', 'slack|C0'), '10.3');
  assert.equal(t.store.state('deliveredTs', 'slack|C0').length, 3);
  assert.ok(!JSON.stringify(t.logs).includes('three'), 'no message text in the log');
});

test('a reply under a delivered top-level ts routes, and does not move the root count', async () => {
  const t = setup({ sessions: ['s1', 's2'] });
  await t.send(msg('10.1', 'beta: first'));
  assert.deepEqual(await t.send(inThread('10.1', '10.2', 'and more')), { queued: 's2' });
  assert.deepEqual(t.host.prompts.map((p) => [p.id, p.text]), [['s2', 'first'], ['s2', 'and more']]);
  assert.equal(roots(t, 's2')[0].count, 1, 'the delivered message is not under the root');
});

test('a reply under the current root routes; a name prefix there does not re-address it', async () => {
  const t = setup({ sessions: ['s1', 's2'] });
  await t.send(msg('10.1', 'alpha: first'));
  const rootTs = roots(t)[0].ts;
  assert.deepEqual(await t.send(inThread(rootTs, '10.2', 'beta: not for you')), { queued: 's1' });
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
  assert.deepEqual(await t.send(msg('10.1', 'hello')), { queued: 's1' }, 'three bindings, one agent: it takes the message');
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
  assert.deepEqual(await t.send(inThread('r1', '10.3', 'old but kept')), { queued: 's1' });
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
  assert.deepEqual(await t.send(msg('10.1', 'plain words')), { queued: 's1' });
  assert.equal(t.ephemerals.length, 0);
  const u = setup({ bindings: [{ id: 'b0', scope: { type: 'session', id: 's1' } }, { id: 'b1', scope: { type: 'session', id: 's1' } }] });
  assert.deepEqual(await u.send(msg('10.1', 'plain words')), { queued: 's1' }, 'two bindings, one agent');
});

test('a name inside a top-level message still addresses one agent of several', async () => {
  const t = setup({ sessions: ['s1', 's2'] });
  assert.deepEqual(await t.send(msg('10.1', '@Beta: do it')), { queued: 's2' });
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


test('a message that routes to no agent is settled, so a backfill does not replay it', async () => {
  const t = setup();
  const r = inThread('9.9', '10.2', 'alpha: hello');
  assert.deepEqual(await t.send(r), { ignored: 'no-target' });
  assert.ok(t.store.state('settledIds', 'slack|C0').includes(requestIdFor('slack', 'C0', '10.2')));
});
