import { requestIdFor } from './replies.js';

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
  const prefix = `${ck}|`;
  const found = new Map();
  for (const key of store.stateKeys('roots').filter((k) => k.startsWith(prefix))) {
    for (const e of store.state('roots', key)) found.set(e.ts, key.slice(prefix.length));
  }
  for (const e of store.state('deliveredTs', ck) || []) found.set(e.ts, e.sessionId);
  return [...found].map(([ts, sessionId]) => ({ ts, mark: store.state('threadMarks', `${prefix}${sessionId}`) })).filter((t) => t.mark);
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
    return [];
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
  for (const source of sources) {
    for (const r of await fetchMessages(ctx, source)) {
      counts.fetched += 1;
      if (ageMs(now(), r.ts) > MAX_AGE_MS) {
        counts.skipped += 1;
        if (missed(store, bindings, ck, adapterId, r)) skipped.set(r.user.id, (skipped.get(r.user.id) || 0) + 1);
        continue;
      }
      try { await accept(adapterId, r); counts.accepted += 1; } catch (e) {
        log({ event: 'backfill-accept-failed', channel, error: e.message });
      }
    }
  }
  await notify(ctx, channel, skipped);
  return counts;
}

/**
 * Reads the history of every bound channel from its watermarks and sends what is newer than an hour through
 * `accept(adapterId, r)`. One notice per user and channel says how many older messages were not delivered.
 * @param ctx `{ adapterId, adapter, store, now, accept, log, bindings? }`; `bindings` defaults to the store's.
 * @returns `{ fetched, accepted, skipped }` summed over the channels.
 */
export async function backfill(ctx) {
  const all = (ctx.bindings || ctx.store.bindings()).filter((b) => b.adapter === ctx.adapterId);
  const total = { fetched: 0, accepted: 0, skipped: 0 };
  for (const channel of new Set(all.map((b) => b.target.channel))) {
    const counts = await backfillChannel(ctx, channel, all.filter((b) => b.target.channel === channel));
    for (const k of Object.keys(total)) total[k] += counts[k];
  }
  ctx.log({ event: 'backfill', ...total });
  return total;
}
