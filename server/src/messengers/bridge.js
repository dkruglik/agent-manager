import path from 'node:path';
import { inputCard, finishedCard, noticeCard } from './cards.js';
import { ReplyRouter } from './replies.js';
import { HookDecisions } from './hook-decisions.js';
import { createThreads } from './threads.js';
import { createOutbox } from './outbox.js';

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

/**
 * @typedef {object} InputItem An open dialog a card is posted for.
 * @property {string} key  Unique per dialog: a Codex request key, `ir:<cli>:<detectedAt>`, or `hook:<uuid>`.
 * @property {'permission'|'question'|'confirmation'|string} kind
 * @property {'hook'} [source]  Set on a Claude hook item, which is answered to the waiting hook, never the session.
 * @property {boolean} [generic]  Only the fact of a dialog is known: the card links to the terminal.
 * @property {string} [details]  Preformatted request text (a command, a JSON tool input).
 * @property {{value: string, label: string}[]} [choices]  Decisions, e.g. accept / decline.
 * @property {{id: string, text: string, secret?: boolean, options?: ({label: string}|string)[]}[]} [questions]
 * @property {string} [event]  The Claude hook event (PermissionRequest, PreToolUse).
 * @property {object} [toolInput]  The Claude tool input an AskUserQuestion answer travels back with.
 */

const BACKOFF_MIN_MS = 5000;
const BACKOFF_MAX_MS = 5 * 60_000;

// Settings shows only what an adapter marked public (a Slack error code): any
// other error may carry file paths or network details, which stay in the log.
const publicError = (e) => {
  if (typeof e.publicMessage === 'string') return e.publicMessage.slice(0, 200);
  return e.event === 'requests-failed' ? 'could not look up open dialogs — see the server log' : 'could not post — see the server log';
};

const inputKey = (binding, s, item) => `${binding.id}|${s.id}|${item.key}`;

export class MessengerBridge {
  constructor({
    host, store, adapters, now = () => Date.now(), log = () => {}, dataDir = path.dirname(store.file),
    settleMs = 8000, digestEveryMs = 5000, tickMs = 2000, lookForMs = 60_000,
    decisionTimeoutMs = 120_000, setTimer = setTimeout, clearTimer = clearTimeout,
  }) {
    Object.assign(this, { host, store, adapters, now, log, settleMs, digestEveryMs, tickMs, lookForMs, decisionTimeoutMs, setTimer, clearTimer });
    this.hooks = new HookDecisions(this);
    this.waitingSince = new Map(); // sessionId → when it settled into waiting
    this.digestAt = new Map();     // `${bindingId}|${sessionId}` → last transcript read
    this.statuses = new Map();     // adapterId → {connected, error}
    this.failing = new Map();      // bindingId → {count, error, retryAt} while its posts keep failing
    this.timer = null;
    this.ticking = false;
    const scope = (binding, sessions) => this.sessionsFor(binding, sessions);
    this.threads = createThreads({
      host, store, adapters, log, now, scope,
      outbox: (a, c, ts) => this.outbox.waiting(a, c, ts),
      rows: { sessionsIn: (a, c) => this.outbox.sessionsIn(a, c), dropSessions: (a, c, ids) => this.outbox.dropSessions(a, c, ids) },
    });
    this.outbox = createOutbox({ host, store, adapters, threads: this.threads, dir: path.join(dataDir, 'messenger-outbox'), log, now });
    this.replies = new ReplyRouter({
      host, store, adapters, log, scope, threads: this.threads, outbox: this.outbox,
      answerer: (...args) => this.hooks.answer(...args),
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
  // other CLI exposes only the fact (and kind) of a dialog. A failed lookup
  // throws: what is open is then unknown, not empty, and the binding backs off.
  async inputItems(s) {
    if (!s.inputRequired) return [];
    let typed;
    try { typed = await this.host.requests(s); } catch (e) {
      throw Object.assign(new Error(e.message), { event: 'requests-failed' });
    }
    if (typed.length) return typed;
    const ir = s.inputRequired;
    return [{ key: `ir:${ir.cli}:${ir.detectedAt}`, kind: ir.kind, generic: true }];
  }

  async checkInput(binding, s) {
    const items = await this.inputItems(s);
    const hooked = [...this.hooks.pending.values()].some((p) => p.sessionId === s.id);
    for (const item of items) {
      // A Claude hook item already has its own card; the dialog it mirrors needs no second one.
      if (hooked && item.generic) continue;
      if (this.store.posted(inputKey(binding, s, item))) continue;
      await this.postInput(binding, s, item);
    }
    // A dialog that closed anywhere — terminal, reader, another chat — is
    // resolved here too, so nobody presses a button for a question that is gone.
    const live = new Set(items.map((i) => i.key));
    for (const [k, p] of this.store.allPosted()) {
      if (p.bindingId !== binding.id || p.sessionId !== s.id || p.kind !== 'input' || p.status !== 'open') continue;
      if (!live.has(p.key) && !this.hooks.pending.has(p.key)) await this.closeCard(k, p, s, 'Answered or dismissed outside this chat.');
    }
  }

  // Posts the card for an open dialog and records it; returns [storeKey, record].
  async postInput(binding, s, item) {
    const ref = await this.post(binding, this.inputCardFor(binding, s, item));
    const k = inputKey(binding, s, item);
    const posted = {
      bindingId: binding.id, sessionId: s.id, key: item.key, kind: 'input', status: 'open',
      adapter: binding.adapter, ref, item, partial: {},
    };
    this.store.putPosted(k, posted);
    this.log({ event: 'posted', binding: binding.id, session: s.id, kind: 'input', key: item.key });
    return [k, posted];
  }

  async refreshCard(p, s, partial) {
    const binding = this.store.binding(p.bindingId);
    await this.adapters.get(p.adapter)?.update(p.ref, this.inputCardFor(binding, s, p.item, { partial }));
  }

  async closeCard(k, p, s, text) {
    const binding = this.store.binding(p.bindingId);
    // A closed card is never answered again: its tool input need not stay on disk.
    const closed = { ...p, status: 'closed', closedText: text };
    if (p.item) {
      const { details, toolInput, ...kept } = p.item;
      closed.item = kept;
    }
    this.store.putPosted(k, closed);
    if (!binding || !p.ref) return;
    try {
      await this.adapters.get(p.adapter)?.update(p.ref, this.inputCardFor(binding, s, p.item, { partial: p.partial, resolved: { text } }));
    } catch (e) {
      this.log({ event: 'update-failed', key: p.key, binding: p.bindingId, session: p.sessionId, adapter: p.adapter, error: e.message });
    }
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
    // Already shown to the operator in the web UI: nothing to announce.
    if (d.read) {
      this.store.putSeen(k, id);
      this.log({ event: 'skipped-read', binding: binding.id, session: s.id, kind: 'finished' });
      return;
    }
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
        await this.threads.noteReach(binding.adapter, binding.target.channel, sessions);
        for (const s of this.sessionsFor(binding, sessions)) {
          const e = await this.checkSession(binding, s);
          if (e) failure = e;
        }
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
      this.log({ event: e.event || 'tick-failed', binding: binding.id, session: s.id, error: e.message });
      return e;
    }
  }

  // A binding that fails keeps being skipped for 5 s, doubling to 5 min, so a
  // dead channel costs neither a request every tick nor a log line every tick.
  noteOutcome(binding, failure) {
    if (!failure) { this.failing.delete(binding.id); return; }
    const count = (this.failing.get(binding.id)?.count || 0) + 1;
    const wait = Math.min(BACKOFF_MAX_MS, BACKOFF_MIN_MS * 2 ** (count - 1));
    this.failing.set(binding.id, { count, error: publicError(failure), retryAt: this.now() + wait });
  }

  /** What Settings shows for a binding whose posts or lookups are failing, else null. */
  lastError(bindingId) { return this.failing.get(bindingId)?.error ?? null; }

  /** Delivers the waiting chat prompts (outbox.js); tests call it directly. */
  drain() { return this.outbox.drain(); }

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
    // The lock reaches the outbox only through the host. The callback gives just the new state, which the
    // outbox compares with its own record of the last one; a real lock already in place counts as landing.
    this.unwatchLock = this.host.onLock((st) => this.outbox.noteLock(st));
    this.outbox.noteLock(this.host.lockState());
    this.timer = setInterval(() => {
      this.tick().catch((e) => this.log({ event: 'tick-failed', error: e.message }));
      this.drain().catch((e) => this.log({ event: 'drain-failed', error: e.message }));
    }, this.tickMs);
    this.timer.unref?.();
  }

  async stop() {
    clearInterval(this.timer);
    this.unwatchLock?.();
    this.timer = null;
    this.hooks.settleAll('Agent Manager is stopping — answer in the terminal.');
    for (const a of this.adapters.values()) await a.stop?.();
  }
}
