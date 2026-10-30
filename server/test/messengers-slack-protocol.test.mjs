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
  assert.deepEqual(cfg, { publicUrl: 'https://am.example.test', slack: { botToken: 'xoxb-2', appToken: 'xapp-2' } });
  assert.deepEqual(resolveMessengerConfig({}), { publicUrl: '', slack: { botToken: '', appToken: '' } });
  assert.throws(() => resolveMessengerConfig({ AM_PUBLIC_URL: 'am.example.test' }), /AM_PUBLIC_URL/, 'a bad URL fails at startup');
});
