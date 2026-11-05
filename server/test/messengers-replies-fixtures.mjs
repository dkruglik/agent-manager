import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MessengerBridge } from '../src/messengers/bridge.js';
import { BindingStore } from '../src/messengers/store.js';

// Inbound replies: what is said back in chat, what is logged, and that a card
// is answered once.

export const typed = { key: 'req1', kind: 'permission', details: '{"command":"ls"}', choices: [{ value: 'accept', label: 'Approve once' }, { value: 'decline', label: 'Deny' }] };
export const user = { id: 'U1', name: 'alice' };

export function setup({ approvals = true, allowedUsers = ['U1'] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-messengers-replies-'));
  const store = new BindingStore(path.join(root, 'messengers.json'), { now: () => 1000 });
  const host = {
    isLocked: false, gone: false, answers: [],
    sessions: () => (host.gone ? [] : [{ id: 's1', name: 'alpha', cli: 'codex', state: 'working', inputRequired: null }]),
    groupOf: () => ({ id: 'g1', name: 'proj' }), locked: () => host.isLocked, lockState: () => ({ locked: host.isLocked, reason: host.isLocked ? 'public-space' : null }), onLock: () => () => {}, ready: async () => 'skipped', lockScope: () => ({ signal: new AbortController().signal, release() {} }), link: () => null,
    requests: async () => [], digest: async () => null,
    answer: async (...a) => { host.answers.push(a); }, prompt: async () => {},
    deliver: async (s, { text, requestId }) => { await host.prompt(s, text, { requestId }); return { state: 'delivered' }; },
  };
  const posts = [];
  const ephemerals = [];
  const slack = {
    configured: () => true, start() {}, failPosts: false,
    async post(target, card) {
      if (slack.failPosts) throw new Error('slack chat.postMessage: channel_not_found');
      const ref = { channel: target.channel, ts: `t${posts.length + 1}` };
      posts.push({ target, card, ref });
      return ref;
    },
    async update() {},
    async postEphemeral(e) { ephemerals.push(e); },
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
  return { bridge, host, slack, store, posts, ephemerals, logs, root };
}

export const press = (n, optionId = 'd:accept', who = user) => ({ channel: 'C0', ts: 'card1', thread: null, user: who, messageId: `m${n}`, optionId });
export const text = (n, body) => ({ channel: 'C0', ts: `x${n}`, thread: null, user, messageId: `m${n}`, text: body });

