// Slack message events and history entries, turned into the replies the bridge takes:
// `{ channel, ts, thread, user, messageId, text }`, plus `edit: { ts, editTs }` for an edit and
// `deleted: { ts }` for a delete. A live event and a history entry go through the same filter, so a
// bot message or the bot's own user never reaches the agent by either path.

export const FILE_NOTE = 'A file was attached in Slack and was not delivered.';

// The inverse for inbound text: Slack wraps links and mentions in <…> and
// escapes &, < and >. The agent should read plain text.
export function fromMrkdwn(text) {
  return String(text || '')
    .replace(/<([@#!])([^>|]*)(?:\|([^>]*))?>/g, (_, kind, id, label) => (kind === '!' ? `@${label || id}` : `${kind}${label || id}`))
    .replace(/<([^>|]+)(?:\|[^>]*)?>/g, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

const fromBot = (m, botUser) => !m || !!m.bot_id || m.user === botUser || !m.user;

// A person's text, with the file sentence when files came along (and as the whole text when there is none).
function bodyOf(m) {
  const text = fromMrkdwn(m.text).trim();
  if (!m.files?.length) return fromMrkdwn(m.text);
  return text ? `${text}\n\n${FILE_NOTE}` : FILE_NOTE;
}

// A plain message, or a file share; every other subtype is dropped.
function plain(m, channel, botUser, messageId) {
  if ((m.subtype && m.subtype !== 'file_share') || fromBot(m, botUser)) return null;
  const thread = m.thread_ts && m.thread_ts !== m.ts ? m.thread_ts : null;
  return { channel, ts: m.ts, thread, user: { id: m.user }, messageId: messageId || `${channel}:${m.ts}`, text: bodyOf(m) };
}

// The user and the new text are on the nested message. An event that changes no text (a link unfurl) is not an edit.
function changed(e, botUser, id) {
  const m = e.message;
  if (!m || m.subtype || fromBot(m, botUser)) return null;
  if (fromMrkdwn(m.text) === fromMrkdwn(e.previous_message?.text) && !m.files?.length) return null;
  const reply = plain(m, e.channel, botUser, id);
  return reply && { ...reply, edit: { ts: m.ts, editTs: m.edited?.ts || e.event_ts } };
}

function deleted(e, botUser, id) {
  const prev = e.previous_message;
  if (!e.deleted_ts || fromBot(prev, botUser)) return null;
  const thread = prev.thread_ts && prev.thread_ts !== e.deleted_ts ? prev.thread_ts : null;
  return { channel: e.channel, ts: e.deleted_ts, thread, user: { id: prev.user }, messageId: id || `${e.channel}:${e.deleted_ts}:deleted`, deleted: { ts: e.deleted_ts } };
}

/** The reply an `events_api` payload stands for, or null when it is not for the agent. */
export function messageReply(p, botUser) {
  const e = p.event || {};
  if (e.type !== 'message') return null;
  if (e.subtype === 'message_changed') return changed(e, botUser, p.event_id);
  if (e.subtype === 'message_deleted') return deleted(e, botUser, p.event_id);
  return plain(e, e.channel, botUser, p.event_id);
}

/** A message from conversations.history or .replies; `thread` is the thread asked for, whose root is skipped. */
export function historyReply(m, channel, thread, botUser) {
  if (thread && m.ts === thread) return null;
  return plain(m, channel, botUser, null);
}

/** Orders replies by their Slack ts (`seconds.micros`), exactly: the digits do not fit a double. */
export function byTs(a, b) {
  const [as, af = ''] = a.ts.split('.');
  const [bs, bf = ''] = b.ts.split('.');
  return (as.length - bs.length) || (as < bs ? -1 : as > bs ? 1 : 0) || (af.padEnd(9, '0') < bf.padEnd(9, '0') ? -1 : af.padEnd(9, '0') > bf.padEnd(9, '0') ? 1 : 0);
}
