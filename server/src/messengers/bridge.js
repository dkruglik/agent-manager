import { inputCard, finishedCard, noticeCard } from './cards.js';
import { ReplyRouter } from './replies.js';
import { HookDecisions } from './hook-decisions.js';

// The bridge between Agent Manager sessions and chat messengers.
//
// Outbound, it watches the sessions each binding covers and posts a card when
// one needs input or has finished a turn. Inbound (ReplyRouter), it turns a
// button press or a reply into a typed answer or an ordinary prompt. It never
// types keystrokes into a TUI dialog (see docs/tui-input-required.md): a dialog
// without a typed answer path gets a card that links to the terminal instead.
//
// Everything about Agent Manager comes through `host`, and everything about a
// chat service through an adapter, so this file knows neither. See
// docs/messengers.md for both contracts.

const BACKOFF_MIN_MS = 5000;
const BACKOFF_MAX_MS = 5 * 60_000;

export class MessengerBridge {
  constructor({
    host, store, adapters, now = () => Date.now(), log = () => {},
    settleMs = 8000, digestEveryMs = 5000, tickMs = 2000, lookForMs = 60_000,
    decisionTimeoutMs = 120_000, setTimer = setTimeout, clearTimer = clearTimeout,
  }) {
    Object.assign(this, { host, store, adapters, now, log, settleMs, digestEveryMs, tickMs, lookForMs, decisionTimeoutMs, setTimer, clearTimer });
    this.hooks = new HookDecisions(this);
    this.pending = this.hooks.pending; // hook key → the decision still being waited for
    this.waitingSince = new Map(); // sessionId → when it settled into waiting
    this.digestAt = new Map();     // `${bindingId}|${sessionId}` → last transcript read
    this.statuses = new Map();     // adapterId → {connected, error}
    this.failing = new Map();      // bindingId → {count, error, retryAt} while its posts keep failing
    this.timer = null;
    this.ticking = false;
    this.replies = new ReplyRouter({
      host, store, adapters, log,
      answerer: (session, item, response, by, ctx) => this.answerItem(session, item, response, by, ctx),
      scope: (binding, sessions) => this.sessionsFor(binding, sessions),
      cards: {
        refresh: (p, session, partial) => this.refreshCard(p, session, partial),
        close: (k, p, session, text) => this.closeCard(k, p, session, text),
      },
    });
  }

  sessionsFor(binding, sessions) {
    if (binding.scope.type === 'session') return sessions.filter((s) => s.id === binding.scope.id);
    return sessions.filter((s) => this.host.groupOf(s.id)?.id === binding.scope.id);
  }

  agent(s) {
    return { id: s.id, name: s.name, cli: s.cli, group: this.host.groupOf(s.id)?.name || null };
  }

  inputCardFor(binding, s, item, extra = {}) {
    return inputCard({ agent: this.agent(s), link: this.host.link(s), item, approvals: binding.approvals, ...extra });
  }

  post(binding, card) {
    return this.adapters.get(binding.adapter).post({ channel: binding.target.channel, thread: null }, card);
  }

  // What needs input right now. Shared Codex exposes typed requests; every
  // other CLI exposes only the fact (and kind) of a dialog. Null when the
  // lookup failed: what is open is then unknown, not empty.
  async inputItems(s) {
    if (!s.inputRequired) return [];
    let typed;
    try { typed = await this.host.requests(s); } catch (e) {
      this.log({ event: 'requests-failed', session: s.id, error: e.message });
      return null;
    }
    if (typed.length) return typed;
    const ir = s.inputRequired;
    return [{ key: `ir:${ir.cli}:${ir.detectedAt}`, kind: ir.kind, generic: true }];
  }

  async checkInput(binding, s) {
    const items = await this.inputItems(s);
    if (!items) return;
    const hooked = [...this.pending.values()].some((p) => p.sessionId === s.id);
    for (const item of items) {
      // A Claude hook item already has its own card; the dialog it mirrors needs no second one.
      if (hooked && item.generic) continue;
      const k = `${binding.id}|${s.id}|${item.key}`;
      if (this.store.posted(k)) continue;
      const ref = await this.post(binding, this.inputCardFor(binding, s, item));
      this.store.putPosted(k, {
        bindingId: binding.id, sessionId: s.id, key: item.key, kind: 'input', status: 'open',
        adapter: binding.adapter, ref, item, partial: {},
      });
      this.log({ event: 'posted', binding: binding.id, session: s.id, kind: 'input', key: item.key });
    }
    // A dialog that closed anywhere — terminal, reader, another chat — is
    // resolved here too, so nobody presses a button for a question that is gone.
    const live = new Set(items.map((i) => i.key));
    for (const [k, p] of this.store.allPosted()) {
      if (p.bindingId !== binding.id || p.sessionId !== s.id || p.kind !== 'input' || p.status !== 'open') continue;
      if (!live.has(p.key) && !this.pending.has(p.key)) await this.closeCard(k, p, s, 'Answered or dismissed outside this chat.');
    }
  }

  awaitDecision(sessionId, item, opts) { return this.hooks.wait(sessionId, item, opts); }
  answerItem(...args) { return this.hooks.answer(...args); }

  async refreshCard(p, s, partial) {
    const binding = this.store.binding(p.bindingId);
    await this.adapters.get(p.adapter)?.update(p.ref, this.inputCardFor(binding, s, p.item, { partial }));
  }

  async closeCard(k, p, s, text) {
    const binding = this.store.binding(p.bindingId);
    // A closed card is never answered again: its tool input need not stay on disk.
    const { details, toolInput, ...kept } = p.item || {};
    this.store.putPosted(k, { ...p, ...(p.item ? { item: kept } : {}), status: 'closed', closedText: text });
    if (!binding || !p.ref) return;
    try {
      await this.adapters.get(p.adapter)?.update(p.ref, this.inputCardFor(binding, s, p.item, { partial: p.partial, resolved: { text } }));
    } catch (e) { this.log({ event: 'update-failed', key: p.key, error: e.message }); }
  }

  // True once a session has sat in `waiting` for the settle window, and only
  // for a while after: a reply lands in the transcript within moments of the
  // turn ending, and an idle agent should not cost a read every few seconds.
  settled(s) {
    if (s.state !== 'waiting' || s.inputRequired) { this.waitingSince.delete(s.id); return false; }
    if (!this.waitingSince.has(s.id)) this.waitingSince.set(s.id, this.now());
    const settledFor = this.now() - this.waitingSince.get(s.id);
    return settledFor >= this.settleMs && settledFor <= this.settleMs + this.lookForMs;
  }

  async checkFinished(binding, s) {
    const k = `${binding.id}|${s.id}`;
    const baseline = this.store.seen(k) === null;
    if (!baseline && !this.settled(s)) return;
    if (this.now() - (this.digestAt.get(k) || 0) < this.digestEveryMs) return;
    this.digestAt.set(k, this.now());
    let d;
    try { d = await this.host.digest(s); } catch (e) {
      // Not a baseline: recording an empty one would replay an old answer later.
      this.log({ event: 'digest-failed', session: s.id, error: e.message });
      return;
    }
    const id = d?.id || '';
    // The first look at a session only records where its conversation stands:
    // binding a channel must not replay an answer the operator already read.
    if (baseline) { this.store.putSeen(k, id); return; }
    if (!id || id === this.store.seen(k) || !d.text) return;
    if (!binding.events.includes('finished')) { this.store.putSeen(k, id); return; }
    // Seen only once posted: a failed post is retried on the next look.
    const ref = await this.post(binding, finishedCard({ agent: this.agent(s), link: this.host.link(s), text: d.text }));
    this.store.putSeen(k, id);
    this.store.putPosted(`${k}|done:${id}`, {
      bindingId: binding.id, sessionId: s.id, key: `done:${id}`, kind: 'finished', status: 'closed', adapter: binding.adapter, ref,
    });
    this.log({ event: 'posted', binding: binding.id, session: s.id, kind: 'finished' });
  }

  async tick() {
    if (this.ticking || this.host.locked()) return;
    this.ticking = true;
    try {
      const sessions = this.host.sessions();
      for (const binding of this.store.bindings()) {
        if (!this.statuses.get(binding.adapter)?.connected) continue;
        if (this.now() < (this.failing.get(binding.id)?.retryAt || 0)) continue;
        let failure = null;
        for (const s of this.sessionsFor(binding, sessions)) failure = (await this.checkSession(binding, s)) || failure;
        this.noteOutcome(binding, failure);
      }
    } finally { this.ticking = false; }
  }

  // Returns the error when the check failed, so the binding can be backed off.
  async checkSession(binding, s) {
    try {
      if (binding.events.includes('input-required')) await this.checkInput(binding, s);
      await this.checkFinished(binding, s);
      return null;
    } catch (e) {
      this.log({ event: 'tick-failed', binding: binding.id, session: s.id, error: e.message });
      return e;
    }
  }

  // A binding that fails keeps being skipped for 5 s, doubling to 5 min, so a
  // dead channel costs neither a request every tick nor a log line every tick.
  noteOutcome(binding, failure) {
    if (!failure) { this.failing.delete(binding.id); return; }
    const count = (this.failing.get(binding.id)?.count || 0) + 1;
    const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (count - 1));
    this.failing.set(binding.id, { count, error: String(failure.message).slice(0, 200), retryAt: this.now() + wait });
  }

  /** The last error of a binding whose posts are failing, else null. */
  lastError(bindingId) { return this.failing.get(bindingId)?.error ?? null; }

  handleReply(adapterId, r) { return this.replies.handle(adapterId, r); }
  handleCommand(adapterId, c) { return this.replies.command(adapterId, c); }

  status() {
    return Object.fromEntries([...this.adapters.keys()].map((id) => [id, this.statuses.get(id) || { connected: false, error: null }]));
  }

  testBinding(binding) {
    return this.post(binding, noticeCard(`This channel now receives ${binding.events.join(' and ')} events from Agent Manager.`, '👋 Connected'));
  }

  start() {
    if (this.timer) return;
    for (const [id, a] of this.adapters) {
      this.statuses.set(id, { connected: false, error: a.configured() ? null : 'not configured' });
      if (!a.configured()) continue;
      a.start({
        onReply: (r) => this.handleReply(id, r),
        onCommand: (c) => this.handleCommand(id, c),
        onStatus: (st) => this.statuses.set(id, st),
        log: (e) => this.log({ adapter: id, ...e }),
      });
    }
    this.timer = setInterval(() => { this.tick().catch((e) => this.log({ event: 'tick-failed', error: e.message })); }, this.tickMs);
    this.timer.unref?.();
  }

  async stop() {
    clearInterval(this.timer);
    this.timer = null;
    this.hooks.settleAll('Agent Manager is stopping — answer in the terminal.');
    for (const a of this.adapters.values()) await a.stop?.();
  }
}
