import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

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

export class BindingError extends Error {
  constructor(message) { super(message); this.status = 400; this.code = 'invalid-input'; }
}

const text = (v, max) => typeof v === 'string' ? v.trim().slice(0, max) : '';

export function validateBinding(input, { adapters, existing = null, scopeExists = () => true } = {}) {
  const b = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  const adapter = existing?.adapter ?? text(b.adapter, 32);
  if (!adapters.includes(adapter)) throw new BindingError(`unknown messenger "${adapter}"`);
  const target = b.target ?? existing?.target;
  const channel = text(target?.channel, 128);
  if (!channel || !ID.test(channel)) throw new BindingError('target.channel is required');
  const scope = b.scope ?? existing?.scope;
  if (!scope || !SCOPES.has(scope.type) || !ID.test(scope.id || '')) throw new BindingError('scope must be {type:"session"|"group", id}');
  if (!scopeExists(scope)) throw new BindingError(`${scope.type} "${scope.id}" does not exist`);
  const events = b.events ?? existing?.events ?? EVENTS;
  if (!Array.isArray(events) || !events.length || events.some((e) => !EVENTS.includes(e))) {
    throw new BindingError(`events must be a non-empty subset of ${EVENTS.join(', ')}`);
  }
  const users = b.allowedUsers ?? existing?.allowedUsers ?? [];
  if (!Array.isArray(users) || users.some((u) => typeof u !== 'string' || !ID.test(u))) {
    throw new BindingError('allowedUsers must be a list of messenger user ids');
  }
  // Approving a tool call from a chat message is opt-in for each binding.
  const approvals = b.approvals ?? existing?.approvals ?? false;
  if (typeof approvals !== 'boolean') throw new BindingError('approvals must be true or false');
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

export function createStore(file, { now = () => Date.now() } = {}) {
  let data = { bindings: [], posted: {}, seen: {} };
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (raw && Array.isArray(raw.bindings)) {
      data = { bindings: raw.bindings, posted: raw.posted || {}, seen: raw.seen || {} };
    }
  } catch {}

  const persist = () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  };

  const prune = () => {
    const cutoff = now() - POSTED_MAX_AGE_MS;
    for (const [k, p] of Object.entries(data.posted)) if ((p.at || 0) < cutoff) delete data.posted[k];
  };

  return {
    bindings: () => data.bindings.slice(),
    binding: (id) => data.bindings.find((b) => b.id === id) || null,
    putBinding(b) {
      const i = data.bindings.findIndex((x) => x.id === b.id);
      if (i >= 0) data.bindings[i] = b; else data.bindings.push(b);
      persist();
      return b;
    },
    removeBinding(id) {
      const before = data.bindings.length;
      data.bindings = data.bindings.filter((b) => b.id !== id);
      for (const k of Object.keys(data.posted)) if (data.posted[k].bindingId === id) delete data.posted[k];
      for (const k of Object.keys(data.seen)) if (k.startsWith(`${id}|`)) delete data.seen[k];
      if (data.bindings.length !== before) persist();
      return data.bindings.length !== before;
    },
    // posted: `${bindingId}|${sessionId}|${key}` → {bindingId, sessionId, key, kind, ref, status, at, ...}
    posted: (k) => data.posted[k] || null,
    allPosted: () => Object.entries(data.posted),
    putPosted(k, value) { data.posted[k] = { ...value, at: value.at ?? now() }; prune(); persist(); },
    findPostedByRef(adapter, channel, ts) {
      return Object.entries(data.posted).find(([, p]) => p.adapter === adapter && p.ref?.channel === channel && p.ref?.ts === ts) || null;
    },
    // seen: `${bindingId}|${sessionId}` → newest reply identity already accounted for
    seen: (k) => data.seen[k] ?? null,
    putSeen(k, v) { data.seen[k] = v; persist(); },
  };
}
