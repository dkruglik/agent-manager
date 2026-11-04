import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Row files of the outbox: `<dir>/<requestId>.json`, written the way Codex
// receipts are (codex-input.js saveReceipt): directory 0700, file 0600, opened
// with O_NOFOLLOW, the file and the directory fsynced. Synchronous on purpose:
// a row is durable when these return.

const MAX_ROW_BYTES = 1 << 20;
const { O_RDONLY, O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW } = fs.constants;
const STATES = ['pending', 'submitted'];

const UUID = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const str = (v) => typeof v === 'string' && v !== '';

/** True when `row` has every field the drain relies on and its id matches `id`. */
export function wellFormedRow(row, id) {
  return !!row && typeof row === 'object' && row.requestId === id && UUID.test(id)
    && ['adapter', 'channel', 'ts', 'sessionId', 'bindingId'].every((k) => str(row[k]))
    && typeof row.text === 'string' && typeof row.body === 'string' && str(row.user?.id)
    && STATES.includes(row.state) && Number.isFinite(row.createdAt)
    && (row.thread === null || str(row.thread)) && typeof row.topLevel === 'boolean';
}

// The id names the file, so only a UUID is accepted: no path can come out of it.
function rowFile(dir, id) {
  if (!UUID.test(String(id))) throw new Error('row request id is not a UUID');
  return path.join(dir, `${id}.json`);
}

function syncDir(dir) {
  const fd = fs.openSync(dir, O_RDONLY);
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function writeNew(file, data) {
  const fd = fs.openSync(file, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Creates the row file; throws when one (or a symlink) is already there. A file this call made is removed on failure. */
export function createRow(dir, row) {
  const file = rowFile(dir, row.requestId);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fd = fs.openSync(file, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o600);
  try {
    fs.writeFileSync(fd, JSON.stringify(row));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    syncDir(dir);
  } catch (e) {
    try { fs.closeSync(fd); } catch { /* already closed */ }
    try { fs.unlinkSync(file); } catch { /* nothing to remove */ }
    throw e;
  }
}

/** Replaces a row file through a temp file and a rename. */
export function rewriteRow(dir, row) {
  const dest = rowFile(dir, row.requestId);
  const tmp = `${dest}.${crypto.randomUUID()}.tmp`;
  try {
    writeNew(tmp, JSON.stringify(row));
    fs.renameSync(tmp, dest);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* nothing was written */ }
    throw e;
  }
  syncDir(dir);
}

/** Deletes the row file and makes the deletion durable; a missing file is fine. */
export function removeRow(dir, id) {
  const file = rowFile(dir, id);
  try { fs.unlinkSync(file); } catch (e) { if (e.code !== 'ENOENT') throw e; }
  syncDir(dir);
}

function readRow(dir, file) {
  const fd = fs.openSync(path.join(dir, file), O_RDONLY | O_NOFOLLOW);
  try {
    if (fs.fstatSync(fd).size > MAX_ROW_BYTES) throw new Error('row file too large');
    return JSON.parse(fs.readFileSync(fd, 'utf8'));
  } finally { fs.closeSync(fd); }
}

/**
 * Looks at the directory before anything is read or written. 'unsafe' for a symlink or a non-directory
 * (the outbox must not write through it); a directory looser than 0700 is tightened.
 */
export function checkDir(dir) {
  let st;
  try { st = fs.lstatSync(dir); } catch (e) { return e.code === 'ENOENT' ? 'missing' : 'unsafe'; }
  if (!st.isDirectory()) return 'unsafe';
  if (st.mode & 0o077) fs.chmodSync(dir, 0o700);
  return 'ok';
}

/**
 * Reads the directory once. `{ rows, bad }`: the well-formed rows, and the names of files that were
 * skipped (unreadable, a symlink, malformed). Skipped files are left where they are.
 */
export function loadRows(dir) {
  const rows = [];
  const bad = [];
  let names;
  try { names = fs.readdirSync(dir); } catch (e) {
    if (e.code === 'ENOENT') return { rows, bad };
    throw e;
  }
  for (const name of names.filter((n) => n.endsWith('.tmp'))) {
    try { fs.unlinkSync(path.join(dir, name)); } catch { /* left for the next start */ }
  }
  for (const name of names.filter((n) => n.endsWith('.json'))) {
    try {
      const row = readRow(dir, name);
      if (!wellFormedRow(row, name.slice(0, -'.json'.length))) throw new Error('malformed');
      rows.push(row);
    } catch { bad.push(name); }
  }
  return { rows, bad };
}
