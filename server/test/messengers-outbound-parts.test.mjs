import assert from 'node:assert/strict';
import test from 'node:test';
import { PARTIAL_HASH } from '../src/transcript-since.js';
import { splitText } from '../src/messengers/outbound.js';
import { started } from './messengers-outbound-fixtures.mjs';

// What the mirror does when the message at the cursor changes (edits, compaction), and when a message of
// several parts fails halfway. A scripted trace and a recording Slack; no test talks to Slack.

const THREE_PARTS = Array.from({ length: 400 }, (_, i) => `line ${i} ${'z'.repeat(20)}`).join('\n');

test('a compaction that puts another message at the cursor seq is posted as a new message', async () => {
  const t = await started(0);
  t.say('the original answer');
  await t.tick();
  const before = t.cursor();
  t.edit(0, 'a summary written by the compaction');
  await t.tick();
  assert.equal(t.updates.length, 0, 'the first message in Slack is not rewritten');
  assert.deepEqual(t.bodies(), ['the original answer', 'a summary written by the compaction']);
  assert.notDeepEqual(t.cursor().refs, before.refs);
  await t.tick();
  assert.equal(t.bodies().length, 2, 'the new hash is the cursor now');
});

test('text that only grows, or only gains trailing text, is updated in place', async () => {
  const t = await started(0);
  t.say('hello  \n');
  await t.tick();
  t.edit(0, 'hello  \nworld');
  await t.tick();
  assert.equal(t.updates.length, 1);
  assert.equal(t.updates[0].card.body, 'hello  \nworld');
  assert.equal(t.bodies().length, 1);
});

test('a tool-only line is updated in place when the tools grow, and posted anew when they do not', async () => {
  const t = await started(0);
  t.say('', ['Bash']);
  await t.tick();
  t.trace.messages[0] = { text: '', tools: ['Bash', 'Edit'] }; t.trace.version += 1;
  await t.tick();
  assert.equal(t.updates.length, 1);
  assert.match(t.updates[0].card.body, /Bash, Edit/);
  t.trace.messages[0] = { text: '', tools: ['Grep'] }; t.trace.version += 1;
  await t.tick();
  assert.equal(t.updates.length, 1, 'no further update');
  assert.equal(t.bodies().length, 2);
  assert.match(t.bodies()[1], /Grep/);
});

test('a failure halfway through a split message does not re-post the parts already sent', async () => {
  const t = await started(0);
  const parts = splitText(THREE_PARTS);
  assert.ok(parts.length >= 3, `${parts.length} parts`);
  t.say(THREE_PARTS);
  t.state.failAt = new Set([3]); // the root is post 0, the parts are 1, 2, 3
  await assert.rejects(t.tick(), /slack down/);
  assert.equal(t.bodies().length, 2);
  t.state.failAt = new Set();
  await t.tick();
  assert.deepEqual(t.bodies(), parts);
  assert.equal(t.cursor().refs.length, parts.length);
  await t.tick();
  assert.equal(t.bodies().length, parts.length, 'nothing more after the retry');
});

test('a restart in the middle of a split message posts only the remaining parts', async () => {
  const t = await started(0);
  const parts = splitText(THREE_PARTS);
  t.say(THREE_PARTS);
  t.state.failAt = new Set([2]); // the root is post 0; part 1 goes out, part 2 fails
  await assert.rejects(t.tick(), /slack down/);
  assert.ok(t.cursor().hash.startsWith(PARTIAL_HASH), 'the cursor is marked partial');
  assert.equal(t.cursor().refs.length, 1);
  t.state.failAt = new Set();
  const before = t.posts.length;
  await t.tick();
  assert.equal(t.posts.length - before, parts.length - 1, 'only the parts that were missing');
  assert.deepEqual(t.bodies(), parts);
  assert.ok(!t.cursor().hash.startsWith(PARTIAL_HASH));
});

test('a message that failed halfway and then grew is continued from the next part', async () => {
  const t = await started(0);
  t.say(THREE_PARTS);
  t.state.failAt = new Set([2]);
  await assert.rejects(t.tick(), /slack down/);
  t.state.failAt = new Set();
  t.edit(0, `${THREE_PARTS}\nand a tail`);
  await t.tick();
  assert.equal(t.bodies().join('\n'), `${THREE_PARTS}\nand a tail`);
});

test('an edit that leaves fewer parts updates each remaining part and blanks the others', async () => {
  const t = await started(0);
  t.say(THREE_PARTS);
  await t.tick();
  const refs = t.cursor().refs;
  const shorter = splitText(THREE_PARTS).slice(0, 2).join('\n');
  t.trace.messages[0] = { text: shorter, tools: [] }; t.trace.version += 1;
  const since = t.ctx.host.since;
  t.ctx.host.since = async (s, c) => {
    const r = await since(s, c);
    return { ...r, updated: { ...r.updated, grew: true } }; // as if the shorter text still extended the old
  };
  t.state.calls = 0;
  await t.tick();
  const parts = splitText(shorter);
  assert.deepEqual(t.updates.slice(0, parts.length).map((u) => u.ref.ts), refs.slice(0, parts.length));
  assert.deepEqual(t.updates.slice(0, parts.length).map((u) => u.card.body), parts);
  assert.deepEqual(t.updates.slice(parts.length).map((u) => u.ref.ts), refs.slice(parts.length));
  assert.ok(t.updates.slice(parts.length).every((u) => /edited/.test(u.card.body)));
  assert.equal(t.state.calls, refs.length, 'one call per ref posted before');
  assert.equal(t.cursor().refs.length, parts.length);
});
