import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MessengerBridge } from '../src/messengers/bridge.js';
import { BindingStore } from '../src/messengers/store.js';
import { inputCard, reviewable, TOO_LONG } from '../src/messengers/cards.js';
import { renderBlocks } from '../src/messengers/adapters/slack.js';

// Bridge failure paths: a failed lookup, post or transcript read must neither
// close cards nor lose or replay events.

function fakeAdapter() {
  const posts = [];
  const updates = [];
  const adapter = {
    posts, updates, failPosts: 0,
    configured: () => true,
    start(h) { h.onStatus({ connected: true, error: null }); },
    async post(target, card) {
      if (adapter.failPosts > 0) { adapter.failPosts -= 1; throw new Error('post failed'); }
      const ref = { channel: target.channel, ts: `t${posts.length + 1}` };
      posts.push({ target, card, ref });
      return ref;
    },
    async update(ref, card) { updates.push({ ref, card }); },
  };
  return adapter;
}

function setup({ events = ['input-required', 'finished'] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-messengers-bridge-'));
  let clock = 1_000_000;
  const store = new BindingStore(path.join(root, 'messengers.json'), { now: () => clock });
  const host = {
    list: [{ id: 's1', name: 'alpha', cli: 'codex', state: 'working', inputRequired: null }],
    typed: [], requestsError: null, digestImpl: async () => null, isLocked: false,
    sessions: () => host.list.map((s) => ({ ...s })),
    groupOf: () => ({ id: 'g1', name: 'proj' }),
    locked: () => host.isLocked,
    link: (s) => `http://am/#session=${s.id}`,
    requests: async () => {
      if (host.requestsError) { const e = host.requestsError; host.requestsError = null; throw e; }
      return host.typed;
    },
    digest: (s) => host.digestImpl(s),
    answer: async () => {}, prompt: async () => {},
  };
  const slack = fakeAdapter();
  const logs = [];
  const bridge = new MessengerBridge({
    host, store, adapters: new Map([['slack', slack]]), now: () => clock, log: (e) => logs.push(e),
    tickMs: 1e9, settleMs: 0, digestEveryMs: 0,
  });
  store.putBinding({
    id: 'b0', adapter: 'slack', target: { channel: 'C0' }, scope: { type: 'group', id: 'g1' },
    events, allowedUsers: ['U1'], approvals: true, createdAt: 'x',
  });
  bridge.statuses.set('slack', { connected: true, error: null });
  return { bridge, host, slack, store, logs, tick: (ms = 0) => { clock += ms; return bridge.tick(); } };
}

const permission = {
  key: 'req1', kind: 'permission', details: '{"command":"ls"}',
  choices: [{ value: 'accept', label: 'Approve once' }, { value: 'decline', label: 'Deny' }],
};

test('a failed request lookup keeps typed cards open and posts nothing generic', async () => {
  const t = setup({ events: ['input-required'] });
  t.host.typed = [permission];
  t.host.list[0].inputRequired = { kind: 'permission', cli: 'codex', detectedAt: 'x' };
  await t.tick();
  assert.equal(t.slack.posts.length, 1);
  assert.equal(t.store.posted('b0|s1|req1').status, 'open');
  t.host.requestsError = new Error('app-server down');
  await t.tick();
  assert.equal(t.store.posted('b0|s1|req1').status, 'open', 'the typed card stays open');
  assert.equal(t.slack.posts.length, 1, 'no generic card was posted');
  assert.equal(t.slack.updates.length, 0);
  const failed = t.logs.find((e) => e.event === 'requests-failed');
  assert.deepEqual([failed.session, failed.error], ['s1', 'app-server down']);
  await t.tick();
  assert.equal(t.store.posted('b0|s1|req1').status, 'open', 'still open once lookups work again');
});

test('a corrupt messengers.json is set aside, not overwritten', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-messengers-corrupt-'));
  const file = path.join(dir, 'messengers.json');
  fs.writeFileSync(file, '{not json');
  const warnings = [];
  const warn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  let store;
  try { store = new BindingStore(file, { now: () => 4242 }); } finally { console.warn = warn; }
  const aside = path.join(dir, 'messengers.json.corrupt-4242');
  assert.equal(fs.readFileSync(aside, 'utf8'), '{not json');
  assert.equal(fs.existsSync(file), false);
  assert.deepEqual(store.bindings(), []);
  assert.equal(warnings.length, 1);
  store.putSeen('k', 'v');
  assert.equal(fs.readFileSync(aside, 'utf8'), '{not json', 'a later write leaves the copy alone');

  const noBindings = path.join(dir, 'other.json');
  fs.writeFileSync(noBindings, '{"posted":{}}');
  new BindingStore(noBindings, { now: () => 7 });
  assert.ok(fs.existsSync(`${noBindings}.corrupt-7`), 'JSON without a bindings array is set aside too');

  assert.deepEqual(new BindingStore(path.join(dir, 'missing.json')).bindings(), [], 'a missing file just starts empty');
  assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('missing')), []);
});

test('approval details are escaped for Slack and never cut', () => {
  const fenced = (blocks) => blocks.filter((b) => b.text?.text.startsWith('```')).map((b) => b.text.text.slice(3, -3));
  const details = '<https://a|b> <!here> a&lt;b';
  assert.deepEqual(fenced(renderBlocks({ title: 't', details })), ['&lt;https://a|b&gt; &lt;!here&gt; a&amp;lt;b']);

  // Worst case: every character expands to &amp;. All of it is still shown, whole entities only.
  const long = '&'.repeat(1800);
  const parts = fenced(renderBlocks({ title: 't', details: long }));
  assert.ok(parts.length > 1);
  assert.ok(parts.every((p) => p.length + 6 <= 3000));
  assert.equal(parts.join(''), '&amp;'.repeat(1800));
});

test('details containing a code fence are not reviewable from chat', () => {
  const item = { kind: 'permission', details: 'echo ```x```', choices: [{ value: 'accept', label: 'Approve once' }] };
  assert.equal(reviewable(item), false);
  const card = inputCard({ agent: { name: 'a' }, link: null, item, approvals: true });
  assert.deepEqual(card.options, []);
  assert.equal(card.hint, TOO_LONG);
  assert.equal(reviewable({ ...item, details: 'echo x' }), true);
});

test('awaitDecision leaves a too-long permission request to the terminal at once', async () => {
  const t = setup();
  const timers = [];
  t.bridge.setTimer = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  const long = { ...permission, details: 'x'.repeat(2000) };
  const outcome = await Promise.race([t.bridge.awaitDecision('s1', long), new Promise((r) => setTimeout(r, 200, 'still waiting'))]);
  assert.equal(outcome, null, 'resolves at once');
  assert.equal(t.slack.posts.length, 0);
  assert.equal(timers.length, 0, 'no timer was started');
  assert.equal(t.bridge.pending.size, 0);
});

test('a finished card whose post failed is posted on the next tick', async () => {
  const t = setup({ events: ['finished'] });
  t.host.digestImpl = async () => ({ id: 'a:1', text: 'old' });
  await t.tick();
  t.host.digestImpl = async () => ({ id: 'a:2', text: 'new answer' });
  t.host.list[0].state = 'waiting';
  t.slack.failPosts = 1;
  await t.tick();
  assert.equal(t.slack.posts.length, 0);
  assert.ok(t.logs.some((e) => e.event === 'tick-failed'));
  await t.tick(5000); // past the failed binding's first backoff
  assert.equal(t.slack.posts.length, 1, 'retried');
  assert.equal(t.slack.posts[0].card.body, 'new answer');
  await t.tick(1000);
  assert.equal(t.slack.posts.length, 1, 'and announced once');
});

test('a failed transcript read does not become the baseline', async () => {
  const t = setup({ events: ['finished'] });
  t.host.digestImpl = async () => { throw new Error('transcript unreadable'); };
  t.host.list[0].state = 'waiting';
  await t.tick();
  const failed = t.logs.find((e) => e.event === 'digest-failed');
  assert.deepEqual([failed.session, failed.error], ['s1', 'transcript unreadable']);
  assert.equal(t.store.seen('b0|s1'), null, 'still no baseline');
  t.host.digestImpl = async () => ({ id: 'a', text: 'old' });
  await t.tick(1000);
  assert.equal(t.slack.posts.length, 0, 'the old answer becomes the baseline');
  assert.equal(t.store.seen('b0|s1'), 'a');
});

test('/am status lists nothing while locked', async () => {
  const t = setup();
  const ask = () => t.bridge.handleCommand('slack', { channel: 'C0', user: { id: 'U1' }, text: 'status' });
  assert.match(await ask(), /alpha/);
  t.host.isLocked = true;
  const reply = await ask();
  assert.equal(reply, 'Agent Manager is locked.');
  assert.doesNotMatch(reply, /alpha/);
});

test('a binding whose posts keep failing is backed off, reported, and cleared on success', async () => {
  const t = setup({ events: ['finished'] });
  t.host.digestImpl = async () => ({ id: 'a:1', text: 'old' });
  await t.tick();
  t.host.digestImpl = async () => ({ id: 'a:2', text: 'new answer' });
  t.host.list[0].state = 'waiting';
  let attempts = 0;
  t.slack.post = async () => { attempts += 1; throw new Error('slack chat.postMessage: channel_not_found'); };
  await t.tick(1000);
  assert.equal(attempts, 1);
  assert.equal(t.bridge.lastError('b0'), 'slack chat.postMessage: channel_not_found');
  await t.tick(4000);
  assert.equal(attempts, 1, 'skipped while backing off');
  await t.tick(1000);
  assert.equal(attempts, 2, 'retried after 5 s');
  await t.tick(9000);
  assert.equal(attempts, 2, 'the wait doubled to 10 s');
  await t.tick(1000);
  assert.equal(attempts, 3);
  assert.equal(t.logs.filter((e) => e.event === 'tick-failed').length, 3, 'one log line per attempt, not per tick');
  for (let i = 0; i < 10; i++) t.bridge.noteOutcome({ id: 'b0' }, new Error('x'));
  assert.equal(t.bridge.failing.get('b0').retryAt - t.bridge.now(), 300_000, 'capped at 5 minutes');
  t.bridge.waitingSince.clear(); // a long wait leaves the look-for window; start a new one

  const real = fakeAdapter();
  t.slack.post = real.post;
  await t.tick(300_000);
  assert.equal(t.bridge.lastError('b0'), null, 'cleared by a success');
  assert.equal(t.bridge.failing.size, 0);
});
