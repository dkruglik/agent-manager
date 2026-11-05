// The bytes a row sends: the preamble after a source change, the sender prefix, the body.

export const PREAMBLE_HEAD = 'Earlier messages from Slack (the conversation restarted since):';

const quoted = (text) => text.split('\n').map((l) => `> ${l}`).join('\n');

// The stored texts of a session when its source changed since they were delivered, else ''.
function preambleFor({ host, store, rows }, key, session, except) {
  // A row already waiting carries it; a second copy would repeat the same lines (an edited row is not its own other copy).
  const [adapter, channel] = key.split('|');
  const hasPreambleQueued = [...rows.values()].some((r) => r.requestId !== except
    && r.adapter === adapter && r.channel === channel && r.sessionId === session.id
    && r.text.startsWith(PREAMBLE_HEAD));
  if (hasPreambleQueued) return '';
  const recent = store.state('recent', key);
  if (!recent?.lastSrc || !recent.texts.length) return '';
  if ((host.sourceKey?.(session) ?? '') === recent.lastSrc) return '';
  return `${PREAMBLE_HEAD}\n${recent.texts.map(quoted).join('\n')}\n\n`;
}

// Several people may write to the session: say who this is, in a form that is not the `[Agent Manager:` notice.
function senderPrefix(ctx, adapterId, channel, session, user) {
  const writers = new Set(ctx.store.bindings()
    .filter((b) => b.adapter === adapterId && b.target.channel === channel && ctx.threads.reaches(b, session.id))
    .flatMap((b) => b.allowedUsers));
  return writers.size > 1 ? `Slack user ${user.id}: ` : '';
}

// The bytes a row sends: preamble, sender prefix, body. `except` is the row being rewritten.
export const frozenText = (ctx, adapterId, channel, session, user, body, except) => preambleFor(ctx, `${adapterId}|${channel}|${session.id}`, session, except)
  + senderPrefix(ctx, adapterId, channel, session, user) + body;
