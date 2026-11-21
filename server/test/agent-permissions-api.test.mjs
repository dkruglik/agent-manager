// Agent permissions through the real server: what a save accepts and writes,
// what Claude is launched with, and what an unreadable settings file may not undo.
// Run with: node test/agent-permissions-api.test.mjs  (from server/)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { nativeFetch as fetch } from './native-client.mjs';
import { freePort } from './free-port.mjs';

const { SPACE_ID, AM_DISTRIBUTE_SKILLS, ...BASE_ENV } = process.env;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function boot(t, seed = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-perms-api-'));
  const dataDir = path.join(root, 'data');
  const home = path.join(root, 'home');
  fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true });
  fs.mkdirSync(path.join(home, '.cursor'), { recursive: true });
  for (const [rel, text] of Object.entries(seed)) {
    const file = path.join(root, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text);
  }
  const port = await freePort();
  const server = spawn('node', ['src/index.js'], {
    env: { ...BASE_ENV, PORT: String(port), DATA_DIR: dataDir, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), AM_BASHRC: '/nonexistent' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let log = '';
  server.stdout.on('data', (c) => { log += c; });
  server.stderr.on('data', (c) => { log += c; });
  t.after(async () => {
    server.kill('SIGTERM');
    await Promise.race([new Promise((r) => server.once('exit', r)), sleep(3000)]);
    for (let i = 0; i < 5; i++) { try { fs.rmSync(root, { recursive: true, force: true }); break; } catch { await sleep(100); } }
  });
  const api = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 80; i++) {
    if (await fetch(`${api}/api/health`).then((r) => r.ok).catch(() => false)) break;
    await sleep(250);
  }
  const call = async (route, init = {}) => {
    const r = await fetch(`${api}${route}`, { ...init, headers: { 'content-type': 'application/json', 'x-am-origin': 'operator' } });
    return { status: r.status, body: await r.json().catch(() => null) };
  };
  return { root, dataDir, home, call, log: () => log };
}
const SETTINGS = { artifacts: { enabled: true, space: '', visibility: 'private' }, jobs: { askAboveUsd: 5 }, archive: { after: 'never' }, revive: { enabled: false, days: 7, continue: false }, backup: { every: 'never', dataset: '', exclude: [] } };
const put = (env, agentPermissions, base) => env.call(`/api/config${base ? `?base=${encodeURIComponent(base)}` : ''}`,
  { method: 'PUT', body: JSON.stringify({ ...SETTINGS, agentPermissions }) });

test('a save refuses bad rules and switches, and keeps good ones', async (t) => {
  const env = await boot(t);
  const first = await put(env, { claude: { allow: ['Bash(ls)'] } });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  const rev = first.body.rev;
  for (const [bad, why] of [
    [{ claude: { allow: [3] } }, /must be text/],
    [{ claude: { blockReadsOutsideWorkingDirectories: 'yes' } }, /must be true or false/],
    [{ cursor: { blockWritesOutsideWorkingDirectories: true } }, /not a Cursor setting/],
  ]) {
    const r = await put(env, bad, rev);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.code, 'invalid-input');
    assert.match(r.body.error, why);
  }
  const ok = await put(env, { claude: { allow: ['Bash(ls)'], blockReadsOutsideWorkingDirectories: true }, cursor: { deny: ['Shell(rm)'] } }, rev);
  assert.equal(ok.status, 200, JSON.stringify(ok.body));
  assert.equal(ok.body.agentPermissions.claude.blockReadsOutsideWorkingDirectories, true);
  const saved = JSON.parse(fs.readFileSync(path.join(env.dataDir, 'am-config.json'), 'utf8'));
  assert.deepEqual(saved.agentPermissions.cursor.deny, ['Shell(rm)']);
  const cursor = JSON.parse(fs.readFileSync(path.join(env.home, '.cursor', 'cli-config.json'), 'utf8'));
  assert.deepEqual(cursor.permissions.deny, ['Shell(rm)']);
  assert.deepEqual(ok.body.cursorPermissions, { ok: true, changed: true });
  assert.deepEqual((await env.call('/api/config')).body.agentPermissions.cursor.deny, ['Shell(rm)']);
});

test('an unreadable am-config.json at boot leaves the Cursor rules in the file', async (t) => {
  const cursorFile = { permissions: { allow: [], deny: ['Shell(rm)'] }, model: 'x' };
  const env = await boot(t, {
    'data/am-config.json': '{ not json',
    'home/.cursor/cli-config.json': JSON.stringify(cursorFile),
    'data/state/cursor-permissions-applied.json': JSON.stringify({ allow: [], deny: ['Shell(rm)'] }),
  });
  const after = JSON.parse(fs.readFileSync(path.join(env.home, '.cursor', 'cli-config.json'), 'utf8'));
  assert.deepEqual(after, cursorFile, `the Cursor file was rewritten\n${env.log().slice(-600)}`);
  const status = (await env.call('/api/config')).body.cursorPermissions;
  assert.equal(status.ok, false);
  assert.match(status.error, /left as they are/);
});
