import { createCredentialFilter } from '../audit-credentials.js';
import { knownSecretValues } from '../config.js';

// The Slack mirror of an agent's transcript (the `transcript` binding event, docs/messengers.md): new
// assistant messages go into the session's bot-owned thread (threads.js). Plain functions; the host,
// the adapters, the clock and the privacy lock come in through `ctx`:
//   { host: { since, link, lockState }, store, adapters, threads, filter, settled, log, now }
//
// The cursor is one record per adapter, channel and session: the last message posted and its Slack ts
// values (`refs`). It is written once per tick, after the posts it covers returned, so a crash can post
// the last message twice, never skip one.

export const MAX_NEW = 5;       // new messages posted per tick and session; older ones collapse into a line
export const MAX_CALLS = 12;    // Slack calls per tick and session, so one backlog cannot stall every channel
const PART_MAX = 2900;          // one section holds 3000 characters, counted after Slack's escaping
const PARTS_MAX = 8;            // parts of one message; the rest is cut with a note
const TOOLS_SHOWN = 6;
const EMPTY = { src: '', seq: 0, hash: '', refs: [] };

/** A binding that has `transcript` gets no `finished` card: the mirror already shows the answer. */
export const postsFinished = (binding) => binding.events.includes('finished') && !binding.events.includes('transcript');

export const cursorKey = (adapter, channel, sessionId) => `${adapter}|${channel}|${sessionId}`;

/** The secrets of this process the credential filter must catch by value (config.js knownSecretValues). */
export const knownValues = (env = process.env) => knownSecretValues(env);
export const createFilter = (env = process.env) => createCredentialFilter(knownValues(env));

/** A finished card with its body run through the filter. */
export const redactCard = (filter, card) => (typeof card.body === 'string' ? { ...card, body: filter(card.body) } : card);

// ---------- the record: the transcript cursor and the last finished card ----------

/** The id of the last finished card announced for this channel and session, or null before a baseline. */
export const finishedMark = (store, adapter, channel, sessionId) => store.state('outbound', cursorKey(adapter, channel, sessionId))?.finished ?? null;

export function markFinished(store, adapter, channel, sessionId, id) {
  const key = cursorKey(adapter, channel, sessionId);
  store.patchState({ outbound: { [key]: { ...(store.state('outbound', key) || EMPTY), finished: id } } });
}

/**
 * The `seen` migration. A session that has a `seen` entry and no outbound record gets one, holding the
 * seen id as its finished mark and no transcript cursor: the first `transcript` look is then a baseline
 * and posts nothing. Safe to run on every start. Returns how many records it wrote.
 */
export function migrateSeen(store) {
  const patch = {};
  for (const k of store.seenKeys()) {
    const [bindingId, ...rest] = k.split('|');
    const binding = store.binding(bindingId);
    const key = binding && cursorKey(binding.adapter, binding.target.channel, rest.join('|'));
    const seen = store.seen(k);
    if (!key || patch[key] || store.state('outbound', key) || typeof seen !== 'string') continue;
    patch[key] = { ...EMPTY, finished: seen };
  }
  if (Object.keys(patch).length) store.patchState({ outbound: patch });
  return Object.keys(patch).length;
}

// ---------- text ----------

const weight = (ch) => (ch === '&' ? 5 : ch === '<' || ch === '>' ? 4 : 1); // &amp; &lt; &gt;

/** `text` in pieces that each fit one section after escaping, cut at a newline when there is one. */
export function splitText(text, max = PART_MAX) {
  const parts = [];
  let rest = text;
  while (rest) {
    let width = 0;
    let end = 0;
    while (end < rest.length && width + weight(rest[end]) <= max) width += weight(rest[end++]);
    if (end === rest.length) { parts.push(rest); break; }
    if (/[\ud800-\udbff]/.test(rest[end - 1])) end -= 1;
    const nl = rest.lastIndexOf('\n', end - 1);
    const lineEnd = nl > end / 2 ? nl : -1;
    parts.push(rest.slice(0, lineEnd >= 0 ? lineEnd : end));
    rest = rest.slice(lineEnd >= 0 ? lineEnd + 1 : end);
  }
  return parts;
}

function lineOf(m) {
  if (m.text.trim()) return m.text;
  const names = [...new Set(m.tools)];
  const more = names.length > TOOLS_SHOWN ? ` and ${names.length - TOOLS_SHOWN} more` : '';
  return `Used tools: ${names.slice(0, TOOLS_SHOWN).join(', ')}${more}`;
}

function partsOf(text) {
  const parts = splitText(text);
  if (parts.length <= PARTS_MAX) return parts;
  const kept = parts.slice(0, PARTS_MAX - 1);
  const cut = parts.slice(PARTS_MAX - 1).reduce((n, p) => n + p.length, 0);
  return [...kept, `… ${cut} more characters — open in Agent Manager.`];
}

// The pieces of one message as posted: filtered first, so a secret cannot straddle two pieces.
const shown = (ctx, m) => partsOf(ctx.filter(lineOf(m)));

// ---------- posting ----------

// What one tick may do for one session: the root is ensured on the first post, and every Slack call counts.
// Agent text reaches `send` and `replace` only through `shown`, which runs the credential filter.
function makePoster(ctx, binding, session) {
  const channel = binding.target.channel;
  const adapter = ctx.adapters.get(binding.adapter);
  const run = { calls: 0, sent: 0, rootTs: null };
  const root = async () => {
    if (!run.rootTs) { run.calls += 1; run.rootTs = await ctx.threads.ensureRoot(binding.adapter, channel, session); }
    return run.rootTs;
  };
  return {
    run,
    fits: (n) => run.calls + n + (run.rootTs ? 0 : 1) <= MAX_CALLS,
    async send(text, extra = {}) {
      const thread = await root();
      run.calls += 1;
      const ref = await adapter.post({ channel, thread }, { kind: 'transcript', body: text, ...extra });
      run.sent += 1;
      return ref.ts;
    },
    async replace(ts, text) {
      run.calls += 1;
      await adapter.update({ channel, ts }, { kind: 'transcript', body: text });
    },
  };
}

// Edits the cursor message in place: its last ref takes the matching part, and parts it never had are posted.
async function updateLast(ctx, poster, cursor, updated) {
  const parts = shown(ctx, updated);
  const refs = [...cursor.refs];
  await poster.replace(refs.at(-1), parts[Math.min(refs.length, parts.length) - 1]);
  for (const part of parts.slice(refs.length)) refs.push(await poster.send(part));
  return refs;
}

async function postParts(poster, parts) {
  const refs = [];
  for (const part of parts) refs.push(await poster.send(part));
  return refs;
}

const idOf = (m, refs) => ({ src: m.src, seq: m.seq, hash: m.hash, refs });

// Posts what the since() result calls for, in order. `progress` always names the last thing fully posted.
async function mirror(ctx, poster, binding, link, result, cursor, progress) {
  if (result.restarted) {
    await poster.send('Conversation restarted.');
    progress.now = idOf(result.end, []);
    return;
  }
  if (result.updated) {
    const edited = { ...cursor, hash: result.updated.hash };
    progress.now = cursor.refs.length ? { ...edited, refs: await updateLast(ctx, poster, cursor, result.updated) } : edited;
  }
  const fresh = result.messages;
  const skipped = Math.max(0, fresh.length - MAX_NEW);
  if (skipped) {
    await poster.send(`${skipped} earlier message${skipped > 1 ? 's' : ''} — open in Agent Manager.`, { link });
    progress.now = idOf(fresh[skipped - 1], []);
  }
  for (const m of fresh.slice(skipped)) {
    const parts = shown(ctx, m);
    if (!poster.fits(parts.length)) return;
    progress.now = idOf(m, await postParts(poster, parts));
  }
}

// One store write for the tick: the cursor, and the root's message count with it.
function commit(ctx, binding, session, stored, poster, next) {
  const { threads, store, now } = ctx;
  const channel = binding.target.channel;
  const key = cursorKey(binding.adapter, channel, session.id);
  return threads.exclusive(binding.adapter, channel, session.id, () => {
    if (!threads.stillReached(binding.adapter, channel, session.id)) return;
    const patch = { outbound: { [key]: { ...next, ...(stored && typeof stored.finished === 'string' ? { finished: stored.finished } : {}) } } };
    if (poster.run.sent && poster.run.rootTs) {
      patch.roots = { [key]: threads.bump(store.state('roots', key) || [], poster.run.rootTs, now(), poster.run.sent) };
    }
    store.patchState(patch);
  });
}

const same = (a, b) => !!a && !!b && a.src === b.src && a.seq === b.seq && a.hash === b.hash && a.refs.join() === b.refs.join();

/**
 * One look at one session for a `transcript` binding. Does nothing without the event, under a real privacy
 * lock (`checking` is not one), or until the session has settled; a first look only records the end.
 * Throws the Slack error after storing the progress made before it, so the bridge can back off.
 */
export async function transcriptTick(ctx, binding, session) {
  if (!binding.events.includes('transcript')) return;
  const { locked, reason } = ctx.host.lockState();
  if (locked && reason !== 'checking') return;
  const stored = ctx.store.state('outbound', cursorKey(binding.adapter, binding.target.channel, session.id));
  const cursor = stored?.src ? stored : null;
  if (cursor && !ctx.settled(session)) return;
  const result = await ctx.host.since(session, cursor && { src: cursor.src, seq: cursor.seq, hash: cursor.hash });
  if (!result) return;
  const poster = makePoster(ctx, binding, session);
  const progress = { now: cursor || idOf(result.end, []) };
  let failure = null;
  if (cursor) {
    try { await mirror(ctx, poster, binding, ctx.host.link(session), result, cursor, progress); } catch (e) { failure = e; }
  }
  try {
    if (!same(progress.now, cursor) || poster.run.sent) await commit(ctx, binding, session, stored, poster, progress.now);
  } catch (e) { failure ||= e; }
  if (failure) throw failure;
}
