// Claude Code rotates a conversation to a new transcript by ending the old
// file with {"type":"continued-in","continuedInSessionId":"<uuid>"}; all new
// turns then land in <uuid>.jsonl. Our pin (session.sessionUuid) stays on the
// first file, so we follow the handoff at read time instead of rewriting
// sessions.json.
import fsp from 'node:fs/promises';
import path from 'node:path';

const TAIL_BYTES = 64 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The session uuid this transcript was continued in, or null. Reads only the
 *  tail of the file; any read or parse problem means "not continued". */
export async function continuedIn(file) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const { size } = await fh.stat();
    const len = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(len);
    const { bytesRead } = await fh.read(buf, 0, len, size - len);
    if (bytesRead !== len) return null; // short read: the tail is not trustworthy
    const last = buf.toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean).pop();
    if (!last) return null;
    const rec = JSON.parse(last);
    const id = rec && rec.type === 'continued-in' ? rec.continuedInSessionId : null;
    return typeof id === 'string' && UUID_RE.test(id) ? id : null;
  } catch (err) {
    if (err?.code !== 'ENOENT' && !(err instanceof SyntaxError)) {
      console.warn(`[claude-continuation] cannot read ${path.basename(file)}: ${err?.code || err?.message}`);
    }
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/** mtime in ms, or null when the file cannot be stat-ed. A file that raced away
 *  (ENOENT) is skipped silently; any other error is reported. */
async function mtimeOf(p) {
  try {
    return (await fsp.stat(p)).mtimeMs;
  } catch (err) {
    if (err?.code !== 'ENOENT') console.warn(`[claude-continuation] cannot stat ${path.basename(p)}: ${err?.code || err?.message}`);
    return null;
  }
}

async function pickSuccessor(current, files, id) {
  const hits = files.filter((p) => path.basename(p).startsWith(id));
  if (!hits.length) return null;
  const dir = path.dirname(current);
  const local = hits.filter((p) => path.dirname(p) === dir);
  const pool = local.length ? local : hits;
  let best = null, bestMs = -Infinity;
  for (const p of pool) {
    let ms;
    ms = await mtimeOf(p);
    if (ms !== null && ms > bestMs) { best = p; bestMs = ms; }
  }
  return best;
}

/** Every transcript from `file` along its continued-in handoffs through
 *  `files` (absolute .jsonl paths): `[file, ...successors]`. The walk stops at
 *  a transcript with no (valid) continued-in id, a missing successor, a
 *  successor already in the chain (a cycle A -> B -> A ends at B), or after
 *  maxHops successors. */
export async function continuationChain(file, files, { maxHops = 8 } = {}) {
  const chain = [file];
  const visited = new Set(chain);
  for (let hop = 0; hop < maxHops; hop++) {
    const id = await continuedIn(chain[chain.length - 1]);
    if (!id) break;
    const next = await pickSuccessor(chain[chain.length - 1], files, id);
    if (!next || visited.has(next)) break;
    visited.add(next);
    chain.push(next);
  }
  return chain;
}

/** The furthest transcript reached from `file`: the last element of
 *  continuationChain. Stops on a missing id, a missing successor, a repeated
 *  path (a cycle A -> B -> A returns B), or maxHops; `file` itself when it was
 *  not continued. */
export async function followContinuation(file, files, opts) {
  const chain = await continuationChain(file, files, opts);
  return chain[chain.length - 1];
}

/** The live transcript of a Claude session: the NEWEST (by mtime) of the files
 *  named for `sessionUuid` (one uuid can sit in several project dirs), then
 *  followed to the end of its continued-in chain. This is the single answer
 *  every reader (digestFor, the bulk digest, traceLocation, findTranscript)
 *  uses, so they cannot disagree. Null when no pinned file exists. */
export async function liveTranscript(sessionUuid, files) {
  let best = null, bestMs = -Infinity;
  for (const p of files) {
    if (!path.basename(p).startsWith(sessionUuid)) continue;
    const ms = await mtimeOf(p);
    if (ms !== null && ms > bestMs) { best = p; bestMs = ms; }
  }
  return best && followContinuation(best, files);
}
