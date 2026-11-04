import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MessengerBridge } from '../src/messengers/bridge.js';
import { BindingStore } from '../src/messengers/store.js';

// Shared by the messengers-bridge suites: a recording adapter, a scripted host, and a bridge on one binding.
// Not a suite itself.

export function fakeAdapter() {
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

export function setup({ events = ['input-required', 'finished'] } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-messengers-bridge-'));
  let clock = 1_000_000;
  const store = new BindingStore(path.join(root, 'messengers.json'), { now: () => clock });
  const host = {
    list: [{ id: 's1', name: 'alpha', cli: 'codex', state: 'working', inputRequired: null }],
    typed: [], requestsError: null, digestImpl: async () => null, isLocked: false,
    sessions: () => host.list.map((s) => ({ ...s })),
    groupOf: () => ({ id: 'g1', name: 'proj' }),
    locked: () => host.isLocked, lockState: () => ({ locked: host.isLocked, reason: host.isLocked ? 'public-space' : null }), onLock: () => () => {}, ready: async () => 'skipped', lockScope: () => ({ signal: new AbortController().signal, release() {} }),
    link: (s) => `http://am/#session=${s.id}`,
    requests: async () => {
      if (host.requestsError) { const e = host.requestsError; host.requestsError = null; throw e; }
      return host.typed;
    },
    digest: (s) => host.digestImpl(s),
    sinceImpl: async () => null, since: (s, c) => host.sinceImpl(s, c),
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

export const permission = {
  key: 'req1', kind: 'permission', details: '{"command":"ls"}',
  choices: [{ value: 'accept', label: 'Approve once' }, { value: 'decline', label: 'Deny' }],
};

export const end = (seq) => ({ src: 'srcA', seq, hash: `h${seq}` });
export const msg = (seq, text) => ({ ...end(seq), text, tools: [] });
