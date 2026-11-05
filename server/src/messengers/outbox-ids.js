import { addDeliveredId, addSubmittedId } from './delivery-state.js';

// The id sets in messengers.json that say what became of a chat message (deliveredIds, submittedIds,
// settledIds), as the outbox reads and writes them. `ctx` is the outbox's context.

export const errMeta = (e) => ({ error: e.code ?? e.name, ...(e.message ? { message: String(e.message).slice(0, 200) } : {}) });

export const idsKey = (row) => `${row.adapter}|${row.channel}`;
export const isDelivered = ({ store }, row) => !!store.state('deliveredIds', idsKey(row))?.includes(row.requestId);
export const isSubmitted = ({ store }, row) => !!store.state('submittedIds', idsKey(row))?.includes(row.requestId);
// Settled: refused, dropped or skipped without being delivered. Backfill must not bring it back (delivery-state.js).
export const isSettled = ({ store }, row) => !!store.state('settledIds', idsKey(row))?.includes(row.requestId);

export function remember(ctx, section, row) {
  const key = idsKey(row);
  const ids = ctx.store.state(section, key);
  const next = section === 'submittedIds'
    ? addSubmittedId(ids, row.requestId)
    : addDeliveredId(ids, row.requestId);
  ctx.store.patchState({ [section]: { [key]: next ?? null } });
}


export function settle(ctx, row) {
  try {
    remember(ctx, 'settledIds', row);
    ctx.unsettled.delete(row.requestId);
    return true;
  } catch (e) {
    if (!ctx.unsettled.has(row.requestId)) ctx.log({ event: 'settle-failed', requestId: row.requestId, ...errMeta(e) });
    ctx.unsettled.set(row.requestId, row);
    return false;
  }
}


// submittedIds is not capped, so an id leaves it when its row expires (the settled id, capped, replaces it).
export function forgetSubmitted(ctx, row) {
  const key = idsKey(row);
  try {
    const ids = (ctx.store.state('submittedIds', key) || []).filter((id) => id !== row.requestId);
    ctx.store.patchState({ submittedIds: { [key]: ids.length ? ids : null } });
  } catch (e) { ctx.log({ event: 'submitted-forget-failed', requestId: row.requestId, ...errMeta(e) }); }
}


export function releaseDelivered(ctx, row) {
  const key = idsKey(row);
  const ids = (ctx.store.state('deliveredIds', key) || []).filter((id) => id !== row.requestId);
  ctx.store.patchState({ deliveredIds: { [key]: ids.length ? ids : null } });
}

// A failed release leaves the id in deliveredIds while the row is still pending; retry until it clears.
export function tryReleaseDelivered(ctx, row) {
  try {
    releaseDelivered(ctx, row);
    ctx.unreleased.delete(row.requestId);
  } catch (e) {
    if (!ctx.unreleased.has(row.requestId)) ctx.log({ event: 'deliver-claim-release-failed', requestId: row.requestId, ...errMeta(e) });
    ctx.unreleased.add(row.requestId);
  }
}

