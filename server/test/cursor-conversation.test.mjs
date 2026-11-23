// Cursor chat ownership: which chat store.db a pane's process holds open, and when the pin follows it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cursorChatForPid, cursorRepin, cursorTranscriptWithMarker } from '../src/cursor-conversation.js';

const HASH = 'd72f0a1b2c3d4e5f60718293a4b5c6d7';
const A = 'f4c51f89-1111-4222-8333-444455556666';
const B = '37c13ac9-1111-4222-8333-444455556666';

function fixture() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-conv-'));
  const chatsRoot = path.join(tmp, 'chats');
  const procRoot = path.join(tmp, 'proc');
  fs.mkdirSync(chatsRoot, { recursive: true });
  const open = (pid, targets) => {
    fs.mkdirSync(path.join(procRoot, String(pid), 'fd'), { recursive: true });
    targets.forEach((t, i) => fs.symlinkSync(t, path.join(procRoot, String(pid), 'fd', String(i + 3))));
  };
  return { tmp, chatsRoot, procRoot, open, opts: { chatsRoot, procRoot } };
}
const db = (root, id, file = 'store.db', hash = HASH) => path.join(root, hash, id, file);

test('one chat store.db with -wal and -shm resolves to that chat', () => {
  const f = fixture();
  f.open(100, [db(f.chatsRoot, A), db(f.chatsRoot, A, 'store.db-wal'), db(f.chatsRoot, A, 'store.db-shm'), '/dev/null']);
  assert.deepEqual(cursorChatForPid(100, f.opts), { id: A });
});

test('symlinked chats root: fd targets use the real path', () => {
  const f = fixture();
  const real = path.join(f.tmp, 'real-chats');
  fs.mkdirSync(real);
  const link = path.join(f.tmp, 'link-chats');
  fs.symlinkSync(real, link);
  f.open(101, [db(real, A)]);
  assert.deepEqual(cursorChatForPid(101, { chatsRoot: link, procRoot: f.procRoot }), { id: A });
});

test('two different chats open is ambiguous', () => {
  const f = fixture();
  f.open(102, [db(f.chatsRoot, A), db(f.chatsRoot, B)]);
  assert.equal(cursorChatForPid(102, f.opts), null);
});

test('only -wal open does not count', () => {
  const f = fixture();
  f.open(103, [db(f.chatsRoot, A, 'store.db-wal'), db(f.chatsRoot, A, 'meta.json')]);
  assert.equal(cursorChatForPid(103, f.opts), null);
});

test('store.db outside the chats root is ignored', () => {
  const f = fixture();
  f.open(104, [path.join(f.tmp, 'elsewhere', HASH, A, 'store.db')]);
  assert.equal(cursorChatForPid(104, f.opts), null);
});

test('wrong depth or non-uuid directory is ignored', () => {
  const f = fixture();
  f.open(105, [path.join(f.chatsRoot, A, 'store.db'), path.join(f.chatsRoot, HASH, 'not-a-uuid', 'store.db'),
    path.join(f.chatsRoot, 'zz', A, 'store.db'), path.join(f.chatsRoot, HASH, A, 'x', 'store.db')]);
  assert.equal(cursorChatForPid(105, f.opts), null);
});

test('missing fd dir or missing chats root is a miss', () => {
  const f = fixture();
  assert.equal(cursorChatForPid(106, f.opts), null);
  f.open(107, [db(f.chatsRoot, A)]);
  assert.equal(cursorChatForPid(107, { chatsRoot: path.join(f.tmp, 'nope'), procRoot: f.procRoot }), null);
});

test('invalid pids are a miss', () => {
  const f = fixture();
  for (const pid of [0, 1, 'x', -5, 1.5, null]) assert.equal(cursorChatForPid(pid, f.opts), null);
});

test('cursorRepin moves only to an unclaimed, different chat', () => {
  assert.equal(cursorRepin({ owned: { id: B }, pinned: A, claimed: new Set() }), B);
  assert.equal(cursorRepin({ owned: { id: A }, pinned: A, claimed: new Set() }), null);
  assert.equal(cursorRepin({ owned: { id: B }, pinned: A, claimed: new Set([B]) }), null);
  assert.equal(cursorRepin({ owned: null, pinned: A, claimed: new Set() }), null);
});

// A delegated turn ends with its marker, so the transcript that holds it names the
// chat the pane really used, without reading the process's fds.
function projects() {
  const root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-proj-')), 'projects');
  const write = (slug, id, text, mtime = Date.now()) => {
    const file = path.join(root, slug, 'agent-transcripts', id, `${id}.jsonl`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ role: 'user', message: { content: [{ type: 'text', text }] } })}\n`);
    fs.utimesSync(file, mtime / 1000, mtime / 1000);
    return file;
  };
  return { root, write };
}
const MARK = '[AM delegation 26adc413-f8c8-462f-907a-3871d700e023]';

test('the transcript holding the marker is found, in any project', async () => {
  const p = projects();
  p.write('data-workspaces-a', A, 'old chat, unrelated');
  const file = p.write('data-workspaces-b', B, `task text\n\n${MARK}`);
  assert.deepEqual(await cursorTranscriptWithMarker({ root: p.root, marker: MARK, since: Date.now() - 60_000 }), { file, chat: B });
});

test('a transcript last written before the dispatch is not read', async () => {
  const p = projects();
  p.write('data-workspaces-a', A, MARK, Date.now() - 3_600_000);
  assert.equal(await cursorTranscriptWithMarker({ root: p.root, marker: MARK, since: Date.now() - 60_000 }), null);
});

test('the excluded file and a quote of the marker in two chats are not a match', async () => {
  const p = projects();
  const pinned = p.write('data-workspaces-a', A, MARK);
  assert.equal(await cursorTranscriptWithMarker({ root: p.root, marker: MARK, since: 0, exclude: pinned }), null, 'already watched');
  p.write('data-workspaces-b', B, MARK);
  assert.equal(await cursorTranscriptWithMarker({ root: p.root, marker: MARK, since: 0 }), null, 'two chats is ambiguous: no guess');
});

test('a missing projects folder is no match, not an error', async () => {
  assert.equal(await cursorTranscriptWithMarker({ root: path.join(os.tmpdir(), 'no-such-cursor-projects'), marker: MARK, since: 0 }), null);
});

test('an unreadable fd directory (a non-dumpable process) is no answer, and says so once', (t) => {
  const f = fixture();
  f.open(200, [db(f.chatsRoot, A)]);
  fs.chmodSync(path.join(f.procRoot, '200', 'fd'), 0o000);
  t.after(() => fs.chmodSync(path.join(f.procRoot, '200', 'fd'), 0o700));
  const logged = [];
  t.mock.method(console, 'warn', (...args) => logged.push(args.join(' ')));
  assert.equal(cursorChatForPid(200, f.opts), null);
  assert.equal(cursorChatForPid(200, f.opts), null);
  assert.equal(logged.filter((l) => l.includes('EACCES')).length, 1, logged.join('\n'));
});
