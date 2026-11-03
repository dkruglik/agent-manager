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
    await fh.read(buf, 0, len, size - len);
    const last = buf.toString('utf8').split('\n').map((l) => l.trim()).filter(Boolean).pop();
    if (!last) return null;
    const rec = JSON.parse(last);
    const id = rec && rec.type === 'continued-in' ? rec.continuedInSessionId : null;
    return typeof id === 'string' && UUID_RE.test(id) ? id : null;
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

async function mtimeOf(p) {
  try { return (await fsp.stat(p)).mtimeMs; } catch { return -1; }
}

async function pickSuccessor(current, files, id) {
  const hits = files.filter((p) => path.basename(p).startsWith(id));
  if (!hits.length) return null;
  const dir = path.dirname(current);
  const local = hits.filter((p) => path.dirname(p) === dir);
  const pool = local.length ? local : hits;
  let best = null, bestMs = -Infinity;
  for (const p of pool) {
    const ms = await mtimeOf(p);
    if (ms > bestMs) { best = p; bestMs = ms; }
  }
  return best;
}

/** Follow continued-in handoffs from `file` through `files` (absolute .jsonl
 *  paths). Returns the last transcript in the chain, or `file` itself when it
 *  was not continued, the successor is missing, it loops, or maxHops is hit. */
export async function followContinuation(file, files, { maxHops = 8 } = {}) {
  const visited = new Set([file]);
  let current = file;
  for (let hop = 0; hop < maxHops; hop++) {
    const id = await continuedIn(current);
    if (!id) break;
    const next = await pickSuccessor(current, files, id);
    if (!next || visited.has(next)) break;
    visited.add(next);
    current = next;
  }
  return current;
}
