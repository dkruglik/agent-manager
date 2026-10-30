import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MessengerBridge } from '../src/messengers/bridge.js';
import { BindingStore, validateBinding } from '../src/messengers/store.js';

// The bridge end to end with a fake host and adapter. Every scenario builds
// its own fixture, so none depends on another having run.

function fakeAdapter() {
  const posts = [];
  const updates = [];
  let n = 0;
  return {
    posts, updates,
    configured: () => true,
    start(h) { this.hooks = h; h.onStatus({ connected: true, error: null }); },
    async post(target, card) { const ref = { channel: target.channel, ts: `t${++n}` }; posts.push({ target, card, ref }); return ref; },
    async update(ref, card) { updates.push({ ref, card }); },
  };
}

function fakeHost() {
  const h = {
    list: [
      { id: 's1', name: 'alpha', cli: 'claude', state: 'working', inputRequired: null },
      { id: 's2', name: 'beta', cli: 'codex', state: 'waiting', inputRequired: null },
    ],
    digests: { s1: { id: 'a:1', text: 'old answer' }, s2: { id: 'b:1', text: 'beta answer' } },
    typed: {},
    answers: [],
    prompts: [],
    isLocked: false,
    sessions: () => h.list.map((s) => ({ ...s })),
    groupOf: (id) => (['s1', 's2'].includes(id) ? { id: 'g1', name: 'proj' } : null),
    locked: () => h.isLocked,
    link: (s) => `http://am/#session=${s.id}`,
    requests: async (s) => h.typed[s.id] || [],
    digest: async (s) => h.digests[s.id] || null,
    answer: async (s, key, response) => { h.answers.push({ id: s.id, key, response }); h.typed[s.id] = []; h.list.find((x) => x.id === s.id).inputRequired = null; },
    prompt: async (s, text, opts) => { h.prompts.push({ id: s.id, text, requestId: opts.requestId }); },
  };
  return h;
}

const setState = (host, id, patch) => Object.assign(host.list.find((s) => s.id === id), patch);

// A started bridge bound to channel C1 (group g1), past its baseline tick.
async function fixture(t, { approvals = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-messengers-'));
  const clock = { now: 1_000_000 };
  const now = () => clock.now;
  const file = path.join(root, 'messengers.json');
  const store = new BindingStore(file, { now });
  const host = fakeHost();
  const slack = fakeAdapter();
  const bridge = new MessengerBridge({ host, store, adapters: new Map([['slack', slack]]), now, settleMs: 5000, digestEveryMs: 0, tickMs: 1e9 });
  const valid = validateBinding({ adapter: 'slack', target: { channel: 'C1' }, scope: { type: 'group', id: 'g1' } }, { adapters: ['slack'] });
  const binding = store.putBinding({ ...valid, allowedUsers: ['U1'], approvals });
  bridge.start();
  t.after(async () => { await bridge.stop(); fs.rmSync(root, { recursive: true, force: true }); });
  await bridge.tick();
  return { clock, now, file, store, host, slack, bridge, binding };
}

// s1 finishes a turn and its card is announced in the channel.
async function finishFirst(f) {
  f.host.digests.s1 = { id: 'a:2', text: '**Done** — tests pass' };
  setState(f.host, 's1', { state: 'waiting' });
  await f.bridge.tick();
  f.clock.now += 6000;
  await f.bridge.tick();
  return f.slack.posts[0];
}

const reply = (extra) => ({ channel: 'C1', ts: 'm1', thread: null, user: { id: 'U1' }, ...extra });
const typedPermission = (key, details) => [{ key, kind: 'permission', details, choices: [{ value: 'accept', label: 'Approve once' }, { value: 'decline', label: 'Deny' }] }];
const needInput = (f, id, kind, cli, detectedAt, typed) => {
  f.host.typed[id] = typed;
  setState(f.host, id, { inputRequired: { kind, cli, detectedAt } });
};

test('binding validation rejects unknown adapters and scopes, and defaults are safe', () => {
  assert.throws(() => validateBinding({ adapter: 'nope' }, { adapters: ['slack'] }), /unknown messenger/);
  assert.throws(() => validateBinding({ adapter: 'slack', target: { channel: 'C1' }, scope: { type: 'x', id: 'a' } }, { adapters: ['slack'] }), /scope/);
  const valid = validateBinding({ adapter: 'slack', target: { channel: 'C1' }, scope: { type: 'group', id: 'g1' } }, { adapters: ['slack'] });
  assert.equal(valid.approvals, false, 'approvals are opt-in');
  assert.deepEqual(valid.events, ['input-required', 'finished']);
});

test('binding a channel does not replay old answers', async (t) => {
  const f = await fixture(t);
  await f.bridge.tick();
  assert.equal(f.slack.posts.length, 0, 'first observation only records a baseline');
});

test('a finished card is posted once the session settles with a new reply', async (t) => {
  const f = await fixture(t);
  f.host.digests.s1 = { id: 'a:2', text: '**Done** — tests pass' };
  setState(f.host, 's1', { state: 'waiting' });
  await f.bridge.tick();
  assert.equal(f.slack.posts.length, 0, 'not before the settle window');
  f.clock.now += 6000;
  await f.bridge.tick();
  assert.equal(f.slack.posts.length, 1);
  assert.equal(f.slack.posts[0].card.kind, 'finished');
  assert.match(f.slack.posts[0].card.body, /tests pass/);
  await f.bridge.tick();
  assert.equal(f.slack.posts.length, 1, 'the same reply is announced once');

  // An idle agent is not re-read forever: only shortly after each turn.
  f.clock.now += 120_000;
  f.host.digests.s1 = { id: 'a:3', text: 'late' };
  await f.bridge.tick();
  assert.equal(f.slack.posts.length, 1, 'no transcript reads long after the turn settled');
  setState(f.host, 's1', { state: 'working' });
  await f.bridge.tick();
  setState(f.host, 's1', { state: 'waiting' });
  await f.bridge.tick();
  f.clock.now += 6000;
  await f.bridge.tick();
  assert.equal(f.slack.posts.length, 2, 'the next turn is announced');
  assert.equal(f.slack.posts[1].card.body, 'late');
});

test('a reply in a finished card thread prompts that agent, once per delivery', async (t) => {
  const f = await fixture(t);
  const card = await finishFirst(f);
  const msg = reply({ thread: card.ref.ts, messageId: 'e1', text: 'now write docs' });
  assert.deepEqual(await f.bridge.handleReply('slack', msg), { prompted: 's1' });
  assert.equal(f.host.prompts[0].text, 'now write docs');
  assert.deepEqual(await f.bridge.handleReply('slack', msg), { ignored: 'duplicate' }, 'Slack redelivery is not a second prompt');
  assert.equal(f.host.prompts.length, 1);
});

test('only allowed users can prompt an agent', async (t) => {
  const f = await fixture(t);
  const card = await finishFirst(f);
  const r = await f.bridge.handleReply('slack', reply({ ts: 'm2', thread: card.ref.ts, user: { id: 'U9' }, messageId: 'e2', text: 'rm -rf' }));
  assert.deepEqual(r, { refused: 'user-not-allowed' });
  assert.equal(f.host.prompts.length, 0);
});

test('in a group channel "name: text" addresses one agent', async (t) => {
  const f = await fixture(t);
  const r = await f.bridge.handleReply('slack', reply({ ts: 'm3', messageId: 'e3', text: 'beta: rebase please' }));
  assert.deepEqual(r, { prompted: 's2' });
  assert.equal(f.host.prompts[0].text, 'rebase please');
});

test('a typed question is answered by its buttons and the card closes', async (t) => {
  const f = await fixture(t);
  needInput(f, 's2', 'question', 'codex', 'x', [{ key: 'k1', kind: 'question', questions: [{ id: 'q1', text: 'Which DB?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] }]);
  await f.bridge.tick();
  const qCard = f.slack.posts.at(-1);
  assert.equal(qCard.card.kind, 'input');
  assert.deepEqual(qCard.card.options.map((o) => o.label), ['Postgres', 'SQLite']);
  let r = await f.bridge.handleReply('slack', reply({ ts: qCard.ref.ts, user: { id: 'U1', name: 'dk' }, messageId: 'e4', optionId: 'q:0:1' }));
  assert.deepEqual(r, { answered: 'k1' });
  assert.deepEqual(f.host.answers[0], { id: 's2', key: 'k1', response: { answers: { q1: 'SQLite' } } });
  assert.match(f.slack.updates.at(-1).card.resolved.text, /dk/);
  r = await f.bridge.handleReply('slack', reply({ ts: qCard.ref.ts, messageId: 'e5', optionId: 'q:0:0' }));
  assert.deepEqual(r, { refused: 'closed' }, 'a second click on a closed card does nothing');
});

test('a typed question is answered by a thread reply', async (t) => {
  const f = await fixture(t);
  needInput(f, 's2', 'question', 'codex', 'y', [{ key: 'k2', kind: 'question', questions: [{ id: 'q1', text: 'Name?', options: [] }] }]);
  await f.bridge.tick();
  const r = await f.bridge.handleReply('slack', reply({ ts: 'm6', thread: f.slack.posts.at(-1).ref.ts, messageId: 'e6', text: 'orders' }));
  assert.deepEqual(r, { answered: 'k2' });
  assert.deepEqual(f.host.answers[0].response, { answers: { q1: 'orders' } });
});

test('a permission card has no approve buttons without opt-in, and closes when resolved elsewhere', async (t) => {
  const f = await fixture(t);
  needInput(f, 's2', 'permission', 'codex', 'z', typedPermission('k3', '{"command":"npm i"}'));
  await f.bridge.tick();
  const pCard = f.slack.posts.at(-1);
  assert.equal(pCard.card.options.length, 0, 'no approve buttons without opt-in');
  const r = await f.bridge.handleReply('slack', reply({ ts: pCard.ref.ts, messageId: 'e7', optionId: 'd:accept' }));
  assert.deepEqual(r, { refused: 'approvals-off' });
  assert.equal(f.host.answers.length, 0);

  // Resolved in the terminal: the card is closed without a click.
  f.host.typed.s2 = [];
  setState(f.host, 's2', { inputRequired: null });
  await f.bridge.tick();
  assert.match(f.slack.updates.at(-1).card.resolved.text, /outside this chat/);
});

test('with approvals on, a permission card can be approved from chat', async (t) => {
  const f = await fixture(t, { approvals: true });
  needInput(f, 's2', 'permission', 'codex', 'w', typedPermission('k4', '{}'));
  await f.bridge.tick();
  const pCard = f.slack.posts.at(-1);
  assert.deepEqual(pCard.card.options.map((o) => o.id), ['d:accept', 'd:decline']);
  const r = await f.bridge.handleReply('slack', reply({ ts: pCard.ref.ts, messageId: 'e8', optionId: 'd:accept' }));
  assert.deepEqual(r, { answered: 'k4' });
  assert.deepEqual(f.host.answers[0].response, { decision: 'accept' });
});

test('an untyped dialog (e.g. Claude) links to the terminal', async (t) => {
  const f = await fixture(t);
  setState(f.host, 's1', { inputRequired: { kind: 'permission', cli: 'claude', detectedAt: 'c1' } });
  await f.bridge.tick();
  const gCard = f.slack.posts.at(-1);
  assert.equal(gCard.card.options.length, 0);
  assert.match(gCard.card.hint, /terminal/);
});

test('the privacy lock stops both directions', async (t) => {
  const f = await fixture(t);
  const card = await finishFirst(f);
  f.host.isLocked = true;
  const before = f.slack.posts.length;
  setState(f.host, 's1', { inputRequired: { kind: 'permission', cli: 'claude', detectedAt: 'c2' } });
  await f.bridge.tick();
  assert.equal(f.slack.posts.length, before, 'nothing is posted while locked');
  const r = await f.bridge.handleReply('slack', reply({ ts: 'm9', thread: card.ref.ts, messageId: 'e9', text: 'hi' }));
  assert.deepEqual(r, { refused: 'locked' });
  assert.equal(f.host.prompts.length, 0);
});

test('posted cards and baselines survive a restart', async (t) => {
  const f = await fixture(t);
  await finishFirst(f);
  setState(f.host, 's1', { inputRequired: { kind: 'permission', cli: 'claude', detectedAt: 'c1' } });
  await f.bridge.tick();
  const store2 = new BindingStore(f.file, { now: f.now });
  const slack2 = fakeAdapter();
  const bridge2 = new MessengerBridge({ host: f.host, store: store2, adapters: new Map([['slack', slack2]]), now: f.now, settleMs: 0, digestEveryMs: 0, tickMs: 1e9 });
  bridge2.start();
  t.after(() => bridge2.stop());
  await bridge2.tick();
  assert.equal(slack2.posts.length, 0, 'no duplicate cards or replays after a restart');
});

test('/am status lists agents for allowed users only', async (t) => {
  const f = await fixture(t);
  setState(f.host, 's1', { inputRequired: { kind: 'permission', cli: 'claude', detectedAt: 'c2' } });
  assert.match(await f.bridge.handleCommand('slack', { channel: 'C1', user: { id: 'U1' }, text: 'status' }), /alpha.*needs input/);
  assert.match(await f.bridge.handleCommand('slack', { channel: 'C1', user: { id: 'U9' }, text: 'status' }), /not on the allowed/);
});
