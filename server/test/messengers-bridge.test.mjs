import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MessengerBridge } from '../src/messengers/bridge.js';
import { finishedDigest } from '../src/messengers/finished-digest.js';
import { BindingStore } from '../src/messengers/store.js';
import { finishedMark, createFilter } from '../src/messengers/outbound.js';
import { inputCard, reviewable, TOO_LONG } from '../src/messengers/cards.js';
import { renderBlocks } from '../src/messengers/adapters/slack.js';
import { fakeAdapter, setup, permission } from './messengers-bridge-fixtures.mjs';

// Bridge failure paths: a failed lookup, post or transcript read must neither
// close cards nor lose or replay events.

test('input cards redact configured secrets in details before posting', async () => {
  const secret = 'totally-a-bot-token';
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-messengers-bridge-secrets-'));
  const store = new BindingStore(path.join(root, 'messengers.json'));
  const host = {
    list: [{ id: 's1', name: 'alpha', cli: 'codex', state: 'working', inputRequired: { kind: 'permission', cli: 'codex', detectedAt: 'x' } }],
    sessions: () => host.list.map((s) => ({ ...s })),
    groupOf: () => ({ id: 'g1', name: 'proj' }),
    locked: () => false, lockState: () => ({ locked: false, reason: null }), onLock: () => () => {},
    ready: async () => 'skipped', lockScope: () => ({ signal: new AbortController().signal, release() {} }),
    link: () => null,
    requests: async () => [{ key: 'req1', kind: 'permission', details: `echo ${secret}`, choices: [{ value: 'accept', label: 'Approve once' }] }],
    digest: async () => null, since: async () => null, answer: async () => {}, prompt: async () => {},
  };
  const slack = fakeAdapter();
  const bridge = new MessengerBridge({
    host, store, adapters: new Map([['slack', slack]]), dataDir: root, filter: createFilter({ SLACK_BOT_TOKEN: secret }),
    log: () => {}, tickMs: 1e9, settleMs: 0, digestEveryMs: 0,
  });
  store.putBinding({
    id: 'b0', adapter: 'slack', target: { channel: 'C0' }, scope: { type: 'group', id: 'g1' },
    events: ['input-required'], allowedUsers: ['U1'], approvals: true, createdAt: 'x',
  });
  bridge.statuses.set('slack', { connected: true, error: null });
  await bridge.tick();
  assert.ok(slack.posts[0].card.details.includes('[redacted]'));
  assert.ok(!slack.posts[0].card.details.includes(secret));
});

test('a failed request lookup keeps typed cards open and posts nothing generic', async () => {
  const t = setup({ events: ['input-required'] });
  t.host.typed = [permission];
  t.host.list[0].inputRequired = { kind: 'permission', cli: 'codex', detectedAt: 'x' };
  await t.tick();
  assert.equal(t.slack.posts.length, 1);
  assert.equal(t.store.posted('b0|s1|req1').status, 'open');
  t.host.requestsError = Object.assign(new Error('app-server down'), { code: 'ECONNREFUSED' });
  await t.tick();
  assert.equal(t.store.posted('b0|s1|req1').status, 'open', 'the typed card stays open');
  assert.equal(t.slack.posts.length, 1, 'no generic card was posted');
  assert.equal(t.slack.updates.length, 0);
  const failed = t.logs.find((e) => e.event === 'requests-failed');
  assert.deepEqual([failed.session, failed.error], ['s1', 'ECONNREFUSED']);
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

test('hooks.wait leaves a too-long permission request to the terminal at once', async () => {
  const t = setup();
  const timers = [];
  t.bridge.setTimer = (fn, ms) => { timers.push({ fn, ms }); return timers.length; };
  const long = { ...permission, details: 'x'.repeat(2000) };
  // Resolved before anything else can run: no post, no timer, nothing to wait for.
  const outcome = await Promise.race([t.bridge.hooks.wait('s1', long), new Promise((r) => setImmediate(r, 'still waiting'))]);
  assert.equal(outcome, null, 'resolves at once');
  assert.equal(t.slack.posts.length, 0);
  assert.equal(timers.length, 0, 'no timer was started');
  assert.equal(t.bridge.hooks.pending.size, 0);
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
  t.slack.post = async () => {
    attempts += 1;
    throw Object.assign(new Error('slack chat.postMessage: channel_not_found'), { publicMessage: 'slack chat.postMessage: channel_not_found' });
  };
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
  const real = fakeAdapter();
  t.slack.post = real.post;
  await t.tick(20_000);
  assert.equal(real.posts.length, 1, 'posted once the channel works again');
  assert.equal(t.bridge.lastError('b0'), null, 'cleared by a success');
});

test('a request lookup that keeps failing backs the binding off like a failed post', async () => {
  const t = setup({ events: ['input-required'] });
  t.host.list[0].inputRequired = { kind: 'permission', cli: 'codex', detectedAt: 'x' };
  let lookups = 0;
  t.host.requests = async () => { lookups += 1; throw new Error('app-server down'); };
  await t.tick();
  assert.equal(lookups, 1);
  assert.equal(t.bridge.lastError('b0'), 'could not look up open dialogs — see the server log');
  await t.tick(4000);
  assert.equal(lookups, 1, 'no retry while backing off');
  await t.tick(1000);
  assert.equal(lookups, 2, 'retried after 5 s');
  assert.equal(t.logs.filter((e) => e.event === 'requests-failed').length, 2, 'one log line per attempt, not per tick');
  assert.equal(t.slack.posts.length, 0, 'nothing generic posted for an unknown dialog');
  for (let i = 0; i < 10; i++) t.bridge.noteOutcome({ id: 'b0' }, new Error('x'));
  await t.tick(299_999);
  assert.equal(lookups, 2, 'still backing off just short of 5 minutes');
  await t.tick(1);
  assert.equal(lookups, 3, 'the wait is capped at 5 minutes');
});

test('lastError shows only what an adapter marked public, never paths or network details', async () => {
  const t = setup({ events: ['finished'] });
  t.host.digestImpl = async () => ({ id: 'a:1', text: 'old' });
  await t.tick();
  t.host.digestImpl = async () => ({ id: 'a:2', text: 'new answer' });
  t.host.list[0].state = 'waiting';
  t.slack.post = async () => { throw Object.assign(new Error("EACCES: permission denied, open '/home/op/.am/data/messengers.json.tmp'"), { code: 'EACCES' }); };
  await t.tick(1000);
  assert.equal(t.bridge.lastError('b0'), 'could not post — see the server log');
  const logged = t.logs.find((e) => e.event === 'tick-failed');
  assert.equal(logged.error, 'EACCES', 'the error code is logged, not its message (paths, text)');
});

test('a reply the operator already read in the web UI posts no finished card', async () => {
  const t = setup({ events: ['finished'] });
  t.host.digestImpl = async () => ({ id: 'a:1', text: 'old', read: false });
  await t.tick();
  t.host.digestImpl = async () => ({ id: 'a:2', text: 'seen on screen', read: true });
  t.host.list[0].state = 'waiting';
  await t.tick(1000);
  assert.equal(t.slack.posts.length, 0, 'nothing posted');
  assert.equal(finishedMark(t.store, 'slack', 'C0', 's1'), 'a:2', 'recorded as seen');
  assert.deepEqual(t.logs.filter((e) => e.event === 'skipped-read'), [
    { event: 'skipped-read', binding: 'b0', session: 's1', kind: 'finished' },
  ]);
  await t.tick(1000);
  assert.equal(t.slack.posts.length, 0, 'and not retried');
});

test('an unread reply still posts, and a later unread reply after a read one posts too', async () => {
  const t = setup({ events: ['finished'] });
  t.host.digestImpl = async () => ({ id: 'a:1', text: 'old', read: false });
  await t.tick();
  t.host.list[0].state = 'waiting';
  t.host.digestImpl = async () => ({ id: 'a:2', text: 'unread answer', read: false });
  await t.tick(1000);
  assert.equal(t.slack.posts.length, 1);
  assert.equal(t.slack.posts[0].card.body, 'unread answer');
  t.host.digestImpl = async () => ({ id: 'a:3', text: 'read answer', read: true });
  await t.tick(1000);
  assert.equal(t.slack.posts.length, 1, 'the read one is skipped');
  t.host.digestImpl = async () => ({ id: 'a:4', text: 'next, unread', read: false });
  await t.tick(1000);
  assert.equal(t.slack.posts.length, 2);
  assert.equal(t.slack.posts[1].card.body, 'next, unread');
});

test('a long finished delay still opens the look window after it', async () => {
  const t = setup({ events: ['finished'] });
  t.bridge.settleMs = 600_000;
  t.host.digestImpl = async () => ({ id: 'a:1', text: 'old' });
  await t.tick();
  t.host.digestImpl = async () => ({ id: 'a:2', text: 'late answer' });
  t.host.list[0].state = 'waiting';
  await t.tick(1000);
  await t.tick(500_000);
  assert.equal(t.slack.posts.length, 0, 'still inside the delay');
  await t.tick(100_000);
  assert.equal(t.slack.posts.length, 1, 'posted once the delay has passed');
});

test('a reply read during the finished delay is skipped once, and not retried', async () => {
  const t = setup({ events: ['finished'] });
  t.bridge.settleMs = 8000;
  t.host.digestImpl = async () => ({ id: 'a:1', text: 'old', read: false });
  await t.tick();
  t.host.digestImpl = async () => ({ id: 'a:2', text: 'new', read: false });
  t.host.list[0].state = 'waiting';
  await t.tick(1000);
  await t.tick(3000);
  assert.equal(t.slack.posts.length, 0, 'inside the delay');
  t.host.digestImpl = async () => ({ id: 'a:2', text: 'new', read: true });
  await t.tick(5000);
  assert.equal(t.slack.posts.length, 0, 'read before the delay ended');
  assert.equal(finishedMark(t.store, 'slack', 'C0', 's1'), 'a:2');
  assert.equal(t.logs.filter((e) => e.event === 'skipped-read').length, 1);
  await t.tick(1000);
  assert.equal(t.slack.posts.length, 0);
  assert.equal(t.logs.filter((e) => e.event === 'skipped-read').length, 1, 'logged once');
});

test('a host digest built with finishedDelay mapping: a matching mark posts nothing, a changed hash posts', async () => {
  const t = setup({ events: ['finished'] });
  let mark = null;
  let out = { src: 'rollout', seq: 1, hash: 'h1' };
  const text = { lastAssistantMd: 'the answer', lastAssistantText: 'plain' };
  t.host.digestImpl = async () => finishedDigest(out, text, mark);
  await t.tick();
  out = { src: 'rollout', seq: 2, hash: 'h2' };
  mark = { src: 'rollout', seq: 2, hash: 'h2' };
  t.host.list[0].state = 'waiting';
  await t.tick(1000);
  assert.equal(t.slack.posts.length, 0, 'mark covers the reply');
  out = { src: 'rollout', seq: 3, hash: 'h3' };
  await t.tick(1000);
  assert.equal(t.slack.posts.length, 1, 'new reply, old mark');
  assert.equal(t.slack.posts[0].card.body, 'the answer');
});

// ---------- transcript and finished (outbound.js) ----------
