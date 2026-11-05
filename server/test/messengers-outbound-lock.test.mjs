import assert from 'node:assert/strict';
import test from 'node:test';
import { createFilter } from '../src/messengers/outbound.js';
import { started } from './messengers-outbound-fixtures.mjs';

// Mirror tick edge cases: a crash between posts, a lock landing mid-tick, and a filter fed by the caller.

test('a crash after the first of three posts leaves the cursor on it, so the others go out once', async () => {
  const t = await started(1);
  t.say('a'); t.say('b'); t.say('c');
  t.state.failAt = new Set([2]); // posts: root, a, then b fails
  await assert.rejects(t.tick());
  assert.equal(t.cursor().seq, 2);
  t.state.failAt = new Set();
  await t.tick();
  assert.deepEqual(t.bodies(), ['a', 'b', 'c']);
});

test('a privacy lock that lands mid-tick stops the posts; the cursor keeps what went out', async () => {
  const t = await started(1);
  t.say('a'); t.say('b'); t.say('c');
  const post = t.slack.post.bind(t.slack);
  t.slack.post = async (target, card) => {
    const ref = await post(target, card);
    if (card.body === 'a') t.state.lock = { locked: true, reason: 'public-space' };
    return ref;
  };
  await t.tick();
  assert.deepEqual(t.bodies(), ['a']);
  assert.equal(t.cursor().seq, 2);
  t.state.lock = { locked: false, reason: null };
  await t.tick();
  assert.deepEqual(t.bodies(), ['a', 'b', 'c']);
});

test('the filter takes its values from the caller on every call', () => {
  const values = [];
  const filter = createFilter(() => values);
  const later = 'set-after-boot-secret-2';
  assert.equal(filter(`k ${later}`), `k ${later}`);
  values.push(later);
  assert.equal(filter(`k ${later}`), 'k [redacted]');
});
