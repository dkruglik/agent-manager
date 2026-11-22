import fs from 'node:fs';
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
  } catch { return null; }
}

// The id a session should move its pin to, or null to stay. Never takes a chat
// another session already pins.
export function cursorRepin({ owned, pinned, claimed }) {
  if (!owned || owned.id === pinned || claimed.has(owned.id)) return null;
  return owned.id;
}
