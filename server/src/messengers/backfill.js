import { requestIdFor } from './replies.js';
import { addDeliveredId, laterTs, threadHistorySources } from './delivery-state.js';

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
const handled = (store, ck, id) => ['deliveredIds', 'submittedIds', 'settledIds', 'skippedIds'].some((s) => store.state(s, ck)?.includes(id));

// A skipped message counts as missed only for someone a binding allows and only when it never got in.
function missed(store, bindings, ck, id, r) {
  return !handled(store, ck, id) && bindings.some((b) => b.allowedUsers.includes(r.user?.id));
}

// Remembers the messages a notice was sent for, so the next reconnect does not announce them again.
function settleSkipped(ctx, ck, ids) {
  try {
    const kept = ids.reduce((all, id) => addDeliveredId(all, id), ctx.store.state('skippedIds', ck));
    ctx.store.patchState({ skippedIds: { [ck]: kept } });
  } catch (e) {
    ctx.log({ event: 'settle-failed', channel: ck, error: e.code ?? e.name });
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
      log({ event: 'notice-failed', channel, error: e.code ?? e.name });
    }
  }
  return told;
}

const NARROW_ROUNDS = 4;
const logTarget = (args) => ({ channel: args.channel, ...(args.thread ? { thread: args.thread } : {}) });

// The ts just below `ts` (microsecond resolution), so a mark set there still lets `ts` itself be read.
function before(ts) {
  const [sec, frac = ''] = String(ts).split('.');
  const v = BigInt(sec) * 1000000n + BigInt(frac.padEnd(6, '0').slice(0, 6)) - 1n;
  return `${v / 1000000n}.${String(v % 1000000n).padStart(6, '0')}`;
}

const failure = (ctx, args, e) => {
  ctx.log({ event: 'backfill-failed', ...logTarget(args), error: e.code ?? e.name });
  return { failed: true, ...(e.code === 'rate-limited' ? { rateLimited: true, retryAfter: e.retryAfter } : {}) };
};

// A channel read is newest first, so a cut-off one holds the newest pages and the gap is the older end. Nothing
// from it is delivered: the window below the edge is read instead, again and again until one fits, and that
// oldest chunk is handled first. `advanceTo` then moves the mark just below the chunk's end, so the next
// connect continues with the rest. If no window fits within the rounds, nothing is lost: the mark stays.
async function readOldest(ctx, source, first) {
  let edge = first.edge;
  for (let round = 0; round < NARROW_ROUNDS && edge; round++) {
    try {
      const messages = await ctx.adapter.history({ ...source, latest: edge });
      return { messages, advanceTo: before(edge) };
    } catch (e) {
      if (e.event !== 'history-truncated') return failure(ctx, source, e);
      edge = e.edge;
    }
  }
  ctx.log({ event: 'backfill-gap', ...logTarget(source) });
  return { failed: true };
}

async function fetchMessages(ctx, args) {
  try { return { messages: await ctx.adapter.history(args) }; } catch (e) {
    if (e.event === 'history-truncated' && Array.isArray(e.partial)) {
      if (!args.thread) return readOldest(ctx, args, e);
      // Replies are read oldest first: the pages already read are kept, the rest comes from the new watermark.
      ctx.log({ event: 'backfill-truncated', ...logTarget(args), kept: e.partial.length });
      return { messages: e.partial };
    }
    return failure(ctx, args, e);
  }
}

// One message of a source: too old is announced as skipped, a handled one is passed over, the rest is accepted.
async function visit(ctx, ck, bindings, r, state) {
  const { adapterId, store, accept, log, now } = ctx;
  const id = requestIdFor(adapterId, r.channel, r.ts);
  state.counts.fetched += 1;
  if (ageMs(now(), r.ts) > MAX_AGE_MS) {
    state.counts.skipped += 1;
    if (missed(store, bindings, ck, id, r)) state.skipped.set(r.user.id, [...(state.skipped.get(r.user.id) || []), id]);
    return;
  }
  if (handled(store, ck, id)) return; // refused, dropped or delivered before: not answered or sent a second time
  try { await accept(adapterId, r); state.counts.accepted += 1; } catch (e) {
    state.acceptFailed += 1;
    log({ event: 'backfill-accept-failed', channel: r.channel, error: e.code ?? e.name });
  }
}

function advance(ctx, ck, ts) {
  try { ctx.store.patchState({ channelMarks: { [ck]: laterTs(ctx.store.state('channelMarks', ck), ts) } }); } catch (e) {
    ctx.log({ event: 'settle-failed', channel: ck, error: e.code ?? e.name });
  }
}

async function backfillChannel(ctx, channel, bindings) {
  const { adapterId, store } = ctx;
  const ck = `${adapterId}|${channel}`;
  const sources = [];
  const mark = store.state('channelMarks', ck);
  if (mark) sources.push({ channel, oldest: mark });
  for (const t of threadsOf(store, ck)) sources.push({ channel, thread: t.ts, oldest: t.mark });
  const state = { skipped: new Map(), counts: { fetched: 0, accepted: 0, skipped: 0 }, acceptFailed: 0 };
  let failed = false;
  let retryAfter = null;
  for (const source of sources) {
    const got = await fetchMessages(ctx, source);
    if (got.failed) {
      failed = true;
      // Every later source would meet the same limit: stop, and let the caller retry after the wait.
      if (got.rateLimited) { retryAfter = got.retryAfter ?? 60; break; }
      continue;
    }
    const failedBefore = state.acceptFailed;
    for (const r of got.messages) await visit(ctx, ck, bindings, r, state);
    if (got.advanceTo && state.acceptFailed === failedBefore) advance(ctx, ck, got.advanceTo);
  }
  const told = await notify(ctx, channel, state.skipped);
  if (told.length) settleSkipped(ctx, ck, told);
  return { counts: state.counts, failed: failed || state.acceptFailed > 0, acceptFailed: state.acceptFailed, retryAfter };
}

/**
 * Reads the history of every bound channel from its watermarks and sends what is newer than an hour through
 * `accept(adapterId, r)`. One notice per user and channel says how many older messages were not delivered.
 * @param ctx `{ adapterId, adapter, store, now, accept, log, bindings? }`; `bindings` defaults to the store's.
 * A failed history read is not an empty history: other sources are still read, then this throws so the
 * caller can retry from the same watermarks. After a `rate-limited` read the rest is not attempted; the thrown
 * error then has `code: 'rate-limited'` and `retryAfter` (seconds), and the caller should call backfill again after it.
 * @returns `{ fetched, accepted, skipped }` summed over the channels.
 */
export async function backfill(ctx) {
  const all = (ctx.bindings || ctx.store.bindings()).filter((b) => b.adapter === ctx.adapterId);
  const total = { fetched: 0, accepted: 0, skipped: 0 };
  let failed = false;
  let acceptFailed = 0;
  let retryAfter = null;
  for (const channel of new Set(all.map((b) => b.target.channel))) {
    const part = await backfillChannel(ctx, channel, all.filter((b) => b.target.channel === channel));
    for (const k of Object.keys(total)) total[k] += part.counts[k];
    if (part.failed) failed = true;
    acceptFailed += part.acceptFailed;
    if (part.retryAfter != null) { retryAfter = part.retryAfter; break; } // the limit is per workspace: other channels would fail too
  }
  ctx.log({ event: 'backfill', ...total });
  if (failed) {
    throw Object.assign(new Error('backfill incomplete'), {
      event: 'backfill-failed', acceptFailed: acceptFailed > 0, ...(retryAfter != null ? { code: 'rate-limited', retryAfter } : {}),
    });
  }
  return total;
}
