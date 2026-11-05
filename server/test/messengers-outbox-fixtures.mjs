import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MessengerBridge } from '../src/messengers/bridge.js';
import { BindingStore } from '../src/messengers/store.js';
import { requestIdFor } from '../src/messengers/replies.js';

// Shared by the outbox suites: a fake host and adapter stand in for the app and Slack.
// Not a suite itself (no .test. in the name).

export const HOUR = 3600_000;
export const DAY = 24 * HOUR;
export const alice = { id: 'U1', name: 'alice' };
export const bob = { id: 'U2', name: 'bob' };

export function setup({ allowedUsers = ['U1'], sessions = ['s1'], root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-messengers-outbox-')) } = {}) {
  const clock = { t: 1_000_000 };
  const now = () => clock.t;
  const store = new BindingStore(path.join(root, 'messengers.json'), { now });
  const names = { s1: 'alpha', s2: 'beta' };
  const host = {
    deliveries: [], isLocked: false, src: 'src-1', outcome: () => ({ state: 'delivered' }),
    list: sessions.map((id) => ({ id, name: names[id], cli: 'claude', state: 'working', inputRequired: null })),
    sessions: () => host.list.map((s) => ({ ...s })),
    groupOf: () => ({ id: 'g1', name: 'proj' }),
    locked: () => host.isLocked, lockState: () => ({ locked: host.isLocked, reason: host.isLocked ? 'public-space' : null }), onLock: () => () => {}, readyCalls: [], readyImpl: async () => 'skipped', ready: async (s, o) => { host.readyCalls.push(s.id); return host.readyImpl(s, o); }, lockScope: () => ({ signal: new AbortController().signal, release() {} }), link: () => null, sourceKey: () => host.src,
    requests: async () => [], digest: async () => null, answer: async () => {},
    async deliver(s, { text, requestId }) {
      host.deliveries.push({ id: s.id, text, requestId });
      return host.outcome(s, host.deliveries.length);
    },
  };
  const posts = [];
  const slack = {
    configured: () => true, start(h) { h.onStatus({ connected: true, error: null }); },
    async post(target, card) { const ref = { channel: target.channel, ts: `t${posts.length + 1}` }; posts.push({ target, card, ref }); return ref; },
    async update() {}, async postEphemeral() {},
  };
  const logs = [];
  // `fresh` reads messengers.json again, like a restarted process.
  const make = ({ fresh = false } = {}) => {
    const st = fresh ? new BindingStore(path.join(root, 'messengers.json'), { now }) : store;
    const bridge = new MessengerBridge({ host, store: st, adapters: new Map([['slack', slack]]), now, dataDir: root, log: (e) => logs.push(e), tickMs: 1e9, settleMs: 0, digestEveryMs: 0 });
    bridge.statuses.set('slack', { connected: true, error: null });
    return bridge;
  };
  const bridge = make();
  const bind = (id, extra = {}) => store.putBinding({
    id, adapter: 'slack', target: { channel: 'C0' }, scope: { type: 'group', id: 'g1' },
    events: ['input-required'], allowedUsers, approvals: false, createdAt: 'x', ...extra,
  });
  bind('b0');
  const dir = path.join(root, 'messenger-outbox');
  const files = () => (fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')) : []);
  const row = (ts) => JSON.parse(fs.readFileSync(path.join(dir, `${requestIdFor('slack', 'C0', ts)}.json`), 'utf8'));
  return { root, clock, store, host, slack, posts, logs, bridge, make, bind, dir, files, row, send: (r) => bridge.handleReply('slack', r) };
}

export const msg = (ts, body, extra = {}) => ({ channel: 'C0', ts, thread: null, user: alice, messageId: `m${ts}`, text: body, ...extra });
export const inThread = (thread, ts, body, extra = {}) => msg(ts, body, { thread, ...extra });
