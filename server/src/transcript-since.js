import { outputHash, sourceKey } from './output-id.js';
import { readTrace, traceRevisionOf } from './traces.js';

// host.since(session, cursor): the assistant messages of a session after a
// cursor, for the Slack `transcript` event (docs/messengers.md). The whole
// transcript is parsed by the trace reader (every harness, OpenCode's SQLite
// included), and only when the trace revision changed: an idle session costs a
// stat. A byte offset does not apply to a database.
//
// `seq` is the 1-based place of a message among the transcript's assistant
// messages that said something or called a tool; `hash` covers its text and
// tool names. Both are a check on the current `src` (output-id.js sourceKey):
// they restart with a new transcript, and after a compaction in the same file.

export { traceRevisionOf };

/** A cursor hash with this prefix names a message whose parts were only partly posted (messengers/outbound.js). */
export const PARTIAL_HASH = 'partial:';

const PAGE = 500;
const CACHED_SESSIONS = 16;
const VERSIONS_KEPT = 8; // tail messages remembered per session, to tell an edit from a replacement

const textOf = (m) => m.blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n');
const toolsOf = (m) => m.blocks.filter((b) => b.type === 'tool_use').map((b) => String(b.name));

/** Every assistant message of the session's trace as `{ text, tools }`, with the revision it was parsed at. */
export async function readAssistantMessages(session) {
  const messages = [];
  let revision = null;
  for (let offset = 0, total = 1; offset < total; offset += PAGE) {
    const page = await readTrace(session, { offset, limit: PAGE });
    ({ revision, total } = page);
    for (const m of page.turns) {
      if (m.role !== 'assistant') continue;
      // A failed turn's text can read like an answer. Show that it failed instead of dropping it.
      if (m.error) { messages.push({ text: 'The assistant turn failed.', tools: [] }); continue; }
      const entry = { text: textOf(m), tools: toolsOf(m) };
      if (entry.text.trim() || entry.tools.length) messages.push(entry);
    }
  }
  return { revision, messages };
}

const withIds = (src, messages) => messages.map((m, i) => ({
  src, seq: i + 1, hash: outputHash(`${m.text}\u0000${m.tools.join(',')}`), text: m.text, tools: m.tools,
}));
/**
 * True when `now` plausibly is `before` grown: its text continues the old text (trailing whitespace aside),
 * or, for a message that was only tool calls, its tools include the old ones. A compaction in the same
 * file puts another message at the same seq, and that is neither.
 */
export function extendsMessage(before, now) {
  if (!before.text.trim()) return before.tools.every((t) => now.tools.includes(t));
  return now.text.startsWith(before.text.trimEnd());
}

const endOf = (src, all) => (all.length ? { src, seq: all.at(-1).seq, hash: all.at(-1).hash } : { src, seq: 0, hash: '' });

/**
 * @param revisionOf `(session) => revision|null`, cheap.
 * @param readMessages `(session) => { revision, messages }`: the parse, called only when the revision moved.
 * @typedef {{src: string, seq: number, hash: string}} TranscriptCursor Logical position. `seq` is 1-based
 *   among assistant messages that said something or called a tool; `seq` 0 is an empty transcript.
 * @typedef {{src: string, seq: number, hash: string, text: string, tools: string[]}} AssistantMirrorMessage
 * @typedef {{end: TranscriptCursor, messages: AssistantMirrorMessage[], restarted: boolean,
 *   updated?: {seq: number, hash: string, text: string, tools: string[], grew: boolean}}} SinceResult
 *   `updated` is the cursor message when its hash changed. It has no `src`; the cursor's `src` still applies.
 *   `grew` is true only when this process saw the cursor's version and the new one extends it (extendsMessage);
 *   a replacement, or a version this process never saw (after a restart), is false. A `PARTIAL_HASH` prefix on the
 *   cursor's hash is ignored for that check, and the message is always reported as `updated`.
 * @returns {Promise<SinceResult|null>} `{ end, messages, restarted, updated? }`, or null without a transcript.
 *   `cursor` is `{ src, seq, hash }` or null. A null cursor is a baseline (the end, no messages, not a restart).
 *   Another `src`, or a `seq` past the end, is a restart (the end, no messages, `restarted: true`). Otherwise
 *   `messages` are those after `cursor.seq`, and `updated` is the cursor message when its hash changed.
 */
export function createSince({ revisionOf = traceRevisionOf, readMessages = readAssistantMessages, sourceOf = sourceKey } = {}) {
  const cache = new Map();   // session id → { revision, all }
  const flights = new Map(); // session id → the parse in flight
  const versions = new Map(); // session id → { src, tails: Map hash → { text, tools } }, newest last

  function remember(session, src, all) {
    const tail = all.at(-1);
    if (!tail) return;
    let kept = versions.get(session.id);
    if (!kept || kept.src !== src) versions.set(session.id, kept = { src, tails: new Map() });
    kept.tails.delete(tail.hash);
    kept.tails.set(tail.hash, { text: tail.text, tools: tail.tools });
    while (kept.tails.size > VERSIONS_KEPT) kept.tails.delete(kept.tails.keys().next().value);
    while (versions.size > CACHED_SESSIONS) versions.delete(versions.keys().next().value);
  }

  async function load(session, revision) {
    const hit = cache.get(session.id);
    if (hit && hit.revision === revision) return hit.all;
    if (!flights.has(session.id)) {
      const run = readMessages(session).then((read) => {
        const all = withIds(sourceOf(session), read.messages);
        cache.delete(session.id);
        cache.set(session.id, { revision: read.revision, all });
        remember(session, sourceOf(session), all);
        while (cache.size > CACHED_SESSIONS) cache.delete(cache.keys().next().value);
        return all;
      }).finally(() => flights.delete(session.id));
      flights.set(session.id, run);
    }
    return flights.get(session.id);
  }

  return async function since(session, cursor) {
    const src = sourceOf(session);
    const revision = src ? await revisionOf(session) : null;
    if (!revision) return null;
    const all = await load(session, revision);
    const end = endOf(src, all);
    if (!cursor) return { end, messages: [], restarted: false };
    if (cursor.src !== src || cursor.seq > end.seq) return { end, messages: [], restarted: true };
    const result = { end, messages: all.filter((m) => m.seq > cursor.seq), restarted: false };
    const at = all[cursor.seq - 1];
    if (at && at.hash !== cursor.hash) {
      const before = versions.get(session.id)?.tails.get(cursor.hash.replace(PARTIAL_HASH, ''));
      result.updated = { seq: at.seq, hash: at.hash, text: at.text, tools: at.tools, grew: !!before && extendsMessage(before, at) };
    }
    return result;
  };
}

/** The default `host.since`: the real trace reader, with its own per-revision cache. */
export const since = createSince();
