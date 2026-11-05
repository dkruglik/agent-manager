import { postNotice } from './cards.js';

// What the outbox does when the privacy lock lands, and the lines it owes once the lock is lifted.

const LOCKED_TEXT = 'Not delivered (locked).';

/** One line in the row's thread (a notice never throws). */
export const say = (ctx, row, text) => postNotice(ctx.adapters, row.adapter, { channel: row.channel, thread: row.thread || row.ts }, text, ctx.log);

/** Holds a line about `row` back until the lock is lifted (one per thread and text). */
export const deferNotice = (ctx, row, text) => ctx.noticeLater.set(row.requestId, { row, text });

/**
 * Tracks real locks. A real lock is `locked` with a reason other than 'checking'. When one lands (from unlocked,
 * from checking, or already in place when the bridge starts) every pending row is deleted and its thread
 * remembered in memory; once the manager unlocks, each such thread gets one line. Submitted rows stay.
 * Lines deferred during a lock or 'checking' (expiry) go out then too.
 * @param drop `(ctx, row)` from outbox.js
 */
export function noteLock(ctx, state, drop) {
  const real = !!state.locked && state.reason !== 'checking';
  const landed = real && !ctx.realLock;
  ctx.realLock = real;
  if (landed) {
    for (const row of [...ctx.rows.values()].filter((r) => r.state === 'pending')) {
      deferNotice(ctx, row, LOCKED_TEXT);
      drop(ctx, row);
    }
    ctx.log({ event: 'lock-landed', reason: state.reason });
  }
  if (state.locked || !ctx.noticeLater.size) return Promise.resolve();
  const lines = new Map([...ctx.noticeLater.values()].map((l) => [`${l.row.adapter}|${l.row.channel}|${l.row.thread || l.row.ts}|${l.text}`, l]));
  ctx.noticeLater.clear();
  return Promise.all([...lines.values()].map((l) => say(ctx, l.row, l.text)));
}
