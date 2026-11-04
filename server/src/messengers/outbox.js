import { postNotice } from './cards.js';
import { addDeliveredId, addSubmittedId, compareSlackTs } from './delivery-state.js';
import { checkDir, createRow, loadRows, persistError, removeRow, rewriteRow } from './outbox-files.js';
import { createAmend } from './outbox-edits.js';

// The outbox between a chat message and the agent. A message is a row file
// before the adapter acknowledges it (accept); the drain delivers it later,
// one send at a time per session, in ts order. The text of a row is frozen when
// it is written, so a retry sends the same bytes (docs/messengers.md, "Outbox").

const LIFETIME_MS = 24 * 3600_000;
export const PREAMBLE_HEAD = 'Earlier messages from Slack (the conversation restarted since):';

const quoted = (text) => text.split('\n').map((l) => `> ${l}`).join('\n');
const errMeta = (e) => ({ error: e.code ?? e.name, ...(e.message ? { message: String(e.message).slice(0, 200) } : {}) });
const deliverErr = (e) => ({ error: e.code ?? e.name });

// The stored texts of a session when its source changed since they were delivered, else ''.
function preambleFor({ host, store, rows }, key, session, except) {
  // A row already waiting carries it; a second copy would repeat the same lines (an edited row is not its own other copy).
  const [adapter, channel] = key.split('|');
  const hasPreambleQueued = [...rows.values()].some((r) => r.requestId !== except
    && r.adapter === adapter && r.channel === channel && r.sessionId === session.id
    && r.text.startsWith(PREAMBLE_HEAD));
  if (hasPreambleQueued) return '';
  const recent = store.state('recent', key);
  if (!recent?.lastSrc || !recent.texts.length) return '';
  if ((host.sourceKey?.(session) ?? '') === recent.lastSrc) return '';
  return `${PREAMBLE_HEAD}\n${recent.texts.map(quoted).join('\n')}\n\n`;
}

// Several people may write to the session: say who this is, in a form that is not the `[Agent Manager:` notice.
function senderPrefix(ctx, adapterId, channel, session, user) {
  const writers = new Set(ctx.store.bindings()
    .filter((b) => b.adapter === adapterId && b.target.channel === channel && ctx.threads.reaches(b, session.id))
    .flatMap((b) => b.allowedUsers));
  return writers.size > 1 ? `Slack user ${user.id}: ` : '';
}

// The bytes a row sends: preamble, sender prefix, body. `except` is the row being rewritten.
const frozenText = (ctx, adapterId, channel, session, user, body, except) => preambleFor(ctx, `${adapterId}|${channel}|${session.id}`, session, except)
  + senderPrefix(ctx, adapterId, channel, session, user) + body;

/** Persists a row and returns once it is on disk. `{ queued }` or `{ ignored: 'duplicate' }`; a failed write throws. */
function accept(ctx, { requestId, binding, session, r, body, via, extra }) {
  const { store, rows, log, now, dir } = ctx;
  if (ctx.unsafe) throw Object.assign(new Error('outbox directory is not safe to write'), { persist: true });
  if (ctx.loadFailed) throw Object.assign(new Error('outbox directory could not be read'), { persist: true });
  const key = `${binding.adapter}|${r.channel}`;
  const idRow = { adapter: binding.adapter, channel: r.channel, requestId };
  if (rows.has(requestId) || isDelivered(ctx, idRow) || isSubmitted(ctx, idRow)) {
    log({ event: 'duplicate', requestId, binding: binding.id, session: session.id });
    return { ignored: 'duplicate' };
  }
  const text = frozenText(ctx, binding.adapter, r.channel, session, r.user, body);
  const row = {
    requestId, adapter: binding.adapter, channel: r.channel, ts: r.ts, thread: r.thread || null, topLevel: !r.thread,
    sessionId: session.id, bindingId: binding.id, user: { id: r.user.id, ...(r.user.name ? { name: r.user.name } : {}) },
    text, body, via, state: 'pending', createdAt: now(), ...extra,
  };
  try { createRow(dir, row); } catch (e) { throw persistError(e); }
  rows.set(requestId, row);
  return { queued: session.id };
}

const idsKey = (row) => `${row.adapter}|${row.channel}`;
const isDelivered = ({ store }, row) => !!store.state('deliveredIds', idsKey(row))?.includes(row.requestId);
const isSubmitted = ({ store }, row) => !!store.state('submittedIds', idsKey(row))?.includes(row.requestId);

function remember(ctx, section, row) {
  const key = idsKey(row);
  const ids = ctx.store.state(section, key);
  const next = section === 'submittedIds'
    ? addSubmittedId(ids, row.requestId)
    : addDeliveredId(ids, row.requestId);
  ctx.store.patchState({ [section]: { [key]: next ?? null } });
}

// A failed delete is safe: the delivered-id set (or submittedIds) already says the file must not be sent.
function drop(ctx, row) {
  ctx.rows.delete(row.requestId);
  try { removeRow(ctx.dir, row.requestId); } catch (e) {
    ctx.log({ event: 'row-delete-failed', requestId: row.requestId, ...errMeta(e) });
  }
}

// Rewrites a submitted row's file; a failure is retried by the drain (`stale`).
function saveSubmitted(ctx, row) {
  try { rewriteRow(ctx.dir, row); row.stale = false; } catch (e) {
    row.stale = true;
    ctx.log({ event: 'row-rewrite-failed', requestId: row.requestId, ...errMeta(e) });
  }
}

const say = (ctx, row, text) => postNotice(ctx.adapters, row.adapter, { channel: row.channel, thread: row.thread || row.ts }, text, ctx.log);

async function expire(ctx, row) {
  const { state } = row;
  drop(ctx, row);
  ctx.log({ event: 'expired', requestId: row.requestId, state });
  if (state === 'pending') await say(ctx, row, 'Not delivered — still waiting after 24h.');
}

// `[code, short reason]` why a row may no longer be delivered, or null: the same checks as when it was accepted.
function refusalOf(ctx, row, session) {
  if (!session) return ['no-session', 'the agent no longer exists'];
  const bindings = ctx.store.bindings().filter((b) => b.adapter === row.adapter && b.target.channel === row.channel);
  const { binding, reached } = ctx.threads.pick(bindings, row.sessionId, row.user);
  if (!reached) return ['not-in-channel', 'the agent is no longer connected to this channel'];
  if (!binding?.allowedUsers.includes(row.user.id)) return ['user-not-allowed', 'you are no longer allowed to message this agent'];
  return null;
}

function releaseDelivered(ctx, row) {
  const key = idsKey(row);
  const ids = (ctx.store.state('deliveredIds', key) || []).filter((id) => id !== row.requestId);
  ctx.store.patchState({ deliveredIds: { [key]: ids.length ? ids : null } });
}

const runOf = (ctx, session) => ctx.host.runId?.(session) ?? null;

// The id is recorded before the row file goes, so a crash between the two cannot send the text again.
async function delivered(ctx, row, session) {
  remember(ctx, 'deliveredIds', row);
  drop(ctx, row);
  ctx.log({ event: 'prompted', binding: row.bindingId, session: row.sessionId, user: row.user.id, requestId: row.requestId });
  const r = { channel: row.channel, ts: row.ts, thread: row.thread, user: row.user };
  await ctx.threads.recordDelivery(row.adapter, session, r, row.body, row.via);
}

// One send under a lock scope: a real lock aborts it. A rejection is pending with reason 'error'.
async function attempt(ctx, row, session) {
  const scope = ctx.host.lockScope();
  ctx.active.add(row.requestId); // an edit meanwhile is a new message: this send already has its bytes
  try {
    // Once per pane launch. A stop and a new runId waits again; a stable run does not.
    const run = runOf(ctx, session);
    if (ctx.ready.get(row.sessionId) !== run) {
      try {
        await ctx.host.ready(session, { signal: scope.signal });
      } catch (e) {
        const reason = e?.code === 'prompt-not-ready' ? 'prompt-not-ready' : 'error';
        if (reason === 'error') ctx.log({ event: 'deliver-failed', requestId: row.requestId, session: row.sessionId, ...deliverErr(e) });
        return { state: 'pending', reason };
      }
      if (!scope.signal.aborted && runOf(ctx, session) === run) ctx.ready.set(row.sessionId, run);
    }
    if (scope.signal.aborted) return { state: 'pending', reason: 'locked' };
    // Claim the id before the bytes go out. A crash during the send must not deliver them twice.
    // A send that stays pending gives the id back, so the next drain tries again.
    remember(ctx, 'deliveredIds', row);
    let out;
    try {
      out = await ctx.host.deliver(session, { text: row.text, requestId: row.requestId, signal: scope.signal });
    } catch (e) {
      ctx.log({ event: 'deliver-failed', requestId: row.requestId, session: row.sessionId, ...deliverErr(e) });
      out = { state: 'pending', reason: 'error' };
    }
    if (out?.state === 'submitted') remember(ctx, 'submittedIds', row);
    if (out?.state !== 'delivered') releaseDelivered(ctx, row);
    return out;
  } finally { ctx.active.delete(row.requestId); scope.release(); }
}

async function send(ctx, row) {
  if (isDelivered(ctx, row)) {
    drop(ctx, row);
    ctx.log({ event: 'already-delivered', requestId: row.requestId });
    return true;
  }
  const session = ctx.host.sessions().find((s) => s.id === row.sessionId);
  const refusal = refusalOf(ctx, row, session);
  if (refusal) {
    const [reason, why] = refusal;
    drop(ctx, row);
    ctx.log({ event: 'refused', reason, binding: row.bindingId, session: row.sessionId });
    await say(ctx, row, `Not delivered — ${why}.`);
    return true;
  }
  const out = await attempt(ctx, row, session);
  if (out?.state === 'delivered') { await delivered(ctx, row, session); return true; }
  // A real lock landed during the send and already deleted the row: nothing is left to record.
  if (!ctx.rows.has(row.requestId)) return true;
  if (out?.state === 'submitted') {
    Object.assign(row, { state: 'submitted', reason: out.reason });
    saveSubmitted(ctx, row);
    ctx.log({ event: 'submitted', requestId: row.requestId, session: row.sessionId, reason: out.reason });
    return true;
  }
  const reason = out?.reason || 'error';
  if (row.reason !== reason) ctx.log({ event: 'held', requestId: row.requestId, session: row.sessionId, reason });
  row.reason = reason;
  return false;
}

// One session's pending rows in ts order. A held row stops the later ones; a submitted row does not.
async function drainSession(ctx, list) {
  for (const row of list.sort((a, b) => compareSlackTs(a.ts, b.ts))) {
    if (!ctx.rows.has(row.requestId) || row.state !== 'pending') continue;
    if (ctx.host.lockState().locked) return; // a real lock deletes the rows; checking holds them
    try { if (!(await send(ctx, row))) return; } catch (e) {
      ctx.log({ event: 'drain-failed', requestId: row.requestId, session: row.sessionId, ...errMeta(e) });
      return;
    }
  }
}

// Expiry and file upkeep never wait for a send, so a stuck session cannot keep a row past its day.
async function upkeep(ctx) {
  for (const row of [...ctx.rows.values()]) {
    if (!ctx.rows.has(row.requestId)) continue;
    if (ctx.now() - row.createdAt > LIFETIME_MS) await expire(ctx, row);
    else if (row.stale) saveSubmitted(ctx, row);
  }
}

// One read of the row directory. A failure leaves `loadFailed` set and accepts nothing until a later drain succeeds.
function loadOrFail(ctx) {
  try {
    ctx.unsafe = checkDir(ctx.dir, (e) => ctx.log(e)) === 'unsafe';
    if (ctx.unsafe) { ctx.loadFailed = false; return { rows: [], bad: [] }; }
    const loaded = loadRows(ctx.dir);
    ctx.loadFailed = false;
    return loaded;
  } catch (e) {
    if (!ctx.loadFailed) ctx.log({ event: 'outbox-unreadable', ...errMeta(e) });
    ctx.loadFailed = true;
    return { rows: [], bad: [] };
  }
}

function ingest(ctx, loaded) {
  for (const row of loaded.rows) if (!ctx.rows.has(row.requestId)) restore(ctx, row);
  for (const file of loaded.bad) ctx.log({ event: 'row-malformed', file });
}

async function drain(ctx) {
  if (ctx.loadFailed) {
    const loaded = loadOrFail(ctx);
    if (ctx.loadFailed) return;
    ingest(ctx, loaded);
  }
  await upkeep(ctx);
  if (ctx.host.lockState().locked) return;
  const waiting = [...ctx.rows.values()].filter((r) => r.state === 'pending');
  const bySession = Map.groupBy(waiting, (r) => r.sessionId);
  await Promise.all([...bySession].filter(([id]) => !ctx.sending.has(id)).map(async ([id, list]) => {
    ctx.sending.add(id);
    try { await drainSession(ctx, list); } finally { ctx.sending.delete(id); }
  }));
}

// Tracks real locks. A real lock is `locked` with a reason other than 'checking'. When one lands (from unlocked,
// from checking, or already in place when the bridge starts) every pending row is deleted and its thread
// remembered in memory; once the manager unlocks, each such thread gets one line. Submitted rows stay.
function noteLock(ctx, state) {
  const real = !!state.locked && state.reason !== 'checking';
  const landed = real && !ctx.realLock;
  ctx.realLock = real;
  if (landed) {
    for (const row of [...ctx.rows.values()].filter((r) => r.state === 'pending')) {
      ctx.noticeLater.set(`${row.adapter}|${row.channel}|${row.thread || row.ts}`, row);
      drop(ctx, row);
    }
    ctx.log({ event: 'lock-landed', reason: state.reason });
  }
  if (state.locked || !ctx.noticeLater.size) return Promise.resolve();
  const rows = [...ctx.noticeLater.values()];
  ctx.noticeLater.clear();
  return Promise.all(rows.map((row) => say(ctx, row, 'Not delivered (locked).')));
}

/** The session id behind a top-level message that is still waiting (pending or submitted), else null. */
const waiting = ({ rows }, adapterId, channel, ts) => [...rows.values()]
  .find((r) => r.topLevel && r.adapter === adapterId && r.channel === channel && r.ts === ts)?.sessionId ?? null;

const sessionsIn = ({ rows }, adapterId, channel) => [...new Set([...rows.values()]
  .filter((r) => r.adapter === adapterId && r.channel === channel).map((r) => r.sessionId))];

/** Deletes the live rows of sessions no binding in the channel reaches any more. */
function dropSessions(ctx, adapterId, channel, ids) {
  for (const row of [...ctx.rows.values()]) {
    if (row.adapter === adapterId && row.channel === channel && ids.has(row.sessionId)) drop(ctx, row);
  }
}

// A row read at startup: one already delivered is removed, one already submitted stays submitted.
function restore(ctx, row) {
  // submittedIds wins over a delivered-id left from a crash during the send: the text may have
  // reached the agent, so the row stays submitted and is not sent again.
  if (row.state === 'pending' && isSubmitted(ctx, row)) Object.assign(row, { state: 'submitted', stale: true });
  if (row.state === 'submitted') { ctx.rows.set(row.requestId, row); return; }
  if (isDelivered(ctx, row)) {
    try { removeRow(ctx.dir, row.requestId); } catch (e) { ctx.log({ event: 'row-delete-failed', requestId: row.requestId, error: e.code ?? e.name }); }
    ctx.log({ event: 'already-delivered', requestId: row.requestId });
    return;
  }
  ctx.rows.set(row.requestId, row);
}

/** Loads the row directory. A failed read is retried on each drain; until then accept refuses, so Slack redelivers. */
export function createOutbox({ host, store, adapters, threads, dir, log, now = () => Date.now() }) {
  const ctx = {
    host, store, adapters, threads, dir, log, now, rows: new Map(), sending: new Set(), active: new Set(),
    ready: new Map(), unsafe: false, loadFailed: false, realLock: false, noticeLater: new Map(),
  };
  const loaded = loadOrFail(ctx);
  if (ctx.unsafe) log({ event: 'outbox-unsafe' });
  ingest(ctx, loaded);
  const amend = createAmend(ctx, { accept, drop, isDelivered, isSubmitted, frozenText, rewriteRow });
  return {
    accept: (args) => accept(ctx, args),
    edit: amend.edit,
    deleted: amend.deleted,
    noteLock: (state) => noteLock(ctx, state),
    drain: () => drain(ctx),
    waiting: (adapterId, channel, ts) => waiting(ctx, adapterId, channel, ts),
    sessionsIn: (adapterId, channel) => sessionsIn(ctx, adapterId, channel),
    dropSessions: (adapterId, channel, ids) => dropSessions(ctx, adapterId, channel, ids),
  };
}
