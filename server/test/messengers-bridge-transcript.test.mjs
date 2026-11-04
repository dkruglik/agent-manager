import assert from 'node:assert/strict';
import test from 'node:test';
import { finishedMark, migrateSeen } from '../src/messengers/outbound.js';
import { setup, permission, end, msg } from './messengers-bridge-fixtures.mjs';

// The transcript mirror and the finished card, driven through bridge.tick().

test('a failed transcript read does not become the baseline', async () => {
  const t = setup({ events: ['finished'] });
  t.host.digestImpl = async () => { throw new Error('transcript unreadable'); };
  t.host.list[0].state = 'waiting';
  await t.tick();
  const failed = t.logs.find((e) => e.event === 'digest-failed');
  assert.deepEqual([failed.session, failed.error], ['s1', 'transcript unreadable']);
  assert.equal(finishedMark(t.store, 'slack', 'C0', 's1'), null, 'still no baseline');
  t.host.digestImpl = async () => ({ id: 'a', text: 'old' });
  await t.tick(1000);
  assert.equal(t.slack.posts.length, 0, 'the old answer becomes the baseline');
  assert.equal(finishedMark(t.store, 'slack', 'C0', 's1'), 'a');
});

test('a binding with both events posts transcript only', async () => {
  const t = setup({ events: ['finished', 'transcript'] });
  t.host.digestImpl = async () => ({ id: 'a:1', text: 'old' });
  t.host.sinceImpl = async (s, c) => ({ end: end(1), messages: [], restarted: false });
  await t.tick();
  t.host.digestImpl = async () => ({ id: 'a:2', text: 'FINISHED TEXT' });
  t.host.sinceImpl = async () => ({ end: end(2), messages: [msg(2, 'MIRRORED TEXT')], restarted: false });
  t.host.list[0].state = 'waiting';
  await t.tick(1000);
  const bodies = t.slack.posts.map((p) => p.card.body).filter(Boolean);
  assert.deepEqual(bodies, ['MIRRORED TEXT']);
  assert.ok(t.slack.posts.every((p) => p.card.kind !== 'finished'));
});

test('a finished card body with a configured SLACK_BOT_TOKEN value is redacted', async () => {
  const token = 'test-bot-token-value-9999';
  process.env.SLACK_BOT_TOKEN = token;
  try {
    const t = setup({ events: ['finished'] });
    t.host.digestImpl = async () => ({ id: 'a:1', text: 'old' });
    await t.tick();
    t.host.digestImpl = async () => ({ id: 'a:2', text: `the token is ${token}, keep it` });
    t.host.list[0].state = 'waiting';
    await t.tick(1000);
    assert.equal(t.slack.posts.length, 1);
    assert.ok(!t.slack.posts[0].card.body.includes(token));
    assert.match(t.slack.posts[0].card.body, /\[redacted\]/);
  } finally { delete process.env.SLACK_BOT_TOKEN; }
});

test('after migrateSeen an old seen entry posts nothing, for finished and for transcript', async () => {
  const t = setup({ events: ['finished', 'transcript'] });
  t.store.putBinding({ ...t.store.binding('b0'), events: ['finished'] });
  t.store.putSeen('b0|s1', 'a:1');
  assert.equal(migrateSeen(t.store), 1);
  t.host.digestImpl = async () => ({ id: 'a:1', text: 'already announced' });
  t.host.list[0].state = 'waiting';
  await t.tick();
  assert.equal(t.slack.posts.length, 0);
  t.store.putBinding({ ...t.store.binding('b0'), events: ['transcript'] });
  t.host.sinceImpl = async (s, c) => {
    assert.equal(c, null, 'no transcript cursor yet: a baseline');
    return { end: end(5), messages: [], restarted: false };
  };
  await t.tick(1000);
  assert.equal(t.slack.posts.length, 0);
  assert.equal(t.store.state('outbound', 'slack|C0|s1').seq, 5);
});

test('a restart does not baseline a session with a cursor: only messages after it are posted', async () => {
  const t = setup({ events: ['transcript'] });
  t.store.patchState({ outbound: { 'slack|C0|s1': { ...end(2), refs: ['x'] } } });
  const seen = [];
  t.host.sinceImpl = async (s, c) => {
    seen.push(c);
    return { end: end(3), messages: [msg(3, 'three')], restarted: false };
  };
  t.host.list[0].state = 'waiting';
  await t.tick();
  assert.deepEqual(seen, [{ src: 'srcA', seq: 2, hash: 'h2' }]);
  assert.deepEqual(t.slack.posts.map((p) => p.card.body).filter(Boolean), ['three']);
  assert.equal(t.store.state('outbound', 'slack|C0|s1').seq, 3);
});

test('checking mirrors the transcript and does not post cards', async () => {
  const t = setup({ events: ['input-required', 'transcript'] });
  t.host.isLocked = true;
  t.host.lockState = () => ({ locked: true, reason: 'checking' });
  t.host.list[0].state = 'waiting';
  let n = 0;
  t.host.sinceImpl = async () => {
    n += 1;
    if (n === 1) return { end: end(1), messages: [], restarted: false };
    return { end: end(2), messages: [msg(2, 'during checking')], restarted: false };
  };
  await t.tick();
  await t.tick();
  assert.deepEqual(t.slack.posts.map((p) => p.card.body).filter(Boolean), ['during checking']);
  t.host.list[0].inputRequired = { kind: 'permission', cli: 'codex', detectedAt: 'x' };
  t.host.typed = [permission];
  await t.tick();
  assert.equal(t.slack.posts.some((p) => p.card.kind === 'input'), false);
});

test('a failed transcript read does not baseline, and a later read does', async () => {
  const t = setup({ events: ['transcript'] });
  t.host.list[0].state = 'waiting';
  t.host.sinceImpl = async () => { throw new Error('trace unreadable'); };
  await t.tick();
  assert.equal(t.store.state('outbound', 'slack|C0|s1'), null);
  assert.equal(t.bridge.lastError('b0'), 'could not post — see the server log');
  t.host.sinceImpl = async () => ({ end: end(1), messages: [msg(1, 'later')], restarted: false });
  await t.tick(6000);
  assert.equal(t.slack.posts.length, 0, 'the first successful look is a baseline');
  assert.equal(t.store.state('outbound', 'slack|C0|s1').seq, 1);
  t.host.sinceImpl = async () => ({ end: end(2), messages: [msg(2, 'after')], restarted: false });
  await t.tick();
  assert.deepEqual(t.slack.posts.map((p) => p.card.body).filter(Boolean), ['after']);
});

test('a secret across the finished-card clip boundary is redacted before the card is clipped', async () => {
  const token = 'test-bot-token-value-7777';
  process.env.SLACK_BOT_TOKEN = token;
  try {
    const t = setup({ events: ['finished'] });
    t.host.digestImpl = async () => ({ id: 'a:1', text: 'old' });
    await t.tick();
    // The token starts 10 characters before the 2800-character card limit.
    t.host.digestImpl = async () => ({ id: 'a:2', text: `${'x'.repeat(2790)}${token} and more text` });
    t.host.list[0].state = 'waiting';
    await t.tick(1000);
    const body = t.slack.posts[0].card.body;
    assert.ok(!body.includes(token.slice(0, 8)), 'no leading fragment of the token survives the clip');
    assert.match(body, /\[redacted/, 'the marker, not the token, sits at the clip');
  } finally { delete process.env.SLACK_BOT_TOKEN; }
});

test('a lock that outlasts the look window still posts the transcript after it lifts', async () => {
  const t = setup({ events: ['transcript'] });
  t.host.list[0].state = 'waiting';
  let seq = 1;
  t.host.sinceImpl = async () => ({ end: end(seq), messages: seq > 1 ? [msg(seq, 'written during the lock')] : [], restarted: false });
  await t.tick();               // baseline
  await t.tick(1000);           // settled, nothing new
  seq = 2;
  t.host.isLocked = true;
  await t.tick(10 * 60_000);    // locked ten minutes: nothing happens
  assert.equal(t.slack.posts.length, 0);
  t.host.isLocked = false;
  await t.tick(1000);
  assert.deepEqual(t.slack.posts.map((p) => p.card.body).filter(Boolean), ['written during the lock']);
});

test('a working session posts no transcript, however long it was waiting before', async () => {
  const t = setup({ events: ['transcript'] });
  t.host.list[0].state = 'waiting';
  let seq = 1;
  t.host.sinceImpl = async () => ({ end: end(seq), messages: seq > 1 ? [msg(seq, 'mid-turn')] : [], restarted: false });
  await t.tick();
  seq = 2;
  t.host.list[0].state = 'working';
  await t.tick(10 * 60_000);
  assert.equal(t.slack.posts.length, 0);
});
