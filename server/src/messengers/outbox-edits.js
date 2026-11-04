import { postNotice } from './cards.js';
import { persistError } from './outbox-files.js';
import { editRequestIdFor, requestIdFor } from './replies.js';

// A Slack message that was edited or deleted after it was accepted (message_changed, message_deleted).
// A row still waiting is changed or dropped in its file. What the agent may already have is never rewritten:
// an edit then is a new message under its own request id, and a delete is one line in the thread.

export const EDIT_HEAD = 'Edited in Slack (replaces the earlier message):\n';
export const DELETED_LINE = 'The Slack message was deleted after it was sent to the agent.';

/**
 * @param ctx the outbox state (rows, store, adapters, dir, log, active)
 * @param h `{ accept, drop, isDelivered, isSubmitted, frozenText, rewriteRow }` from outbox.js
 */
export function createAmend(ctx, h) {
  const { rows, store, log } = ctx;
  const idRow = (adapter, channel, requestId) => ({ adapter, channel, requestId });
  // A row not yet handed to the agent, whose bytes can still change. One mid-send already has its text.
  const editable = (row) => row?.state === 'pending' && !ctx.active.has(row.requestId);
  const known = (adapter, channel, requestId) => rows.has(requestId)
    || h.isDelivered(ctx, idRow(adapter, channel, requestId)) || h.isSubmitted(ctx, idRow(adapter, channel, requestId));

  function replace(row, session, body) {
    const text = h.frozenText(ctx, row.adapter, row.channel, session, row.user, body, row.requestId);
    try { h.rewriteRow(ctx.dir, { ...row, text, body }); } catch (e) { throw persistError(e); }
    Object.assign(row, { text, body });
    log({ event: 'edited', requestId: row.requestId, session: session.id });
    return { edited: session.id };
  }

  function edit({ binding, session, r, body, via }) {
    const ignore = (reason) => {
      log({ event: 'edit-ignored', reason, binding: binding.id, session: session.id });
      return { ignored: reason };
    };
    const id = requestIdFor(binding.adapter, r.channel, r.edit.ts);
    const row = rows.get(id);
    // The send already has its bytes. Leave the event unacked so Slack retries once the send finishes.
    if (row && ctx.active.has(row.requestId)) throw Object.assign(new Error('the message is still being delivered'), { persist: true });
    if (!known(binding.adapter, r.channel, id)) return ignore('unknown-message');
    if (editable(row)) return row.sessionId === session.id ? replace(row, session, body) : ignore('session-changed');
    const requestId = editRequestIdFor(binding.adapter, r.channel, r.edit.ts, r.edit.editTs);
    return h.accept(ctx, { requestId, binding, session, r, body: EDIT_HEAD + body, via, extra: { editOf: r.edit.ts } });
  }

  // The thread for a line about a message: its own, else the session's current root, else the channel.
  function where(adapter, channel, thread, sessionId) {
    if (thread) return thread;
    return sessionId ? store.state('roots', `${adapter}|${channel}|${sessionId}`)?.at(-1)?.ts ?? null : null;
  }

  async function deleted({ adapterId, r }) {
    const id = requestIdFor(adapterId, r.channel, r.deleted.ts);
    const row = rows.get(id);
    const waiting = [...rows.values()].filter((x) => x.adapter === adapterId && x.channel === r.channel && editable(x)
      && (x.requestId === id || x.editOf === r.deleted.ts));
    for (const x of waiting) h.drop(ctx, x);
    if (waiting.length) { log({ event: 'deleted-dropped', requestId: id, rows: waiting.length }); return { dropped: waiting.length }; }
    if (!known(adapterId, r.channel, id)) return { ignored: 'unknown-message' };
    let sessionId = row?.sessionId;
    if (!sessionId) {
      sessionId = store.state('deliveredTs', `${adapterId}|${r.channel}`)?.find((e) => e.ts === r.deleted.ts)?.sessionId;
    }
    const thread = where(adapterId, r.channel, r.thread || row?.thread, sessionId);
    await postNotice(ctx.adapters, adapterId, { channel: r.channel, thread }, DELETED_LINE, log);
    return { noted: id };
  }

  return { edit, deleted };
}
