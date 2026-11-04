import { noticeCard } from './cards.js';
import { ROOTS_MAX, SECTIONS, cutText, addDelivered, pushRecent, laterTs } from './delivery-state.js';

// One bot-owned thread per agent per channel, and the routing of a chat message
// to an agent. The bot posts the root (`🧵 name · cli`); a person's message is
// never one. A top-level message is delivered once and quoted into the agent's
// current root. The records live in messengers.json (delivery-state.js).

const ROOT_FULL = 200;           // bridge messages under one root before a new one opens
const ROOT_IDLE_MS = 12 * 3600_000;
const NOTICE_EVERY_MS = 3600_000; // one "not delivered" notice per user and channel
const QUOTE_LINES = 5;
export const NOT_DELIVERED = 'Not delivered. Address an agent with `name:`.';
const NAME_NEEDED = 'This channel now reaches several agents. Plain messages are no longer delivered: address one with `name:` (or `@name`).';

export const allowed = (binding, user) => !!user?.id && binding.allowedUsers.includes(user.id);

// Slack reads &, < and > as markup, so quoted text is escaped before the `>` is added.
const escape = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The quote posted under a root: the sender's id in bold (no mention, so nobody is pinged) and the first lines. */
export function quoteOf(user, text) {
  const lines = cutText(text).split('\n').slice(0, QUOTE_LINES).map((l) => `> ${escape(l)}`);
  return `*${String(user.id).replace(/[^A-Za-z0-9]/g, '')}*\n${lines.join('\n')}`;
}

const bump = (list, ts, at) => list.map((e) => (e.ts === ts ? { ...e, count: e.count + 1, at } : e));

// A binding reaches a session by its scope alone, so a session that is gone still counts for a session binding.
const reaches = ({ host }, binding, sessionId) => (binding.scope.type === 'session'
  ? binding.scope.id === sessionId
  : host.groupOf(sessionId)?.id === binding.scope.id);

// The distinct sessions the bindings reach now; a lone session binding whose session is gone still names it.
function reachable({ host, scope }, bindings) {
  const sessions = host.sessions();
  const live = [...new Set(bindings.flatMap((b) => scope(b, sessions).map((s) => s.id)))];
  if (live.length) return live;
  return [...new Set(bindings.filter((b) => b.scope.type === 'session').map((b) => b.scope.id))];
}

// "name: text" or "@name text" addresses one agent. A bare first word does not.
function byName({ host, scope }, bindings, text) {
  const m = /^(?:@([^\s:]{1,80})[:\s]|([^\s:@]{1,80}):)\s*([\s\S]+)$/.exec(text.trim());
  if (!m) return null;
  const wanted = (m[1] || m[2]).toLowerCase();
  const sessions = host.sessions();
  for (const binding of bindings) {
    const session = scope(binding, sessions).find((x) => x.name.toLowerCase() === wanted);
    if (session) return { binding, session, text: m[3].trim() };
  }
  return null;
}

// The session a thread belongs to: a root in the roots list, a delivered top-level ts, or a waiting message.
function threadOwner({ store, outbox }, adapterId, channel, thread) {
  const prefix = `${adapterId}|${channel}|`;
  for (const k of store.stateKeys('roots')) {
    if (k.startsWith(prefix) && store.state('roots', k).some((e) => e.ts === thread)) return { sessionId: k.slice(prefix.length), root: true };
  }
  const hit = store.state('deliveredTs', `${adapterId}|${channel}`)?.find((e) => e.ts === thread);
  if (hit) return { sessionId: hit.sessionId, root: false };
  const waiting = outbox(adapterId, channel, thread);
  return waiting ? { sessionId: waiting, root: false } : null;
}

/**
 * Which session an event is for, in the order of docs/messengers.md: a card's thread, a bot thread,
 * a name, the channel's only agent. `{ sessionId, text, via, found?, root? }`, `{ unnamed: true }` when
 * several agents could take it, or `{ ignored }`.
 */
function route(ctx, adapterId, bindings, r) {
  const text = r.text || '';
  const anchor = r.optionId ? r.ts : r.thread;
  const found = anchor ? ctx.store.findPostedByRef(adapterId, r.channel, anchor) : null;
  if (found) return { sessionId: found[1].sessionId, text, via: 'card', found };
  if (r.optionId) return { ignored: 'no-target' };
  if (r.thread) {
    const owner = threadOwner(ctx, adapterId, r.channel, r.thread);
    return owner ? { sessionId: owner.sessionId, text, via: 'thread', root: owner.root } : { ignored: 'no-target' };
  }
  const named = byName(ctx, bindings, text);
  if (named) return { sessionId: named.session.id, text: named.text, via: 'name' };
  const ids = reachable(ctx, bindings);
  if (ids.length === 1) return { sessionId: ids[0], text, via: 'only' };
  return ids.length > 1 ? { unnamed: true } : { ignored: 'no-target' };
}

// The first binding that reaches the session and allows the sender (or the card's own binding, see below).
// `reached` is false when none reaches it.
function pick(ctx, bindings, sessionId, user, cardBindingId = null) {
  // A card is answered under the binding that posted it, even when another binding allows the sender
  // (approvals and allowed users are that binding's). Only a card whose binding is gone or no longer reaches it falls through.
  const own = bindings.find((b) => b.id === cardBindingId && reaches(ctx, b, sessionId));
  if (own) return { binding: own, reached: true };
  const reaching = bindings.filter((b) => reaches(ctx, b, sessionId));
  const hit = reaching.find((b) => allowed(b, user));
  if (hit || reaching.length) return { binding: hit || reaching[0], reached: true };
  return { binding: bindings.find((b) => allowed(b, user)) || bindings[0], reached: false };
}

// Tells an allowed sender, at most once an hour per channel, that their message went nowhere.
async function notifyUnnamed({ adapters, log, now, told }, adapterId, r) {
  const k = `${adapterId}|${r.channel}|${r.user.id}`;
  if (now() - (told.get(k) ?? -Infinity) < NOTICE_EVERY_MS) return;
  told.set(k, now());
  try { await adapters.get(adapterId).postEphemeral({ channel: r.channel, user: r.user.id, text: NOT_DELIVERED }); } catch (e) {
    log({ event: 'notice-failed', adapter: adapterId, channel: r.channel, error: e.message });
  }
}

// One channel notice when a channel that reached one agent now reaches several. The count is stored first,
// so a failed post is not retried every tick and a restart does not repeat it.
async function noteReach({ store, adapters, scope, log }, adapterId, channel, sessions) {
  try {
    const bindings = store.bindings().filter((b) => b.adapter === adapterId && b.target.channel === channel);
    const count = new Set(bindings.flatMap((b) => scope(b, sessions).map((s) => s.id))).size;
    const key = `${adapterId}|${channel}`;
    const before = store.state('reach', key);
    if (before === count) return;
    store.patchState({ reach: { [key]: count } });
    if (before === 1 && count > 1) await adapters.get(adapterId).post({ channel, thread: null }, noticeCard(NAME_NEEDED));
  } catch (e) {
    log({ event: 'notice-failed', adapter: adapterId, channel, error: e.message });
  }
}

// False once every binding in the channel that reached the session is gone: a delivery in flight must not
// write state that forget() already cleared.
const stillReached = (ctx, adapterId, channel, sessionId) => ctx.store.bindings()
  .some((b) => b.adapter === adapterId && b.target.channel === channel && reaches(ctx, b, sessionId));

const needsRoot = (now, last) => !last || last.count >= ROOT_FULL || now() - last.at >= ROOT_IDLE_MS;

// Quotes a top-level message into the session's current root, opening a new root when it is full or idle.
// Returns the roots list as it should be stored; a Slack failure is logged and the message still counts as delivered.
async function quote(ctx, adapterId, session, r, text, roots) {
  const { host, store, adapters, log, now } = ctx;
  const adapter = adapters.get(adapterId);
  const sk = `${adapterId}|${r.channel}|${session.id}`;
  let list = roots;
  try {
    if (needsRoot(now, list.at(-1))) {
      const card = { kind: 'root', title: `🧵 ${session.name} · ${session.cli}`, link: host.link(session) };
      const ref = await adapter.post({ channel: r.channel, thread: null }, card);
      list = [...list, { ts: ref.ts, at: now(), count: 0 }].slice(-ROOTS_MAX);
      if (stillReached(ctx, adapterId, r.channel, session.id)) store.patchState({ roots: { [sk]: list } });
    }
    const rootTs = list.at(-1).ts;
    await adapter.post({ channel: r.channel, thread: rootTs }, { kind: 'quote', mrkdwn: quoteOf(r.user, text) });
    list = bump(list, rootTs, now());
  } catch (e) {
    log({ event: 'thread-failed', adapter: adapterId, channel: r.channel, session: session.id, error: e.message });
  }
  return list;
}

async function record(ctx, adapterId, session, r, text, via) {
  const { store, host, now } = ctx;
  const ck = `${adapterId}|${r.channel}`;
  const sk = `${ck}|${session.id}`;
  let roots = store.state('roots', sk) || [];
  const patch = {};
  if (!r.thread) {
    roots = await quote(ctx, adapterId, session, r, text, roots);
    patch.channelMarks = { [ck]: laterTs(store.state('channelMarks', ck), r.ts) };
    patch.deliveredTs = { [ck]: addDelivered(store.state('deliveredTs', ck), r.ts, session.id) };
  } else if (via === 'thread') {
    roots = bump(roots, r.thread, now());
    patch.threadMarks = { [sk]: laterTs(store.state('threadMarks', sk), r.ts) };
  }
  const recent = pushRecent(store.state('recent', sk), text, host.sourceKey?.(session) ?? '');
  if (!stillReached(ctx, adapterId, r.channel, session.id)) return;
  store.patchState({ ...patch, roots: { [sk]: roots.length ? roots : null }, recent: { [sk]: recent } });
}

/** After host.deliver delivered a message: quote it, advance the watermarks, keep the text. Never throws. */
function recordDelivery(ctx, adapterId, session, r, text, via) {
  const sk = `${adapterId}|${r.channel}|${session.id}`;
  const run = (ctx.queues.get(sk) || Promise.resolve()).then(() => record(ctx, adapterId, session, r, text, via)).catch((e) => {
    ctx.log({ event: 'thread-failed', adapter: adapterId, channel: r.channel, session: session.id, error: e.message });
  });
  ctx.queues.set(sk, run);
  return run.finally(() => { if (ctx.queues.get(sk) === run) ctx.queues.delete(sk); });
}

// The state keys of a channel that name a session: `adapter|channel|session`.
function sessionKeys(store, prefix) {
  return SECTIONS.flatMap((section) => store.stateKeys(section).filter((k) => k.startsWith(prefix)).map((k) => [section, k]));
}

/** A removed binding: drop the thread state of every session no remaining binding in its channel reaches. */
function forget(ctx, removed) {
  const { store, rows } = ctx;
  const { adapter, target: { channel } } = removed;
  const left = store.bindings().filter((b) => b.adapter === adapter && b.target.channel === channel);
  const ck = `${adapter}|${channel}`;
  const prefix = `${ck}|`;
  const delivered = store.state('deliveredTs', ck) || [];
  const keys = sessionKeys(store, prefix);
  const ids = new Set([...delivered.map((e) => e.sessionId), ...keys.map(([, k]) => k.slice(prefix.length)), ...rows.sessionsIn(adapter, channel)]);
  const gone = new Set([...ids].filter((id) => !left.some((b) => reaches(ctx, b, id))));
  rows.dropSessions(adapter, channel, gone);
  const patch = {};
  for (const [section, k] of keys) if (gone.has(k.slice(prefix.length))) (patch[section] ||= {})[k] = null;
  const kept = delivered.filter((e) => !gone.has(e.sessionId));
  if (!left.length) Object.assign(patch, { channelMarks: { [ck]: null }, deliveredIds: { [ck]: null }, submittedIds: { [ck]: null }, reach: { [ck]: null } });
  if (kept.length !== delivered.length || !left.length) patch.deliveredTs = { [ck]: left.length && kept.length ? kept : null };
  if (Object.keys(patch).length) store.patchState(patch);
}

/**
 * @param scope `(binding, sessions) => sessions` the binding reaches.
 * @param outbox `(adapterId, channel, ts) => sessionId|null`: a top-level message still waiting to be
 *   delivered (the outbox index). The default finds none.
 * @param rows `{ sessionsIn(adapterId, channel), dropSessions(adapterId, channel, ids) }`: the outbox rows
 *   of a channel, so removing a binding can delete those of sessions nothing reaches.
 */
export function createThreads({
  host, store, adapters, scope, log, now = () => Date.now(), outbox = () => null,
  rows = { sessionsIn: () => [], dropSessions: () => {} },
}) {
  const ctx = {
    host, store, adapters, scope, log, now, outbox, rows,
    told: new Map(),   // `adapter|channel|user` → when the last "not delivered" notice went out
    queues: new Map(), // `adapter|channel|session` → tail of the deliveries in flight for it
  };
  return {
    route: (adapterId, bindings, r) => route(ctx, adapterId, bindings, r),
    pick: (bindings, sessionId, user, cardBindingId) => pick(ctx, bindings, sessionId, user, cardBindingId),
    byName: (bindings, text) => byName(ctx, bindings, text),
    reaches: (binding, sessionId) => reaches(ctx, binding, sessionId),
    notifyUnnamed: (adapterId, r) => notifyUnnamed(ctx, adapterId, r),
    noteReach: (adapterId, channel, sessions) => noteReach(ctx, adapterId, channel, sessions),
    recordDelivery: (adapterId, session, r, text, via) => recordDelivery(ctx, adapterId, session, r, text, via),
    forget: (removed) => forget(ctx, removed),
  };
}
