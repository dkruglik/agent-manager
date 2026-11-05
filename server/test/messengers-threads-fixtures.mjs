import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MessengerBridge } from '../src/messengers/bridge.js';
import { BindingStore } from '../src/messengers/store.js';

// Bot-owned threads, routing and the delivery side effects of a chat prompt.
// A fake adapter and host stand in for Slack and Agent Manager.

export const HOUR = 3600_000;
export const DAY = 24 * HOUR;
export const user = { id: 'U1', name: 'alice' };
export const ask = { key: 'q1', kind: 'question', questions: [{ id: 'a', text: 'Which one?' }] };

export function setup({ allowedUsers = ['U1'], link = null, sessions = ['s1'], bindings = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-messengers-threads-'));
  const clock = { t: 1_000_000 };
  const now = () => clock.t;
  const store = new BindingStore(path.join(root, 'messengers.json'), { now });
  const names = { s1: 'alpha', s2: 'beta' };
  const host = {
    prompts: [], answers: [], isLocked: false, group: Object.fromEntries(sessions.map((id) => [id, 'g1'])),
    list: sessions.map((id) => ({ id, name: names[id], cli: 'codex', state: 'working', inputRequired: null })),
    sessions: () => host.list.map((s) => ({ ...s })),
    groupOf: (id) => (host.group[id] ? { id: host.group[id], name: 'proj' } : null),
    locked: () => host.isLocked, lockState: () => ({ locked: host.isLocked, reason: host.isLocked ? 'public-space' : null }), onLock: () => () => {}, ready: async () => 'skipped', lockScope: () => ({ signal: new AbortController().signal, release() {} }), link: link ? (s) => `${link}/#session=${s.id}` : () => null,
    sourceKey: (s) => `src-${s.id}`, requests: async () => [], digest: async () => null,
    answer: async (s, key, response) => { host.answers.push({ id: s.id, key, response }); },
    deliver: async (s, { text, requestId }) => { host.prompts.push({ id: s.id, text, requestId }); return { state: 'delivered' }; },
  };
  const posts = [];
  const ephemerals = [];
  const slack = {
    configured: () => true, start(h) { h.onStatus({ connected: true, error: null }); },
    async post(target, card) { const ref = { channel: target.channel, ts: `t${posts.length + 1}` }; posts.push({ target, card, ref }); return ref; },
    async update() {},
    async postEphemeral(e) { ephemerals.push(e); },
  };
  const logs = [];
  const mk = (adapters) => new MessengerBridge({ host, store, adapters, now, log: (e) => logs.push(e), tickMs: 1e9, settleMs: 0, digestEveryMs: 0 });
  const bridge = mk(new Map([['slack', slack]]));
  bridge.statuses.set('slack', { connected: true, error: null });
  const base = { adapter: 'slack', target: { channel: 'C0' }, events: ['input-required'], allowedUsers, approvals: false, createdAt: 'x' };
  const bind = (id, scope, extra = {}) => store.putBinding({ ...base, id, scope, ...extra });
  for (const b of bindings || [{ id: 'b0', scope: { type: 'group', id: 'g1' } }]) bind(b.id, b.scope, b.extra);
  return { root, clock, store, host, slack, posts, ephemerals, logs, bridge, bind, mk, send: async (r) => { const out = await bridge.handleReply('slack', r); await bridge.drain(); return out; } };
}

export const msg = (ts, body, extra = {}) => ({ channel: 'C0', ts, thread: null, user, messageId: `m${ts}`, text: body, ...extra });
export const inThread = (thread, ts, body, extra = {}) => msg(ts, body, { thread, ...extra });
export const card = (t, key, extra = {}) => t.store.putPosted(`b0|s1|${key}`, {
  bindingId: 'b0', sessionId: 's1', key, kind: 'input', status: 'open', adapter: 'slack',
  ref: { channel: 'C0', ts: `card-${key}` }, item: ask, partial: {}, ...extra,
});
export const roots = (t, session = 's1') => t.store.state('roots', `slack|C0|${session}`) || [];

