import { finishedCard } from './cards.js';
import { finishedMark, markFinished, redactCard } from './outbound.js';

// The `finished` card: the latest assistant text, clipped, as a top-level channel post. `b` is the
// MessengerBridge. A binding that also has `transcript` never gets here (outbound.js postsFinished).

/** Posts a finished card for the session's newest reply, once, when it has settled and was not read. */
export async function checkFinished(b, binding, s) {
  const { store, host, now, log } = b;
  const { adapter } = binding;
  const channel = binding.target.channel;
  const k = `${binding.id}|${s.id}`;
  const mark = finishedMark(store, adapter, channel, s.id);
  const baseline = mark === null;
  if (!baseline && !b.settled(s)) return;
  if (now() - (b.digestAt.get(k) || 0) < b.digestEveryMs) return;
  b.digestAt.set(k, now());
  let d;
  try { d = await host.digest(s); } catch (e) {
    // Not a baseline: recording an empty one would replay an old answer later.
    log({ event: 'digest-failed', session: s.id, error: e.message });
    return;
  }
  const id = d?.id || '';
  // The first look at a session only records where its conversation stands:
  // binding a channel must not replay an answer the operator already read.
  if (baseline) { markFinished(store, adapter, channel, s.id, id); return; }
  if (!id || id === mark || !d.text) return;
  // Already shown to the operator in the web UI: nothing to announce.
  if (d.read) {
    markFinished(store, adapter, channel, s.id, id);
    log({ event: 'skipped-read', binding: binding.id, session: s.id, kind: 'finished' });
    return;
  }
  // Marked only once posted: a failed post is retried on the next look.
  const card = redactCard(b.filter, finishedCard({ agent: b.agent(s), link: host.link(s), text: d.text }));
  const ref = await b.post(binding, card);
  markFinished(store, adapter, channel, s.id, id);
  store.putPosted(`${k}|done:${id}`, {
    bindingId: binding.id, sessionId: s.id, key: `done:${id}`, kind: 'finished', status: 'closed', adapter, ref,
  });
  log({ event: 'posted', binding: binding.id, session: s.id, kind: 'finished' });
}
