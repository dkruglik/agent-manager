import crypto from 'node:crypto';
import { ApiError } from '../api-errors.js';
import { postNotice, reviewable, TOO_LONG } from './cards.js';
import { allowed } from './threads.js';

// Inbound side of the bridge: a button press or a chat message becomes a typed
// answer to an open dialog, or an ordinary prompt. Every path checks the
// binding's allowed users and the privacy lock before anything reaches a session.
// Which session a message is for is decided in threads.js.

const SEEN_MESSAGES = 500;
const LOW_NIBBLE = 0x0f;
const VERSION_8 = 0x80;
const LOW_6_BITS = 0x3f;
const VARIANT_10 = 0x80;
// A name-based UUID (RFC 9562 version 8) of the seed text.
const uuid8 = (seed) => {
  const b = crypto.createHash('sha256').update(seed).digest().subarray(0, 16);
  b[6] = (b[6] & LOW_NIBBLE) | VERSION_8; // RFC 9562 version 8 (custom, name-based)
  b[8] = (b[8] & LOW_6_BITS) | VARIANT_10; // RFC 9562 variant 10xx
  const h = b.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
// Shared Codex (CodexInput.send) needs a UUID; a Slack retry or a re-read of the same message must give the same id.
export const requestIdFor = (adapterId, channel, ts) => uuid8(`${adapterId}:${channel}:${ts}`);
// An edit is its own request: not refused as the message it replaces, and not a row file already taken.
export const editRequestIdFor = (adapterId, channel, ts, editTs) => uuid8(`${adapterId}:${channel}:${ts}:edit:${editTs}`);

export class ReplyRouter {
  /**
   * @param cards `{ refresh(posted, session, partial), close(key, posted, session, text) }`
   *   from the outbound side, which owns how a posted card is re-rendered.
   * @param answerer `(session, item, response, by, {binding, text})` delivers a typed answer: to a waiting
   *   hook, or to the session.
   */
  constructor({ host, store, adapters, cards, threads, outbox, scope, log, answerer }) {
    this.host = host;
    this.store = store;
    this.adapters = adapters;
    this.cards = cards;
    this.threads = threads;
    this.outbox = outbox;
    this.scope = scope;
    this.answerer = answerer;
    this.log = log;
    this.handled = [];
    this.inflight = new Map(); // messageId → the handle() in progress for it
    this.answering = new Set(); // posted keys with an answer in flight; never persisted, so a crash leaves the card open
  }

  say(adapterId, channel, thread, text) {
    return postNotice(this.adapters, adapterId, { channel, thread }, text, this.log);
  }

  // One log line per refusal, never the message text.
  refused(reason, binding, session) {
    this.log({ event: 'refused', reason, binding: binding.id, ...(session ? { session: session.id } : {}) });
    return { refused: reason };
  }

  allowed(binding, user) { return allowed(binding, user); }

  channelBindings(adapterId, channel) {
    return this.store.bindings().filter((b) => b.adapter === adapterId && b.target.channel === channel);
  }

  sessionById(id) {
    return this.host.sessions().find((s) => s.id === id);
  }

  // Slack (like most services) redelivers events it thinks were missed.
  duplicate(messageId) {
    if (!messageId) return false;
    if (this.handled.includes(messageId)) return true;
    this.handled.push(messageId);
    if (this.handled.length > SEEN_MESSAGES) this.handled.shift();
    return false;
  }

  byName(bindings, text) { return this.threads.byName(bindings, text); }

  // A refused message is settled: backfill reads the same message from history after a reconnect and
  // must neither deliver it later nor answer it a second time. A failed write is a log line, not a failed refusal.
  settle(adapterId, r) {
    if (!r.ts || r.edit || r.deleted || r.optionId) return;
    try { this.outbox.settle(adapterId, r.channel, requestIdFor(adapterId, r.channel, r.ts)); } catch (e) {
      this.log({ event: 'settle-failed', adapter: adapterId, channel: r.channel, error: String(e.message).slice(0, 200) });
    }
  }

  // An unaddressed message in a channel with several agents goes to none of them. An allowed sender is told
  // once with an ephemeral notice; the log records the skip (never the text).
  async skipUnnamed(adapterId, r, bindings) {
    const ok = bindings.some((b) => this.allowed(b, r.user));
    const reason = ok ? 'no-agent-named' : 'user-not-allowed';
    this.log({ event: 'refused', reason, binding: bindings[0].id, user: r.user?.id });
    if (ok) await this.threads.notifyUnnamed(adapterId, r);
    return { refused: reason };
  }

  /**
   * One inbound event: `{ channel, ts, thread, user:{id,name}, messageId, optionId?, text? }`.
   * `ts` is the message a button lives on; `thread` is the card a reply belongs to.
   */
  // A redelivery that arrives while the first is still being persisted waits for it: if the first fails, so does
  // this one (unacked), and if it succeeds this one is a duplicate.
  handle(adapterId, r) {
    const id = r.messageId;
    const running = id && this.inflight.get(id);
    if (running) return running.then(() => ({ ignored: 'duplicate' }));
    const p = this.run(adapterId, r);
    if (id) {
      this.inflight.set(id, p);
      const clear = () => this.inflight.delete(id);
      p.then(clear, clear);
    }
    return p;
  }

  async run(adapterId, r) {
    if (this.duplicate(r.messageId)) return { ignored: 'duplicate' };
    if (r.deleted) return this.outbox.deleted({ adapterId, r });
    const bindings = this.channelBindings(adapterId, r.channel);
    if (!bindings.length) return { ignored: 'unbound-channel' };
    const target = this.threads.route(adapterId, bindings, r);
    if (target.unnamed) {
      if (r.edit) return { ignored: 'unnamed' };
      this.settle(adapterId, r);
      return this.skipUnnamed(adapterId, r, bindings);
    }
    if (target.ignored) return { ignored: target.ignored };
    const { found, text } = target;
    const posted = found?.[1];
    const answering = !r.edit && posted?.kind === 'input' && (posted.status === 'open' || !!r.optionId);
    const { binding, reached } = this.threads.pick(bindings, target.sessionId, r.user, answering ? posted.bindingId : null);
    const session = this.sessionById(target.sessionId);
    const where = posted ? posted.ref.ts : (r.thread || r.ts);
    const reply = (t) => this.say(adapterId, r.channel, where, t);
    const refused = await this.refusal(binding, session, r, reply, reached, !answering);
    if (refused) {
      this.settle(adapterId, r);
      return refused;
    }
    try {
      // A closed input card no longer takes answers: a reply in its thread is an ordinary prompt.
      if (answering) return await this.answer(found, binding, session, r, text, reply);
      return await this.prompt(adapterId, binding, session, r, text, target.via);
    } catch (e) {
      if (e.persist) {
        // Not accepted: the adapter leaves the event unacked, and its redelivery must not look like a duplicate.
        this.handled = this.handled.filter((id) => id !== r.messageId);
        throw e;
      }
      this.log({
        event: 'reply-failed', binding: binding.id, session: session.id,
        ...(e.requestId ? { requestId: e.requestId } : {}), error: e.message,
      });
      // Only errors written for the operator are shown (a 4xx ApiError, like the API's error envelope);
      // anything else may carry paths or internals.
      const shown = (e instanceof ApiError && e.statusCode < 500) || e.userFacing;
      await reply(shown ? `⚠️ ${e.message}` : '⚠️ Could not deliver that — see the server log.');
      return { error: e.message };
    }
  }

  // `holdable`: a prompt may be saved while the first privacy verdict is in flight ('checking'); a real lock and card answers refuse both.
  async refusal(binding, session, r, reply, reached = true, holdable = false) {
    if (!this.allowed(binding, r.user)) {
      this.log({ event: 'refused', reason: 'user-not-allowed', binding: binding.id, user: r.user?.id });
      if (r.optionId) await reply(`<@${r.user?.id}> is not allowed to answer for this agent.`);
      return { refused: 'user-not-allowed' };
    }
    if (!session) {
      await reply('That agent no longer exists.');
      return this.refused('no-session', binding);
    }
    if (!reached) {
      await reply('That agent is no longer connected to this channel.');
      return this.refused('not-in-channel', binding, session);
    }
    const lock = this.host.lockState();
    if (lock.locked && !(holdable && lock.reason === 'checking')) {
      await reply('Agent Manager is locked; nothing was sent.');
      return this.refused('locked', binding, session);
    }
    return null;
  }

  async prompt(adapterId, binding, session, r, text, via) {
    const body = text.trim();
    if (!body) return { ignored: 'empty' };
    // The id follows the Slack message; without a ts there is nothing stable to derive it from.
    if (!r.ts) {
      this.log({ event: 'refused', reason: 'no-ts', binding: binding.id, session: session.id });
      return { ignored: 'no-ts' };
    }
    // An edit changes a row still waiting, or is sent as a new message; a delete is handled in run().
    if (r.edit) return this.outbox.edit({ binding, session, r, body, via });
    const requestId = requestIdFor(adapterId, r.channel, r.ts);
    // Returns once the row is on disk; the drain delivers it (outbox.js).
    return this.outbox.accept({ requestId, binding, session, r, body, via });
  }

  async answer([k, snapshot], binding, session, r, text, reply) {
    // The snapshot was taken before the awaits in handle(): a press that arrived
    // together with this one may have closed the card since.
    const p = this.store.posted(k) || snapshot;
    if (p.status !== 'open' || this.answering.has(k)) {
      await reply('This request is already closed.');
      return this.refused('closed', binding, session);
    }
    if (p.item.generic) {
      await reply('This dialog cannot be answered from chat yet — open the terminal.');
      return this.refused('untyped', binding, session);
    }
    const by = r.user.name || r.user.id;
    const outcome = r.optionId?.startsWith('d:')
      ? this.decision(binding, p.item, r.optionId.slice(2), by)
      : this.questions(p, r.optionId, text, by);
    if (outcome.refused) {
      if (outcome.say) await reply(outcome.say);
      return this.refused(outcome.refused, binding, session);
    }
    if (outcome.partial) {
      this.store.putPosted(k, { ...p, partial: outcome.partial });
      await this.cards.refresh(p, session, outcome.partial);
      return { partial: true };
    }
    // Claimed before the first await, so a second press sees the card taken.
    this.answering.add(k);
    try { await this.answerer(session, p.item, outcome.response, by, { binding, text: outcome.text }); } finally {
      this.answering.delete(k);
    }
    this.log({ event: 'answered', binding: binding.id, session: session.id, key: p.item.key, user: r.user.id });
    // The answer was delivered: a card that cannot be closed is a log line, not a failed reply.
    try { await this.cards.close(k, { ...p, partial: outcome.answers || p.partial }, session, outcome.text); } catch (e) {
      this.log({ event: 'close-failed', binding: binding.id, session: session.id, key: p.item.key, error: e.message });
    }
    return { answered: p.item.key };
  }

  decision(binding, item, decision, by) {
    if (!binding.approvals) return { refused: 'approvals-off', say: 'Approvals from chat are off for this binding.' };
    if (!reviewable(item)) return { refused: 'too-long', say: TOO_LONG };
    const choice = item.choices?.find((c) => c.value === decision);
    if (!choice) return { refused: 'unknown-option' };
    return { response: { decision }, text: `${choice.label} — by ${by}` };
  }

  // Codex takes all answers of a request at once, so a multi-question card
  // collects them one by one and submits when the last is in.
  questions(p, optionId, text, by) {
    const questions = p.item.questions || [];
    const partial = { ...(p.partial || {}) };
    if (optionId?.startsWith('q:')) {
      const [, qi, oi] = optionId.split(':').map(Number);
      const q = questions[qi];
      const o = q?.options?.[oi];
      if (!q || o === undefined || q.secret) return { refused: 'unknown-option' };
      partial[q.id] = String(o.label ?? o);
    } else {
      const q = questions.find((x) => partial[x.id] === undefined && !x.secret);
      if (!q || !text.trim()) return { refused: 'nothing-open', say: 'Nothing left to answer here from chat.' };
      partial[q.id] = text.trim();
    }
    if (questions.some((q) => partial[q.id] === undefined)) return { partial };
    return { response: { answers: partial }, answers: partial, text: `Answered by ${by}` };
  }

  async command(adapterId, { channel, user, text }) {
    const bindings = this.channelBindings(adapterId, channel);
    if (!bindings.length) return 'This channel is not connected to Agent Manager.';
    if (!bindings.some((b) => this.allowed(b, user))) return 'You are not on the allowed-users list for this channel.';
    const word = (text || '').trim().split(/\s+/)[0] || 'status';
    if (word !== 'status') return 'Commands: `status`. Reply in a card\'s thread to talk to that agent, or start a message with `agent-name:`.';
    if (this.host.locked()) return 'Agent Manager is locked.';
    const sessions = this.host.sessions();
    const rows = [];
    for (const b of bindings) for (const s of this.scope(b, sessions)) {
      rows.push(`• *${s.name}* (${s.cli}) — ${s.inputRequired ? 'needs input' : s.state}`);
    }
    return rows.length ? rows.join('\n') : 'No agents in scope.';
  }
}
