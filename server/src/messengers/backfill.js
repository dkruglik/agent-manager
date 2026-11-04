import { requestIdFor } from './replies.js';
import { threadHistorySources } from './delivery-state.js';

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

// A skipped message counts as missed only for someone a binding allows and only when it never got in.
function missed(store, bindings, ck, adapterId, r) {
  const id = requestIdFor(adapterId, r.channel, r.ts);
  if (store.state('deliveredIds', ck)?.includes(id) || store.state('submittedIds', ck)?.includes(id)) return false;
  return bindings.some((b) => b.allowedUsers.includes(r.user?.id));
}

async function notify({ adapter, log }, channel, skipped) {
  for (const [user, n] of skipped) {
    try { await adapter.postEphemeral({ channel, user, text: noticeText(n) }); } catch (e) {
      log({ event: 'notice-failed', channel, error: e.message });
    }
  }
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
      if (ageMs(now(), r.ts) > MAX_AGE_MS) {
        counts.skipped += 1;
        if (missed(store, bindings, ck, adapterId, r)) skipped.set(r.user.id, (skipped.get(r.user.id) || 0) + 1);
        continue;
      }
      try { await accept(adapterId, r); counts.accepted += 1; } catch (e) {
        acceptFailed += 1;
        log({ event: 'backfill-accept-failed', channel, error: e.message });
      }
    }
  }
  await notify(ctx, channel, skipped);
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
