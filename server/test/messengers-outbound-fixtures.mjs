import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BindingStore } from '../src/messengers/store.js';
import { createThreads } from '../src/messengers/threads.js';
import { createSince } from '../src/transcript-since.js';
import { transcriptTick, createFilter } from '../src/messengers/outbound.js';

// Shared by the messengers-outbound suites: a scripted trace, a recording Slack, and a session that already
// has a baseline cursor. Not a suite itself.

export const KEY = 'slack|C0|s1';
export const BOT = 'test-bot-token-value-1234';
export const session = { id: 's1', name: 'alpha', cli: 'claude' };

export function setup({ events = ['transcript'], lock = { locked: false, reason: null }, env = {}, settled = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-outbound-'));
  const clock = { t: 1_000_000 };
  const now = () => clock.t;
  const store = new BindingStore(path.join(root, 'messengers.json'), { now });
  store.putBinding({
    id: 'b0', adapter: 'slack', target: { channel: 'C0' }, scope: { type: 'session', id: 's1' },
    events, allowedUsers: ['U1'], approvals: false, createdAt: 'x',
  });
  const trace = { src: 'srcA', version: 1, messages: [], parses: 0 };
  const state = { lock, settled, failAt: new Set(), calls: 0 };
  const posts = [];
  const updates = [];
  const slack = {
    configured: () => true,
    async post(target, card) {
      state.calls += 1;
      if (state.failAt.has(posts.length)) throw new Error('slack down');
      const ref = { channel: target.channel, ts: `t${posts.length + 1}` };
      posts.push({ target, card, ref });
      return ref;
    },
    async update(ref, card) { state.calls += 1; updates.push({ ref, card }); },
  };
  const since = createSince({
    sourceOf: () => trace.src,
    revisionOf: async () => String(trace.version),
    readMessages: async () => { trace.parses += 1; return { revision: String(trace.version), messages: structuredClone(trace.messages) }; },
  });
  const host = {
    since, link: () => 'http://am/#session=s1', lockState: () => state.lock, sessions: () => [session], groupOf: () => null,
    sourceKey: () => trace.src,
  };
  const adapters = new Map([['slack', slack]]);
  const logs = [];
  const threads = createThreads({ host, store, adapters, log: (e) => logs.push(e), now, scope: (b, ss) => ss.filter((s) => s.id === b.scope.id) });
  const ctx = { host, store, adapters, threads, filter: createFilter(env), settled: () => state.settled, log: (e) => logs.push(e), now };
  const tick = () => transcriptTick(ctx, store.binding('b0'), session);
  const say = (text, tools = []) => { trace.messages.push({ text, tools }); trace.version += 1; };
  const edit = (i, text) => { trace.messages[i] = { ...trace.messages[i], text }; trace.version += 1; };
  const cursor = () => store.state('outbound', KEY);
  const bodies = () => posts.filter((p) => p.target.thread).map((p) => p.card.body);
  return { root, clock, store, trace, state, posts, updates, ctx, tick, say, edit, cursor, bodies, logs, threads, slack };
}

// A session that already has `n` messages and a baseline cursor.
export async function started(n = 1, over = {}) {
  const t = setup(over);
  for (let i = 1; i <= n; i++) t.say(`old ${i}`);
  await t.tick();
  assert.equal(t.posts.length, 0);
  return t;
}
