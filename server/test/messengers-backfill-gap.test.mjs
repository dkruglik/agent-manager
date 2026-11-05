import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BindingStore } from '../src/messengers/store.js';
import { backfill } from '../src/messengers/backfill.js';

// Backfill of a channel whose history read is cut off, and under rate limits.

const NOW = 5_000_000_000;
const m = (ts, channel = 'C0') => ({ channel, ts, thread: null, user: { id: 'U1' }, messageId: `${channel}:${ts}`, text: `text ${ts}` });
const cut = (partial, edge) => Object.assign(new Error('history read hit the page limit'), { event: 'history-truncated', partial, edge });

function rig(channels = ['C0']) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-messengers-backfill-gap-'));
  const store = new BindingStore(path.join(root, 'messengers.json'), { now: () => NOW });
  for (const [i, channel] of channels.entries()) {
    store.putBinding({ id: `b${i}`, adapter: 'slack', target: { channel }, scope: { type: 'group', id: 'g1' }, events: ['input-required'], allowedUsers: ['U1'], approvals: false, createdAt: 'x' });
    store.patchState({ channelMarks: { [`slack|${channel}`]: '100.0' } });
  }
  const fetches = [];
  const logs = [];
  const accepted = [];
  const answers = { fn: () => [] };
  const adapter = { async history(a) { fetches.push(a); return answers.fn(a); }, async postEphemeral() {} };
  const ctx = { adapterId: 'slack', adapter, store, now: () => NOW, log: (e) => logs.push(e), accept: async (id, r) => { accepted.push(r.ts); return { queued: 's1' }; } };
  return { store, fetches, logs, accepted, answers, ctx };
}

test('a newest-first channel read that is cut off delivers the oldest chunk and moves the mark below its end', async () => {
  const t = rig();
  const N1 = '4999000.100000';
  t.answers.fn = (a) => {
    if (!a.latest) throw cut([m('4999900.0'), m('4999800.0')], '4999800.0'); // newest pages only
    return [m(N1), m('4999001.100000')]; // the window below the edge fits
  };
  await backfill(t.ctx);
  assert.deepEqual(t.fetches.map((f) => f.latest), [undefined, '4999800.0']);
  assert.deepEqual(t.accepted, [N1, '4999001.100000'], 'the newest pages are not delivered ahead of the older gap');
  assert.equal(t.store.state('channelMarks', 'slack|C0'), '4999799.999999', 'the next connect continues from just below the edge');
});

test('an empty oldest window still moves the mark, and a window that never fits loses nothing', async () => {
  const t = rig();
  t.answers.fn = (a) => { if (!a.latest) throw cut([m('4999900.0')], '4999900.0'); return []; };
  await backfill(t.ctx);
  assert.equal(t.store.state('channelMarks', 'slack|C0'), '4999899.999999');
  const u = rig();
  u.answers.fn = (a) => { throw cut([m('4999900.0')], a.latest ? '4999000.0' : '4999900.0'); };
  await assert.rejects(() => backfill(u.ctx), (e) => e.event === 'backfill-failed');
  assert.deepEqual(u.accepted, []);
  assert.equal(u.store.state('channelMarks', 'slack|C0'), '100.0');
  assert.ok(u.logs.some((e) => e.event === 'backfill-gap'));
});

test('a failed accept in the oldest chunk leaves the mark where it was', async () => {
  const t = rig();
  t.answers.fn = (a) => { if (!a.latest) throw cut([m('4999900.0')], '4999900.0'); return [m('4999000.0')]; };
  t.ctx.accept = async () => { throw new Error('write failed'); };
  await assert.rejects(() => backfill(t.ctx));
  assert.equal(t.store.state('channelMarks', 'slack|C0'), '100.0');
});

test('a rate-limited read stops the remaining sources and reports when to retry', async () => {
  const t = rig(['C0', 'C1']);
  t.store.patchState({ threadMarks: { 'slack|C0|s1': '200.0' }, roots: { 'slack|C0|s1': [{ ts: '300.0', at: 1, count: 0 }] } });
  t.answers.fn = () => { throw Object.assign(new Error('slack conversations.history: rate-limited'), { code: 'rate-limited', retryAfter: 17 }); };
  await assert.rejects(() => backfill(t.ctx), (e) => e.code === 'rate-limited' && e.retryAfter === 17 && e.event === 'backfill-failed');
  assert.equal(t.fetches.length, 1, 'neither the threads nor the other channel are tried');
  assert.ok(t.logs.every((e) => e.error === undefined || e.error === 'rate-limited'));
});
