import assert from 'node:assert/strict';
import test from 'node:test';
import { hookItem, hookOutput } from '../src/messengers/claude-approvals.js';
import { flush, hookBridge, permissionPayload as perm, user } from './messengers-fixtures.mjs';

// Hook decisions on the bridge: what is kept while one is in flight, which
// bindings get its cards, and how it ends.

const setup = (bindings = [{}]) => hookBridge({ bindings });

test('a settled hook decision closes its card, answered or timed out', async () => {
  const answered = setup();
  const waiting = answered.bridge.hooks.wait('s1', hookItem(perm));
  await flush();
  const click = { channel: 'C0', ts: answered.posts[0].ref.ts, thread: null, user, messageId: 'm1', optionId: 'd:accept' };
  await answered.bridge.handleReply('slack', click);
  assert.equal((await waiting).by, 'alice');
  assert.equal(answered.updates.at(-1).card.resolved.text, 'Approve once — by alice', 'answered');
  assert.ok(answered.bridge.store.allPosted().every(([, p]) => p.status === 'closed'));

  const timedOut = setup();
  const late = timedOut.bridge.hooks.wait('s1', hookItem(perm));
  await flush();
  timedOut.timers.values().next().value.fn();
  assert.equal(await late, null);
  await flush();
  assert.equal(timedOut.updates.at(-1).card.resolved.text, 'No answer in time — answer in the terminal.', 'timed out');
  assert.ok(timedOut.bridge.store.allPosted().every(([, p]) => p.status === 'closed'));
});

test('a decision settled while its card is still being posted closes that card with the text', async () => {
  const t = setup();
  const release = Promise.withResolvers();
  const post = t.bridge.adapters.get('slack').post;
  t.bridge.adapters.get('slack').post = async (...a) => { await release.promise; return post(...a); };
  const waiting = t.bridge.hooks.wait('s1', hookItem(perm));
  await flush();
  t.timers.values().next().value.fn();
  assert.equal(await waiting, null);
  release.resolve();
  await flush();
  await flush();
  assert.equal(t.updates.at(-1).card.resolved.text, 'No answer in time — answer in the terminal.');
});

test('stop settles every waiting hook decision with null and starts no second interval', async () => {
  const t = setup();
  const waiting = t.bridge.hooks.wait('s1', hookItem(perm));
  await flush();
  const started = [];
  const realSet = globalThis.setInterval;
  globalThis.setInterval = (...a) => { const h = realSet(...a); started.push(h); return h; };
  try { t.bridge.start(); t.bridge.start(); } finally { globalThis.setInterval = realSet; }
  assert.equal(started.length, 1, 'one interval');
  await t.bridge.stop();
  assert.equal(await waiting, null);
  assert.equal(t.bridge.hooks.pending.size, 0);
  await flush();
  assert.equal(t.updates.at(-1).card.resolved.text, 'Agent Manager is stopping — answer in the terminal.');
});

test('the decision timer does not keep the process alive', async () => {
  const t = setup();
  const handle = { unref() { handle.unrefd = true; } };
  t.bridge.setTimer = () => handle;
  const waiting = t.bridge.hooks.wait('s1', hookItem(perm));
  await flush();
  assert.equal(handle.unrefd, true);
  await t.bridge.stop();
  await waiting;
});

test('approval cards go only to bindings that include input-required', async () => {
  const t = setup([{ events: ['finished'], approvals: true }, { events: ['input-required', 'finished'], approvals: true }]);
  const waiting = t.bridge.hooks.wait('s1', hookItem(perm));
  await flush();
  assert.deepEqual(t.posts.map((p) => p.target.channel), ['C1']);
  await t.bridge.stop();
  await waiting;

  const only = setup([{ events: ['finished'], approvals: true }]);
  assert.equal(await only.bridge.hooks.wait('s1', hookItem(perm)), null, 'nothing qualifies, so the terminal keeps the dialog');
  assert.equal(only.posts.length, 0);
});

const pending = (promise) => Promise.race([promise.then(() => false), flush().then(() => true)]);

test('a user who is not allowed cannot approve a pending hook card', async () => {
  const t = setup();
  const waiting = t.bridge.hooks.wait('s1', hookItem(perm));
  await flush();
  const [key] = t.bridge.hooks.pending.keys();
  const click = { channel: 'C0', ts: t.posts[0].ref.ts, thread: null, user: { id: 'U9', name: 'mallory' }, messageId: 'm9', optionId: 'd:accept' };
  assert.deepEqual(await t.bridge.handleReply('slack', click), { refused: 'user-not-allowed' });
  assert.equal(await pending(waiting), true, 'the hook is still waiting');
  assert.ok(t.bridge.hooks.pending.has(key));
  assert.equal(t.bridge.store.posted(`b0|s1|${key}`).status, 'open', 'the card stays open');
  assert.equal(t.updates.length, 0);
  assert.match(t.posts.at(-1).card.body, /<@U9> is not allowed to answer for this agent\./);
  await t.bridge.stop();
  assert.equal(await waiting, null);
});

test('a two-question Claude dialog is answered one part at a time', async () => {
  const questions = [
    { question: 'Which DB?', options: [{ label: 'pg' }, { label: 'sqlite' }] },
    { question: 'Which lang?', options: [{ label: 'js' }, { label: 'ts' }] },
  ];
  const item = hookItem({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions } });
  const t = setup();
  const waiting = t.bridge.hooks.wait('s1', item);
  await flush();
  const [key] = t.bridge.hooks.pending.keys();
  const card = t.posts[0].ref;
  const click = { channel: 'C0', ts: card.ts, thread: null, user, messageId: 'm1', optionId: 'q:0:0' };
  assert.deepEqual(await t.bridge.handleReply('slack', click), { partial: true });
  assert.equal(await pending(waiting), true, 'one answer of two does not settle the hook');
  assert.deepEqual(t.bridge.store.posted(`b0|s1|${key}`).partial, { q0: 'pg' });
  assert.equal(t.bridge.store.posted(`b0|s1|${key}`).status, 'open');
  assert.equal(t.updates.length, 1, 'the card is refreshed');
  assert.equal(t.updates[0].ref.ts, card.ts);

  const reply = { channel: 'C0', ts: 'r1', thread: card.ts, user, messageId: 'm2', text: 'rust' };
  assert.deepEqual(await t.bridge.handleReply('slack', reply), { answered: key });
  const decided = await waiting;
  assert.deepEqual(decided.response, { answers: { q0: 'pg', q1: 'rust' } });
  assert.deepEqual(hookOutput(item, decided.response, { by: decided.by }).hookSpecificOutput.updatedInput.answers,
    { 'Which DB?': 'pg', 'Which lang?': 'rust' });
});

const waitFor = async (predicate, what) => {
  for (let i = 0; i < 1000 && !predicate(); i++) await flush();
  assert.ok(predicate(), `timed out waiting for ${what}`);
};

test('a hook card that cannot be posted falls back to the terminal and closes the cards already posted', async () => {
  const t = setup([{ events: ['input-required'], approvals: true }, { events: ['input-required'], approvals: true }]);
  const post = t.slack.post;
  t.slack.post = async (target, card) => {
    if (target.channel === 'C1') throw new Error('slack chat.postMessage: channel_not_found');
    return post(target, card);
  };
  assert.equal(await t.bridge.hooks.wait('s1', hookItem(perm)), null, 'the terminal keeps the dialog');
  const failed = t.logs.find((e) => e.event === 'hook-post-failed');
  assert.deepEqual([failed.binding, failed.session, failed.adapter, failed.error], ['b1', 's1', 'slack', 'slack chat.postMessage: channel_not_found']);
  await waitFor(() => t.updates.length === 1, 'the first card to close');
  assert.equal(t.updates[0].ref.channel, 'C0');
  assert.equal(t.updates[0].card.resolved.text, 'Could not be posted.');
});

test('aborting while the second card is being posted closes both cards', async () => {
  const t = setup([{ events: ['input-required'], approvals: true }, { events: ['input-required'], approvals: true }]);
  const post = t.slack.post;
  const release = Promise.withResolvers();
  let second = false;
  t.slack.post = async (target, card) => {
    if (target.channel === 'C1') { second = true; await release.promise; }
    return post(target, card);
  };
  const stop = new AbortController();
  const waiting = t.bridge.hooks.wait('s1', hookItem(perm), { signal: stop.signal });
  await waitFor(() => second, 'the second post to start');
  stop.abort();
  assert.equal(await waiting, null);
  release.resolve();
  await waitFor(() => t.updates.length === 2, 'both cards to close');
  assert.deepEqual(t.updates.map((u) => [u.ref.channel, u.card.resolved.text]).sort(),
    [['C0', 'Stopped waiting — answer in the terminal.'], ['C1', 'Stopped waiting — answer in the terminal.']]);
});

test('a card update or close that fails is logged with its binding, session and adapter', async () => {
  const t = setup();
  t.slack.update = async () => { throw new Error('slack chat.update: message_not_found'); };
  const waiting = t.bridge.hooks.wait('s1', hookItem(perm));
  await waitFor(() => t.posts.length === 1, 'the card');
  t.timers.values().next().value.fn();
  assert.equal(await waiting, null);
  await waitFor(() => t.logs.some((e) => e.event === 'update-failed'), 'the update failure');
  const failed = t.logs.find((e) => e.event === 'update-failed');
  assert.deepEqual([failed.binding, failed.session, failed.adapter], ['b0', 's1', 'slack']);

  const c = setup();
  const waiting2 = c.bridge.hooks.wait('s1', hookItem(perm));
  await waitFor(() => c.posts.length === 1, 'the card');
  c.bridge.store.putPosted = () => { throw new Error('disk full'); };
  c.timers.values().next().value.fn();
  assert.equal(await waiting2, null);
  await waitFor(() => c.logs.some((e) => e.event === 'close-failed'), 'the close failure');
  const closeFailed = c.logs.find((e) => e.event === 'close-failed');
  assert.deepEqual([closeFailed.binding, closeFailed.session, closeFailed.adapter, closeFailed.error], ['b0', 's1', 'slack', 'disk full']);
});
