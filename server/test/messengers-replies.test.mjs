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
  return { bridge, host, slack, store, posts, logs };
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

  t.bridge.store.putPosted('b0|s1|hook:gone', { ...t.store.posted('b0|s1|req1'), key: 'hook:gone', ref: { channel: 'C0', ts: 'card2' }, item: { ...typed, key: 'hook:gone' } });
  await t.bridge.handleReply('slack', { ...press(3), ts: 'card2' });
  assert.match(t.posts.at(-1).card.body, /no longer waiting — answer in the terminal/);
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
