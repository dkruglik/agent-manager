// am_install_cursor, the install the Dockerfile runs, against a stub download.
// The image calls this function (it does not keep a second copy of the steps).
// Its three promises: a checksum mismatch fails the build, a checksum-matched
// tarball that does not unpack or run fails the build, and a failed download
// leaves the image without the agent but builds.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const allowlist = path.join(repo, 'scripts', 'cli-allowlist.sh');
const dockerfile = fs.readFileSync(path.join(repo, 'Dockerfile'), 'utf8');
assert.match(dockerfile, /am_cli_install cursor 1/, 'the image installs cursor only when the allowlist says so');
assert.match(dockerfile, /am_install_cursor/, 'the image uses the shared installer');
assert.doesNotMatch(dockerfile, /downloads\.cursor\.com/, 'the pin lives in the shared installer, not a second copy');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'am-cursor-image-'));
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// A tarball shaped like Cursor's: one top folder holding the `cursor-agent` wrapper.
const tarball = (name, versionExit) => {
  const src = path.join(tmp, `${name}-src`, 'dist-package');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'cursor-agent'),
    `#!/bin/sh\n[ -d "$HOME" ] || { echo "no HOME" >&2; exit 3; }\necho 2026.10.22-test\nexit ${versionExit}\n`, { mode: 0o755 });
  const out = path.join(tmp, `${name}.tar.gz`);
  execFileSync('tar', ['-czf', out, '-C', path.dirname(src), 'dist-package']);
  return out;
};

const runStep = (name, { source, sha }) => {
  const root = path.join(tmp, name);
  const stubs = path.join(root, 'stubs');
  for (const dir of ['opt', 'bin', 'tmp', 'stubs']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  // curl -fsSL <url> -o <file>: copy the fixture, or fail like a 404.
  fs.writeFileSync(path.join(stubs, 'curl'), source
    ? `#!/bin/sh\nwhile [ $# -gt 0 ]; do [ "$1" = -o ] && { cp "${source}" "$2"; exit 0; }; shift; done\nexit 1\n`
    : '#!/bin/sh\nexit 22\n', { mode: 0o755 });
  const result = spawnSync('sh', ['-c', '. "$1" && am_install_cursor', 'sh', allowlist], {
    encoding: 'utf8',
    env: {
      PATH: `${stubs}:${root}/bin:${process.env.PATH}`,
      CURSOR_VERSION: '2026.10.22-test',
      CURSOR_URL: 'https://downloads.invalid/agent-cli-package.tar.gz',
      CURSOR_SHA256: sha,
      AM_CURSOR_DEST: path.join(root, 'opt', 'cursor-agent'),
      AM_CLI_BINDIR: path.join(root, 'bin'),
      AM_CLI_TMP: path.join(root, 'tmp'),
    },
  });
  return { ...result, root };
};

try {
  const good = tarball('good', 0);
  const ok = runStep('ok', { source: good, sha: sha256(good) });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(fs.readlinkSync(path.join(ok.root, 'bin/cursor-agent')),
    `${ok.root}/opt/cursor-agent/2026.10.22-test/cursor-agent`, 'cursor-agent links into the pinned tree');
  assert.ok(fs.existsSync(path.join(ok.root, 'bin/agent')), 'and so does agent');
  assert.match(ok.stdout, /2026\.10\.22-test/, '--version ran, with a HOME that exists');

  const mismatch = runStep('mismatch', { source: good, sha: '0'.repeat(64) });
  assert.equal(mismatch.status, 1, 'a checksum mismatch fails the build');
  assert.match(mismatch.stderr, /does not match the pinned SHA-256/);
  assert.ok(!fs.existsSync(path.join(mismatch.root, 'bin/cursor-agent')), 'and installs nothing');

  const broken = tarball('broken', 1);
  const notRunning = runStep('not-running', { source: broken, sha: sha256(broken) });
  assert.equal(notRunning.status, 1, 'a matched tarball whose --version fails fails the build');
  assert.match(notRunning.stderr, /matched its SHA-256 but did not install or run/);

  const garbage = path.join(tmp, 'garbage.tar.gz');
  fs.writeFileSync(garbage, 'not a tarball\n');
  const notUnpacking = runStep('not-unpacking', { source: garbage, sha: sha256(garbage) });
  assert.equal(notUnpacking.status, 1, 'a matched tarball that does not unpack fails the build');
  assert.match(notUnpacking.stderr, /matched its SHA-256 but did not install or run/);

  const offline = runStep('offline', { source: null, sha: sha256(good) });
  assert.equal(offline.status, 0, 'a failed download does not fail the build');
  assert.match(offline.stdout, /cursor-agent install failed/);
  assert.ok(!fs.existsSync(path.join(offline.root, 'bin/cursor-agent')), 'and leaves no agent');

  console.log('cursor image step: all checks passed');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
