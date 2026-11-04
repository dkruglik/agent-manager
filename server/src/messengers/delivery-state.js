// Records beside the bindings in messengers.json that say where a chat message
// went: bot-owned thread roots, watermarks, the delivered top-level set and the
// recent texts. This module only checks and shapes them; threads.js decides
// what they mean, and store.js writes them.

export const ROOTS_MAX = 20;
export const DELIVERED_MAX = 50;
export const RECENT_TEXTS = 3;
export const TEXT_MAX = 2048; // a stored Slack text is cut here

// Sections of messengers.json this module owns; each maps a string key to a record.
//   roots        `adapter|channel|session` → [{ ts, at, count }], newest last
//   threadMarks  `adapter|channel|session` → last delivered ts in that thread
//   channelMarks `adapter|channel`         → last delivered top-level ts
//   deliveredTs  `adapter|channel`         → [{ ts, sessionId }], oldest first
//   recent       `adapter|channel|session` → { lastSrc, texts }
//   reach        `adapter|channel`         → how many agents the channel reached last time
export const SECTIONS = ['roots', 'threadMarks', 'channelMarks', 'deliveredTs', 'recent', 'reach'];

export const cutText = (s) => String(s ?? '').slice(0, TEXT_MAX);

const isPlain = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const str = (v) => typeof v === 'string' && v !== '';
const count = (v) => Number.isInteger(v) && v >= 0;
const list = (v) => (Array.isArray(v) ? v : []);

const root = (e) => isPlain(e) && str(e.ts) && Number.isFinite(e.at) && count(e.count);
const delivered = (e) => isPlain(e) && str(e.ts) && str(e.sessionId);

// The kept entries of each section; a malformed entry is dropped, never an error.
const KEEP = {
  roots: (v) => {
    const kept = list(v).filter(root).slice(-ROOTS_MAX).map((e) => ({ ts: e.ts, at: e.at, count: e.count }));
    return kept.length ? kept : undefined;
  },
  threadMarks: (v) => (str(v) ? v : undefined),
  channelMarks: (v) => (str(v) ? v : undefined),
  deliveredTs: (v) => {
    const kept = list(v).filter(delivered).slice(-DELIVERED_MAX).map((e) => ({ ts: e.ts, sessionId: e.sessionId }));
    return kept.length ? kept : undefined;
  },
  recent: (v) => {
    if (!isPlain(v)) return undefined;
    const texts = list(v.texts).filter((t) => typeof t === 'string').slice(-RECENT_TEXTS).map(cutText);
    return { lastSrc: typeof v.lastSrc === 'string' ? v.lastSrc : '', texts };
  },
  reach: (v) => (count(v) ? v : undefined),
};

/** Every section of a parsed messengers.json; a file without them (an older install) gives empty ones. */
export function loadDelivery(raw) {
  return Object.fromEntries(SECTIONS.map((section) => {
    const entries = Object.entries(isPlain(raw?.[section]) ? raw[section] : {})
      .map(([k, v]) => [k, KEEP[section](v)]).filter(([, v]) => v !== undefined);
    return [section, Object.fromEntries(entries)];
  }));
}

/** The delivered top-level set with `ts` added for `sessionId`; the oldest entries beyond 50 drop. */
export function addDelivered(entries, ts, sessionId) {
  const rest = list(entries).filter((e) => e.ts !== ts);
  return [...rest, { ts, sessionId }].slice(-DELIVERED_MAX);
}

/** A session's recent delivery with `text` (cut at 2 KB) as the newest of the last 3. */
export function pushRecent(recent, text, lastSrc) {
  const texts = [...list(recent?.texts), cutText(text)].slice(-RECENT_TEXTS);
  return { lastSrc, texts };
}

/** The later of two Slack ts strings (`seconds.micros`), compared as numbers; an unparsable `next` wins. */
export function laterTs(prev, next) {
  const parse = (ts) => /^(\d+)(?:\.(\d+))?$/.exec(String(ts ?? ''));
  const a = parse(prev);
  const b = parse(next);
  if (!a || !b) return b || !a ? next : prev;
  const key = (m) => [Number(m[1]), (m[2] || '').padEnd(9, '0')];
  const [as, af] = key(a);
  const [bs, bf] = key(b);
  if (as !== bs) return as > bs ? prev : next;
  return af > bf ? prev : next;
}
