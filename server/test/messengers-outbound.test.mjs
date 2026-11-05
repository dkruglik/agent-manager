import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { BindingStore } from '../src/messengers/store.js';
import { finishedCard } from '../src/messengers/cards.js';
import { toMrkdwn } from '../src/messengers/adapters/slack.js';
import { postsFinished, createFilter, filterFinishedCard, migrateSeen, finishedMark, markFinished } from '../src/messengers/outbound.js';
import { KEY, BOT, session, setup, started } from './messengers-outbound-fixtures.mjs';

// The Slack mirror of an agent's transcript (the `transcript` binding event): the cursor, the caps,
// splitting, in-place updates, the credential filter, the privacy lock, and the `seen` migration.
// A scripted trace and a recording adapter stand in for Agent Manager and Slack; no test talks to Slack.

test('a binding with both events posts transcript only', () => {
  const b = (events) => ({ events });
  assert.equal(postsFinished(b(['input-required', 'finished'])), true);
  assert.equal(postsFinished(b(['finished', 'transcript'])), false);
  assert.equal(postsFinished(b(['input-required', 'finished', 'transcript'])), false);
  assert.equal(postsFinished(b(['transcript'])), false);
  assert.equal(postsFinished(b(['input-required'])), false);
});

test('transcript off posts no mirror and does not read the transcript', async () => {
  const t = setup({ events: ['input-required', 'finished'] });
  t.say('hello');
  await t.tick();
  t.say('again');
  await t.tick();
  assert.equal(t.posts.length, 0);
  assert.equal(t.trace.parses, 0);
  assert.equal(t.cursor(), null);
});

test('the first look is a baseline: nothing is posted and the end is stored', async () => {
  const t = setup();
  t.say('a'); t.say('b');
  await t.tick();
  assert.equal(t.posts.length, 0);
  assert.deepEqual({ ...t.cursor(), hash: '' }, { src: 'srcA', seq: 2, hash: '', refs: [] });
  assert.ok(t.cursor().hash);
});

test('new messages go into the session root, and the cursor follows with the Slack ts', async () => {
  const t = await started(1);
  t.say('hello there');
  await t.tick();
  assert.equal(t.posts.length, 2);
  assert.deepEqual([t.posts[0].target.thread, t.posts[0].card.kind], [null, 'root']);
  assert.equal(t.posts[0].card.title, '🧵 alpha · claude');
  assert.deepEqual([t.posts[1].target.thread, t.posts[1].card.body], ['t1', 'hello there']);
  assert.equal(t.cursor().seq, 2);
  assert.deepEqual(t.cursor().refs, ['t2']);
  assert.equal(t.store.state('roots', KEY).at(-1).count, 1);
  await t.tick();
  assert.equal(t.posts.length, 2, 'nothing new, nothing posted');
});

test('nothing is posted until the session has settled', async () => {
  const t = await started(1, { settled: false });
  t.say('streaming');
  await t.tick();
  assert.equal(t.posts.length, 0);
  t.state.settled = true;
  await t.tick();
  assert.deepEqual(t.bodies(), ['streaming']);
});

test('at most 5 messages are posted, the older ones collapse into one line', async () => {
  const t = await started(1);
  for (let i = 1; i <= 8; i++) t.say(`m${i}`);
  await t.tick();
  assert.deepEqual(t.bodies(), ['3 earlier messages — open in Agent Manager.', 'm4', 'm5', 'm6', 'm7', 'm8']);
  assert.equal(t.posts.find((p) => p.card.body?.startsWith('3 earlier')).card.link, 'http://am/#session=s1');
  assert.equal(t.cursor().seq, 9);
  await t.tick();
  assert.equal(t.bodies().length, 6, 'the collapsed ones are not posted later');
});

test('text past the block limit is split into successive messages, in order', async () => {
  const t = await started(0);
  const long = Array.from({ length: 700 }, (_, i) => `line ${i} ${'x'.repeat(5)}`).join('\n');
  t.say(long);
  await t.tick();
  const parts = t.bodies();
  assert.ok(parts.length >= 3);
  assert.equal(parts.join('\n'), long);
  assert.ok(parts.every((p) => toMrkdwn(p).length <= 2990), 'each part fits one section after Slack escaping');
  assert.equal(t.cursor().refs.length, parts.length);
});

test('escaping is counted when splitting: a text of ampersands is not cut by the adapter', async () => {
  const t = await started(0);
  t.say('&'.repeat(2000));
  await t.tick();
  assert.ok(t.bodies().length >= 2);
  assert.equal(t.bodies().join(''), '&'.repeat(2000));
  assert.ok(t.bodies().every((p) => toMrkdwn(p).length <= 2990));
});

test('an edited cursor message updates only its last ref in place', async () => {
  const t = await started(0);
  t.say('x'.repeat(5000));
  await t.tick();
  const before = t.cursor();
  assert.equal(before.refs.length, 2);
  t.edit(0, `${'x'.repeat(5000)} and a tail`);
  await t.tick();
  assert.equal(t.updates.length, 1);
  assert.equal(t.updates[0].ref.ts, before.refs.at(-1));
  assert.ok(t.updates[0].card.body.endsWith('and a tail'));
  assert.equal(t.bodies().length, 2, 'nothing new is posted');
  assert.deepEqual(t.cursor().refs, before.refs);
  assert.notEqual(t.cursor().hash, before.hash);
  await t.tick();
  assert.equal(t.updates.length, 1, 'the new hash is the cursor now');
});

test('an older message is not rewritten when it changes after a newer one was posted', async () => {
  const t = await started(0);
  t.say('first'); await t.tick();
  t.say('second'); await t.tick();
  t.edit(0, 'first, rewritten');
  await t.tick();
  assert.equal(t.updates.length, 0);
});

test('the cursor is not written when the post fails, and the next tick retries', async () => {
  const t = await started(1);
  const before = t.cursor();
  t.say('lost?');
  t.state.failAt = new Set([0]);
  await assert.rejects(t.tick(), /slack down/);
  assert.deepEqual(t.cursor(), before);
  t.state.failAt = new Set([1]);
  await assert.rejects(t.tick(), /slack down/);
  assert.deepEqual(t.cursor(), before, 'the root went out, the message did not');
  t.state.failAt = new Set();
  await t.tick();
  assert.deepEqual(t.bodies(), ['lost?']);
  assert.equal(t.cursor().seq, 2);
});

test('a failure after some posts keeps the cursor at the last one posted', async () => {
  const t = await started(1);
  t.say('one'); t.say('two');
  t.state.failAt = new Set([2]); // the root is post 0, "one" is 1, "two" is 2
  await assert.rejects(t.tick(), /slack down/);
  assert.equal(t.cursor().seq, 2);
  assert.deepEqual(t.bodies(), ['one']);
  t.state.failAt = new Set();
  await t.tick();
  assert.deepEqual(t.bodies(), ['one', 'two']);
});

test('the cursor is committed after each message, not once per tick', async () => {
  const t = await started(1);
  const seqs = [];
  const patch = t.store.patchState.bind(t.store);
  t.store.patchState = (p) => { if (p.outbound) seqs.push(Object.values(p.outbound)[0].seq); return patch(p); };
  t.say('a'); t.say('b'); t.say('c');
  await t.tick();
  assert.deepEqual(seqs, [2, 3, 4]);
  assert.equal(t.bodies().length, 3);
  assert.equal(t.store.state('roots', KEY).at(-1).count, 3, 'each post is counted once, not again at the final commit');
});

test('a tool-only turn posts one line naming the tools', async () => {
  const t = await started(0);
  t.say('', ['Bash', 'Edit', 'Bash']);
  await t.tick();
  assert.equal(t.bodies().length, 1);
  assert.match(t.bodies()[0], /Bash.*Edit/);
  assert.equal((t.bodies()[0].match(/Bash/g) || []).length, 1);
});

test('a transcript the session did not have before posts one restart line and the new end', async () => {
  const t = await started(3);
  t.trace.src = 'srcB';
  t.trace.messages = [{ text: 'fresh start', tools: [] }];
  t.trace.version += 1;
  await t.tick();
  assert.deepEqual(t.bodies(), ['Conversation restarted.']);
  assert.deepEqual([t.cursor().src, t.cursor().seq], ['srcB', 1]);
  t.say('next');
  await t.tick();
  assert.deepEqual(t.bodies(), ['Conversation restarted.', 'next']);
});

test('an edit after a restart, when nothing was posted for that message, is posted', async () => {
  const t = await started(1);
  t.trace.src = 'srcB';
  t.trace.messages = [{ text: 'fresh', tools: [] }];
  t.trace.version += 1;
  await t.tick();
  assert.deepEqual(t.cursor().refs, []);
  t.edit(0, 'fresh, longer');
  await t.tick();
  assert.ok(t.bodies().includes('fresh, longer'));
  assert.ok(t.cursor().refs.length >= 1);
});

test('under a real lock nothing is posted and the cursor stays put', async () => {
  const t = await started(1);
  const before = t.cursor();
  t.say('while locked');
  t.state.lock = { locked: true, reason: 'public-space' };
  await t.tick();
  assert.equal(t.posts.length, 0);
  assert.deepEqual(t.cursor(), before);
  t.state.lock = { locked: false, reason: null };
  await t.tick();
  assert.deepEqual(t.bodies(), ['while locked']);
});

test('while the privacy verdict is still being checked, it still posts', async () => {
  const t = await started(1);
  t.say('during checking');
  t.state.lock = { locked: true, reason: 'checking' };
  await t.tick();
  assert.deepEqual(t.bodies(), ['during checking']);
});

test('a call cap per session and tick keeps one backlog from stalling the rest', async () => {
  const t = await started(0);
  for (let i = 0; i < 5; i++) t.say(`${i} ${'y'.repeat(6000)}`); // three parts each
  t.state.calls = 0;
  await t.tick();
  assert.ok(t.state.calls <= 12, `${t.state.calls} calls`);
  const first = t.cursor().seq;
  assert.ok(first >= 1 && first < 5);
  t.state.calls = 0;
  await t.tick();
  assert.equal(t.cursor().seq, 5);
  assert.ok(t.state.calls <= 12);
});

test('a configured SLACK_BOT_TOKEN in the text is redacted, in the transcript and in a finished card', async () => {
  const env = { SLACK_BOT_TOKEN: BOT, SLACK_APP_TOKEN: 'test-app-token-value-5678', HF_TOKEN: 'plain-hf-secret-value', OPENAI_API_KEY: 'plain-openai-secret' };
  const t = await started(0, { env });
  t.say(`the token is ${BOT} and ${env.OPENAI_API_KEY}`, ['Bash']);
  await t.tick();
  assert.ok(!t.bodies()[0].includes(BOT) && !t.bodies()[0].includes('plain-openai-secret'));
  assert.match(t.bodies()[0], /\[redacted\]/);
  const filter = createFilter(env);
  const card = filterFinishedCard(filter, finishedCard({ agent: session, link: null, text: `done, ${BOT} and ${env.HF_TOKEN}` }));
  assert.ok(!card.body.includes(BOT) && !card.body.includes(env.HF_TOKEN));
  assert.equal(card.kind, 'finished');
  assert.equal(card.title, '✅ alpha finished');
});

test('question cards are untouched: the mirror never posts, updates or closes an input card', async () => {
  const t = await started(1);
  const input = {
    bindingId: 'b0', sessionId: 's1', key: 'q1', kind: 'input', status: 'open', adapter: 'slack',
    ref: { channel: 'C0', ts: 'card-ts' }, item: { key: 'q1', kind: 'question' }, partial: {},
  };
  t.store.putPosted('b0|s1|q1', input);
  const before = structuredClone(t.store.posted('b0|s1|q1'));
  t.say('a'); await t.tick();
  t.edit(1, 'a, longer'); await t.tick();
  assert.deepEqual(t.store.posted('b0|s1|q1'), before);
  assert.ok(t.updates.every((u) => u.ref.ts !== 'card-ts'));
  assert.ok(t.posts.every((p) => !p.card.options?.length && p.card.kind !== 'input'));
});

test('the seen migration seeds a baseline once and posts nothing', async () => {
  const t = setup();
  t.say('old 1'); t.say('old 2');
  t.store.putSeen('b0|s1', 'srcA:2:abc');
  t.store.putSeen('gone|s1', 'srcA:2:abc');
  assert.equal(migrateSeen(t.store), 1);
  assert.equal(finishedMark(t.store, 'slack', 'C0', 's1'), 'srcA:2:abc');
  assert.equal(migrateSeen(t.store), 0, 'once');
  await t.tick();
  assert.equal(t.posts.length, 0);
  assert.equal(t.cursor().seq, 2, 'the first transcript look is the baseline');
  assert.equal(finishedMark(t.store, 'slack', 'C0', 's1'), 'srcA:2:abc', 'the finished mark survives the cursor');
});

test('migrating does not overwrite an existing cursor, and the finished mark does not disturb it', async () => {
  const t = await started(2);
  const before = t.cursor();
  t.store.putSeen('b0|s1', 'srcA:1:zzz');
  assert.equal(migrateSeen(t.store), 0);
  markFinished(t.store, 'slack', 'C0', 's1', 'srcA:2:q');
  assert.deepEqual({ ...t.cursor(), finished: undefined }, { ...before, finished: undefined });
  assert.equal(finishedMark(t.store, 'slack', 'C0', 's1'), 'srcA:2:q');
});

test('removing the binding drops the cursor with the rest of the session\'s thread state', async () => {
  const t = await started(1);
  const removed = t.store.binding('b0');
  t.store.removeBinding('b0');
  t.threads.forget(removed);
  assert.equal(t.cursor(), null);
});

test('the cursor survives a restart of the store, and a malformed record is dropped', async () => {
  const t = await started(1);
  t.say('kept'); await t.tick();
  const reloaded = new BindingStore(path.join(t.root, 'messengers.json'));
  assert.deepEqual(reloaded.state('outbound', KEY), t.cursor());
  const file = path.join(t.root, 'messengers.json');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  raw.outbound[KEY] = { src: 'x', seq: -1 };
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.equal(new BindingStore(file).state('outbound', KEY), null);
});
