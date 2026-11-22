#!/usr/bin/env node
// Stand-in for `cursor-agent` that only does what the pin follower can see: it
// holds <HOME>/.cursor/chats/<hash>/<id>/store.db open for the id given by
// `--resume`, and when $FAKE_DIR/switch-<id> appears (its content is a new id)
// it closes that file and opens the new chat's instead, like /clear does.
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const first = argv[argv.indexOf('--resume') + 1];
const dir = process.env.FAKE_DIR;
const HASH = '0123456789abcdef0123456789abcdef';
const open = (id) => {
  const d = path.join(process.env.HOME, '.cursor', 'chats', HASH, id);
  fs.mkdirSync(d, { recursive: true });
  return fs.openSync(path.join(d, 'store.db'), 'a+');
};
let fd = open(first);
fs.writeFileSync(path.join(dir, `ready-${first}`), 'x');
const timer = setInterval(() => {
  const m = path.join(dir, `switch-${first}`);
  if (!fs.existsSync(m)) return;
  const next = fs.readFileSync(m, 'utf8').trim();
  fs.rmSync(m);
  fs.closeSync(fd);
  fd = open(next);
  fs.writeFileSync(path.join(dir, `switched-${first}`), next);
}, 50);
process.stdin.resume();
process.on('SIGTERM', () => { clearInterval(timer); process.exit(0); });
