import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const HASH = /^[0-9a-f]{32}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// cursor-agent keeps the open chat's store.db held for the whole process. That
// names the chat exactly, even when several panes share one folder, and it
// follows `/clear` (the process swaps to the new chat's database). Several
// open databases (a subagent, say) are ambiguous, so we do not guess.
export function cursorChatForPid(pid, {
  chatsRoot = path.join(process.env.CURSOR_CONFIG_DIR || path.join(process.env.HOME || os.homedir(), '.cursor'), 'chats'),
  procRoot = '/proc',
} = {}) {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  try {
    // /proc fd links show real paths, and ~/.cursor may be a symlink.
    const root = fs.realpathSync(chatsRoot);
    const ids = new Set();
    for (const fd of fs.readdirSync(`${procRoot}/${pid}/fd`).slice(0, 1024)) {
      let target;
      try { target = fs.readlinkSync(`${procRoot}/${pid}/fd/${fd}`); } catch { continue; }
      const rel = path.relative(root, target).split(path.sep);
      if (rel.length === 3 && rel[2] === 'store.db' && HASH.test(rel[0]) && UUID.test(rel[1])) ids.add(rel[1]);
    }
    return ids.size === 1 ? { id: [...ids][0] } : null;
  } catch (e) {
    // cursor-agent's sandbox makes its process non-dumpable, and then even its
    // parent (the AM server) cannot list /proc/<pid>/fd. This route is then
    // dead for good; say so once instead of failing silently on every beat.
    if ((e?.code === 'EACCES' || e?.code === 'EPERM') && !fdDeniedLogged) {
      fdDeniedLogged = true;
      console.warn(`[cursor] cannot read ${procRoot}/${pid}/fd (${e.code}); the pin follows a new chat only through delegation markers`);
    }
    return null;
  }
}
let fdDeniedLogged = false;

// The id a session should move its pin to, or null to stay. Never takes a chat
// another session already pins.
export function cursorRepin({ owned, pinned, claimed }) {
  if (!owned || owned.id === pinned || claimed.has(owned.id)) return null;
  return owned.id;
}

const TAIL_BYTES = 4 * 1024 * 1024;

/**
 * The transcript whose newest turns hold `marker`, among those written since
 * `since` (ms) in any project, or null. A delegated message ends with its
 * unique `[AM delegation <id>]` marker, so this names the chat the pane really
 * used even when its fds cannot be read. Two candidates are ambiguous (the
 * marker quoted somewhere else): no guess.
 */
export async function cursorTranscriptWithMarker({
  root = path.join(process.env.CURSOR_CONFIG_DIR || path.join(process.env.HOME || os.homedir(), '.cursor'), 'projects'),
  marker, since, exclude = null,
}) {
  if (typeof marker !== 'string' || !marker) return null;
  let slugs;
  try { slugs = await fsp.readdir(root); } catch { return null; }
  const hits = [];
  for (const slug of slugs) {
    let ids;
    try { ids = await fsp.readdir(path.join(root, slug, 'agent-transcripts')); } catch { continue; }
    for (const id of ids) {
      if (!UUID.test(id)) continue;
      const file = path.join(root, slug, 'agent-transcripts', id, `${id}.jsonl`);
      if (file === exclude) continue;
      try {
        const st = await fsp.stat(file);
        if (!st.isFile() || st.mtimeMs < since) continue;
        if ((await readTail(file, st.size)).includes(marker)) hits.push({ file, chat: id });
      } catch { /* gone or unreadable: not a candidate */ }
      if (hits.length > 1) return null;
    }
  }
  return hits.length === 1 ? hits[0] : null;
}

async function readTail(file, size) {
  const fh = await fsp.open(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  try {
    const bytes = Math.min(size, TAIL_BYTES);
    const buf = Buffer.alloc(bytes);
    await fh.read(buf, 0, bytes, size - bytes);
    return buf.toString('utf8');
  } finally { await fh.close(); }
}
