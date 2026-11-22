// Which commit a build came from, for the version label in Settings.
//
// A deploy stamps server/build-info.json; a checkout run from source asks git;
// a Space deployed some other way only has HF's COMMIT_SHA, which is the Space
// repo's own commit and must say so. The route check runs the real server from
// this checkout, which has no stamp, so it reports the checkout's HEAD.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync, spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { readBuildInfo, buildStamp, BUILD_INFO_FILE } from '../src/build-info.js';
import { nativeFetch as fetch } from './native-client.mjs';

const SERVER = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-build-info-'));
test.after(() => fs.rmSync(root, { recursive: true, force: true }));

const ENV = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_AUTHOR_NAME: 'am', GIT_AUTHOR_EMAIL: 'am@test', GIT_COMMITTER_NAME: 'am', GIT_COMMITTER_EMAIL: 'am@test' };
const sh = (args, cwd) => execFileSync('git', args, { cwd, env: ENV, encoding: 'utf8' }).trim();
const SHA_A = 'a'.repeat(40);
const SHA_B = 'b'.repeat(40);

function appDir(name, { stamp } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
  if (stamp !== undefined) fs.writeFileSync(path.join(dir, BUILD_INFO_FILE), stamp);
  return dir;
}
function repo(dir) {
  sh(['init', '--quiet', '--initial-branch=main', '.'], dir);
  fs.writeFileSync(path.join(dir, 'README.md'), 'x\n');
  sh(['add', '.'], dir); sh(['commit', '--quiet', '-m', 'one'], dir);
  return sh(['rev-parse', 'HEAD'], dir);
}

test('a deploy stamp wins over git and COMMIT_SHA', () => {
  const dir = appDir('stamped', { stamp: buildStamp(SHA_A, 'main') });
  repo(dir);
  assert.deepEqual(readBuildInfo({ appRoot: dir, env: { COMMIT_SHA: SHA_B } }), { sha: SHA_A, ref: 'main', source: 'stamp' });
});

test('a checkout without a stamp reports its own HEAD and branch', () => {
  const dir = appDir('checkout');
  const head = repo(dir);
  assert.deepEqual(readBuildInfo({ appRoot: dir, env: { COMMIT_SHA: SHA_B } }), { sha: head, ref: 'main', source: 'git' });
});

test('an app unpacked inside some other repo does not report that repo', () => {
  const outer = path.join(root, 'outer');
  fs.mkdirSync(outer, { recursive: true });
  repo(outer);
  const dir = path.join(outer, 'release');
  fs.mkdirSync(path.join(dir, 'server'), { recursive: true });
  assert.equal(readBuildInfo({ appRoot: dir, env: {} }), null);
});

test('with neither, a Space reports its own commit as such', () => {
  const dir = appDir('space');
  assert.deepEqual(readBuildInfo({ appRoot: dir, env: { COMMIT_SHA: SHA_B } }), { sha: SHA_B, ref: null, source: 'space-commit' });
  assert.equal(readBuildInfo({ appRoot: dir, env: {} }), null, 'and nothing at all is null, not a guess');
});

test('a malformed stamp or COMMIT_SHA is ignored, not shown', () => {
  for (const stamp of ['not json', '{"sha":"$(id)"}', '{}']) {
    const dir = appDir(`bad-${Buffer.from(stamp).toString('hex')}`, { stamp });
    assert.deepEqual(readBuildInfo({ appRoot: dir, env: { COMMIT_SHA: SHA_B } }).source, 'space-commit', stamp);
  }
  assert.equal(readBuildInfo({ appRoot: appDir('bad-env'), env: { COMMIT_SHA: 'main; rm -rf' } }), null);
});

test('/api/info carries the build of the running server', async () => {
  const dir = path.join(root, 'route');
  const home = path.join(dir, 'home');
  const publicDir = path.join(dir, 'public');
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(publicDir, { recursive: true });
  fs.writeFileSync(path.join(publicDir, 'index.html'), '<html>fixture</html>');
  const free = net.createServer(); free.listen(0, '127.0.0.1'); await once(free, 'listening');
  const port = free.address().port; await new Promise((r) => free.close(r));
  const child = spawn(process.execPath, ['src/index.js'], {
    cwd: SERVER,
    env: {
      PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', DATA_DIR: path.join(dir, 'data'), PORT: String(port), PUBLIC_DIR: publicDir,
      CODEX_HOME: path.join(home, 'codex'), CLAUDE_CONFIG_DIR: path.join(home, 'claude'),
      XDG_CONFIG_HOME: path.join(home, 'config'), XDG_DATA_HOME: path.join(home, 'share'),
      AM_REPIN_DIR: path.join(dir, 'repin'), AM_INPUT_REQUIRED_DIR: path.join(dir, 'input-required'), AM_BASHRC: '/nonexistent',
      AM_LOCAL: path.join(dir, 'local'),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let logs = '';
  child.stdout.on('data', (c) => { logs += c; });
  child.stderr.on('data', (c) => { logs += c; });
  const base = `http://127.0.0.1:${port}`;
  try {
    let info = null;
    for (let i = 0; i < 200 && !info; i++) {
      try { const r = await fetch(`${base}/api/info`); if (r.ok) info = await r.json(); } catch {}
      if (child.exitCode !== null) throw new Error(`server exited:\n${logs}`);
      if (!info) await new Promise((r) => setTimeout(r, 100));
    }
    assert.ok(info, `server did not start:\n${logs}`);
    const expected = readBuildInfo({ appRoot: path.join(SERVER, '..'), env: {} });
    assert.ok(expected, 'this checkout has a git HEAD to report');
    assert.deepEqual(info.build, expected);
  } finally {
    child.kill('SIGTERM');
    if (child.exitCode === null) await once(child, 'exit');
  }
});
