import { requestIdFor } from './replies.js';
import { addDeliveredId, threadHistorySources } from './delivery-state.js';

// What Slack held while the server was away, read once per socket connect (not on Slack's hourly refresh).
// History is only ever read from a watermark; every message that is sent on goes through `accept`, the path
// of a live event (routing, refusal(), the delivered-id check, the row write). Raw history is never copied
// into the agent, and message text is never logged.

const MAX_AGE_MS = 3600_000;

const plural = (n) => `${n} message${n === 1 ? '' : 's'}`;
const noticeText = (n) => `${plural(n)} you sent while Agent Manager was offline ${n === 1 ? 'was' : 'were'} not delivered.`;
const ageMs = (now, ts) => now - Number(String(ts).split('.')[0]) * 1000;

// The threads of a channel worth reading: the roots still listed and the delivered top-level messages, each
// with the session whose thread watermark applies. Without a watermark there is nothing to read from.
function threadsOf(store, ck) {
  return threadHistorySources(store, ck);
}

// Whether the message already got in or was dealt with: delivered, submitted, or settled (refused, dropped,
// or announced as skipped). A live event and a history copy have different message ids, but the same request id.
const handled = (store, ck, id) => ['deliveredIds', 'submittedIds', 'settledIds'].some((s) => store.state(s, ck)?.includes(id));

// A skipped message counts as missed only for someone a binding allows and only when it never got in.
function missed(store, bindings, ck, id, r) {
  return !handled(store, ck, id) && bindings.some((b) => b.allowedUsers.includes(r.user?.id));
}

// Remembers the messages a notice was sent for, so the next reconnect does not announce them again.
function settleSkipped(ctx, ck, ids) {
  try {
    const kept = ids.reduce((all, id) => addDeliveredId(all, id), ctx.store.state('settledIds', ck));
    ctx.store.patchState({ settledIds: { [ck]: kept } });
  } catch (e) {
    ctx.log({ event: 'settle-failed', channel: ck, error: String(e.message).slice(0, 200) });
  }
}

// `skipped`: user → ids of their messages that were not delivered. Returns the ids a notice went out for.
async function notify({ adapter, log }, channel, skipped) {
  const told = [];
  for (const [user, ids] of skipped) {
    try {
      await adapter.postEphemeral({ channel, user, text: noticeText(ids.length) });
      told.push(...ids);
    } catch (e) {
      log({ event: 'notice-failed', channel, error: e.message });
    }
  }
  return told;
}

async function fetchMessages({ adapter, log }, args) {
  try { return await adapter.history(args); } catch (e) {
    log({ event: 'backfill-failed', channel: args.channel, ...(args.thread ? { thread: args.thread } : {}), error: e.message });
    return null;
  }
}

async function backfillChannel(ctx, channel, bindings) {
  const { adapterId, store, accept, log, now } = ctx;
  const ck = `${adapterId}|${channel}`;
  const sources = [];
  const mark = store.state('channelMarks', ck);
  if (mark) sources.push({ channel, oldest: mark });
  for (const t of threadsOf(store, ck)) sources.push({ channel, thread: t.ts, oldest: t.mark });
  const skipped = new Map();
  const counts = { fetched: 0, accepted: 0, skipped: 0 };
  let failed = false;
  let acceptFailed = 0;
  for (const source of sources) {
    const messages = await fetchMessages(ctx, source);
    if (!messages) { failed = true; continue; }
    for (const r of messages) {
      counts.fetched += 1;
      const id = requestIdFor(adapterId, r.channel, r.ts);
      if (ageMs(now(), r.ts) > MAX_AGE_MS) {
        counts.skipped += 1;
        if (missed(store, bindings, ck, id, r)) skipped.set(r.user.id, [...(skipped.get(r.user.id) || []), id]);
        continue;
      }
      if (handled(store, ck, id)) continue; // refused, dropped or delivered before: not answered or sent a second time
      try { await accept(adapterId, r); counts.accepted += 1; } catch (e) {
        acceptFailed += 1;
        log({ event: 'backfill-accept-failed', channel, error: e.message });
      }
    }
  }
  const told = await notify(ctx, channel, skipped);
  if (told.length) settleSkipped(ctx, ck, told);
  if (acceptFailed) failed = true;
  return { counts, failed, acceptFailed };
}

/**
 * Reads the history of every bound channel from its watermarks and sends what is newer than an hour through
 * `accept(adapterId, r)`. One notice per user and channel says how many older messages were not delivered.
 * @param ctx `{ adapterId, adapter, store, now, accept, log, bindings? }`; `bindings` defaults to the store's.
 * A failed history read is not an empty history: other sources are still read, then this throws so the
 * caller can retry from the same watermarks.
 * @returns `{ fetched, accepted, skipped }` summed over the channels.
 */
export async function backfill(ctx) {
  const all = (ctx.bindings || ctx.store.bindings()).filter((b) => b.adapter === ctx.adapterId);
  const total = { fetched: 0, accepted: 0, skipped: 0 };
  let failed = false;
  let acceptFailed = 0;
  for (const channel of new Set(all.map((b) => b.target.channel))) {
    const part = await backfillChannel(ctx, channel, all.filter((b) => b.target.channel === channel));
    for (const k of Object.keys(total)) total[k] += part.counts[k];
    if (part.failed) failed = true;
    acceptFailed += part.acceptFailed;
  }
  ctx.log({ event: 'backfill', ...total });
  if (failed) throw Object.assign(new Error('backfill incomplete'), { event: 'backfill-failed', acceptFailed: acceptFailed > 0 });
  return total;
}
