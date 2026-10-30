import { WebSocket } from 'ws';

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

// Slack's mrkdwn is not Markdown: bold is *x*, links are <url|text>, and
// &, < and > must be escaped. Good enough for agent replies; code survives.
export function toMrkdwn(md) {
  return String(md || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<$2|$1>');
}

// The inverse for inbound text: Slack wraps links and mentions in <…> and
// escapes &, < and >. The agent should read plain text.
export function fromMrkdwn(text) {
  return String(text || '')
    .replace(/<([@#!])([^>|]*)(?:\|([^>]*))?>/g, (_, kind, id, label) => (kind === '!' ? `@${label || id}` : `${kind}${label || id}`))
    .replace(/<([^>|]+)(?:\|[^>]*)?>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

const escapeMrkdwn = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Slack reads <...> as links and mentions, so details are escaped to show as
// written. Escaping can grow text fivefold, past one block's limit: it is split
// across blocks between characters, never cut or dropped.
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

const fallbackText = (card) => [card.title, card.body].filter(Boolean).join('\n').slice(0, 3000) || 'Agent Manager';

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

function messageReply(p, botUser) {
  const e = p.event || {};
  if (e.type !== 'message' || e.subtype || e.bot_id || e.user === botUser || !e.user) return null;
  return {
    channel: e.channel, ts: e.ts, thread: e.thread_ts && e.thread_ts !== e.ts ? e.thread_ts : null,
    user: { id: e.user }, messageId: p.event_id || `${e.channel}:${e.ts}`, text: fromMrkdwn(e.text),
  };
}

export class SlackAdapter {
  constructor({ botToken = '', appToken = '', fetchImpl = globalThis.fetch, WebSocketImpl = WebSocket, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
    Object.assign(this, { botToken, appToken, fetchImpl, WebSocketImpl, setTimer, clearTimer });
    this.watch = { silent: null, ping: null };
    this.socket = null;
    this.stopped = false;
    this.running = false;
    this.generation = 0; // bumped by stop(), so a connect() begun before it cannot open a socket after
    this.attempt = 0;
    this.hooks = null;
    this.botUser = null;
  }

  configured() { return !!(this.botToken && this.appToken); }

  async call(method, body, token = this.botToken) {
    const res = await this.fetchImpl(`${API}/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body || {}),
    });
    const json = await res.json().catch(() => ({}));
    if (!json.ok) throw new Error(`slack ${method}: ${json.error || `HTTP ${res.status}`}`);
    return json;
  }

  setStatus(connected, error = null) { this.hooks?.onStatus({ connected, error }); }

  reconnectLater(reason) {
    if (this.stopped) return;
    this.setStatus(false, reason);
    const delay = Math.min(BACKOFF_MAX_MS, 1000 * 2 ** Math.min(this.attempt++, 6));
    this.setTimer(() => { this.connect().catch((e) => this.reconnectLater(e.message)); }, delay);
  }

  async connect() {
    const generation = this.generation;
    const live = () => !this.stopped && generation === this.generation;
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

  // Anything from the socket restarts the silence clock.
  heard(ws) {
    this.clearTimer(this.watch.silent);
    this.watch.silent = this.timer(() => {
      if (this.socket !== ws) return;
      this.hooks.log({ event: 'socket-silent' });
      this.socket = null;
      this.unwatch();
      (ws.terminate || ws.close).call(ws);
      this.reconnectLater('no frames for 2 minutes');
    }, SILENT_AFTER_MS);
  }

  schedulePing(ws) {
    this.watch.ping = this.timer(() => {
      if (this.socket !== ws) return;
      try { ws.ping(); } catch (e) { this.hooks.log({ event: 'ping-failed', error: e.message }); }
      this.schedulePing(ws);
    }, PING_EVERY_MS);
  }

  async onFrame(ws, raw) {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { this.hooks.log({ event: 'bad-frame' }); return; }
    if (msg.type === 'hello') { this.attempt = 0; this.setStatus(true); return; }
    if (msg.type === 'disconnect') { this.socket = null; this.unwatch(); ws.close(); this.reconnectLater('refresh requested'); return; }
    if (!msg.envelope_id) return;
    const p = msg.payload || {};
    // Slack redelivers anything not acknowledged within 3 s, so ack first —
    // except slash commands, whose ack carries the reply.
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
    ws.send(JSON.stringify({ envelope_id: msg.envelope_id }));
    let reply = null;
    if (msg.type === 'interactive') reply = interactiveReply(p);
    else if (msg.type === 'events_api') reply = messageReply(p, this.botUser);
    if (reply) await this.hooks.onReply(reply);
  }

  start(hooks) {
    if (this.running) return;
    this.running = true;
    this.hooks = hooks;
    this.stopped = false;
    this.connect().catch((e) => this.reconnectLater(e.message));
  }

  async stop() {
    this.stopped = true;
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
}
