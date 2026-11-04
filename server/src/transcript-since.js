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

const PAGE = 500;
const CACHED_SESSIONS = 16;

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
      if (m.role !== 'assistant' || m.error) continue;
      const entry = { text: textOf(m), tools: toolsOf(m) };
      if (entry.text.trim() || entry.tools.length) messages.push(entry);
    }
  }
  return { revision, messages };
}

const withIds = (src, messages) => messages.map((m, i) => ({
  src, seq: i + 1, hash: outputHash(`${m.text}\u0000${m.tools.join(',')}`), text: m.text, tools: m.tools,
}));
const endOf = (src, all) => (all.length ? { src, seq: all.at(-1).seq, hash: all.at(-1).hash } : { src, seq: 0, hash: '' });

/**
 * @param revisionOf `(session) => revision|null`, cheap.
 * @param readMessages `(session) => { revision, messages }`: the parse, called only when the revision moved.
 * @returns `since(session, cursor)`: `{ end, messages, restarted, updated? }`, or null without a transcript.
 *   `cursor` is `{ src, seq, hash }` or null. A null cursor is a baseline (the end, no messages, not a restart).
 *   Another `src`, or a `seq` past the end, is a restart (the end, no messages, `restarted: true`). Otherwise
 *   `messages` are those after `cursor.seq`, and `updated` is the cursor message when its hash changed.
 */
export function createSince({ revisionOf = traceRevisionOf, readMessages = readAssistantMessages, sourceOf = sourceKey } = {}) {
  const cache = new Map();   // session id → { revision, all }
  const flights = new Map(); // session id → the parse in flight

  async function load(session, revision) {
    const hit = cache.get(session.id);
    if (hit && hit.revision === revision) return hit.all;
    if (!flights.has(session.id)) {
      const run = readMessages(session).then((read) => {
        const all = withIds(sourceOf(session), read.messages);
        cache.delete(session.id);
        cache.set(session.id, { revision: read.revision, all });
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
    if (at && at.hash !== cursor.hash) result.updated = { seq: at.seq, hash: at.hash, text: at.text, tools: at.tools };
    return result;
  };
}

/** The default `host.since`: the real trace reader, with its own per-revision cache. */
export const since = createSince();
