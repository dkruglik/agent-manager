import crypto from 'node:crypto';
import { ApiError } from '../api-errors.js';
import { noticeCard, reviewable, TOO_LONG } from './cards.js';

// Inbound side of the bridge: a button press or a chat message becomes a typed
// answer to an open dialog, or an ordinary prompt. Every path checks the
// binding's allowed users and the privacy lock before anything reaches a session.

const SEEN_MESSAGES = 500;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

export class ReplyRouter {
  /**
   * @param cards `{ refresh(posted, session, partial), close(key, posted, session, text) }`
   *   from the outbound side, which owns how a posted card is re-rendered.
   * @param answerer `(session, item, response, by, {binding, text})` delivers a typed answer: to a waiting
   *   hook, or to the session.
   */
  constructor({ host, store, adapters, cards, scope, log, answerer }) {
    this.host = host;
    this.store = store;
    this.adapters = adapters;
    this.cards = cards;
    this.scope = scope;
    this.answerer = answerer;
    this.log = log;
    this.handled = [];
  }

  async say(adapterId, channel, thread, text) {
    try { await this.adapters.get(adapterId)?.post({ channel, thread }, noticeCard(text)); } catch (e) {
      this.log({ event: 'notice-failed', adapter: adapterId, channel, error: e.message });
    }
  }

  // One log line per refusal, never the message text.
  refused(reason, binding, session) {
    this.log({ event: 'refused', reason, binding: binding.id, ...(session ? { session: session.id } : {}) });
    return { refused: reason };
  }

  allowed(binding, user) {
    return !!user?.id && binding.allowedUsers.includes(user.id);
  }

  // Slack (like most services) redelivers events it thinks were missed.
  duplicate(messageId) {
    if (!messageId) return false;
    if (this.handled.includes(messageId)) return true;
    this.handled.push(messageId);
    if (this.handled.length > SEEN_MESSAGES) this.handled.shift();
    return false;
  }

  // "name: text" or "@name text" addresses one agent in a group channel.
  byName(bindings, text) {
    const m = /^(?:@([^\s:]{1,80})[:\s]|([^\s:@]{1,80}):)\s*([\s\S]+)$/.exec(text.trim());
    if (!m) return null;
    const wanted = (m[1] || m[2]).toLowerCase();
    const sessions = this.host.sessions();
    for (const binding of bindings) {
      const session = this.scope(binding, sessions).find((x) => x.name.toLowerCase() === wanted);
      if (session) return { binding, session, text: m[3].trim() };
    }
    return null;
  }

  /** The binding, session and posted card a reply is about, if any. */
  resolve(adapterId, r) {
    const bindings = this.store.bindings().filter((b) => b.adapter === adapterId && b.target.channel === r.channel);
    if (!bindings.length) return { ignored: 'unbound-channel' };
    const anchor = r.optionId ? r.ts : r.thread;
    const found = anchor ? this.store.findPostedByRef(adapterId, r.channel, anchor) : null;
    const text = r.text || '';
    if (found) {
      const posted = found[1];
      const session = this.host.sessions().find((s) => s.id === posted.sessionId);
      return { binding: this.store.binding(posted.bindingId), session, found, text };
    }
    if (r.optionId || r.thread) return { ignored: 'no-target' };
    const named = this.byName(bindings, text);
    if (named) return named;
    const direct = bindings.filter((b) => b.scope.type === 'session');
    if (direct.length !== 1) return { ignored: 'no-target' };
    return { binding: direct[0], session: this.host.sessions().find((s) => s.id === direct[0].scope.id), text };
  }

  /**
   * One inbound event: `{ channel, ts, thread, user:{id,name}, messageId, optionId?, text? }`.
   * `ts` is the message a button lives on; `thread` is the card a reply belongs to.
   */
  async handle(adapterId, r) {
    if (this.duplicate(r.messageId)) return { ignored: 'duplicate' };
    const target = this.resolve(adapterId, r);
    if (!target.binding) return { ignored: target.ignored || 'no-target' };
    const { binding, session, found, text } = target;
    const posted = found?.[1];
    const where = posted ? posted.ref.ts : (r.thread || r.ts);
    const reply = (t) => this.say(adapterId, r.channel, where, t);
    const refused = await this.refusal(binding, session, r, reply);
    if (refused) return refused;
    try {
      if (posted?.kind === 'input') return await this.answer(found, binding, session, r, text, reply);
      return await this.prompt(adapterId, binding, session, r, text, reply);
    } catch (e) {
      this.log({ event: 'reply-failed', binding: binding.id, session: session.id, error: e.message });
      // Only errors written for the operator are shown; anything else may carry paths or internals.
      await reply(e instanceof ApiError || e.userFacing ? `⚠️ ${e.message}` : '⚠️ Could not deliver that — see the server log.');
      return { error: e.message };
    }
  }

  async refusal(binding, session, r, reply) {
    if (!this.allowed(binding, r.user)) {
      this.log({ event: 'refused', reason: 'user-not-allowed', binding: binding.id, user: r.user?.id });
      if (r.optionId) await reply(`<@${r.user?.id}> is not allowed to answer for this agent.`);
      return { refused: 'user-not-allowed' };
    }
    if (!session) {
      await reply('That agent no longer exists.');
      return this.refused('no-session', binding);
    }
    if (this.host.locked()) {
      await reply('Agent Manager is locked; nothing was sent.');
      return this.refused('locked', binding, session);
    }
    return null;
  }

  async prompt(adapterId, binding, session, r, text, reply) {
    if (!text.trim()) return { ignored: 'empty' };
    const requestId = `msg-${sha(`${adapterId}:${r.channel}:${r.messageId || r.ts}`)}`;
    await this.host.prompt(session, text.trim(), { requestId, user: r.user });
    this.log({ event: 'prompted', binding: binding.id, session: session.id, user: r.user.id });
    await reply(`➡️ Sent to *${session.name}*.`);
    return { prompted: session.id };
  }

  async answer([k, snapshot], binding, session, r, text, reply) {
    // The snapshot was taken before the awaits in handle(): a press that arrived
    // together with this one may have closed the card since.
    const p = this.store.posted(k) || snapshot;
    if (p.status !== 'open') { await reply('This request is already closed.'); return this.refused('closed', binding, session); }
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
    this.store.putPosted(k, { ...p, status: 'answering' });
    try { await this.answerer(session, p.item, outcome.response, by, { binding, text: outcome.text }); } catch (e) {
      this.store.putPosted(k, p);
      throw e;
    }
    this.log({ event: 'answered', binding: binding.id, session: session.id, key: p.item.key, user: r.user.id });
    await this.cards.close(k, { ...p, partial: outcome.answers || p.partial }, session, outcome.text);
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
    const bindings = this.store.bindings().filter((b) => b.adapter === adapterId && b.target.channel === channel);
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
