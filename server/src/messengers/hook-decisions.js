import crypto from 'node:crypto';
import { reviewable } from './cards.js';

// The Claude hook side of the bridge: a blocking hook asks for a chat decision,
// cards are posted to the bindings that allow approvals, and the first answer
// (or a timeout, or the hook going away) settles it exactly once.
export class HookDecisions {
  constructor(bridge) {
    this.bridge = bridge;
    this.pending = new Map();      // hook key → {resolve, timer, sessionId, session, detach}
    this.settledText = new Map();  // hook key → the text its cards were closed with, while its post is in flight
  }

  // Waits for a chat decision on a Claude hook item. Resolves {response, by}
  // when someone answers in chat, or null when nothing qualifies, nobody
  // answers in time, or the hook's request went away (the terminal took over).
  async wait(sessionId, item, { timeoutMs = this.bridge.decisionTimeoutMs, signal } = {}) {
    const session = this.bridge.host.sessions().find((x) => x.id === sessionId);
    if (signal?.aborted || !session || this.bridge.host.locked()) return null;
    // A card the approver cannot read in full has no buttons, so waiting would only stall the hook.
    if (item.choices?.length && !reviewable(item)) return null;
    const bindings = this.bridge.store.bindings().filter((b) => b.approvals === true
      && this.bridge.statuses.get(b.adapter)?.connected && this.bridge.sessionsFor(b, [session]).length);
    if (!bindings.length) return null;
    const key = `hook:${crypto.randomUUID()}`;
    const withKey = { ...item, key };
    return new Promise((resolve) => {
      const entry = { resolve, sessionId, session, posting: true, timer: null, detach: () => {} };
      this.pending.set(key, entry);
      const timer = this.bridge.setTimer(() => this.settle(key, null, 'No answer in time — answer in the terminal.'), timeoutMs);
      const onAbort = () => this.settle(key, null, 'Answered in the terminal.');
      signal?.addEventListener('abort', onAbort, { once: true });
      timer?.unref?.();
      Object.assign(entry, { timer, detach: () => signal?.removeEventListener('abort', onAbort) });
      this.postHookCards(bindings, session, withKey)
        .then(() => { if (signal?.aborted) onAbort(); })
        .catch((e) => { this.bridge.log({ event: 'hook-post-failed', key, error: e.message }); this.settle(key, null, 'Could not be posted.'); })
        .finally(() => { entry.posting = false; this.settledText.delete(key); });
    });
  }

  async postHookCards(bindings, session, item) {
    for (const binding of bindings) {
      const ref = await this.bridge.post(binding, this.bridge.inputCardFor(binding, session, item));
      const k = `${binding.id}|${session.id}|${item.key}`;
      const p = {
        bindingId: binding.id, sessionId: session.id, key: item.key, kind: 'input', status: 'open',
        adapter: binding.adapter, ref, item, partial: {},
      };
      this.bridge.store.putPosted(k, p);
      this.bridge.log({ event: 'posted', binding: binding.id, session: session.id, kind: 'input', key: item.key });
      // Settled while this post was in flight: settle() could not see the card yet.
      if (!this.pending.has(item.key)) {
        await this.bridge.closeCard(k, p, session, this.settledText.get(item.key) || 'No longer waiting — answer in the terminal.');
        return;
      }
    }
  }

  // Settles a pending hook item once; `answeredBy` is the binding whose card the
  // reply router closes itself, every other open card for the key is closed here.
  settle(key, result, text, answeredBy = null) {
    const entry = this.pending.get(key);
    if (!entry) return;
    this.pending.delete(key);
    // Only a card still being posted needs the text, and nothing else would clear it.
    if (entry.posting) this.settledText.set(key, text);
    this.bridge.clearTimer(entry.timer);
    entry.detach();
    entry.resolve(result);
    for (const [k, p] of this.bridge.store.allPosted()) {
      if (p.key !== key || p.status !== 'open' || p.bindingId === answeredBy) continue;
      this.bridge.closeCard(k, p, entry.session, text).catch((e) => this.bridge.log({ event: 'close-failed', key, error: e.message }));
    }
  }

  // Nothing will answer once the server stops: tell every waiting hook to fall back to the terminal.
  settleAll(text) {
    for (const key of [...this.pending.keys()]) this.settle(key, null, text);
  }

  answer(session, item, response, by, { binding, text } = {}) {
    if (this.pending.has(item.key)) {
      this.settle(item.key, { response, by }, text, binding?.id);
      return undefined;
    }
    if (item.key.startsWith('hook:')) {
      throw Object.assign(new Error('This request is no longer waiting — answer in the terminal.'), { userFacing: true });
    }
    return this.bridge.host.answer(session, item.key, response);
  }
}
