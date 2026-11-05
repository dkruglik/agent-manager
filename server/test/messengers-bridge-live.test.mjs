import assert from 'node:assert/strict';
import test from 'node:test';
import { MessengerBridge } from '../src/messengers/bridge.js';
import { setup } from './messengers-bridge-fixtures.mjs';

// The bridge's life cycle (stop waits for a drain) and its credential filter on input cards, which is built
// from getKnownCredentialValues on every call. No Slack.

const item = (over) => ({ key: 'q1', kind: 'question', ...over });

test('stop() waits for a drain in flight, and a drain after stop does nothing', async () => {
  const { bridge } = setup();
  let finish;
  let calls = 0;
  bridge.outbox = { drain: () => { calls += 1; return new Promise((r) => { finish = r; }); } };
  bridge.drain();
  let stopped = false;
  const stopping = bridge.stop().then(() => { stopped = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(stopped, false, 'stop is still waiting for the drain');
  finish();
  await stopping;
  assert.equal(stopped, true);
  await bridge.drain();
  assert.equal(calls, 1, 'no drain starts once stopped');
});

test('stop() waits for the tick in flight, and that tick posts nothing after stop', async () => {
  const t = setup({ events: ['transcript'] });
  t.host.list[0].state = 'waiting';
  t.host.sinceImpl = async () => ({ end: { src: 'srcA', seq: 1, hash: 'h1' }, messages: [], restarted: false });
  await t.tick(); // baseline
  let release;
  const gate = new Promise((r) => { release = r; });
  t.host.sinceImpl = async () => {
    await gate;
    return { end: { src: 'srcA', seq: 2, hash: 'h2' }, messages: [{ src: 'srcA', seq: 2, hash: 'h2', text: 'LATE', tools: [] }], restarted: false };
  };
  const ticking = t.bridge.tick();
  await new Promise((r) => setImmediate(r));
  let stopped = false;
  const stopping = t.bridge.stop().then(() => { stopped = true; });
  await new Promise((r) => setImmediate(r));
  assert.equal(stopped, false, 'stop is waiting for the tick');
  release();
  await stopping;
  await ticking;
  assert.deepEqual(t.slack.posts.filter((p) => p.card.body === 'LATE'), []);
});

test('a hung drain does not block the next one: drains are not coalesced', async () => {
  const { bridge } = setup();
  let calls = 0;
  bridge.outbox = { drain: () => { calls += 1; return calls === 1 ? new Promise(() => {}) : Promise.resolve(); } };
  bridge.drain();
  await bridge.drain();
  assert.equal(calls, 2);
});

test('input cards filter the question text and the option labels, strings and objects alike', () => {
  const secret = 'plain-provider-secret-value';
  const { bridge, host } = setup();
  const filtered = new MessengerBridge({
    host, store: bridge.store, adapters: bridge.adapters, getKnownCredentialValues: () => [secret], log: () => {},
  });
  const questions = [{ id: 'a', text: `use ${secret}?`, options: [{ label: `key ${secret}` }, `raw ${secret}`, { label: 'plain' }] }];
  const card = filtered.inputCardFor({ approvals: true }, { id: 's1', name: 'alpha', cli: 'claude' }, item({ questions }));
  const json = JSON.stringify(card);
  assert.ok(!json.includes(secret), 'no secret in the card');
  assert.match(json, /\[redacted\]/);
  assert.ok(json.includes('plain'), 'other labels are kept');
  assert.equal(questions[0].options[0].label, `key ${secret}`, 'the stored item is not changed');
});

test('the credential filter is rebuilt per call: a secret set after boot is redacted', () => {
  const env = {};
  const { host, bridge } = setup();
  const live = new MessengerBridge({ host, store: bridge.store, adapters: bridge.adapters, getKnownCredentialValues: () => Object.values(env), log: () => {} });
  const later = 'set-after-boot-secret-1';
  assert.equal(live.filter(`x ${later}`), `x ${later}`);
  env.LATE = later;
  assert.equal(live.filter(`x ${later}`), 'x [redacted]');
  assert.equal(live.outbound.filter(`x ${later}`), 'x [redacted]', 'the transcript mirror uses the same filter');
});

test('a value the Space injected is redacted whatever its name, through the production wiring', () => {
  const env = { DEPLOY_DSN: 'postgres://op:injected-value-1234@db/x', PLAIN_NAME: 'not-a-secret-value' };
  const { bridge } = setup({ injectedKeys: ['DEPLOY_DSN'], env });
  assert.equal(bridge.filter(`url ${env.DEPLOY_DSN}`), 'url [redacted]');
  assert.equal(bridge.outbound.filter(`url ${env.DEPLOY_DSN}`), 'url [redacted]');
  assert.equal(bridge.filter(`v ${env.PLAIN_NAME}`), `v ${env.PLAIN_NAME}`, 'a variable that was not injected is kept');
});

function limited(retryAfter) {
  const t = setup({ events: ['input-required'] });
  t.store.patchState({ channelMarks: { 'slack|C0': '100.0' } });
  let reads = 0;
  t.slack.history = async () => {
    reads += 1;
    if (reads === 1) throw Object.assign(new Error('slack says: too many requests for hunter2'), { code: 'rate-limited', retryAfter });
    return [];
  };
  t.slack.postEphemeral = async () => {};
  return { ...t, reads: () => reads };
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test('a rate-limited backfill is tried again after retryAfter, and the log has the code only', async () => {
  const t = limited(0.02);
  await t.bridge.backfill('slack', t.slack);
  assert.equal(t.reads(), 1);
  const failed = t.logs.find((e) => e.event === 'backfill-failed');
  assert.equal(failed.error, 'rate-limited');
  await wait(150);
  assert.equal(t.reads(), 2, 'read again once');
  await t.bridge.stop();
});

test('stop() cancels a backfill retry that is waiting', async () => {
  const t = limited(0.05);
  await t.bridge.backfill('slack', t.slack);
  await t.bridge.stop();
  await wait(200);
  assert.equal(t.reads(), 1, 'no retry after stop');
});
