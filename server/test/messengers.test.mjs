import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createBridge } from '../src/messengers/bridge.js';
import { resolveMessengerConfig } from '../src/config.js';
import { createStore, validateBinding } from '../src/messengers/store.js';
import { EventEmitter } from 'node:events';
import { renderBlocks, toMrkdwn, createSlackAdapter } from '../src/messengers/adapters/slack.js';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-messengers-'));
let clock = 1_000_000;
const now = () => clock;

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

try {
  // ---------- binding validation ----------
  assert.throws(() => validateBinding({ adapter: 'nope' }, { adapters: ['slack'] }), /unknown messenger/);
  assert.throws(() => validateBinding({ adapter: 'slack', target: { channel: 'C1' }, scope: { type: 'x', id: 'a' } }, { adapters: ['slack'] }), /scope/);
  const valid = validateBinding({ adapter: 'slack', target: { channel: 'C1' }, scope: { type: 'group', id: 'g1' } }, { adapters: ['slack'] });
  assert.equal(valid.approvals, false, 'approvals are opt-in');
  assert.deepEqual(valid.events, ['input-required', 'finished']);

  const store = createStore(path.join(root, 'messengers.json'), { now });
  const host = fakeHost();
  const slack = fakeAdapter();
  const bridge = createBridge({ host, store, adapters: new Map([['slack', slack]]), now, settleMs: 5000, digestEveryMs: 0, tickMs: 1e9 });
  const binding = store.putBinding({ ...valid, allowedUsers: ['U1'] });
  bridge.start();

  // ---------- baseline: binding a channel does not replay old answers ----------
  await bridge.tick();
  assert.equal(slack.posts.length, 0, 'first observation only records a baseline');

  // ---------- finished: posted once the session settles with a new reply ----------
  host.digests.s1 = { id: 'a:2', text: '**Done** — tests pass' };
  setState(host, 's1', { state: 'waiting' });
  await bridge.tick();
  assert.equal(slack.posts.length, 0, 'not before the settle window');
  clock += 6000;
  await bridge.tick();
  assert.equal(slack.posts.length, 1);
  assert.equal(slack.posts[0].card.kind, 'finished');
  assert.match(slack.posts[0].card.body, /tests pass/);
  await bridge.tick();
  assert.equal(slack.posts.length, 1, 'the same reply is announced once');

  // An idle agent is not re-read forever: only shortly after each turn.
  clock += 120_000;
  host.digests.s1 = { id: 'a:3', text: 'late' };
  await bridge.tick();
  assert.equal(slack.posts.length, 1, 'no transcript reads long after the turn settled');
  setState(host, 's1', { state: 'working' });
  await bridge.tick();
  setState(host, 's1', { state: 'waiting' });
  await bridge.tick();
  clock += 6000;
  await bridge.tick();
  assert.equal(slack.posts.length, 2, 'the next turn is announced');
  assert.equal(slack.posts[1].card.body, 'late');

  // ---------- reply in a finished card's thread prompts that agent ----------
  let r = await bridge.handleReply('slack', { channel: 'C1', ts: 'm1', thread: slack.posts[0].ref.ts, user: { id: 'U1' }, messageId: 'e1', text: 'now write docs' });
  assert.deepEqual(r, { prompted: 's1' });
  assert.equal(host.prompts[0].text, 'now write docs');
  r = await bridge.handleReply('slack', { channel: 'C1', ts: 'm1', thread: slack.posts[0].ref.ts, user: { id: 'U1' }, messageId: 'e1', text: 'now write docs' });
  assert.deepEqual(r, { ignored: 'duplicate' }, 'Slack redelivery is not a second prompt');

  // ---------- user allowlist ----------
  r = await bridge.handleReply('slack', { channel: 'C1', ts: 'm2', thread: slack.posts[0].ref.ts, user: { id: 'U9' }, messageId: 'e2', text: 'rm -rf' });
  assert.deepEqual(r, { refused: 'user-not-allowed' });
  assert.equal(host.prompts.length, 1);

  // ---------- group channel: "name: text" addresses one agent ----------
  r = await bridge.handleReply('slack', { channel: 'C1', ts: 'm3', thread: null, user: { id: 'U1' }, messageId: 'e3', text: 'beta: rebase please' });
  assert.deepEqual(r, { prompted: 's2' });
  assert.equal(host.prompts[1].text, 'rebase please');

  // ---------- typed question: buttons answer it, card closes ----------
  host.typed.s2 = [{ key: 'k1', kind: 'question', questions: [{ id: 'q1', text: 'Which DB?', options: [{ label: 'Postgres' }, { label: 'SQLite' }] }] }];
  setState(host, 's2', { inputRequired: { kind: 'question', cli: 'codex', detectedAt: 'x' } });
  await bridge.tick();
  const qCard = slack.posts.at(-1);
  assert.equal(qCard.card.kind, 'input');
  assert.deepEqual(qCard.card.options.map((o) => o.label), ['Postgres', 'SQLite']);
  r = await bridge.handleReply('slack', { channel: 'C1', ts: qCard.ref.ts, thread: null, user: { id: 'U1', name: 'dk' }, messageId: 'e4', optionId: 'q:0:1' });
  assert.deepEqual(r, { answered: 'k1' });
  assert.deepEqual(host.answers[0], { id: 's2', key: 'k1', response: { answers: { q1: 'SQLite' } } });
  assert.match(slack.updates.at(-1).card.resolved.text, /dk/);
  r = await bridge.handleReply('slack', { channel: 'C1', ts: qCard.ref.ts, thread: null, user: { id: 'U1' }, messageId: 'e5', optionId: 'q:0:0' });
  assert.deepEqual(r, { refused: 'closed' }, 'a second click on a closed card does nothing');

  // ---------- typed question answered by a thread reply ----------
  host.typed.s2 = [{ key: 'k2', kind: 'question', questions: [{ id: 'q1', text: 'Name?', options: [] }] }];
  setState(host, 's2', { inputRequired: { kind: 'question', cli: 'codex', detectedAt: 'y' } });
  await bridge.tick();
  r = await bridge.handleReply('slack', { channel: 'C1', ts: 'm6', thread: slack.posts.at(-1).ref.ts, user: { id: 'U1' }, messageId: 'e6', text: 'orders' });
  assert.deepEqual(r, { answered: 'k2' });
  assert.deepEqual(host.answers[1].response, { answers: { q1: 'orders' } });

  // ---------- permissions need opt-in approvals ----------
  host.typed.s2 = [{ key: 'k3', kind: 'permission', details: '{"command":"npm i"}', choices: [{ value: 'accept', label: 'Approve once' }, { value: 'decline', label: 'Deny' }] }];
  setState(host, 's2', { inputRequired: { kind: 'permission', cli: 'codex', detectedAt: 'z' } });
  await bridge.tick();
  let pCard = slack.posts.at(-1);
  assert.equal(pCard.card.options.length, 0, 'no approve buttons without opt-in');
  r = await bridge.handleReply('slack', { channel: 'C1', ts: pCard.ref.ts, thread: null, user: { id: 'U1' }, messageId: 'e7', optionId: 'd:accept' });
  assert.deepEqual(r, { refused: 'approvals-off' });
  assert.equal(host.answers.length, 2);

  // Resolved in the terminal → the card is closed without a click.
  host.typed.s2 = [];
  setState(host, 's2', { inputRequired: null });
  await bridge.tick();
  assert.match(slack.updates.at(-1).card.resolved.text, /outside this chat/);

  store.putBinding({ ...binding, allowedUsers: ['U1'], approvals: true });
  host.typed.s2 = [{ key: 'k4', kind: 'permission', details: '{}', choices: [{ value: 'accept', label: 'Approve once' }, { value: 'decline', label: 'Deny' }] }];
  setState(host, 's2', { inputRequired: { kind: 'permission', cli: 'codex', detectedAt: 'w' } });
  await bridge.tick();
  pCard = slack.posts.at(-1);
  assert.deepEqual(pCard.card.options.map((o) => o.id), ['d:accept', 'd:decline']);
  r = await bridge.handleReply('slack', { channel: 'C1', ts: pCard.ref.ts, thread: null, user: { id: 'U1' }, messageId: 'e8', optionId: 'd:accept' });
  assert.deepEqual(r, { answered: 'k4' });
  assert.deepEqual(host.answers[2].response, { decision: 'accept' });

  // ---------- untyped dialogs (e.g. Claude) link to the terminal ----------
  setState(host, 's1', { inputRequired: { kind: 'permission', cli: 'claude', detectedAt: 'c1' } });
  await bridge.tick();
  const gCard = slack.posts.at(-1);
  assert.equal(gCard.card.options.length, 0);
  assert.match(gCard.card.hint, /terminal/);

  // ---------- the privacy lock stops both directions ----------
  host.isLocked = true;
  const before = slack.posts.length;
  setState(host, 's1', { inputRequired: { kind: 'permission', cli: 'claude', detectedAt: 'c2' } });
  await bridge.tick();
  assert.equal(slack.posts.length, before, 'nothing is posted while locked');
  r = await bridge.handleReply('slack', { channel: 'C1', ts: 'm9', thread: slack.posts[0].ref.ts, user: { id: 'U1' }, messageId: 'e9', text: 'hi' });
  assert.deepEqual(r, { refused: 'locked' });
  host.isLocked = false;

  // ---------- restart: posted cards and baselines survive ----------
  const store2 = createStore(path.join(root, 'messengers.json'), { now });
  const slack2 = fakeAdapter();
  const bridge2 = createBridge({ host, store: store2, adapters: new Map([['slack', slack2]]), now, settleMs: 0, digestEveryMs: 0, tickMs: 1e9 });
  bridge2.start();
  setState(host, 's1', { inputRequired: { kind: 'permission', cli: 'claude', detectedAt: 'c1' } });
  await bridge2.tick();
  assert.equal(slack2.posts.length, 0, 'no duplicate cards or replays after a restart');
  await bridge.stop(); await bridge2.stop();

  // ---------- commands ----------
  assert.match(await bridge.handleCommand('slack', { channel: 'C1', user: { id: 'U1' }, text: 'status' }), /alpha.*needs input/);
  assert.match(await bridge.handleCommand('slack', { channel: 'C1', user: { id: 'U9' }, text: 'status' }), /not on the allowed/);

  // ---------- Slack rendering ----------
  assert.equal(toMrkdwn('**a** <b> [x](https://y)'), '*a* &lt;b&gt; <https://y|x>');
  const blocks = renderBlocks({ title: 't', body: 'b', options: [{ id: 'd:accept', label: 'Approve once', style: 'primary' }], link: 'http://am' });
  assert.equal(blocks.find((b) => b.type === 'actions').elements[0].value, 'd:accept');
  const closed = renderBlocks({ title: 't', body: 'b', options: [{ id: 'x', label: 'y' }], resolved: { text: 'done' } });
  assert.ok(!closed.some((b) => b.type === 'actions'), 'a resolved card has no buttons');

  // ---------- Slack Socket Mode protocol ----------
  const calls = [];
  const sockets = [];
  class FakeWs extends EventEmitter {
    constructor(url) { super(); this.url = url; this.sent = []; sockets.push(this); }
    send(s) { this.sent.push(JSON.parse(s)); }
    close() { this.emit('close'); }
  }
  const fetchImpl = async (url, init) => {
    const method = url.split('/').pop();
    calls.push({ method, auth: init.headers.authorization, body: JSON.parse(init.body) });
    const out = { 'auth.test': { ok: true, user_id: 'UBOT' }, 'apps.connections.open': { ok: true, url: 'wss://x' },
      'chat.postMessage': { ok: true, channel: 'C1', ts: '111.1' }, 'chat.update': { ok: true } }[method];
    return { status: 200, json: async () => out };
  };
  const adapter = createSlackAdapter({ botToken: 'xoxb-1', appToken: 'xapp-1', fetchImpl, WebSocketImpl: FakeWs, setTimer: () => {} });
  assert.equal(adapter.configured(), true);
  const got = [];
  const statuses = [];
  adapter.start({ onReply: async (x) => got.push(x), onCommand: async () => 'pong', onStatus: (s) => statuses.push(s), log: () => {} });
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls.find((c) => c.method === 'apps.connections.open').auth, 'Bearer xapp-1', 'the app token opens the socket');
  const ws = sockets[0];
  const frame = async (m) => { ws.emit('message', Buffer.from(JSON.stringify(m))); await new Promise((r) => setTimeout(r, 5)); };
  await frame({ type: 'hello' });
  assert.deepEqual(statuses.at(-1), { connected: true, error: null });
  await frame({ type: 'interactive', envelope_id: 'env1', payload: { type: 'block_actions', trigger_id: 'tr', user: { id: 'U1', username: 'dk' }, channel: { id: 'C1' }, message: { ts: '111.1' }, actions: [{ action_id: 'am:d:accept', value: 'd:accept', action_ts: '1' }] } });
  assert.deepEqual(ws.sent.at(-1), { envelope_id: 'env1' }, 'every envelope is acknowledged');
  assert.deepEqual({ ...got.at(-1), messageId: undefined }, { channel: 'C1', ts: '111.1', thread: null, user: { id: 'U1', name: 'dk' }, messageId: undefined, optionId: 'd:accept' });
  await frame({ type: 'events_api', envelope_id: 'env2', payload: { event_id: 'Ev1', event: { type: 'message', channel: 'C1', user: 'U1', text: 'hello', ts: '222.2', thread_ts: '111.1' } } });
  assert.equal(got.at(-1).thread, '111.1');
  assert.equal(got.at(-1).text, 'hello');
  const count = got.length;
  await frame({ type: 'events_api', envelope_id: 'env3', payload: { event: { type: 'message', channel: 'C1', bot_id: 'B1', text: 'own card', ts: '3' } } });
  await frame({ type: 'events_api', envelope_id: 'env4', payload: { event: { type: 'message', subtype: 'message_changed', channel: 'C1', ts: '4' } } });
  assert.equal(got.length, count, 'bot messages and edits are not replies');
  await frame({ type: 'slash_commands', envelope_id: 'env5', payload: { channel_id: 'C1', user_id: 'U1', text: 'status' } });
  assert.equal(ws.sent.at(-1).payload.text, 'pong', 'a slash command is answered in its ack');
  const ref = await adapter.post({ channel: 'C1', thread: '111.1' }, { title: 'x', body: 'y', options: [] });
  assert.deepEqual(ref, { channel: 'C1', ts: '111.1' });
  assert.equal(calls.at(-1).body.thread_ts, '111.1');
  assert.equal(calls.at(-1).auth, 'Bearer xoxb-1');
  await adapter.stop();
  assert.equal(createSlackAdapter({}).configured(), false);
  assert.equal(createSlackAdapter({ botToken: 'xoxb-1' }).configured(), false, 'both tokens are needed');

  // ---------- configuration (read once, in config.js) ----------
  const cfg = resolveMessengerConfig({ SLACK_BOT_TOKEN: 'xoxb-2', SLACK_APP_TOKEN: 'xapp-2', AM_PUBLIC_URL: 'https://am.example.test/' });
  assert.deepEqual(cfg, { publicUrl: 'https://am.example.test', slack: { botToken: 'xoxb-2', appToken: 'xapp-2' } });
  assert.deepEqual(resolveMessengerConfig({}), { publicUrl: '', slack: { botToken: '', appToken: '' } });
  assert.throws(() => resolveMessengerConfig({ AM_PUBLIC_URL: 'am.example.test' }), /AM_PUBLIC_URL/, 'a bad URL fails at startup');

  console.log('messengers: all assertions passed');
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
