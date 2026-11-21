// A running Cursor pane's pin follows the chat its cursor-agent holds open.
//
// Real PTYs through the runner, with a stand-in `cursor-agent` on PATH
// (fixtures/fake-cursor-agent.mjs) that holds a chat's store.db open and moves
// to another chat on request, as /clear does. Covers runner.refreshCursorPin:
// unchanged while the chat is the pinned one, moved (and persisted) after the
// switch, refused when another session already pins the new chat, and harmless
// for a stopped or non-cursor session. No model, no real Cursor; everything
// lives under a temp HOME.
//
// Run with: node test/cursor-repin.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test, after } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-repin-'));
for (const k of Object.keys(process.env)) {
  if (/^(CLAUDE_CONFIG_DIR|CODEX_HOME|GEMINI_CLI_HOME|CURSOR_\w+|OPENCODE_\w+|HERMES_HOME|OPENCLAW_HOME|FX_HOME|XDG_\w+|AM_\w+)$/.test(k)) delete process.env[k];
}
const FAKE_DIR = path.join(root, 'fake'); fs.mkdirSync(FAKE_DIR);
const BIN = path.join(root, 'bin'); fs.mkdirSync(BIN);
fs.writeFileSync(path.join(BIN, 'cursor-agent'),
  `#!/bin/sh\nexec ${process.execPath} ${path.join(HERE, 'fixtures', 'fake-cursor-agent.mjs')} "$@"\n`, { mode: 0o755 });
Object.assign(process.env, {
  DATA_DIR: path.join(root, 'data'), HOME: path.join(root, 'home'), AM_LOCAL: path.join(root, 'local'),
  XDG_CONFIG_HOME: path.join(root, 'xdg'), AM_BASHRC: '/nonexistent', FAKE_DIR,
  PATH: `${BIN}${path.delimiter}${process.env.PATH}`,
});
for (const d of [process.env.DATA_DIR, process.env.HOME, process.env.AM_LOCAL, process.env.XDG_CONFIG_HOME]) fs.mkdirSync(d, { recursive: true });
const sessions = await import('../src/sessions.js');
const runner = await import('../src/runner.js');
// The pane is a login shell, which resets PATH; the temp HOME's profile puts the fake back first.
fs.writeFileSync(path.join(process.env.HOME, '.profile'), `export PATH=${BIN}:$PATH\n`);
sessions.init();
after(async () => { await runner.stopAll(); fs.rmSync(root, { recursive: true, force: true }); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 10000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(50); } return false; };
const marker = (kind, id) => path.join(FAKE_DIR, `${kind}-${id}`);
let n = 0;
const start = async () => {
  const s = sessions.create({ name: `cur-${++n}`, cli: 'cursor', path: `cur-${n}` });
  runner.ensureRunning(sessions.get(s.id));
  assert.ok(await until(() => fs.existsSync(marker("ready", s.sessionUuid))), 'the fake cursor-agent never opened its chat');
  return s;
};
const switchTo = async (s, next) => {
  fs.writeFileSync(marker('switch', s.sessionUuid), next);
  assert.ok(await until(() => fs.existsSync(marker('switched', s.sessionUuid))), 'the fake never switched chats');
};

test('the pin follows the chat the pane holds open after a /clear', async () => {
  const s = await start();
  assert.equal(runner.refreshCursorPin(s.id), s.sessionUuid, 'unchanged while the chat is the pinned one');
  const next = randomUUID();
  await switchTo(s, next);
  assert.equal(runner.refreshCursorPin(s.id), next);
  assert.equal(sessions.get(s.id).sessionUuid, next);
  assert.equal(sessions.list().find((x) => x.id === s.id).sessionUuid, next);
  runner.stop(s.id);
});

test('a chat another session pins is not taken', async () => {
  const s = await start();
  const next = randomUUID();
  const rival = sessions.create({ name: 'rival', cli: 'cursor', path: 'rival' });
  sessions.update(rival.id, { sessionUuid: next });
  await switchTo(s, next);
  assert.equal(runner.refreshCursorPin(s.id), s.sessionUuid);
  assert.equal(sessions.get(s.id).sessionUuid, s.sessionUuid);
  runner.stop(s.id);
});

test('a stopped or non-cursor session returns its pin and does not throw', () => {
  const stopped = sessions.create({ name: 'stopped', cli: 'cursor', path: 'stopped' });
  assert.equal(runner.refreshCursorPin(stopped.id), stopped.sessionUuid);
  const other = sessions.create({ name: 'other', cli: 'claude', path: 'other' });
  assert.equal(runner.refreshCursorPin(other.id), other.sessionUuid);
  assert.equal(runner.refreshCursorPin('no-such-session'), undefined);
});
