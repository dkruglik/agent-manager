// A delegation's delivery is recorded apart from its outcome.
//
// The 2026-11-17 failures ended `outcome: completed`, `reason:
// harness-turn-ended`: the child's reason hid that the callback was never
// confirmed in the parent. Now `delivery` says how the callback went (state,
// reason, attempts, last attempt), `reason` names the delivery failure when
// the result is known but not delivered, and the child's own reason stays in
// `outcomeReason`. Journal files written before this (no `delivery`) derive
// it from `state` and `reason`. See docs/agent-delegation-workflow.md.
//
// Run with: node test/delegation-delivery.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path'; import { randomUUID } from 'node:crypto';
import { Delegations, hash, traceCheckpoint, notifyClaudeOnce } from '../src/delegations.js';
import * as delivery from '../src/delegation-delivery.js';

const input = (text) => ({ type: 'user', message: { content: text } });
const answer = (text = 'Review ready') => ({ type: 'assistant', message: { content: [{ type: 'text', text }], stop_reason: 'end_turn' } });
function fixture(t, notify) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-delivery-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'trace.jsonl'); fs.writeFileSync(file, '');
  const state = { parent: 'waiting', target: 'waiting' }; let now = 1000;
  const append = (r) => fs.appendFileSync(file, JSON.stringify(r) + '\n');
  const options = { dir: path.join(root, 'journal'), identity: (id) => id, state: async (id) => state[id], assertWritable: () => {}, now: () => now,
    prepare: async () => ({ cli: 'claude', expectedText: 'placeholder', cursor: traceCheckpoint(file) }),
    dispatch: async (j, payload) => { j.expectedHash = hash(payload); append(input(payload)); },
    notify: (job) => notify(job, root) };
  const d = new Delegations(options);
  const done = async () => { const { id } = await d.create('parent', 'target', { requestId: randomUUID(), text: 'review' }); append(answer()); return id; };
  return { d, root, options, done, time: (n) => { now = n; }, reopen: () => new Delegations(options) };
}
const typedFailure = (job, root) => notifyClaudeOnce(root, job.callbackId, async () => { throw Object.assign(Error('pasted'), { code: 'input-not-confirmed', typed: true }); });

test('an uncertain callback names the delivery failure, not the child\'s reason', async (t) => {
  const f = fixture(t, typedFailure);
  const id = await f.done(); f.time(5000); await f.d.tick();
  const v = f.d.get(id, 'parent');
  assert.equal(v.state, 'notification-uncertain');
  assert.equal(v.outcome, 'completed');
  assert.equal(v.reason, 'delegation-notify-uncertain');
  assert.equal(v.outcomeReason, 'harness-end-turn');
  assert.deepEqual(v.delivery, { state: 'uncertain', reason: 'delegation-notify-uncertain', attempts: 1, lastAttemptAt: 5000 });
  assert.equal(v.result, 'Review ready');
});

test('a delivered callback keeps the child\'s reason', async (t) => {
  const f = fixture(t, async () => ({ ok: true }));
  const id = await f.done(); await f.d.tick();
  const v = f.d.get(id, 'parent');
  assert.equal(v.state, 'delivered');
  assert.equal(v.reason, 'harness-end-turn');
  assert.equal(v.outcomeReason, 'harness-end-turn');
  assert.deepEqual(v.delivery, { state: 'delivered', reason: null, attempts: 1, lastAttemptAt: 1000 });
});

test('a failure before anything was typed is pending with its reason; each attempt is counted and audited', async (t) => {
  let tries = 0;
  const f = fixture(t, (job, root) => notifyClaudeOnce(root, job.callbackId, async () => {
    if (++tries === 1) throw Object.assign(Error('busy'), { code: 'input-line-busy' });
    return { ok: true };
  }));
  const id = await f.done(); f.time(2000); await f.d.tick();
  let v = f.d.get(id, 'parent');
  assert.equal(v.state, 'ready');
  assert.equal(v.reason, 'input-line-busy');
  assert.deepEqual(v.delivery, { state: 'pending', reason: 'input-line-busy', attempts: 1, lastAttemptAt: 2000 });
  f.time(7000); await f.d.tick();
  v = f.d.get(id, 'parent');
  assert.deepEqual(v.delivery, { state: 'delivered', reason: null, attempts: 2, lastAttemptAt: 7000 });
  const attempts = v.audit.filter((e) => e.state === 'ready' || e.state === 'delivered');
  assert.deepEqual(attempts.map((e) => [e.state, e.reason, e.attempts]), [['ready', 'input-line-busy', 1], ['delivered', 'harness-end-turn', 2]]);
});

test('the audit records the move to notification-uncertain once, with the delivery reason', async (t) => {
  const f = fixture(t, typedFailure);
  const id = await f.done(); await f.d.tick(); await f.d.tick();
  const uncertain = f.d.get(id, 'parent').audit.filter((e) => e.state === 'notification-uncertain');
  assert.equal(uncertain.length, 1);
  assert.equal(uncertain[0].reason, 'delegation-notify-uncertain');
  assert.equal(uncertain[0].outcome, 'completed');
});

test('a journal written before `delivery` existed loads and derives it', async (t) => {
  const cases = [['delivered', null, 'delivered', null], ['notification-uncertain', 'delegation-notify-uncertain', 'uncertain', 'delegation-notify-uncertain'],
    ['notification-review', 'codex-recovery-review', 'uncertain', 'codex-recovery-review'], ['ready', 'input-not-ready', 'pending', 'input-not-ready'],
    ['watching', null, 'pending', null], ['cancelled', null, 'not-delivered', 'cancelled']];
  for (const [state, reason, expected, expectedReason] of cases) {
    const f = fixture(t, async () => ({ ok: true }));
    const id = await f.done();
    const file = path.join(f.options.dir, `${id}.json`);
    const j = JSON.parse(fs.readFileSync(file, 'utf8'));
    delete j.delivery; j.state = state; if (reason) j.reason = reason; else delete j.reason;
    if (state !== 'watching') j.evidence = { ...j.evidence, outcome: 'completed', reason: 'harness-end-turn', answer: 'done' };
    fs.writeFileSync(file, JSON.stringify(j));
    const v = f.reopen().get(id, 'parent');
    assert.equal(v.delivery.state, expected, state);
    assert.equal(v.delivery.reason, expectedReason, state);
    assert.equal(v.delivery.attempts, 0, state);
  }
});

test('the callback receipts live in delegation-delivery.js; delegations.js still exports them', () => {
  assert.equal(notifyClaudeOnce, delivery.notifyClaudeOnce);
  for (const name of ['notifyClaudeOnce', 'readNotifyReceipt', 'writeNotifyReceipt', 'clearNotifyReceipt', 'deliveryOf']) {
    assert.equal(typeof delivery[name], 'function', name);
  }
});

test('what agents are told (the served skill text and the spec) names delivery and outcomeReason', () => {
  const here = path.dirname(new URL(import.meta.url).pathname);
  const served = fs.readFileSync(path.join(here, '../src/index.js'), 'utf8');
  const spec = fs.readFileSync(path.join(here, '../../docs/agent-delegation-workflow.md'), 'utf8');
  for (const [name, text] of [['index.js', served], ['agent-delegation-workflow.md', spec]]) {
    assert.match(text, /outcomeReason/, name);
    assert.match(text, /lastAttemptAt/, name);
  }
});

test('a crash while notifying: the resumed call is the next attempt, recorded once, never a second paste', async (t) => {
  let calls = 0;
  const f = fixture(t, (job, root) => notifyClaudeOnce(root, job.callbackId, async () => { calls++; return { ok: true }; }));
  const id = await f.done();
  f.d.state = async (who) => (who === 'parent' ? 'working' : 'waiting');
  await f.d.tick();
  // As left by a crash after startAttempt was saved and before notify() settled.
  const j = f.d.jobs.get(id); j.state = 'notifying'; j.delivery = { state: 'pending', reason: null, attempts: 1, lastAttemptAt: 1000 }; f.d.save(j);
  f.time(9000);
  const resumed = f.reopen(); await resumed.tick();
  const v = resumed.get(id, 'parent');
  assert.equal(calls, 1);
  assert.equal(v.state, 'delivered');
  assert.deepEqual(v.delivery, { state: 'delivered', reason: null, attempts: 2, lastAttemptAt: 9000 });
});

test('a crash after the receipt was written: the resumed call is uncertain and never pastes again', async (t) => {
  let calls = 0;
  const f = fixture(t, (job, root) => notifyClaudeOnce(root, job.callbackId, async () => { calls++; return { ok: true }; }));
  const id = await f.done();
  f.d.state = async (who) => (who === 'parent' ? 'working' : 'waiting');
  await f.d.tick();
  const j = f.d.jobs.get(id); j.state = 'notifying'; j.delivery = { state: 'pending', reason: null, attempts: 1, lastAttemptAt: 1000 }; f.d.save(j);
  delivery.writeNotifyReceipt(f.root, j.callbackId, { status: 'sending' });
  f.time(9000);
  const resumed = f.reopen(); await resumed.tick(); await resumed.tick();
  const v = resumed.get(id, 'parent');
  assert.equal(calls, 0, 'the callback was pasted again');
  assert.equal(v.state, 'notification-uncertain');
  assert.deepEqual(v.delivery, { state: 'uncertain', reason: 'delegation-notify-uncertain', attempts: 2, lastAttemptAt: 9000 });
});
