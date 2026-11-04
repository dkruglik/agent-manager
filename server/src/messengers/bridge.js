import path from 'node:path';
import { inputCard, noticeCard } from './cards.js';
import { ReplyRouter } from './replies.js';
import { HookDecisions } from './hook-decisions.js';
import { createThreads } from './threads.js';
import { createOutbox } from './outbox.js';
import { backfill } from './backfill.js';
import { checkFinished } from './finished.js';
import { createFilter, migrateSeen, postsFinished, transcriptTick } from './outbound.js';

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
    settleMs = 8000, filter = createFilter(), digestEveryMs = 5000, tickMs = 2000, lookForMs = 60_000,
    decisionTimeoutMs = 120_000, setTimer = setTimeout, clearTimer = clearTimeout,
  }) {
    Object.assign(this, { filter, host, store, adapters, now, log, settleMs, digestEveryMs, tickMs, lookForMs, decisionTimeoutMs, setTimer, clearTimer });
    this.hooks = new HookDecisions(this);
    this.waitingSince = new Map(); // sessionId → when it settled into waiting
    this.digestAt = new Map();     // `${bindingId}|${sessionId}` → last transcript read
    this.statuses = new Map();     // adapterId → {connected, error}
    this.failing = new Map();      // bindingId → {count, error, retryAt} while its posts keep failing
    this.timer = null;
    this.stopped = false; // set by stop(): a backfill still running then writes no row
    this.ticking = false;
    const scope = (binding, sessions) => this.sessionsFor(binding, sessions);
    this.threads = createThreads({
      host, store, adapters, log, now, scope,
      outbox: (a, c, ts) => this.outbox.waiting(a, c, ts),
      rows: { sessionsIn: (a, c) => this.outbox.sessionsIn(a, c), dropSessions: (a, c, ids) => this.outbox.dropSessions(a, c, ids) },
    });
    // The old `seen` marks become outbound records before the first tick (outbound.js migrateSeen).
    migrateSeen(store);
    this.outbound = { host, store, adapters, threads: this.threads, filter, settled: (s) => this.settled(s, { bounded: false }), log, now: () => this.now() };
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
    const shown = item.details ? { ...item, details: this.filter(item.details) } : item;
    return inputCard({ agent: this.agent(s), link: this.host.link(s), item: shown, approvals: binding.approvals, ...extra });
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

  // True once a session has sat in `waiting` for the settle window. The finished card also stops at the
  // end of the look window (`bounded`): a reply lands in the transcript within moments of the turn ending,
  // and an idle agent should not cost a read every few seconds. The transcript mirror is unbounded, so
  // what was written during a lock, an outage or a backoff still goes out after it; its revision check
  // is a stat, which keeps an idle session cheap.
  settled(s, { bounded = true } = {}) {
    if (s.state !== 'waiting' || s.inputRequired) { this.waitingSince.delete(s.id); return false; }
    if (!this.waitingSince.has(s.id)) this.waitingSince.set(s.id, this.now());
    const settledFor = this.now() - this.waitingSince.get(s.id);
    return settledFor >= this.settleMs && (!bounded || settledFor <= this.settleMs + this.lookForMs);
  }

  async tick() {
    if (this.ticking) return;
    const lock = this.host.lockState();
    // A real lock holds every post. `checking` is not one for the transcript; cards still wait.
    if (lock.locked && lock.reason !== 'checking') return;
    this.ticking = true;
    try {
      const sessions = this.host.sessions();
      for (const binding of this.store.bindings()) {
        if (!this.statuses.get(binding.adapter)?.connected) continue;
        if (this.now() < (this.failing.get(binding.id)?.retryAt || 0)) continue;
        let failure = null;
        await this.threads.noteReach(binding.adapter, binding.target.channel, sessions);
        for (const s of this.sessionsFor(binding, sessions)) {
          const e = await this.checkSession(binding, s, { cards: !lock.locked });
          if (e) failure = e;
        }
        this.noteOutcome(binding, failure);
      }
    } finally { this.ticking = false; }
  }

  // Returns the error when the check failed, so the binding can be backed off.
  async checkSession(binding, s, { cards = true } = {}) {
    try {
      if (cards && binding.events.includes('input-required')) await this.checkInput(binding, s);
      if (cards && postsFinished(binding)) await checkFinished(this, binding, s);
      await transcriptTick(this.outbound, binding, s);
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
    // A rate-limited adapter names the wait (slack.js `retryAfter`, seconds); otherwise the backoff doubles.
    const asked = Number.isFinite(failure.retryAfter) ? failure.retryAfter * 1000 : 0;
    const wait = Math.min(BACKOFF_MAX_MS, Math.max(asked, BACKOFF_MIN_MS * 2 ** (count - 1)));
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

  // History after a socket connect (not Slack's hourly refresh), sent through the path of a live event.
  backfill(id, adapter) {
    const accept = async (adapterId, r) => (this.stopped ? { ignored: 'stopped' } : this.handleReply(adapterId, r));
    return backfill({ adapterId: id, adapter, store: this.store, now: this.now, accept, log: (e) => this.log({ adapter: id, ...e }) })
      .catch((e) => this.log({ adapter: id, event: 'backfill-failed', error: e.message, acceptFailed: !!e.acceptFailed }));
  }

  start() {
    if (this.timer) return;
    this.stopped = false;
    // messengers.json and the outbox index were loaded when the bridge was built, before any socket connects.
    // The lock reaches the outbox only through the host. The callback gives just the new state, which the
    // outbox compares with its own record of the last one; a real lock already in place counts as landing.
    this.unwatchLock = this.host.onLock((st) => this.outbox.noteLock(st));
    this.outbox.noteLock(this.host.lockState());
    for (const [id, a] of this.adapters) {
      this.statuses.set(id, { connected: false, error: a.configured() ? null : 'not configured' });
      if (!a.configured()) continue;
      a.start({
        onReply: (r) => this.handleReply(id, r),
        onCommand: (c) => this.handleCommand(id, c),
        onStatus: (st) => this.statuses.set(id, st),
        onConnect: () => this.backfill(id, a),
        log: (e) => this.log({ adapter: id, ...e }),
      });
    }
    this.timer = setInterval(() => {
      this.tick().catch((e) => this.log({ event: 'tick-failed', error: e.message }));
      this.drain().catch((e) => this.log({ event: 'drain-failed', error: e.message }));
    }, this.tickMs);
    this.timer.unref?.();
  }

  async stop() {
    this.stopped = true;
    clearInterval(this.timer);
    this.unwatchLock?.();
    this.timer = null;
    this.hooks.settleAll('Agent Manager is stopping — answer in the terminal.');
    for (const a of this.adapters.values()) await a.stop?.();
  }
}
