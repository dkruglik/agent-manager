// Cursor chat ownership: which chat store.db a pane's process holds open, and when the pin follows it.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { cursorChatForPid, cursorRepin } from '../src/cursor-conversation.js';

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
