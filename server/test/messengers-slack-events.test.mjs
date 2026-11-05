import assert from 'node:assert/strict';
import test from 'node:test';
import { messageReply, historyReply } from '../src/messengers/adapters/slack-events.js';

// Slack message events and history entries become the same reply shape.

const BOT = 'UBOT';
const live = (event, id = 'Ev1') => messageReply({ event_id: id, event: { type: 'message', channel: 'C1', ...event } }, BOT);

test('a thread reply sent "also to the channel" (thread_broadcast) is an ordinary threaded reply', () => {
  const r = live({ subtype: 'thread_broadcast', user: 'U1', text: 'hi', ts: '222.2', thread_ts: '111.1' });
  assert.deepEqual(r, { channel: 'C1', ts: '222.2', thread: '111.1', user: { id: 'U1' }, messageId: 'C1:222.2', text: 'hi' });
  assert.equal(historyReply({ subtype: 'thread_broadcast', user: 'U1', text: 'hi', ts: '222.2', thread_ts: '111.1' }, 'C1', null, BOT)?.thread, '111.1');
});

test('other subtypes and bot messages are still dropped', () => {
  for (const subtype of ['channel_join', 'bot_message', 'me_message', 'message_replied']) {
    assert.equal(live({ subtype, user: 'U1', text: 'x', ts: '1.1' }), null, subtype);
  }
  assert.equal(live({ subtype: 'thread_broadcast', user: BOT, text: 'x', ts: '1.1', thread_ts: '0.5' }), null);
  assert.equal(live({ subtype: 'thread_broadcast', bot_id: 'B1', user: 'U2', text: 'x', ts: '1.1', thread_ts: '0.5' }), null);
});

test('a live message and its history copy share one message id, the event id is not used', () => {
  const event = { user: 'U1', text: 'hi', ts: '333.3' };
  const fromEvent = live(event, 'Ev-redelivered');
  const fromHistory = historyReply(event, 'C1', null, BOT);
  assert.equal(fromEvent.messageId, 'C1:333.3');
  assert.equal(fromEvent.messageId, fromHistory.messageId);
  assert.equal(live(event, 'Ev-other').messageId, fromEvent.messageId, 'a redelivery with another event id is the same message');
});

const change = (message, previous) => messageReply({
  event_id: 'Ev9',
  event: { type: 'message', subtype: 'message_changed', channel: 'C1', event_ts: '9.9', message, previous_message: previous },
}, BOT);

test('a message_changed with the same text and the same files is not an edit', () => {
  const files = [{ id: 'F1' }];
  assert.equal(change({ user: 'U1', text: 'look', ts: '5.5', files }, { user: 'U1', text: 'look', ts: '5.5', files }), null);
  assert.equal(change({ user: 'U1', text: 'look', ts: '5.5', files }, { user: 'U1', text: 'look', ts: '5.5' }) !== null, true, 'a file added later is a change');
});

test('an edit of text on a message with files, or of a file_share message, is an edit', () => {
  const files = [{ id: 'F1' }];
  const r = change({ user: 'U1', text: 'new', ts: '5.5', files, edited: { ts: '6.6' } }, { user: 'U1', text: 'old', ts: '5.5', files });
  assert.deepEqual(r.edit, { ts: '5.5', editTs: '6.6' });
  for (const subtype of ['file_share', 'thread_broadcast']) {
    const e = change({ subtype, user: 'U1', text: 'new', ts: '5.5', thread_ts: '1.1', edited: { ts: '6.6' } }, { subtype, user: 'U1', text: 'old', ts: '5.5' });
    assert.equal(e?.edit.ts, '5.5', subtype);
  }
  assert.equal(change({ subtype: 'channel_join', user: 'U1', text: 'new', ts: '5.5' }, { text: 'old' }), null);
});
