// am_install_cursor, the install the Dockerfile runs, against stub downloads.
// The image calls this function (it does not keep a second copy of the steps).
// Its promises, the same ones the image build has: the version is read from
// cursor.com/install and that build is installed; a failed lookup or download
// leaves the image without the agent but builds; a downloaded build that does
// not unpack or run fails the build.
import assert from 'node:assert/strict';
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
assert.doesNotMatch(dockerfile, /cursor_ver=/, 'the lookup is not copied into the Dockerfile');
assert.match(fs.readFileSync(allowlist, 'utf8'), /cursor\.com\/install/, 'the shared installer reads the newest build');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'am-cursor-image-'));
const VERSION = '2026.10.22-abc123';

// A tarball shaped like Cursor's: one top folder holding the `cursor-agent` wrapper.
const tarball = (name, versionExit) => {
  const src = path.join(tmp, `${name}-src`, 'dist-package');
  fs.mkdirSync(src, { recursive: true });
  fs.writeFileSync(path.join(src, 'cursor-agent'),
    `#!/bin/sh\n[ -d "$HOME" ] || { echo "no HOME" >&2; exit 3; }\necho ${VERSION}\nexit ${versionExit}\n`, { mode: 0o755 });
  const out = path.join(tmp, `${name}.tar.gz`);
  execFileSync('tar', ['-czf', out, '-C', path.dirname(src), 'dist-package']);
  return out;
};

// installer: the text cursor.com/install serves, or null to fail the lookup.
// source: the tarball the download returns, or null to fail the download.
const runStep = (name, { installer, source }) => {
  const root = path.join(tmp, name);
  const stubs = path.join(root, 'stubs');
  for (const dir of ['opt', 'bin', 'tmp', 'stubs']) fs.mkdirSync(path.join(root, dir), { recursive: true });
  // curl with -o copies the fixture (or fails); without -o it prints the installer.
  const installerText = installer === null ? '' : `DOWNLOAD_URL="https://downloads.cursor.com/lab/${installer}/\${OS}/\${ARCH}/agent-cli-package.tar.gz"\n`;
  fs.writeFileSync(path.join(stubs, 'curl'), [
    '#!/bin/sh',
    'prev=',
    'for a in "$@"; do',
    '  if [ "$prev" = -o ]; then',
    source ? `    cp "${source}" "$a"; exit $?` : '    exit 22',
    '  fi',
    '  prev=$a',
    'done',
    installer === null ? 'exit 22' : `printf '%s' '${installerText}'`,
    '',
  ].join('\n'), { mode: 0o755 });
  const result = spawnSync('sh', ['-c', '. "$1" && am_install_cursor', 'sh', allowlist], {
    encoding: 'utf8',
    env: {
      PATH: `${stubs}:${root}/bin:${process.env.PATH}`,
      AM_CURSOR_DEST: path.join(root, 'opt', 'cursor-agent'),
      AM_CLI_BINDIR: path.join(root, 'bin'),
      AM_CLI_TMP: path.join(root, 'tmp'),
    },
  });
  return { ...result, root };
};

try {
  const good = tarball('good', 0);
  const ok = runStep('ok', { installer: VERSION, source: good });
  assert.equal(ok.status, 0, ok.stderr);
  assert.equal(fs.readlinkSync(path.join(ok.root, 'bin/cursor-agent')),
    `${ok.root}/opt/cursor-agent/${VERSION}/cursor-agent`, 'cursor-agent links into the versioned tree');
  assert.ok(fs.existsSync(path.join(ok.root, 'bin/agent')), 'and so does agent');
  assert.match(ok.stdout, new RegExp(VERSION), '--version ran, with a HOME that exists');

  const noLookup = runStep('no-lookup', { installer: null, source: good });
  assert.equal(noLookup.status, 0, 'a failed installer lookup does not fail the build');
  assert.match(noLookup.stdout, /cursor-agent install failed/);
  assert.ok(!fs.existsSync(path.join(noLookup.root, 'bin/cursor-agent')), 'and leaves no agent');

  const offline = runStep('offline', { installer: VERSION, source: null });
  assert.equal(offline.status, 0, 'a failed download does not fail the build');
  assert.match(offline.stdout, /cursor-agent install failed/);
  assert.ok(!fs.existsSync(path.join(offline.root, 'bin/cursor-agent')), 'and leaves no agent');

  const broken = tarball('broken', 1);
  const notRunning = runStep('not-running', { installer: VERSION, source: broken });
  assert.equal(notRunning.status, 1, 'a downloaded build whose --version fails fails the build');
  assert.match(notRunning.stderr, /downloaded but did not install or run/);

  const garbage = path.join(tmp, 'garbage.tar.gz');
  fs.writeFileSync(garbage, 'not a tarball\n');
  const notUnpacking = runStep('not-unpacking', { installer: VERSION, source: garbage });
  assert.equal(notUnpacking.status, 1, 'a download that does not unpack fails the build');
  assert.match(notUnpacking.stderr, /downloaded but did not install or run/);

  console.log('cursor image step: all checks passed');
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
