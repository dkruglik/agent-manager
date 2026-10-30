import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ApiError, invalid } from '../api-errors.js';

// Bindings connect one messenger target (a Slack channel, a Telegram chat) to a
// session or a group. Delivery state lives beside them so a restart neither
// re-posts a card that is already in the channel nor announces old answers.
//
// Tokens never live here: adapters read them from the environment, which is
// where Space secrets and a VPS's systemd unit both put them.

export const EVENTS = ['input-required', 'finished'];
const SCOPES = new Set(['session', 'group']);
const ID = /^[A-Za-z0-9_.:-]{1,128}$/;
// A card posted for a request that never resolves would otherwise be kept forever.
const POSTED_MAX_AGE_MS = 7 * 24 * 3600_000;

// A cheap shape check for what was read from disk; validateBinding is the strict one for input.
const wellFormed = (b) => !!b && typeof b === 'object' && typeof b.id === 'string' && !!b.id
  && typeof b.adapter === 'string' && typeof b.target?.channel === 'string'
  && SCOPES.has(b.scope?.type) && typeof b.scope?.id === 'string'
  && Array.isArray(b.events) && Array.isArray(b.allowedUsers) && typeof b.approvals === 'boolean';

const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const plain = (v) => (isPlain(v) ? v : {});
const text = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : '';

export function validateBinding(input, { adapters, existing = null, scopeExists = () => true } = {}) {
  const b = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const adapter = existing?.adapter ?? text(b.adapter, 32);
  if (!adapters.includes(adapter)) throw invalid('adapter', `unknown messenger "${adapter}"`);
  const target = b.target ?? existing?.target;
  const channel = text(target?.channel, 128);
  if (!channel || !ID.test(channel)) throw invalid('target.channel', 'must be a channel id');
  const scope = b.scope ?? existing?.scope;
  if (!scope || !SCOPES.has(scope.type) || typeof scope.id !== 'string' || !ID.test(scope.id)) throw invalid('scope', 'must be {type:"session"|"group", id}');
  // An unchanged scope may point at something deleted since: the binding must stay editable.
  const unchanged = existing && scope.type === existing.scope.type && scope.id === existing.scope.id;
  if (!unchanged && !scopeExists(scope)) throw invalid('scope', `${scope.type} "${scope.id}" does not exist`);
  const events = b.events ?? existing?.events ?? EVENTS;
  if (!Array.isArray(events) || !events.length || events.some((e) => !EVENTS.includes(e))) {
    throw invalid('events', `must be a non-empty subset of ${EVENTS.join(', ')}`);
  }
  const users = b.allowedUsers ?? existing?.allowedUsers ?? [];
  if (!Array.isArray(users) || users.some((u) => typeof u !== 'string' || !ID.test(u))) {
    throw invalid('allowedUsers', 'must be a list of messenger user ids');
  }
  // Approving a tool call from a chat message is opt-in for each binding.
  const approvals = b.approvals ?? existing?.approvals ?? false;
  if (typeof approvals !== 'boolean') throw invalid('approvals', 'must be true or false');
  return {
    id: existing?.id ?? `b_${crypto.randomBytes(6).toString('hex')}`,
    adapter,
    target: { channel },
    scope: { type: scope.type, id: scope.id },
    events: [...new Set(events)],
    allowedUsers: [...new Set(users)],
    approvals,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
}

// True once `file` is at `aside`, else the reason it is not: a rename, or a copy across devices.
function keepCopy(file, aside) {
  try { fs.renameSync(file, aside); return true; } catch (e) {
    try { fs.copyFileSync(file, aside, fs.constants.COPYFILE_EXCL); return true; } catch (c) {
      return `rename: ${e.message}; copy: ${c.message}`;
    }
  }
}

// Persists to one JSON file, written whole and renamed into place, so a crash
// mid-write leaves the previous version rather than half a file.
export class BindingStore {
  constructor(file, { now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
    this.data = { bindings: [], posted: {}, seen: {} };
    this.readOnly = false;
    this.load();
  }

  // A missing file is a first run. Anything else unreadable is kept aside, so
  // the next commit() cannot overwrite what the operator might still recover.
  load() {
    let text;
    try { text = fs.readFileSync(this.file, 'utf8'); } catch (e) {
      if (e.code !== 'ENOENT') this.setAside(e);
      return;
    }
    try {
      const raw = JSON.parse(text);
      if (!raw || !Array.isArray(raw.bindings)) throw new Error('no bindings array');
      const bindings = raw.bindings.filter(wellFormed);
      if (bindings.length !== raw.bindings.length) this.keepDropped(raw.bindings.length - bindings.length);
      const posted = Object.entries(plain(raw.posted)).filter(([, p]) => isPlain(p));
      this.data = { bindings, posted: Object.fromEntries(posted), seen: plain(raw.seen) };
    } catch (e) { this.setAside(e); }
  }

  // The next commit() would remove dropped bindings from disk for good: copy the file first.
  keepDropped(count) {
    const aside = `${this.file}.dropped-${this.now()}`;
    const problem = `messengers: ignored ${count} malformed binding(s) in ${this.file}`;
    try {
      fs.copyFileSync(this.file, aside, fs.constants.COPYFILE_EXCL);
      console.warn(`${problem}; the original is kept as ${aside}`);
    } catch (e) {
      this.readOnly = true;
      console.warn(`${problem}. It could not be copied (${e.message}), so nothing will be saved until it is fixed by hand.`);
    }
  }

  // Moved aside, else copied; if neither works the store refuses to persist,
  // so the file the operator might recover is never overwritten.
  setAside(error) {
    const aside = `${this.file}.corrupt-${this.now()}`;
    const problem = `messengers: could not read ${this.file} (${error.message}); starting empty`;
    const kept = keepCopy(this.file, aside);
    if (kept === true) { console.warn(`${problem}, kept as ${aside}`); return; }
    this.readOnly = true;
    console.warn(`${problem}. It could not be kept aside (${kept}), so nothing will be saved until it is moved by hand.`);
  }

  // Writes `next` and only then makes it the store's state, so a failed write
  // changes nothing: a card that was not saved is not taken as posted.
  commit(next) {
    if (this.readOnly) throw new ApiError(500, 'internal-error', `messengers: ${this.file} could not be kept aside; not overwriting it`);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      // Open cards hold tool inputs: owner-only, including a tmp file left by an earlier crash.
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
      fs.chmodSync(tmp, 0o600);
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error(`[messengers] could not save ${this.file}: ${e.message}`);
      throw new ApiError(500, 'internal-error', 'Could not save the messenger bindings.');
    }
    this.data = next;
  }

  // Copies: a caller that changes one cannot change the store without putBinding().
  bindings() { return structuredClone(this.data.bindings); }
  binding(id) {
    const b = this.data.bindings.find((x) => x.id === id);
    return b ? structuredClone(b) : null;
  }

  putBinding(b) {
    const bindings = this.data.bindings.slice();
    const i = bindings.findIndex((x) => x.id === b.id);
    if (i >= 0) bindings[i] = b; else bindings.push(b);
    this.commit({ ...this.data, bindings });
    return b;
  }

  removeBinding(id) {
    const { data } = this;
    const bindings = data.bindings.filter((b) => b.id !== id);
    if (bindings.length === data.bindings.length) return false;
    const posted = Object.fromEntries(Object.entries(data.posted).filter(([, p]) => p.bindingId !== id));
    const seen = Object.fromEntries(Object.entries(data.seen).filter(([k]) => !k.startsWith(`${id}|`)));
    this.commit({ bindings, posted, seen });
    return true;
  }

  /**
   * @typedef {object} PostedCard A card in a channel, stored under `${bindingId}|${sessionId}|${key}`.
   * @property {string} bindingId
   * @property {string} sessionId
   * @property {string} key  The input item's key, or `done:<reply id>` for a finished card.
   * @property {'input'|'finished'} kind
   * @property {'open'|'closed'} status  Only an open input card takes answers.
   * @property {string} adapter
   * @property {{channel: string, ts: string}} ref  Where the adapter posted it.
   * @property {import('./bridge.js').InputItem} [item]  Input cards; details and toolInput are dropped once closed.
   * @property {Record<string, string>} [partial]  Answers collected so far, by question id.
   * @property {string} [closedText]
   * @property {number} at  When it was recorded (ms); pruned after 7 days.
   */
  posted(k) { return this.data.posted[k] || null; }
  allPosted() { return Object.entries(this.data.posted); }

  putPosted(k, value) {
    const cutoff = this.now() - POSTED_MAX_AGE_MS;
    const all = { ...this.data.posted, [k]: { ...value, at: value.at ?? this.now() } };
    const posted = Object.fromEntries(Object.entries(all).filter(([, p]) => (p.at || 0) >= cutoff));
    this.commit({ ...this.data, posted });
  }

  findPostedByRef(adapter, channel, ts) {
    return Object.entries(this.data.posted).find(([, p]) => p.adapter === adapter && p.ref?.channel === channel && p.ref?.ts === ts) || null;
  }

  // seen: `${bindingId}|${sessionId}` → newest reply identity already accounted for
  seen(k) { return this.data.seen[k] ?? null; }
  putSeen(k, v) { this.commit({ ...this.data, seen: { ...this.data.seen, [k]: v } }); }
}
