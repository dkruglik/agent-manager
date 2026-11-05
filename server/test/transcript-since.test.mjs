import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// host.since(session, cursor): the assistant messages of a real Claude transcript after a cursor,
// parsed only when the trace revision changed. No server, no Slack.

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'am-since-'));
process.env.DATA_DIR = path.join(TMP, 'data');
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'claude');
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
const UUID = '11111111-2222-4333-8444-555555555555';
const file = path.join(process.env.CLAUDE_CONFIG_DIR, 'projects', 'p', `${UUID}.jsonl`);
fs.mkdirSync(path.dirname(file), { recursive: true });

const { createSince, readAssistantMessages, traceRevisionOf } = await import('../src/transcript-since.js');
const { sourceKey } = await import('../src/output-id.js');

const session = { id: 's1', cli: 'claude', sessionUuid: UUID, path: 's1' };
let n = 0;
const ts = () => new Date(Date.UTC(2026, 0, 1, 0, 0, n++)).toISOString();
const line = (type, content, extra = {}) => JSON.stringify({
  type, cwd: TMP, timestamp: ts(), message: { role: type, content, ...extra },
});
const say = (id, text) => line('assistant', [{ type: 'text', text }], { id });
const tool = (id, name) => line('assistant', [{ type: 'tool_use', id: `tu-${id}`, name, input: { command: 'ls' } }], { id });
const user = (text) => line('user', [{ type: 'text', text }]);
const write = (...lines) => fs.writeFileSync(file, `${lines.join('\n')}\n`);
const append = (...lines) => fs.appendFileSync(file, `${lines.join('\n')}\n`);

function counted() {
  const calls = { parse: 0 };
  const since = createSince({
    revisionOf: traceRevisionOf,
    readMessages: async (s) => { calls.parse += 1; return readAssistantMessages(s); },
  });
  return { calls, since };
}
const src = sourceKey(session);

test('a first look is a baseline: the end, no messages, not a restart', async () => {
  write(user('HELLO-USER'), say('m1', 'first'), tool('m2', 'Bash'), say('m3', 'third'));
  const { since } = counted();
  const r = await since(session, null);
  assert.deepEqual(r.messages, []);
  assert.equal(r.restarted, false);
  assert.equal(r.end.src, src);
  assert.equal(r.end.seq, 3);
  assert.ok(r.end.hash);
});

test('messages after a cursor are the assistant ones only, strictly after it', async () => {
  write(user('HELLO-USER'), say('m1', 'first'), user('Continue'), tool('m2', 'Bash'), say('m3', 'third'));
  const { since } = counted();
  const { end } = await since(session, null);
  const first = await since(session, { src, seq: 1, hash: (await since(session, { src, seq: 0, hash: '' })).messages[0].hash });
  assert.deepEqual(first.messages.map((m) => [m.seq, m.text, m.tools]), [[2, '', ['Bash']], [3, 'third', []]]);
  assert.ok(first.messages.every((m) => m.src === src && m.hash));
  assert.equal(first.restarted, false);
  assert.deepEqual(first.end, end);
  assert.equal(first.updated, undefined);
  assert.ok(!JSON.stringify(first).includes('Continue') && !JSON.stringify(first).includes('HELLO-USER'));
});

test('a cursor from another src re-baselines: the end, no messages, restarted', async () => {
  write(say('m1', 'first'));
  const { since } = counted();
  const r = await since(session, { src: 'other', seq: 9, hash: 'x' });
  assert.equal(r.restarted, true);
  assert.deepEqual(r.messages, []);
  assert.equal(r.end.src, src);
  assert.equal(r.end.seq, 1);
});

test('the same seq with a new hash is an update of the cursor message', async () => {
  write(say('m1', 'first'));
  const { since } = counted();
  const cursor = (await since(session, null)).end;
  append(line('assistant', [{ type: 'text', text: 'and more' }], { id: 'm1' }));
  const r = await since(session, cursor);
  assert.deepEqual(r.messages, []);
  assert.equal(r.updated.seq, 1);
  assert.notEqual(r.updated.hash, cursor.hash);
  assert.equal(r.updated.text, 'first\n\nand more');
  assert.equal(r.end.seq, 1);
});

test('an unchanged revision is not parsed again; a changed one is', async () => {
  write(say('m1', 'first'));
  const { since, calls } = counted();
  const { end } = await since(session, null);
  await since(session, end);
  await since(session, end);
  assert.equal(calls.parse, 1);
  append(say('m2', 'second'));
  const r = await since(session, end);
  assert.equal(calls.parse, 2);
  assert.deepEqual(r.messages.map((m) => m.text), ['second']);
});

test('a session without a transcript gives null', async () => {
  const { since } = counted();
  assert.equal(await since({ id: 's9', cli: 'claude', sessionUuid: 'ffffffff-2222-4333-8444-555555555555', path: 's9' }, null), null);
});

test('a cursor past the end of the same transcript is a restart', async () => {
  write(say('m1', 'only'));
  const { since } = counted();
  const r = await since(session, { src, seq: 9, hash: 'old' });
  assert.equal(r.restarted, true);
  assert.deepEqual(r.messages, []);
  assert.equal(r.end.seq, 1);
});

test('an assistant turn the harness marked as an error is a failure line, not dropped', async () => {
  write(say('m1', 'before'), JSON.stringify({
    type: 'assistant', timestamp: ts(), isApiErrorMessage: true, error: 'authentication_failed',
    message: { role: 'assistant', content: [{ type: 'text', text: 'Login expired' }] },
  }), say('m3', 'after'));
  const { messages } = await readAssistantMessages(session);
  assert.deepEqual(messages.map((m) => m.text), ['before', 'The assistant turn failed.', 'after']);
});

test('two looks that share one parse call the reader once', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  let parses = 0;
  const since = createSince({
    revisionOf: async () => '1',
    sourceOf: () => 'src',
    readMessages: async () => {
      parses += 1;
      await gate;
      return { revision: '1', messages: [{ text: 'a', tools: [] }] };
    },
  });
  const flight = { id: 'flight' };
  const both = Promise.all([since(flight, null), since(flight, null)]);
  release();
  const [a, b] = await both;
  assert.equal(parses, 1);
  assert.equal(a.end.seq, 1);
  assert.equal(b.end.seq, 1);
});

test('an updated message says whether it grew: extended text yes, a replacement or an unseen version no', async () => {
  const msgs = [{ text: 'first answer', tools: [] }];
  let rev = 1;
  const make = () => createSince({
    revisionOf: async () => String(rev), sourceOf: () => 'src',
    readMessages: async () => ({ revision: String(rev), messages: structuredClone(msgs) }),
  });
  const since = make();
  const base = (await since({ id: 'g' }, null)).end;
  msgs[0] = { text: 'first answer, continued', tools: [] }; rev += 1;
  assert.equal((await since({ id: 'g' }, base)).updated.grew, true);
  msgs[0] = { text: 'a different message after a compaction', tools: [] }; rev += 1;
  assert.equal((await since({ id: 'g' }, base)).updated.grew, false, 'not an extension of the one the cursor saw');
  assert.equal((await make()({ id: 'g' }, base)).updated.grew, false, 'a fresh process never saw the cursor version');
});

test('with more than 16 sessions the one used last is kept and the least recently used is evicted', async () => {
  const parsed = [];
  const lru = createSince({
    sourceOf: (s) => `src-${s.id}`,
    revisionOf: async () => '1',
    readMessages: async (s) => { parsed.push(s.id); return { revision: '1', messages: [{ text: 'x', tools: [] }] }; },
  });
  const at = (i) => ({ id: `s${i}` });
  for (let i = 0; i < 16; i++) await lru(at(i), null);
  await lru(at(0), null); // s0 is used again: now the newest
  await lru(at(16), null); // the 17th session evicts s1, not s0
  parsed.length = 0;
  await lru(at(0), null);
  assert.deepEqual(parsed, [], 's0 is still cached');
  await lru(at(1), null);
  assert.deepEqual(parsed, ['s1'], 's1 was evicted and is read again');
});
