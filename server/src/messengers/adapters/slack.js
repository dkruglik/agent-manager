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

// Slack's mrkdwn is not Markdown: bold is *x*, links are <url|text>, and
// &, < and > must be escaped. Good enough for agent replies; code survives.
export function toMrkdwn(md) {
  return String(md || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/\*\*(.+?)\*\*/g, '*$1*')
    .replace(/^#{1,6}\s+(.+)$/gm, '*$1*')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<$2|$1>');
}

export function renderBlocks(card) {
  const blocks = [];
  if (card.title) {
    const where = card.agent ? ` · ${card.agent.cli}${card.agent.group ? ` · ${card.agent.group}` : ''}` : '';
    blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `*${toMrkdwn(card.title)}*${where}` } });
  }
  if (card.body) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: toMrkdwn(card.body).slice(0, 2990) } });
  if (card.details) blocks.push({ type: 'section', text: { type: 'mrkdwn', text: `\`\`\`${card.details.replace(/```/g, "'''").slice(0, 2900)}\`\`\`` } });
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

export function createSlackAdapter({ botToken = '', appToken = '', fetchImpl = globalThis.fetch, WebSocketImpl = WebSocket, setTimer = setTimeout } = {}) {
  let socket = null;
  let stopped = false;
  let attempt = 0;
  let hooks = null;
  let botUser = null;

  async function call(method, body, token = botToken) {
    const res = await fetchImpl(`${API}/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body || {}),
    });
    const json = await res.json().catch(() => ({}));
    if (!json.ok) throw new Error(`slack ${method}: ${json.error || `HTTP ${res.status}`}`);
    return json;
  }

  function setStatus(connected, error = null) { hooks?.onStatus({ connected, error }); }

  function reconnectLater(reason) {
    if (stopped) return;
    setStatus(false, reason);
    const delay = Math.min(BACKOFF_MAX_MS, 1000 * 2 ** Math.min(attempt++, 6));
    setTimer(() => { connect().catch((e) => reconnectLater(e.message)); }, delay);
  }

  async function connect() {
    if (stopped) return;
    if (!botUser) botUser = (await call('auth.test', {})).user_id;
    const { url } = await call('apps.connections.open', {}, appToken);
    const ws = new WebSocketImpl(url);
    socket = ws;
    ws.on('message', (raw) => { onFrame(ws, raw).catch((e) => hooks.log({ event: 'frame-failed', error: e.message })); });
    ws.on('close', () => { if (socket === ws) reconnectLater('socket closed'); });
    ws.on('error', (e) => hooks.log({ event: 'socket-error', error: e.message }));
  }

  async function onFrame(ws, raw) {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch { return; }
    if (msg.type === 'hello') { attempt = 0; setStatus(true); return; }
    if (msg.type === 'disconnect') { socket = null; ws.close(); reconnectLater('refresh requested'); return; }
    if (!msg.envelope_id) return;
    const p = msg.payload || {};
    // Slack redelivers anything not acknowledged within 3 s, so ack first —
    // except slash commands, whose ack carries the reply.
    if (msg.type === 'slash_commands') {
      const text = await hooks.onCommand({ channel: p.channel_id, user: { id: p.user_id, name: p.user_name }, text: p.text || '' });
      ws.send(JSON.stringify({ envelope_id: msg.envelope_id, payload: { response_type: 'ephemeral', text: toMrkdwn(text) } }));
      return;
    }
    ws.send(JSON.stringify({ envelope_id: msg.envelope_id }));
    if (msg.type === 'interactive' && p.type === 'block_actions') {
      const action = p.actions?.[0];
      if (!action?.action_id?.startsWith('am:')) return;
      await hooks.onReply({
        channel: p.channel?.id || p.container?.channel_id,
        ts: p.message?.ts || p.container?.message_ts,
        thread: null,
        user: { id: p.user?.id, name: p.user?.username || p.user?.name },
        messageId: `${p.trigger_id || ''}:${action.action_ts || ''}`,
        optionId: action.value,
      });
    } else if (msg.type === 'events_api') {
      const e = p.event || {};
      if (e.type !== 'message' || e.subtype || e.bot_id || e.user === botUser || !e.user) return;
      await hooks.onReply({
        channel: e.channel, ts: e.ts, thread: e.thread_ts && e.thread_ts !== e.ts ? e.thread_ts : null,
        user: { id: e.user }, messageId: p.event_id || `${e.channel}:${e.ts}`, text: e.text || '',
      });
    }
  }

  return {
    id: 'slack',
    capabilities: { buttons: true, threads: true, edit: true },
    configured: () => !!(botToken && appToken),
    start(h) {
      hooks = h;
      stopped = false;
      connect().catch((e) => reconnectLater(e.message));
    },
    async stop() { stopped = true; const ws = socket; socket = null; ws?.close(); },
    async post(target, card) {
      const res = await call('chat.postMessage', {
        channel: target.channel, ...(target.thread ? { thread_ts: target.thread } : {}),
        text: fallbackText(card), blocks: renderBlocks(card), unfurl_links: false,
      });
      return { channel: res.channel, ts: res.ts };
    },
    async update(ref, card) {
      await call('chat.update', { channel: ref.channel, ts: ref.ts, text: fallbackText(card), blocks: renderBlocks(card) });
    },
  };
}
