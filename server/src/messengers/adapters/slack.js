import { WebSocket } from 'ws';
import { fromMrkdwn, historyReply, messageReply, escapeMrkdwn } from './slack-events.js';
import { compareSlackTs } from '../delivery-state.js';

export { fromMrkdwn };

// Slack over Socket Mode: the server dials out to Slack, so this works behind
// NAT, on a VPS without a public URL, and in a private Space — none of which
// can receive Slack's HTTP callbacks. Posting uses the Web API.
//
// Needs a bot token (xoxb-…) and an app-level token (xapp-…, connections:write),
// read from SLACK_BOT_TOKEN and SLACK_APP_TOKEN in config.js.
// docs/messengers.md has the app manifest with the exact scopes and events.

const API = 'https://slack.com/api';
const BACKOFF_MAX_MS = 60_000;
// A socket can die without a close event (NAT, sleep). We ping, and any frame,
// ping or pong proves it alive; two minutes of nothing means it is not.
const PING_EVERY_MS = 30_000;
const SILENT_AFTER_MS = 120_000;

const RATE_LIMIT_RETRIES = 2;
const RETRY_AFTER_MAX_MS = 60_000;
const retryAfterMs = (res) => {
  const raw = res.headers?.get?.('retry-after');
  const seconds = raw == null || raw === '' ? NaN : Number(raw);
  return Math.min(RETRY_AFTER_MAX_MS, Math.max(0, Number.isFinite(seconds) ? seconds : 1) * 1000);
};

// Slack reads the parameters of its read methods from form fields, not from a JSON body.
const FORM_METHODS = new Set(['conversations.history', 'conversations.replies']);
const HISTORY_PAGES = 5;
const HISTORY_PAGE_SIZE = 200;
const REFRESH = 'refresh requested'; // Slack's hourly `disconnect` frame; any other reconnect reason is a real one

// Slack's mrkdwn is not Markdown: bold is *x*, links are <url|text>, and
// &, < and > must be escaped. Good enough for agent replies; code survives.
export function toMrkdwn(md) {
  return escapeMrkdwn(String(md || ''))
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<$2|$1>');
}

// Slack reads <...> as links and mentions, so details are escaped to show as
// written. Escaping can grow text fivefold, past one block's limit: it is split
// across blocks between characters, never truncated or dropped, because an
// approval needs the whole request on screen (cards.js `reviewable`).
function detailBlocks(details, max = 2900) {
  const parts = [];
  let part = '';
  for (const ch of details.replace(/```/g, "'''")) {
    const e = escapeMrkdwn(ch);
    if (part.length + e.length > max) { parts.push(part); part = ''; }
    part += e;
  }
  if (part) parts.push(part);
  return parts.map((text) => ({ type: 'section', text: { type: 'mrkdwn', text: `\`\`\`${text}\`\`\`` } }));
}

export function renderBlocks(card) {
  const blocks = [];
  if (card.title) {
    const where = card.agent ? ` · ${card.agent.cli}${card.agent.group ? ` · ${card.agent.group}` : ''}` : '';
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${toMrkdwn(card.title)}*${where}` } });
  }
  if (card.body) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: toMrkdwn(card.body).slice(0, 2990) } });
  // Ready mrkdwn from the bridge (a quote with a mention); it has already escaped what it quotes.
  if (card.mrkdwn) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: card.mrkdwn.slice(0, 2990) } });
  if (card.details) blocks.push(...detailBlocks(card.details));
  if (card.resolved) {
    blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: `☑️ ${toMrkdwn(card.resolved.text)}` }] });
  } else if (card.options?.length) {
    blocks.push({
      type: 'actions',
      elements: card.options.slice(0, 25).map((o) => ({
        type: 'button', action_id: `am:${o.id}`, value: o.id,
        text: { type: 'plain_text', text: o.label.slice(0, 75) },
        ...(o.style ? { style: o.style } : {}),
      })),
    });
  }
  const foot = [card.hint && !card.resolved ? toMrkdwn(card.hint) : null, card.link ? `<${card.link}|Open in Agent Manager>` : null].filter(Boolean);
  if (foot.length) blocks.push({ type: 'context', elements: [{ type: 'mrkdwn', text: foot.join('  ·  ') }] });
  return blocks;
}

const fallbackText = (card) => [card.title, card.body, card.mrkdwn].filter(Boolean).join('\n').slice(0, 3000) || 'Agent Manager';

// Slack's Socket Mode envelope types that carry something for us.
function interactiveReply(p) {
  const action = p.actions?.[0];
  if (p.type !== 'block_actions' || !action?.action_id?.startsWith('am:')) return null;
  return {
    channel: p.channel?.id || p.container?.channel_id,
    ts: p.message?.ts || p.container?.message_ts,
    thread: null,
    user: { id: p.user?.id, name: p.user?.username || p.user?.name },
    messageId: `${p.trigger_id || ''}:${action.action_ts || ''}`,
    optionId: action.value,
  };
}

export class SlackAdapter {
  constructor({ botToken = '', appToken = '', fetchImpl = globalThis.fetch, WebSocketImpl = WebSocket, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    Object.assign(this, { botToken, appToken, fetchImpl, WebSocketImpl, setTimer, clearTimer });
    this.watch = { silent: null, ping: null };
    this.socket = null;
    this.running = false;
    this.generation = 0; // bumped by stop(), so a connect() begun before it cannot open a socket after
    this.attempt = 0;
    this.hooks = null;
    this.botUser = null;
    this.refreshing = false; // the socket now being dialled replaces one Slack asked us to drop
    this.greeted = new WeakSet(); // sockets that already said hello
  }

  configured() { return !!(this.botToken && this.appToken); }

  // A 429 carries Retry-After in seconds. The call waits that long (at most a minute) and tries again,
  // twice at most; then the 429 is the error, like any other Slack answer.
  async call(method, body, token = this.botToken) {
    for (let retry = 0; ; retry++) {
      const form = FORM_METHODS.has(method);
      const res = await this.fetchImpl(`${API}/${method}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${token}`, 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json; charset=utf-8' },
        body: form ? new URLSearchParams(body || {}).toString() : JSON.stringify(body || {}),
      });
      if (res.status === 429 && retry < RATE_LIMIT_RETRIES) {
        await new Promise((resolve) => this.setTimer(resolve, retryAfterMs(res)));
        continue;
      }
      let json;
      try { json = await res.json(); } catch (e) {
        const message = `slack ${method}: bad response (HTTP ${res.status})`;
        throw Object.assign(new Error(message), { publicMessage: message });
      }
      if (!json.ok) {
        // Slack's error code is safe to show in Settings (bridge lastError); a network error is not marked.
        const message = `slack ${method}: ${String(json.error || `HTTP ${res.status}`).slice(0, 80)}`;
        throw Object.assign(new Error(message), { publicMessage: message });
      }
      return json;
    }
  }

  setStatus(connected, error = null) { this.hooks?.onStatus({ connected, error }); }

  reconnectLater(reason) {
    if (!this.running) return;
    this.refreshing = reason === REFRESH;
    this.setStatus(false, reason);
    const delay = Math.min(BACKOFF_MAX_MS, 1000 * 2 ** Math.min(this.attempt++, 6));
    // A stop() since makes this retry stale, even if start() ran again after it.
    const generation = this.generation;
    this.setTimer(() => {
      if (generation === this.generation) this.connect().catch((e) => this.reconnectLater(e.message));
    }, delay);
  }

  async connect() {
    const generation = this.generation;
    const live = () => this.running && generation === this.generation;
    if (!live()) return;
    if (!this.botUser) this.botUser = (await this.call('auth.test', {})).user_id;
    if (!live()) return;
    const { url } = await this.call('apps.connections.open', {}, this.appToken);
    if (!live()) return;
    const ws = new this.WebSocketImpl(url);
    this.socket = ws;
    this.heard(ws);
    this.schedulePing(ws);
    for (const e of ['ping', 'pong']) ws.on(e, () => this.heard(ws));
    ws.on('message', (raw) => { this.heard(ws); this.onFrame(ws, raw).catch((e) => this.hooks.log({ event: 'frame-failed', error: e.message })); });
    ws.on('close', () => { if (this.socket === ws) { this.unwatch(); this.reconnectLater('socket closed'); } });
    ws.on('error', (e) => this.hooks.log({ event: 'socket-error', error: e.message }));
  }

  timer(fn, ms) {
    const t = this.setTimer(fn, ms);
    t?.unref?.();
    return t;
  }

  unwatch() {
    this.clearTimer(this.watch.silent);
    this.clearTimer(this.watch.ping);
  }

  // Anything from the current socket restarts the silence clock; a replaced one is ignored.
  heard(ws) {
    if (this.socket !== ws) return;
    this.clearTimer(this.watch.silent);
    this.watch.silent = this.timer(() => {
      if (this.socket !== ws) return;
      this.hooks.log({ event: 'socket-silent' });
      this.dropSocket(ws, ws.terminate || ws.close, 'no frames for 2 minutes');
    }, SILENT_AFTER_MS);
  }

  // Forgets the current socket, closes it, and dials a new one.
  dropSocket(ws, close, reason) {
    this.socket = null;
    this.unwatch();
    close.call(ws);
    this.reconnectLater(reason);
  }

  schedulePing(ws) {
    this.watch.ping = this.timer(() => {
      if (this.socket !== ws) return;
      try { ws.ping(); } catch (e) { this.hooks.log({ event: 'ping-failed', error: e.message }); }
      this.schedulePing(ws);
    }, PING_EVERY_MS);
  }

  // Once per socket, and not for Slack's hourly refresh: messages sent while we were away may be missing.
  greet(ws) {
    if (this.greeted.has(ws)) return;
    this.greeted.add(ws);
    if (this.refreshing) { this.refreshing = false; return; }
    Promise.resolve().then(() => this.hooks.onConnect?.()).catch((e) => this.hooks.log({ event: 'connect-hook-failed', error: e.message }));
  }

  async onFrame(ws, raw) {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { this.hooks.log({ event: 'bad-frame' }); return; }
    if (msg.type === 'hello') { this.attempt = 0; this.setStatus(true); this.greet(ws); return; }
    if (msg.type === 'disconnect') {
      if (this.socket !== ws) return; // already replaced
      this.dropSocket(ws, ws.close, REFRESH);
      return;
    }
    if (!msg.envelope_id) return;
    const p = msg.payload || {};
    // Slack redelivers anything not acknowledged within 3 s, so a button press is acked first. A slash
    // command's ack carries its reply, and a message is acked after it is persisted (below).
    if (msg.type === 'slash_commands') {
      let text;
      try { text = await this.hooks.onCommand({ channel: p.channel_id, user: { id: p.user_id, name: p.user_name }, text: p.text || '' }); } catch (e) {
        // Unacked, Slack shows the user a timeout; the error may carry paths, so chat gets a generic line.
        this.hooks.log({ event: 'command-failed', error: e.message });
        text = 'Something went wrong — see the Agent Manager server log.';
      }
      ws.send(JSON.stringify({ envelope_id: msg.envelope_id, payload: { response_type: 'ephemeral', text: toMrkdwn(text) } }));
      return;
    }
    const ack = () => ws.send(JSON.stringify({ envelope_id: msg.envelope_id }));
    if (msg.type === 'events_api') {
      const reply = messageReply(p, this.botUser);
      // A message is acked once its row is durable; a failed write leaves it unacked, so Slack redelivers.
      if (reply) {
        try { await this.hooks.onReply(reply); } catch (e) {
          this.hooks.log({ event: 'persist-failed', error: e.message });
          return;
        }
      }
      ack();
      return;
    }
    ack();
    const reply = msg.type === 'interactive' ? interactiveReply(p) : null;
    if (reply) await this.hooks.onReply(reply);
  }

  start(hooks) {
    if (this.running) return;
    this.running = true;
    this.hooks = hooks;
    this.connect().catch((e) => this.reconnectLater(e.message));
  }

  async stop() {
    this.running = false;
    this.generation += 1;
    this.unwatch();
    const ws = this.socket;
    this.socket = null;
    ws?.close();
  }

  async post(target, card) {
    const res = await this.call('chat.postMessage', {
      channel: target.channel, ...(target.thread ? { thread_ts: target.thread } : {}),
      text: fallbackText(card), blocks: renderBlocks(card), unfurl_links: false,
    });
    return { channel: res.channel, ts: res.ts };
  }

  async update(ref, card) {
    await this.call('chat.update', { channel: ref.channel, ts: ref.ts, text: fallbackText(card), blocks: renderBlocks(card) });
  }

  /**
   * Messages after `oldest` (exclusive) in a channel, or in the thread `thread`, oldest first, in the shape of a live
   * reply. At most 5 pages of 200. Bot messages and the bot's own are left out, as for a live event.
   */
  async history({ channel, thread, oldest }) {
    if (!this.botUser) this.botUser = (await this.call('auth.test', {})).user_id;
    const out = [];
    let cursor = '';
    for (let page = 0; page < HISTORY_PAGES; page++) {
      const res = await this.call(thread ? 'conversations.replies' : 'conversations.history', {
        channel, ...(thread ? { ts: thread } : {}), ...(oldest ? { oldest } : {}), limit: HISTORY_PAGE_SIZE, ...(cursor ? { cursor } : {}),
      });
      for (const m of res.messages || []) {
        const reply = historyReply(m, channel, thread, this.botUser);
        if (reply) out.push(reply);
      }
      cursor = res.response_metadata?.next_cursor || '';
      if (!cursor) break;
    }
    return out.sort((a, b) => compareSlackTs(a.ts, b.ts));
  }

  // Visible to one user only; the bot token's chat:write scope covers it.
  async postEphemeral({ channel, user, text }) {
    await this.call('chat.postEphemeral', { channel, user, text });
  }
}
