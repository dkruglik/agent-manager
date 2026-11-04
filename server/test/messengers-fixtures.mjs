// Shared fixtures for the messenger suites that drive Claude hook decisions on
// a bridge: a recording adapter, a host with one Claude session, manual timers,
// and the hook payloads. Not a suite itself (no .test. in the name).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MessengerBridge } from '../src/messengers/bridge.js';
import { BindingStore } from '../src/messengers/store.js';

export const permissionPayload = { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } };
export const askPayload = (questions) => ({
  hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions, metadata: { source: 'x' } },
});
export const user = { id: 'U1', name: 'alice' };
// Lets every promise queued so far run: all fakes here answer at once.
export const flush = () => new Promise((r) => setImmediate(r));

/** An adapter that records what it posts and updates. */
export function fakeAdapter() {
  const posts = [];
  const updates = [];
  let n = 0;
  return {
    posts, updates,
    configured: () => true,
    start(h) { h.onStatus({ connected: true, error: null }); },
    stop: async () => {},
    async post(target, card) { const ref = { channel: target.channel, ts: `t${++n}` }; posts.push({ target, card, ref }); return ref; },
    async update(ref, card) { updates.push({ ref, card }); },
  };
}

/** One working Claude session, s1 "alpha", in group g1. */
export function fakeHost() {
  const h = {
    list: [{ id: 's1', name: 'alpha', cli: 'claude', state: 'working', inputRequired: null }],
    answers: [],
    isLocked: false,
    sessions: () => h.list.map((s) => ({ ...s })),
    groupOf: () => ({ id: 'g1', name: 'proj' }),
    locked: () => h.isLocked, lockState: () => ({ locked: h.isLocked, reason: h.isLocked ? 'public-space' : null }), onLock: () => () => {}, ready: async () => 'skipped', lockScope: () => ({ signal: new AbortController().signal, release() {} }),
    link: (s) => `http://am/#session=${s.id}`,
    requests: async () => [],
    digest: async () => null,
    answer: async (s, key, response) => { h.answers.push({ id: s.id, key, response }); },
    prompt: async () => {},
  };
  return h;
}

/** Timers that fire only when a test says so. */
export function fakeTimers() {
  const timers = new Map();
  let n = 0;
  return {
    timers,
    setTimer: (fn, ms) => { timers.set(++n, { fn, ms }); return n; },
    clearTimer: (id) => { timers.delete(id); },
    fire: (id) => { const t = timers.get(id); timers.delete(id); t.fn(); },
  };
}

/**
 * A bridge with bindings b0, b1, … on channels C0, C1, … (group g1, user U1),
 * each `{events: ['input-required'], approvals: true}` unless overridden.
 */
export function hookBridge({ bindings = [{}], connected = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-messengers-hook-'));
  const store = new BindingStore(path.join(root, 'messengers.json'), { now: () => 1 });
  const host = fakeHost();
  const slack = fakeAdapter();
  const clock = fakeTimers();
  const logs = [];
  const bridge = new MessengerBridge({
    host, store, adapters: new Map([['slack', slack]]), tickMs: 1e9, settleMs: 0, digestEveryMs: 0,
    setTimer: clock.setTimer, clearTimer: clock.clearTimer, log: (e) => logs.push(e),
  });
  bindings.forEach((b, i) => store.putBinding({
    id: `b${i}`, adapter: 'slack', target: { channel: `C${i}` }, scope: { type: 'group', id: 'g1' },
    events: ['input-required'], allowedUsers: ['U1'], approvals: true, createdAt: 'x', ...b,
  }));
  bridge.statuses.set('slack', { connected, error: null });
  return { bridge, host, store, slack, clock, logs, posts: slack.posts, updates: slack.updates, timers: clock.timers };
}
