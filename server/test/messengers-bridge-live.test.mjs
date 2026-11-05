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
