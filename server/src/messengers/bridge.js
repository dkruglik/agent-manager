import crypto from 'node:crypto';

// The bridge between Agent Manager sessions and chat messengers.
//
// Outbound, it watches the sessions each binding covers and posts a card when
// one needs input or has finished a turn. Inbound, it turns a button press or a
// reply into a typed answer or an ordinary prompt. It never types keystrokes
// into a TUI dialog (see docs/tui-input-required.md): a dialog without a typed
// answer path gets a card that links to the terminal instead of buttons.
//
// Everything about Agent Manager comes through `host`, and everything about a
// chat service through an adapter, so this file knows neither. See
// docs/messengers.md for both contracts.

const FINISHED_MAX = 2800;
const DETAILS_MAX = 1800;
const SEEN_MESSAGES = 500;

const clip = (s, n) => {
  const t = String(s || '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 16);

export function createBridge({
  host, store, adapters, now = () => Date.now(), log = () => {},
  settleMs = 8000, digestEveryMs = 5000, tickMs = 2000, lookForMs = 60_000,
}) {
  const waitingSince = new Map(); // sessionId → ms the session became settled-waiting
  const digestAt = new Map();     // sessionId → last digest read
  const handled = [];             // recent inbound message ids (redelivery guard)
  const status = new Map();       // adapterId → {connected, error}
  let timer = null;
  let ticking = false;

  const adapter = (id) => adapters.get(id) || null;
  const connected = (id) => !!status.get(id)?.connected;

  function sessionsFor(binding, sessions) {
    if (binding.scope.type === 'session') return sessions.filter((s) => s.id === binding.scope.id);
    return sessions.filter((s) => host.groupOf(s.id)?.id === binding.scope.id);
  }

  const cardAgent = (s) => ({ id: s.id, name: s.name, cli: s.cli, group: host.groupOf(s.id)?.name || null });

  function inputCard(binding, s, item, extra = {}) {
    const options = [];
    let hint = null;
    const questions = item.questions || [];
    if (questions.length) {
      const answered = extra.partial || {};
      questions.forEach((q, qi) => {
        if (answered[q.id] !== undefined || q.secret) return;
        (q.options || []).forEach((o, oi) => options.push({ id: `q:${qi}:${oi}`, label: clip(o.label ?? o, 70) }));
      });
      hint = questions.some((q) => q.secret)
        ? 'A question asks for a secret — answer it in the terminal.'
        : 'Pick an option, or reply in this thread to answer in your own words.';
    } else if (item.choices?.length) {
      if (binding.approvals) {
        for (const c of item.choices) {
          options.push({ id: `d:${c.value}`, label: c.label, style: c.value === 'accept' ? 'primary' : 'danger' });
        }
      } else {
        hint = 'Approvals from chat are off for this binding — answer in the terminal.';
      }
    } else {
      hint = 'This dialog cannot be answered from chat yet — open the terminal.';
    }
    const body = questions.length
      ? questions.map((q, i) => `${questions.length > 1 ? `${i + 1}. ` : ''}${q.text}${extra.partial?.[q.id] !== undefined ? `  → ${extra.partial[q.id]}` : ''}`).join('\n')
      : `${s.name} is waiting for ${item.kind === 'permission' ? 'a permission decision' : item.kind === 'question' ? 'an answer' : 'confirmation'}.`;
    return {
      kind: 'input',
      title: `${item.kind === 'permission' ? '🔐' : '❓'} ${s.name} needs input`,
      agent: cardAgent(s),
      body,
      details: item.details ? clip(item.details, DETAILS_MAX) : null,
      options,
      hint,
      link: host.link(s),
      resolved: extra.resolved || null,
    };
  }

  function finishedCard(s, text) {
    return {
      kind: 'finished',
      title: `✅ ${s.name} finished`,
      agent: cardAgent(s),
      body: clip(text, FINISHED_MAX),
      details: null,
      options: [],
      hint: 'Reply in this thread to send the agent a follow-up.',
      link: host.link(s),
      resolved: null,
    };
  }

  // What needs input right now. Shared Codex exposes typed requests; every
  // other CLI exposes only the fact (and kind) of a dialog.
  async function inputItems(s) {
    if (!s.inputRequired) return [];
    let typed = [];
    try { typed = await host.requests(s); } catch { typed = []; }
    if (typed.length) return typed;
    const ir = s.inputRequired;
    return [{ key: `ir:${ir.cli}:${ir.detectedAt}`, kind: ir.kind, generic: true }];
  }

  async function post(binding, card, thread = null) {
    const a = adapter(binding.adapter);
    return a.post({ channel: binding.target.channel, thread }, card);
  }

  async function checkInput(binding, s) {
    const items = await inputItems(s);
    const live = new Set(items.map((i) => i.key));
    for (const item of items) {
      const k = `${binding.id}|${s.id}|${item.key}`;
      if (store.posted(k)) continue;
      const ref = await post(binding, inputCard(binding, s, item));
      store.putPosted(k, {
        bindingId: binding.id, sessionId: s.id, key: item.key, kind: 'input', status: 'open',
        adapter: binding.adapter, ref, item, partial: {},
      });
      log({ event: 'posted', binding: binding.id, session: s.id, kind: 'input', key: item.key });
    }
    // A dialog that closed anywhere — terminal, reader, another chat — is
    // resolved here too, so nobody presses a button for a question that is gone.
    for (const [k, p] of store.allPosted()) {
      if (p.bindingId !== binding.id || p.sessionId !== s.id || p.kind !== 'input' || p.status !== 'open') continue;
      if (live.has(p.key)) continue;
      await closeCard(k, p, s, 'Answered or dismissed outside this chat.');
    }
  }

  async function closeCard(k, p, s, text) {
    const binding = store.binding(p.bindingId);
    store.putPosted(k, { ...p, status: 'closed', closedText: text });
    if (!binding || !p.ref) return;
    try {
      await adapter(p.adapter)?.update(p.ref, inputCard(binding, s, p.item, { partial: p.partial, resolved: { text } }));
    } catch (e) { log({ event: 'update-failed', key: p.key, error: e.message }); }
  }

  async function checkFinished(binding, s) {
    const k = `${binding.id}|${s.id}`;
    const baseline = store.seen(k) === null;
    const settled = s.state === 'waiting' && !s.inputRequired;
    if (!baseline) {
      if (!settled) { waitingSince.delete(s.id); return; }
      if (!waitingSince.has(s.id)) waitingSince.set(s.id, now());
      const settledFor = now() - waitingSince.get(s.id);
      // A reply lands in the transcript within moments of the turn ending.
      // Looking only briefly after each turn keeps an idle agent from costing
      // a transcript read every few seconds for as long as it sits there.
      if (settledFor < settleMs || settledFor > settleMs + lookForMs) return;
    }
    if (now() - (digestAt.get(`${k}`) || 0) < digestEveryMs) return;
    digestAt.set(k, now());
    let d = null;
    try { d = await host.digest(s); } catch { d = null; }
    const id = d?.id || '';
    // The first look at a session only records where its conversation stands:
    // binding a channel must not replay an answer the operator already read.
    if (baseline) { store.putSeen(k, id); return; }
    if (!id || id === store.seen(k) || !d.text) return;
    store.putSeen(k, id);
    if (!binding.events.includes('finished')) return;
    const ref = await post(binding, finishedCard(s, d.text));
    store.putPosted(`${k}|done:${id}`, {
      bindingId: binding.id, sessionId: s.id, key: `done:${id}`, kind: 'finished', status: 'closed', adapter: binding.adapter, ref,
    });
    log({ event: 'posted', binding: binding.id, session: s.id, kind: 'finished' });
  }

  async function tick() {
    if (ticking || host.locked()) return;
    ticking = true;
    try {
      const sessions = host.sessions();
      for (const binding of store.bindings()) {
        if (!connected(binding.adapter)) continue;
        for (const s of sessionsFor(binding, sessions)) {
          try {
            if (binding.events.includes('input-required')) await checkInput(binding, s);
            await checkFinished(binding, s);
          } catch (e) {
            log({ event: 'tick-failed', binding: binding.id, session: s.id, error: e.message });
          }
        }
      }
    } finally { ticking = false; }
  }

  // ---------- inbound ----------

  const allowed = (binding, user) => !!user?.id && binding.allowedUsers.includes(user.id);

  async function say(adapterId, channel, thread, text) {
    try { await adapter(adapterId)?.post({ channel, thread }, { kind: 'notice', body: text, options: [] }); } catch {}
  }

  function sessionByName(bindings, text) {
    // "name: text" or "@name text" addresses one agent in a group channel.
    const m = /^@?([^\s:]{1,80})[:\s]\s*([\s\S]+)$/.exec(text.trim());
    if (!m) return null;
    const wanted = m[1].toLowerCase();
    const sessions = host.sessions();
    for (const binding of bindings) {
      const s = sessionsFor(binding, sessions).find((x) => x.name.toLowerCase() === wanted);
      if (s) return { binding, session: s, text: m[2].trim() };
    }
    return null;
  }

  /**
   * One inbound event from an adapter:
   *   { channel, ts, thread, user:{id,name}, messageId, optionId?, text? }
   * `ts` is the message a button lives on; `thread` is the thread a reply is in.
   */
  async function handleReply(adapterId, r) {
    if (r.messageId) {
      if (handled.includes(r.messageId)) return { ignored: 'duplicate' };
      handled.push(r.messageId);
      if (handled.length > SEEN_MESSAGES) handled.shift();
    }
    const channelBindings = store.bindings().filter((b) => b.adapter === adapterId && b.target.channel === r.channel);
    if (!channelBindings.length) return { ignored: 'unbound-channel' };
    const anchor = r.optionId ? r.ts : r.thread;
    const found = anchor ? store.findPostedByRef(adapterId, r.channel, anchor) : null;

    let binding, session, text = r.text || '';
    if (found) {
      binding = store.binding(found[1].bindingId);
      session = host.sessions().find((s) => s.id === found[1].sessionId);
    } else if (!r.optionId && !r.thread) {
      const direct = channelBindings.filter((b) => b.scope.type === 'session');
      const named = sessionByName(channelBindings, text);
      if (named) ({ binding, session, text } = named);
      else if (direct.length === 1) {
        binding = direct[0];
        session = host.sessions().find((s) => s.id === binding.scope.id);
      }
    }
    if (!binding) return { ignored: 'no-target' };
    if (!allowed(binding, r.user)) {
      log({ event: 'refused', reason: 'user-not-allowed', binding: binding.id, user: r.user?.id });
      if (r.optionId) await say(adapterId, r.channel, r.ts, `<@${r.user?.id}> is not allowed to answer for this agent.`);
      return { refused: 'user-not-allowed' };
    }
    if (!session) {
      await say(adapterId, r.channel, r.thread || r.ts, 'That agent no longer exists.');
      return { refused: 'no-session' };
    }
    if (host.locked()) {
      await say(adapterId, r.channel, r.thread || r.ts, 'Agent Manager is locked; nothing was sent.');
      return { refused: 'locked' };
    }
    const reply = (t) => say(adapterId, r.channel, found ? found[1].ref.ts : (r.thread || r.ts), t);
    try {
      if (found && found[1].kind === 'input') return await answerInput(found, binding, session, r, text, reply);
      if (!text.trim()) return { ignored: 'empty' };
      await host.prompt(session, text.trim(), { requestId: `msg-${sha(`${adapterId}:${r.channel}:${r.messageId || r.ts}`)}`, user: r.user });
      log({ event: 'prompted', binding: binding.id, session: session.id, user: r.user.id });
      await reply(`➡️ Sent to *${session.name}*.`);
      return { prompted: session.id };
    } catch (e) {
      log({ event: 'reply-failed', binding: binding.id, session: session.id, error: e.message });
      await reply(`⚠️ ${e.message}`);
      return { error: e.message };
    }
  }

  async function answerInput([k, p], binding, session, r, text, reply) {
    if (p.status !== 'open') { await reply('This request is already closed.'); return { refused: 'closed' }; }
    const item = p.item;
    if (item.generic) {
      await reply('This dialog cannot be answered from chat yet — open the terminal.');
      return { refused: 'untyped' };
    }
    let response;
    const by = r.user.name || r.user.id;
    if (r.optionId?.startsWith('d:')) {
      if (!binding.approvals) { await reply('Approvals from chat are off for this binding.'); return { refused: 'approvals-off' }; }
      const decision = r.optionId.slice(2);
      if (!item.choices?.some((c) => c.value === decision)) return { refused: 'unknown-option' };
      response = { decision };
      p.answerText = `${item.choices.find((c) => c.value === decision).label} — by ${by}`;
    } else {
      const questions = item.questions || [];
      const partial = { ...(p.partial || {}) };
      if (r.optionId?.startsWith('q:')) {
        const [, qi, oi] = r.optionId.split(':').map(Number);
        const q = questions[qi];
        const o = q?.options?.[oi];
        if (!q || o === undefined || q.secret) return { refused: 'unknown-option' };
        partial[q.id] = String(o.label ?? o);
      } else {
        const q = questions.find((x) => partial[x.id] === undefined && !x.secret);
        if (!q || !text.trim()) { await reply('Nothing left to answer here from chat.'); return { refused: 'nothing-open' }; }
        partial[q.id] = text.trim();
      }
      if (questions.some((q) => partial[q.id] === undefined)) {
        store.putPosted(k, { ...p, partial });
        await adapter(p.adapter)?.update(p.ref, inputCard(binding, session, item, { partial }));
        return { partial: true };
      }
      response = { answers: partial };
      p.partial = partial;
      p.answerText = `Answered by ${by}`;
    }
    await host.answer(session, item.key, response);
    log({ event: 'answered', binding: binding.id, session: session.id, key: item.key, user: r.user.id });
    await closeCard(k, p, session, p.answerText);
    return { answered: item.key };
  }

  async function handleCommand(adapterId, { channel, user, text }) {
    const bindings = store.bindings().filter((b) => b.adapter === adapterId && b.target.channel === channel);
    if (!bindings.length) return 'This channel is not connected to Agent Manager.';
    if (!bindings.some((b) => allowed(b, user))) return 'You are not on the allowed-users list for this channel.';
    const sessions = host.sessions();
    const word = (text || '').trim().split(/\s+/)[0] || 'status';
    if (word !== 'status') return 'Commands: `status`. Reply in a card\'s thread to talk to that agent, or start a message with `agent-name:`.';
    const rows = [];
    for (const b of bindings) for (const s of sessionsFor(b, sessions)) {
      rows.push(`• *${s.name}* (${s.cli}) — ${s.inputRequired ? 'needs input' : s.state}`);
    }
    return rows.length ? rows.join('\n') : 'No agents in scope.';
  }

  return {
    tick,
    handleReply,
    handleCommand,
    status: () => Object.fromEntries([...adapters.keys()].map((id) => [id, status.get(id) || { connected: false, error: null }])),
    async testBinding(binding) {
      return post(binding, { kind: 'notice', title: '👋 Connected', body: `This channel now receives ${binding.events.join(' and ')} events from Agent Manager.`, options: [] });
    },
    start() {
      for (const [id, a] of adapters) {
        status.set(id, { connected: false, error: a.configured() ? null : 'not configured' });
        if (!a.configured()) continue;
        a.start({
          onReply: (r) => handleReply(id, r),
          onCommand: (c) => handleCommand(id, c),
          onStatus: (st) => status.set(id, st),
          log: (e) => log({ adapter: id, ...e }),
        });
      }
      timer = setInterval(() => { tick().catch((e) => log({ event: 'tick-failed', error: e.message })); }, tickMs);
      timer.unref?.();
    },
    async stop() {
      clearInterval(timer);
      for (const a of adapters.values()) await a.stop?.();
    },
  };
}
