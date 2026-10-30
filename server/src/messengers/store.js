import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { invalid } from '../api-errors.js';

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

const text = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : '';

export function validateBinding(input, { adapters, existing = null, scopeExists = () => true } = {}) {
  const b = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const adapter = existing?.adapter ?? text(b.adapter, 32);
  if (!adapters.includes(adapter)) throw invalid('adapter', `unknown messenger "${adapter}"`);
  const target = b.target ?? existing?.target;
  const channel = text(target?.channel, 128);
  if (!channel || !ID.test(channel)) throw invalid('target.channel', 'must be a channel id');
  const scope = b.scope ?? existing?.scope;
  if (!scope || !SCOPES.has(scope.type) || !ID.test(scope.id || '')) throw invalid('scope', 'must be {type:"session"|"group", id}');
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
    label: text(b.label ?? existing?.label, 80) || null,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };
}

// Persists to one JSON file, written whole and renamed into place, so a crash
// mid-write leaves the previous version rather than half a file.
export class BindingStore {
  constructor(file, { now = () => Date.now() } = {}) {
    this.file = file;
    this.now = now;
    this.data = { bindings: [], posted: {}, seen: {} };
    this.load();
  }

  // A missing file is a first run. Anything else unreadable is kept aside, so
  // the next persist() cannot overwrite what the operator might still recover.
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
      if (bindings.length !== raw.bindings.length) {
        console.warn(`messengers: ignored ${raw.bindings.length - bindings.length} malformed binding(s) in ${this.file}`);
      }
      this.data = { bindings, posted: raw.posted || {}, seen: raw.seen || {} };
    } catch (e) { this.setAside(e); }
  }

  setAside(error) {
    const aside = `${this.file}.corrupt-${this.now()}`;
    try { fs.renameSync(this.file, aside); } catch {}
    console.warn(`messengers: could not read ${this.file} (${error.message}); starting empty, kept as ${aside}`);
  }

  persist() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  bindings() { return this.data.bindings.slice(); }
  binding(id) { return this.data.bindings.find((b) => b.id === id) || null; }

  putBinding(b) {
    const i = this.data.bindings.findIndex((x) => x.id === b.id);
    if (i >= 0) this.data.bindings[i] = b; else this.data.bindings.push(b);
    this.persist();
    return b;
  }

  removeBinding(id) {
    const { data } = this;
    const before = data.bindings.length;
    data.bindings = data.bindings.filter((b) => b.id !== id);
    if (data.bindings.length === before) return false;
    for (const k of Object.keys(data.posted)) if (data.posted[k].bindingId === id) delete data.posted[k];
    for (const k of Object.keys(data.seen)) if (k.startsWith(`${id}|`)) delete data.seen[k];
    this.persist();
    return true;
  }

  // posted: `${bindingId}|${sessionId}|${key}` → {bindingId, sessionId, key, kind, ref, status, at, ...}
  posted(k) { return this.data.posted[k] || null; }
  allPosted() { return Object.entries(this.data.posted); }

  putPosted(k, value) {
    this.data.posted[k] = { ...value, at: value.at ?? this.now() };
    const cutoff = this.now() - POSTED_MAX_AGE_MS;
    for (const [key, p] of Object.entries(this.data.posted)) if ((p.at || 0) < cutoff) delete this.data.posted[key];
    this.persist();
  }

  findPostedByRef(adapter, channel, ts) {
    return Object.entries(this.data.posted).find(([, p]) => p.adapter === adapter && p.ref?.channel === channel && p.ref?.ts === ts) || null;
  }

  // seen: `${bindingId}|${sessionId}` → newest reply identity already accounted for
  seen(k) { return this.data.seen[k] ?? null; }
  putSeen(k, v) { this.data.seen[k] = v; this.persist(); }
}
