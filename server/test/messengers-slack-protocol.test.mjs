import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { resolveMessengerConfig } from '../src/config.js';
import { renderBlocks, toMrkdwn, fromMrkdwn, SlackAdapter } from '../src/messengers/adapters/slack.js';

// Slack rendering, the Socket Mode protocol and messenger configuration.

// Polls a condition with a bounded deadline instead of sleeping a fixed time.
async function waitFor(predicate, what) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 1));
  }
}

test('Slack rendering: cards become blocks, text is escaped one way and unescaped the other', () => {
  assert.equal(toMrkdwn('**a** <b> [x](https://y)'), '*a* &lt;b&gt; <https://y|x>');
  const blocks = renderBlocks({ title: 't', body: 'b', options: [{ id: 'd:accept', label: 'Approve once', style: 'primary' }], link: 'http://am' });
  assert.equal(blocks.find((b) => b.type === 'actions').elements[0].value, 'd:accept');
  const closed = renderBlocks({ title: 't', body: 'b', options: [{ id: 'x', label: 'y' }], resolved: { text: 'done' } });
  assert.ok(!closed.some((b) => b.type === 'actions'), 'a resolved card has no buttons');

  assert.equal(fromMrkdwn('run a &amp;&amp; b &lt;x&gt;'), 'run a && b <x>');
  assert.equal(fromMrkdwn('see <https://x.test|docs> and <https://y.test>'), 'see https://x.test and https://y.test');
  assert.equal(fromMrkdwn('<@U123> <@U123|dk> <#C1|general> <!here> <!channel>'), '@U123 @dk #general @here @channel');
  assert.equal(fromMrkdwn('&amp;lt;'), '&lt;', 'ampersand is unescaped last');
});

test('Slack Socket Mode: frames are acknowledged and turned into replies', async () => {
  const calls = [];
  const sockets = [];
  class FakeWs extends EventEmitter {
    constructor(url) { super(); this.url = url; this.sent = []; sockets.push(this); }
    send(s) { this.sent.push(JSON.parse(s)); }
    close() { this.emit('close'); }
  }
  const fetchImpl = async (url, init) => {
    const method = url.split('/').pop();
    calls.push({ method, auth: init.headers.authorization, body: JSON.parse(init.body) });
    const out = { 'auth.test': { ok: true, user_id: 'UBOT' }, 'apps.connections.open': { ok: true, url: 'wss://x' },
      'chat.postMessage': { ok: true, channel: 'C1', ts: '111.1' }, 'chat.update': { ok: true } }[method];
    return { status: 200, json: async () => out };
  };
  const adapter = new SlackAdapter({ botToken: 'xoxb-1', appToken: 'xapp-1', fetchImpl, WebSocketImpl: FakeWs, setTimer: () => {} });
  assert.equal(adapter.configured(), true);
  const got = [];
  const statuses = [];
  adapter.start({ onReply: async (x) => got.push(x), onCommand: async () => 'pong', onStatus: (s) => statuses.push(s), log: () => {} });
  await waitFor(() => sockets.length === 1, 'the socket to open');
  assert.equal(calls.find((c) => c.method === 'apps.connections.open').auth, 'Bearer xapp-1', 'the app token opens the socket');
  const ws = sockets[0];
  // A frame is handled once the adapter's own handler for it has settled.
  const handled = [];
  const onFrame = adapter.onFrame.bind(adapter);
  adapter.onFrame = (...a) => { const p = onFrame(...a); handled.push(p); return p; };
  const frame = async (m) => { ws.emit('message', Buffer.from(JSON.stringify(m))); await Promise.all(handled.splice(0)); };
  await frame({ type: 'hello' });
  assert.deepEqual(statuses.at(-1), { connected: true, error: null });
  await frame({ type: 'interactive', envelope_id: 'env1', payload: { type: 'block_actions', trigger_id: 'tr', user: { id: 'U1', username: 'dk' }, channel: { id: 'C1' }, message: { ts: '111.1' }, actions: [{ action_id: 'am:d:accept', value: 'd:accept', action_ts: '1' }] } });
  assert.deepEqual(ws.sent.at(-1), { envelope_id: 'env1' }, 'every envelope is acknowledged');
  assert.deepEqual({ ...got.at(-1), messageId: undefined }, { channel: 'C1', ts: '111.1', thread: null, user: { id: 'U1', name: 'dk' }, messageId: undefined, optionId: 'd:accept' });
  await frame({ type: 'events_api', envelope_id: 'env2', payload: { event_id: 'Ev1', event: { type: 'message', channel: 'C1', user: 'U1', text: 'hello', ts: '222.2', thread_ts: '111.1' } } });
  assert.equal(got.at(-1).thread, '111.1');
  assert.equal(got.at(-1).text, 'hello');
  await frame({ type: 'events_api', envelope_id: 'env2b', payload: { event_id: 'Ev2', event: { type: 'message', channel: 'C1', user: 'U1', text: 'run a &amp;&amp; b &lt;x&gt; <https://x.test|docs>', ts: '223.2' } } });
  assert.equal(got.at(-1).text, 'run a && b <x> https://x.test', 'inbound text is unescaped');
  const count = got.length;
  await frame({ type: 'events_api', envelope_id: 'env3', payload: { event: { type: 'message', channel: 'C1', bot_id: 'B1', text: 'own card', ts: '3' } } });
  await frame({ type: 'events_api', envelope_id: 'env4', payload: { event: { type: 'message', subtype: 'message_changed', channel: 'C1', ts: '4' } } });
  assert.equal(got.length, count, 'bot messages and edits are not replies');
  await frame({ type: 'slash_commands', envelope_id: 'env5', payload: { channel_id: 'C1', user_id: 'U1', text: 'status' } });
  assert.equal(ws.sent.at(-1).payload.text, 'pong', 'a slash command is answered in its ack');
  const ref = await adapter.post({ channel: 'C1', thread: '111.1' }, { title: 'x', body: 'y', options: [] });
  assert.deepEqual(ref, { channel: 'C1', ts: '111.1' });
  assert.equal(calls.at(-1).body.thread_ts, '111.1');
  assert.equal(calls.at(-1).auth, 'Bearer xoxb-1');
  await adapter.stop();
  assert.equal(new SlackAdapter({}).configured(), false);
  assert.equal(new SlackAdapter({ botToken: 'xoxb-1' }).configured(), false, 'both tokens are needed');
});

test('messenger configuration is read once, in config.js', () => {
  const cfg = resolveMessengerConfig({ SLACK_BOT_TOKEN: 'xoxb-2', SLACK_APP_TOKEN: 'xapp-2', AM_PUBLIC_URL: 'https://am.example.test/' });
  assert.deepEqual(cfg, { publicUrl: 'https://am.example.test', finishedDelayMs: 8000, slack: { botToken: 'xoxb-2', appToken: 'xapp-2' } });
  assert.deepEqual(resolveMessengerConfig({}), { publicUrl: '', finishedDelayMs: 8000, slack: { botToken: '', appToken: '' } });
  assert.throws(() => resolveMessengerConfig({ AM_PUBLIC_URL: 'am.example.test' }), /AM_PUBLIC_URL/, 'a bad URL fails at startup');
});

test('MESSENGER_FINISHED_DELAY_MS is an integer from 0 to 600000, default 8000', () => {
  assert.equal(resolveMessengerConfig({ MESSENGER_FINISHED_DELAY_MS: '30000' }).finishedDelayMs, 30000);
  assert.equal(resolveMessengerConfig({ MESSENGER_FINISHED_DELAY_MS: '0' }).finishedDelayMs, 0);
  assert.equal(resolveMessengerConfig({ MESSENGER_FINISHED_DELAY_MS: '600000' }).finishedDelayMs, 600000);
  for (const bad of ['-1', '600001', '1.5', 'soon', '']) {
    if (bad === '') { assert.equal(resolveMessengerConfig({ MESSENGER_FINISHED_DELAY_MS: bad }).finishedDelayMs, 8000, 'empty means unset'); continue; }
    assert.throws(() => resolveMessengerConfig({ MESSENGER_FINISHED_DELAY_MS: bad }), /MESSENGER_FINISHED_DELAY_MS must be an integer from 0 to 600000/, bad);
  }
});

// A message event is acknowledged only after onReply resolves (the row is durable); a failure leaves it unacked.
async function protocolRig(onReply) {
  const sockets = [];
  const logs = [];
  class FakeWs extends EventEmitter {
    constructor() { super(); this.sent = []; sockets.push(this); }
    send(s) { this.sent.push(JSON.parse(s)); }
    close() { this.emit('close'); }
  }
  const fetchImpl = async (url) => ({ status: 200, json: async () => ({ 'auth.test': { ok: true, user_id: 'UBOT' }, 'apps.connections.open': { ok: true, url: 'wss://x' } }[url.split('/').pop()]) });
  const adapter = new SlackAdapter({ botToken: 'xoxb-1', appToken: 'xapp-1', fetchImpl, WebSocketImpl: FakeWs, setTimer: () => {} });
  adapter.start({ onReply, onCommand: async () => '', onStatus: () => {}, log: (e) => logs.push(e) });
  await waitFor(() => sockets.length === 1, 'the socket to open');
  return { adapter, ws: sockets[0], logs };
}
const eventFrame = (id) => Buffer.from(JSON.stringify({
  type: 'events_api', envelope_id: id, payload: { event_id: `Ev${id}`, event: { type: 'message', channel: 'C1', user: 'U1', text: 'secret text', ts: '1.1' } },
}));

test('Slack Socket Mode: a message event is acked only after onReply resolves', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const { adapter, ws } = await protocolRig(() => gate);
  const done = adapter.onFrame(ws, eventFrame('e1'));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(ws.sent, [], 'not acked while the write is pending');
  release();
  await done;
  assert.deepEqual(ws.sent, [{ envelope_id: 'e1' }]);
  await adapter.stop();
});

test('Slack Socket Mode: a failed persist is not acked and is logged without the text', async () => {
  const { adapter, ws, logs } = await protocolRig(async () => { throw new Error('ENOSPC'); });
  await adapter.onFrame(ws, eventFrame('e2'));
  assert.deepEqual(ws.sent, [], 'unacked, so Slack redelivers');
  const entry = logs.find((e) => e.event === 'persist-failed');
  assert.ok(entry);
  assert.ok(!JSON.stringify(logs).includes('secret text'));
  await adapter.stop();
});

test('Slack Socket Mode: a button press is still acked before its handler runs', async () => {
  let release;
  const { adapter, ws } = await protocolRig(() => new Promise((r) => { release = r; }));
  const done = adapter.onFrame(ws, Buffer.from(JSON.stringify({
    type: 'interactive', envelope_id: 'e3',
    payload: { type: 'block_actions', trigger_id: 't', user: { id: 'U1' }, channel: { id: 'C1' }, message: { ts: '1.1' }, actions: [{ action_id: 'am:d:accept', value: 'd:accept', action_ts: '1' }] },
  })));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(ws.sent, [{ envelope_id: 'e3' }]);
  release();
  await done;
  await adapter.stop();
});

// Subtypes: an edit, a delete and a file share are replies; bot messages stay out for every subtype.
const eventEnvelope = (event, id = 'x') => Buffer.from(JSON.stringify({ type: 'events_api', envelope_id: id, payload: { event_id: `Ev-${id}`, event } }));
async function replies(events) {
  const got = [];
  const { adapter, ws } = await protocolRig(async (r) => got.push(r));
  for (const [i, event] of events.entries()) await adapter.onFrame(ws, eventEnvelope(event, `e${i}`));
  await adapter.stop();
  return { got, acked: ws.sent.length };
}
const changed = (message, previous = { text: 'before', user: 'U1' }, extra = {}) => ({
  type: 'message', subtype: 'message_changed', channel: 'C1', ts: '300.1', event_ts: '300.1',
  message: { type: 'message', user: 'U1', ts: '100.1', ...message }, previous_message: { type: 'message', ts: '100.1', ...previous }, ...extra,
});

test('message_changed is a reply that names the edited message and the edit', async () => {
  const { got, acked } = await replies([
    changed({ text: 'after &amp; more', edited: { user: 'U1', ts: '299.5' } }),
    changed({ text: 'in thread', thread_ts: '50.1', edited: { user: 'U1', ts: '299.6' } }),
    changed({ text: 'no edited stamp' }),
  ]);
  assert.equal(acked, 3, 'every event is acked');
  assert.deepEqual(got[0], { channel: 'C1', ts: '100.1', thread: null, user: { id: 'U1' }, messageId: 'Ev-e0', text: 'after & more', edit: { ts: '100.1', editTs: '299.5' } });
  assert.equal(got[1].thread, '50.1');
  assert.deepEqual(got[2].edit, { ts: '100.1', editTs: '300.1' }, 'the event time stands in without message.edited');
});

test('message_changed that changes no text (a link unfurl) and bot edits are not replies', async () => {
  const { got, acked } = await replies([
    changed({ text: 'same' }, { text: 'same', user: 'U1' }),
    changed({ text: 'by a bot', bot_id: 'B1', user: undefined }),
    changed({ text: 'by the bot user', user: 'UBOT' }),
    changed({ text: 'edited by an app', subtype: 'bot_message', bot_id: 'B2' }),
    { type: 'message', subtype: 'message_changed', channel: 'C1', ts: '4' },
  ]);
  assert.deepEqual(got, []);
  assert.equal(acked, 5);
});

test('message_deleted is a reply that names the deleted message; a deleted bot message is not', async () => {
  const { got } = await replies([
    { type: 'message', subtype: 'message_deleted', channel: 'C1', ts: '301.1', deleted_ts: '100.1', previous_message: { user: 'U1', ts: '100.1', text: 'gone' } },
    { type: 'message', subtype: 'message_deleted', channel: 'C1', ts: '301.2', deleted_ts: '101.1', previous_message: { user: 'U1', ts: '101.1', thread_ts: '50.1' } },
    { type: 'message', subtype: 'message_deleted', channel: 'C1', ts: '301.3', deleted_ts: '102.1', previous_message: { bot_id: 'B1', ts: '102.1' } },
    { type: 'message', subtype: 'message_deleted', channel: 'C1', ts: '301.4', deleted_ts: '103.1', previous_message: { user: 'UBOT', ts: '103.1' } },
  ]);
  assert.equal(got.length, 2);
  assert.deepEqual(got[0], { channel: 'C1', ts: '100.1', thread: null, user: { id: 'U1' }, messageId: 'Ev-e0', deleted: { ts: '100.1' } });
  assert.equal(got[1].thread, '50.1');
  assert.ok(!JSON.stringify(got).includes('gone'), 'the old text is not carried');
});

test('file_share, and a message of only files, say that the file was not delivered', async () => {
  const note = 'A file was attached in Slack and was not delivered.';
  const { got } = await replies([
    { type: 'message', subtype: 'file_share', channel: 'C1', user: 'U1', ts: '1.1', text: 'see this', files: [{ id: 'F1' }] },
    { type: 'message', subtype: 'file_share', channel: 'C1', user: 'U1', ts: '1.2', text: '', files: [{ id: 'F2' }] },
    { type: 'message', channel: 'C1', user: 'U1', ts: '1.3', files: [{ id: 'F3' }] },
    { type: 'message', subtype: 'file_share', channel: 'C1', bot_id: 'B1', ts: '1.4', text: 'bot upload', files: [{ id: 'F4' }] },
    { type: 'message', subtype: 'channel_join', channel: 'C1', user: 'U1', ts: '1.5', text: 'joined' },
  ]);
  assert.deepEqual(got.map((r) => r.text), [`see this\n\n${note}`, note, note]);
});

// A fetch that answers history calls from a script and records their form-encoded params.
function historyAdapter(pages) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const method = url.split('/').pop();
    const params = Object.fromEntries(new URLSearchParams(String(init.body)));
    calls.push({ method, params, type: init.headers['content-type'] });
    if (method === 'auth.test') return { status: 200, json: async () => ({ ok: true, user_id: 'UBOT' }) };
    const page = pages.shift();
    return { status: 200, json: async () => ({ ok: true, ...page }) };
  };
  return { calls, adapter: new SlackAdapter({ botToken: 'xoxb-1', appToken: 'xapp-1', fetchImpl, setTimer: () => {} }) };
}

test('history() reads the channel from the watermark, exclusive, and follows the cursor', async () => {
  const { adapter, calls } = historyAdapter([
    { messages: [{ type: 'message', user: 'U1', ts: '12.0', text: 'b' }, { type: 'message', user: 'U1', ts: '11.0', text: 'a &amp; c' }], response_metadata: { next_cursor: 'CUR1' } },
    { messages: [{ type: 'message', user: 'UBOT', ts: '13.0', text: 'own' }, { type: 'message', bot_id: 'B1', ts: '14.0', text: 'bot' }, { type: 'message', subtype: 'channel_join', user: 'U1', ts: '15.0' }, { type: 'message', user: 'U2', ts: '16.0', text: 'c', thread_ts: '16.0' }], response_metadata: { next_cursor: '' } },
  ]);
  const got = await adapter.history({ channel: 'C1', oldest: '10.5' });
  const reads = calls.filter((c) => c.method.startsWith('conversations'));
  assert.deepEqual(reads.map((c) => c.method), ['conversations.history', 'conversations.history']);
  assert.deepEqual(reads[0].params, { channel: 'C1', oldest: '10.5', limit: '200' });
  assert.equal(reads[0].params.inclusive, undefined, 'the watermark message is not fetched again');
  assert.equal(reads[1].params.cursor, 'CUR1');
  assert.equal(reads[0].type, 'application/x-www-form-urlencoded', 'Slack reads these methods from form fields');
  assert.deepEqual(got.map((r) => [r.ts, r.thread, r.user.id, r.text, r.channel]), [
    ['11.0', null, 'U1', 'a & c', 'C1'], ['12.0', null, 'U1', 'b', 'C1'], ['16.0', null, 'U2', 'c', 'C1'],
  ], 'oldest first; bot, own and subtype messages are out');
  assert.equal(got[0].messageId, 'C1:11.0');
});

test('history() with a thread reads conversations.replies and drops the root; pages are bounded', async () => {
  const more = (ts) => ({ messages: [{ type: 'message', user: 'U1', ts, text: 'x', thread_ts: '20.0' }], response_metadata: { next_cursor: 'MORE' } });
  const { adapter, calls } = historyAdapter([
    { messages: [{ type: 'message', user: 'U1', ts: '20.0', text: 'root', thread_ts: '20.0', reply_count: 6 }, ...more('21.0').messages], response_metadata: { next_cursor: 'MORE' } },
    more('22.0'), more('23.0'), more('24.0'), more('25.0'), more('26.0'),
  ]);
  const err = await adapter.history({ channel: 'C1', thread: '20.0', oldest: '19.0' }).catch((e) => e);
  const reads = calls.filter((c) => c.method.startsWith('conversations'));
  assert.equal(reads.length, 5, 'at most five pages');
  assert.deepEqual(reads[0].params, { channel: 'C1', ts: '20.0', oldest: '19.0', limit: '200' });
  assert.equal(reads[0].method, 'conversations.replies');
  assert.equal(err.event, 'history-truncated', 'a cut-off read is signalled, not returned as if complete');
  assert.deepEqual(err.partial.map((r) => [r.ts, r.thread]), [['21.0', '20.0'], ['22.0', '20.0'], ['23.0', '20.0'], ['24.0', '20.0'], ['25.0', '20.0']]);
});

test('history() that ends inside the page limit does not signal truncation', async () => {
  const { adapter } = historyAdapter([
    { messages: [{ type: 'message', user: 'U1', ts: '12.0', text: 'b' }], response_metadata: { next_cursor: 'C' } },
    { messages: [{ type: 'message', user: 'U1', ts: '13.0', text: 'c' }], response_metadata: { next_cursor: '' } },
  ]);
  assert.equal((await adapter.history({ channel: 'C1', oldest: '10.0' })).length, 2);
});

// Connect signal: one per real connect, none for Slack's hourly refresh.
async function connectRig() {
  const sockets = [];
  const timers = [];
  class FakeWs extends EventEmitter {
    constructor() { super(); this.sent = []; sockets.push(this); }
    send(s) { this.sent.push(JSON.parse(s)); }
    close() { this.emit('close'); }
  }
  const fetchImpl = async (url) => ({ status: 200, json: async () => ({ 'auth.test': { ok: true, user_id: 'UBOT' }, 'apps.connections.open': { ok: true, url: 'wss://x' } }[url.split('/').pop()]) });
  const adapter = new SlackAdapter({ botToken: 'xoxb-1', appToken: 'xapp-1', fetchImpl, WebSocketImpl: FakeWs, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; } });
  let connects = 0;
  adapter.start({ onReply: async () => {}, onCommand: async () => '', onStatus: () => {}, onConnect: () => { connects += 1; }, log: () => {} });
  await waitFor(() => sockets.length === 1, 'the first socket');
  const hello = async (n) => { await waitFor(() => sockets.length === n, 'the socket'); await adapter.onFrame(sockets[n - 1], Buffer.from('{"type":"hello"}')); };
  const redial = async () => { const t = timers.filter((x) => x.ms === 1000).at(-1); t.fn(); };
  return { adapter, sockets, hello, redial, connects: () => connects };
}

test('onConnect fires on the first connect and after a dropped socket, not after a disconnect refresh', async () => {
  const r = await connectRig();
  await r.hello(1);
  assert.equal(r.connects(), 1, 'first connect');
  await r.adapter.onFrame(r.sockets[0], Buffer.from('{"type":"hello"}'));
  assert.equal(r.connects(), 1, 'a second hello on the same socket is not a new connect');
  r.sockets[0].emit('close'); // dropped without a disconnect frame
  r.redial();
  await r.hello(2);
  assert.equal(r.connects(), 2, 'reconnect after a drop');
  await r.adapter.onFrame(r.sockets[1], Buffer.from('{"type":"disconnect","reason":"refresh_requested"}'));
  r.redial();
  await r.hello(3);
  assert.equal(r.connects(), 2, 'a refresh reconnect is not a connect');
  r.sockets[2].emit('close');
  r.redial();
  await r.hello(4);
  assert.equal(r.connects(), 3, 'the flag does not stick to the next drop');
  await r.adapter.stop();
});

test('onConnect fires when a refresh reconnect failed before it succeeded', async () => {
  const r = await connectRig();
  await r.hello(1);
  await r.adapter.onFrame(r.sockets[0], Buffer.from('{"type":"disconnect"}'));
  r.adapter.reconnectLater('apps.connections.open failed'); // the redial failed: Slack may have been unreachable
  r.redial();
  await r.hello(2);
  assert.equal(r.connects(), 2);
  await r.adapter.stop();
});
