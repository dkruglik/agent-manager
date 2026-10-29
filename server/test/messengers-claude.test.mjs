import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hookItem, hookOutput } from '../src/messengers/claude-approvals.js';
import { MessengerBridge } from '../src/messengers/bridge.js';
import { BindingStore } from '../src/messengers/store.js';

const perm = { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls -la' } };
const ask = (questions) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'AskUserQuestion',
  tool_input: { questions, metadata: { source: 'x' } },
});
const q1 = { question: 'Which DB?', header: 'DB', options: [{ label: 'pg', description: 'Postgres' }, { label: 'sqlite' }] };
const q2 = { question: 'Which lang?', options: [{ label: 'js' }, { label: 'ts' }] };

// Permission mapping.
const p = hookItem(perm);
assert.equal(p.kind, 'permission');
assert.equal(p.source, 'claude-hook');
assert.equal(p.event, 'PermissionRequest');
assert.equal(p.tool, 'Bash');
assert.deepEqual(JSON.parse(p.details), { tool: 'Bash', input: { command: 'ls -la' } });
assert.ok(p.details.includes('\n  "tool": "Bash"'));
assert.deepEqual(p.choices, [{ value: 'accept', label: 'Approve once' }, { value: 'decline', label: 'Deny' }]);

assert.deepEqual(hookOutput(p, { decision: 'accept' }), {
  hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
});
assert.deepEqual(hookOutput(p, { decision: 'decline' }, { by: 'alice' }), {
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest',
    decision: { behavior: 'deny', message: 'Denied from chat by alice.', interrupt: false },
  },
});
assert.equal(hookOutput(p, { decision: 'decline' }).hookSpecificOutput.decision.message, 'Denied from chat by chat.');
assert.equal(hookOutput(p, { decision: 'maybe' }), null);
assert.equal(hookOutput(p, {}), null);

// AskUserQuestion mapping.
const one = hookItem(ask([q1]));
assert.deepEqual(one, {
  kind: 'question',
  source: 'claude-hook',
  event: 'PreToolUse',
  toolInput: ask([q1]).tool_input,
  questions: [{ id: 'q0', text: 'Which DB?', secret: false, options: [{ label: 'pg' }, { label: 'sqlite' }] }],
});
const two = hookItem(ask([q1, { ...q2, multiSelect: false }]));
assert.deepEqual(two.questions.map((q) => q.id), ['q0', 'q1']);
assert.equal(two.questions[1].text, 'Which lang?');

// Not handled: multiSelect and invalid shapes.
assert.equal(hookItem(ask([q1, { ...q2, multiSelect: true }])), null);
assert.equal(hookItem(ask([])), null);
assert.equal(hookItem(ask([q1, q2, q1, q2, q1])), null);
assert.equal(hookItem(ask([{ ...q1, options: [] }])), null);
assert.equal(hookItem(ask([{ ...q1, question: '' }])), null);
assert.equal(hookItem(ask([{ ...q1, options: [{ label: '' }] }])), null);
assert.equal(hookItem({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' }), null);
assert.equal(hookItem({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' }), null);
assert.equal(hookItem({ ...ask([q1]), hook_event_name: 'PostToolUse' }), null);
assert.equal(hookItem({ ...ask([q1]), tool_name: 'Bash' }), null);
assert.equal(hookItem(null), null);
assert.equal(hookItem([]), null);
assert.equal(hookItem('x'), null);
assert.equal(hookItem(undefined), null);

// Answers output.
const item = hookItem(ask([q1, q2]));
assert.deepEqual(hookOutput(item, { answers: { q0: 'pg', q1: 'custom text' } }), {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'allow',
    updatedInput: {
      questions: [q1, q2],
      metadata: { source: 'x' },
      answers: { 'Which DB?': 'pg', 'Which lang?': 'custom text' },
    },
  },
});
assert.equal(hookOutput(item, { answers: { q0: 'pg' } }), null);
assert.equal(hookOutput(item, { answers: { q0: 'pg', q1: '' } }), null);
assert.equal(hookOutput(item, { answers: { q0: 'pg', q1: 3 } }), null);
assert.equal(hookOutput(item, {}), null);
assert.equal(hookOutput({ event: 'Other' }, { decision: 'accept' }), null);
assert.equal(hookOutput(null, {}), null);

// ---------- awaitDecision: the bridge waits for a chat decision on a hook item ----------
function fakeAdapter() {
  const posts = [];
  const updates = [];
  let n = 0;
  return {
    posts, updates,
    configured: () => true,
    start(h) { h.onStatus({ connected: true, error: null }); },
    async post(target, card) { const ref = { channel: target.channel, ts: `t${++n}` }; posts.push({ target, card, ref }); return ref; },
    async update(ref, card) { updates.push({ ref, card }); },
  };
}

function fakeHost() {
  const h = {
    list: [{ id: 's1', name: 'alpha', cli: 'claude', state: 'working', inputRequired: null }],
    answers: [],
    isLocked: false,
    sessions: () => h.list.map((s) => ({ ...s })),
    groupOf: () => ({ id: 'g1', name: 'proj' }),
    locked: () => h.isLocked,
    link: (s) => `http://am/#session=${s.id}`,
    requests: async () => [],
    digest: async () => null,
    answer: async (s, key, response) => { h.answers.push({ id: s.id, key, response }); },
    prompt: async () => {},
  };
  return h;
}

function fakeTimers() {
  const timers = new Map();
  let n = 0;
  return {
    timers,
    setTimer: (fn, ms) => { timers.set(++n, { fn, ms }); return n; },
    clearTimer: (id) => { timers.delete(id); },
    fire: (id) => { const t = timers.get(id); timers.delete(id); t.fn(); },
  };
}

function setup({ approvals = [true], connected = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-messengers-claude-'));
  const store = new BindingStore(path.join(root, 'messengers.json'), { now: () => 1 });
  const host = fakeHost();
  const slack = fakeAdapter();
  const clock = fakeTimers();
  const bridge = new MessengerBridge({
    host, store, adapters: new Map([['slack', slack]]), tickMs: 1e9, settleMs: 0, digestEveryMs: 0,
    setTimer: clock.setTimer, clearTimer: clock.clearTimer,
  });
  approvals.forEach((on, i) => store.putBinding({
    id: `b${i}`, adapter: 'slack', target: { channel: `C${i}` }, scope: { type: 'group', id: 'g1' },
    events: ['input-required'], allowedUsers: ['U1'], approvals: on, createdAt: 'x',
  }));
  bridge.statuses.set('slack', { connected, error: null });
  return { bridge, host, slack, store, clock };
}

const user = { id: 'U1', name: 'alice' };
const click = (ref, optionId, n) => ({ channel: ref.channel, ts: ref.ts, thread: null, user, messageId: `m${n}`, optionId });
const labels = (card) => card.options.map((o) => o.label);
const lastUpdate = (slack) => slack.updates.at(-1).card;

{
  // Nothing qualifies: no approvals binding, disconnected adapter, locked host, unknown session.
  for (const [name, opts, patch] of [
    ['approvals off', { approvals: [false] }, () => {}],
    ['disconnected', { connected: false }, () => {}],
    ['locked', {}, (ctx) => { ctx.host.isLocked = true; }],
  ]) {
    const ctx = setup(opts);
    patch(ctx);
    assert.equal(await ctx.bridge.awaitDecision('s1', hookItem(perm)), null, name);
    assert.equal(ctx.slack.posts.length, 0, `${name}: nothing posted`);
    assert.equal(ctx.bridge.pending.size, 0);
  }
  const none = setup();
  assert.equal(await none.bridge.awaitDecision('nope', hookItem(perm)), null, 'unknown session');
  assert.equal(none.slack.posts.length, 0);

  // Approve from chat: resolves, host.answer is not called, the card closes.
  const a = setup();
  const waiting = a.bridge.awaitDecision('s1', hookItem(perm));
  await new Promise((r) => setImmediate(r));
  assert.equal(a.slack.posts.length, 1);
  assert.deepEqual(labels(a.slack.posts[0].card), ['Approve once', 'Deny']);
  assert.equal(a.clock.timers.size, 1);
  const [key] = a.bridge.pending.keys();
  assert.match(key, /^hook:[0-9a-f-]{36}$/);
  assert.equal(a.store.posted(`b0|s1|${key}`).status, 'open');

  // A tick while the hook waits neither closes the card nor posts a generic one.
  a.host.list[0].inputRequired = { cli: 'claude', kind: 'permission', detectedAt: 5 };
  await a.bridge.tick();
  assert.equal(a.store.posted(`b0|s1|${key}`).status, 'open', 'tick keeps the pending card');
  assert.equal(a.slack.posts.length, 1, 'no generic ir card beside a pending hook item');
  assert.equal(a.slack.updates.length, 0);

  const out = await a.bridge.handleReply('slack', click(a.slack.posts[0].ref, 'd:accept', 1));
  assert.deepEqual(out, { answered: key });
  assert.deepEqual(await waiting, { response: { decision: 'accept' }, by: 'alice' });
  assert.equal(a.host.answers.length, 0, 'host.answer is not called for hook items');
  assert.equal(a.bridge.pending.size, 0);
  assert.equal(a.clock.timers.size, 0, 'timer cleared');
  assert.equal(a.store.posted(`b0|s1|${key}`).status, 'closed');
  assert.match(lastUpdate(a.slack).resolved.text, /Approve once — by alice/);
  // A second click on the closed card does nothing more.
  assert.deepEqual(await a.bridge.handleReply('slack', click(a.slack.posts[0].ref, 'd:decline', 2)), { refused: 'closed' });

  // Timeout: null, card updated; a late click is refused.
  const t = setup();
  const late = t.bridge.awaitDecision('s1', hookItem(perm), { timeoutMs: 5000 });
  await new Promise((r) => setImmediate(r));
  const [[timerId, timer]] = [...t.clock.timers];
  assert.equal(timer.ms, 5000);
  t.clock.fire(timerId);
  assert.equal(await late, null);
  await new Promise((r) => setImmediate(r));
  assert.equal(lastUpdate(t.slack).resolved.text, 'No answer in time — answer in the terminal.');
  const [tkey] = [...t.store.allPosted()].map(([k]) => k);
  assert.equal(t.store.posted(tkey).status, 'closed');
  assert.equal(t.bridge.pending.size, 0);
  // Reopen the record to prove the pending map, not the status, refuses the click.
  t.store.putPosted(tkey, { ...t.store.posted(tkey), status: 'open' });
  const refused = await t.bridge.handleReply('slack', click(t.slack.posts[0].ref, 'd:accept', 3));
  assert.ok(refused.error, 'late click is refused');
  assert.match(refused.error, /no longer waiting/);
  assert.match(t.slack.posts.at(-1).card.body, /no longer waiting — answer in the terminal/);
  assert.equal(t.host.answers.length, 0);

  // A leftover hook card (no pending entry) is closed by the next tick.
  const left = setup();
  left.store.putPosted('b0|s1|hook:old', {
    bindingId: 'b0', sessionId: 's1', key: 'hook:old', kind: 'input', status: 'open',
    adapter: 'slack', ref: { channel: 'C0', ts: 'x1' }, item: hookItem(perm), partial: {},
  });
  await left.bridge.tick();
  assert.equal(left.store.posted('b0|s1|hook:old').status, 'closed');

  // Question item answered by a thread reply.
  const q = setup();
  const qWait = q.bridge.awaitDecision('s1', hookItem(ask([q1])));
  await new Promise((r) => setImmediate(r));
  assert.equal(q.slack.posts.length, 1);
  await q.bridge.handleReply('slack', {
    channel: 'C0', ts: 'r1', thread: q.slack.posts[0].ref.ts, user, messageId: 'q1', text: 'use pg please',
  });
  assert.deepEqual(await qWait, { response: { answers: { q0: 'use pg please' } }, by: 'alice' });
  assert.equal(q.host.answers.length, 0);

  // Two approvals bindings: both get a card; answering one closes the other.
  const two2 = setup({ approvals: [true, true] });
  const both = two2.bridge.awaitDecision('s1', hookItem(perm));
  await new Promise((r) => setImmediate(r));
  assert.equal(two2.slack.posts.length, 2);
  await two2.bridge.handleReply('slack', click(two2.slack.posts[1].ref, 'd:decline', 4));
  assert.deepEqual(await both, { response: { decision: 'decline' }, by: 'alice' });
  const closed = two2.slack.updates.filter((u) => u.ref.ts === two2.slack.posts[0].ref.ts);
  assert.equal(closed.length, 1, 'the other binding card is closed');
  assert.match(closed[0].card.resolved.text, /Deny — by alice/);
  assert.ok([...two2.store.allPosted()].every(([, p]) => p.status === 'closed'));

  // Abort: the terminal took over.
  const ab = setup({ approvals: [true, true] });
  const ctl = new AbortController();
  const aw = ab.bridge.awaitDecision('s1', hookItem(perm), { signal: ctl.signal });
  await new Promise((r) => setImmediate(r));
  ctl.abort();
  assert.equal(await aw, null);
  await new Promise((r) => setImmediate(r));
  assert.equal(ab.slack.updates.length, 2);
  assert.ok(ab.slack.updates.every((u) => u.card.resolved.text === 'Answered in the terminal.'));
  assert.equal(ab.clock.timers.size, 0);
  assert.equal(ab.bridge.pending.size, 0);

  // Already-aborted signal.
  const pre = setup();
  const done = new AbortController();
  done.abort();
  assert.equal(await pre.bridge.awaitDecision('s1', hookItem(perm), { signal: done.signal }), null);
  assert.equal(pre.bridge.pending.size, 0);
  assert.ok([...pre.store.allPosted()].every(([, p]) => p.status === 'closed'));
  assert.equal(pre.clock.timers.size, 0);
  assert.equal(pre.slack.posts.length, 0, 'a pre-aborted signal posts nothing');

  // Settled while the post is in flight: the late card is closed, not left open.
  for (const how of ['abort', 'timeout']) {
    const fl = setup();
    let release;
    fl.slack.post = (target) => new Promise((res) => { release = () => res({ channel: target.channel, ts: 'late1' }); });
    const stop = new AbortController();
    const inflight = fl.bridge.awaitDecision('s1', hookItem(perm), { signal: stop.signal });
    await new Promise((r) => setImmediate(r));
    if (how === 'abort') stop.abort(); else fl.clock.fire([...fl.clock.timers.keys()][0]);
    assert.equal(await inflight, null);
    release();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const [[, posted]] = [...fl.store.allPosted()];
    assert.equal(posted.status, 'closed', `${how}: the late card is closed`);
    assert.equal(fl.slack.updates.length, 1);
    assert.equal(fl.slack.updates[0].ref.ts, 'late1');
    assert.equal(fl.slack.updates[0].card.resolved.text, how === 'abort' ? 'Answered in the terminal.' : 'No answer in time — answer in the terminal.');
  }
}

console.log('messengers-claude: all assertions passed');
