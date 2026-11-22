// Which commit this build came from, for the version label in Settings.
//
// The image is built without .git (.dockerignore), so the deploy writes the
// commit into server/build-info.json: the in-app updater (update-deploy.js) and
// scripts/deploy-dev-space.sh both do. The file is gitignored, so a checkout
// run from source has none and asks git instead. A Space deployed any other way
// (duplicated, or pushed by hand) has only HF's COMMIT_SHA, which is the Space
// repo's own commit rather than one of agent-manager's, and is labelled so.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

export const BUILD_INFO_FILE = 'server/build-info.json';
const SHA = /^[0-9a-f]{7,40}$/;
const MAX_REF = 200;

/** The stamp's content, as a deploy writes it. */
export function buildStamp(sha, ref) {
  return `${JSON.stringify({ sha, ...(ref ? { ref } : {}) })}\n`;
}

function fromStamp(appRoot) {
  let raw;
  try { raw = fs.readFileSync(path.join(appRoot, BUILD_INFO_FILE), 'utf8'); } catch { return null; }
  let stamp = null;
  try { stamp = JSON.parse(raw); } catch {}
  if (!SHA.test(stamp?.sha)) {
    console.error(`[build-info] ignoring ${BUILD_INFO_FILE}: no valid "sha" in it`);
    return null;
  }
  const ref = typeof stamp.ref === 'string' && stamp.ref ? stamp.ref.slice(0, MAX_REF) : null;
  return { sha: stamp.sha, ref, source: 'stamp' };
}

function fromGit(appRoot) {
  const run = (args) => execFileSync('git', ['-C', appRoot, ...args],
    { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  try {
    // Only a repo rooted at the app itself: git walks up, and an app unpacked
    // inside some other checkout (a dev-preview release) would report that one.
    if (fs.realpathSync(run(['rev-parse', '--show-toplevel'])) !== fs.realpathSync(appRoot)) return null;
    const sha = run(['rev-parse', 'HEAD']);
    if (!SHA.test(sha)) return null;
    const ref = run(['rev-parse', '--abbrev-ref', 'HEAD']);
    return { sha, ref: ref && ref !== 'HEAD' ? ref.slice(0, MAX_REF) : null, source: 'git' };
  } catch { return null; }
}

/**
 * @param {{ appRoot: string, env?: NodeJS.ProcessEnv }} o  appRoot holds server/
 * @returns {{ sha: string, ref: string | null, source: 'stamp' | 'git' | 'space-commit' } | null}
 */
export function readBuildInfo({ appRoot, env = process.env }) {
  const found = fromStamp(appRoot) || fromGit(appRoot);
  if (found) return found;
  return SHA.test(env.COMMIT_SHA || '') ? { sha: env.COMMIT_SHA, ref: null, source: 'space-commit' } : null;
}
