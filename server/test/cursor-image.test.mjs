// The Dockerfile's cursor-agent install step, run as shell against stubs. The
// step's own text is extracted from the Dockerfile, so this checks the real
// clause, with /opt, /usr/local/bin and /tmp moved under a temporary root. Its
// promises: the version is read from cursor.com/install and that build is
// installed; a failed lookup or download leaves the image without the agent but
// builds; a downloaded build that does not unpack or run fails the build.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dockerfile = fs.readFileSync(path.join(repo, 'Dockerfile'), 'utf8');
const start = dockerfile.lastIndexOf('RUN set -e;', dockerfile.indexOf('cursor_ver="$('));
const end = dockerfile.indexOf('\nRUN rm -rf /tmp/cursor-agent.tar.gz', start);
assert.ok(start > 0 && end > start, 'the cursor-agent RUN step is found in the Dockerfile');
const step = dockerfile.slice(start + 'RUN'.length, end).replace(/\\\n/g, ' ');

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
    'for a in "$@"; do',
    '  if [ "$a" = -o ]; then',
    source ? `    cp "${source}" "$2"; exit $?` : '    exit 22',
    '  fi',
    'done',
    installer === null ? 'exit 22' : `printf '%s' '${installerText}'`,
    '',
  ].join('\n'), { mode: 0o755 });
  // One pass, so the temporary root (itself under /tmp) is not rewritten again.
  const moved = { '/opt/': `${root}/opt/`, '/usr/local/bin': `${root}/bin`, '/tmp/': `${root}/tmp/` };
  const script = step.replace(/\/opt\/|\/usr\/local\/bin|\/tmp\//g, (p) => moved[p]);
  const result = spawnSync('sh', ['-c', script], {
    encoding: 'utf8',
    env: { PATH: `${stubs}:${root}/bin:${process.env.PATH}` },
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
