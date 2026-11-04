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
