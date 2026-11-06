import assert from 'node:assert/strict';
import test from 'node:test';
import { SlackAdapter } from '../src/messengers/adapters/slack.js';
import { knownSecretValues } from '../src/config.js';
import { createFilter } from '../src/messengers/outbound.js';
import { setup as bridgeSetup, end, msg } from './messengers-bridge-fixtures.mjs';

// Slack rate limits and the plain-text fallback of a post; the secret values the credential filter is given.

const BOT = 'test-bot-token-value-1234';
const reply = (status, body, retry) => ({ status, headers: { get: (h) => (h.toLowerCase() === 'retry-after' ? retry : null) }, json: async () => body });
const ok = reply(200, { ok: true, channel: 'C0', ts: '1.1' });
const limited = (seconds) => reply(429, { ok: false, error: 'ratelimited' }, String(seconds));

function adapterFor(script, sent = []) {
  const waits = [];
  let n = 0;
  const adapter = new SlackAdapter({
    botToken: BOT, appToken: 'xapp-1', setTimer: (fn, ms) => { waits.push(ms); fn(); return 1; },
    fetchImpl: async (url, init) => { sent.push(JSON.parse(init.body)); return script[Math.min(n++, script.length - 1)]; },
  });
  return { adapter, waits, calls: () => n };
}

test('Slack answers 429 with a short Retry-After: the call waits and retries, twice at most', async () => {
  const short = adapterFor([limited(3), ok]);
  assert.deepEqual(await short.adapter.post({ channel: 'C0' }, { body: 'x' }), { channel: 'C0', ts: '1.1' });
  assert.deepEqual(short.waits, [3000]);
  const stuck = adapterFor([limited(3), limited(3), limited(3), ok]);
  await assert.rejects(stuck.adapter.post({ channel: 'C0' }, { body: 'x' }), (e) => /ratelimited|429/.test(e.publicMessage));
  assert.deepEqual(stuck.waits, [3000, 3000]);
  assert.equal(stuck.calls(), 3, 'the original call and two retries');
});

test('a long Retry-After is not slept inside the tick: the call throws rate-limited with retryAfter', async () => {
  const slow = adapterFor([limited(45), ok]);
  const e = await slow.adapter.post({ channel: 'C0' }, { body: 'x' }).then(() => null, (err) => err);
  assert.equal(e.code, 'rate-limited');
  assert.equal(e.retryAfter, 45);
  assert.match(e.publicMessage, /rate-limited/);
  assert.deepEqual(slow.waits, [], 'nothing slept');
  assert.equal(slow.calls(), 1);
});

test('a binding whose post was rate-limited is skipped for the Retry-After, not the default backoff', async () => {
  const t = bridgeSetup({ events: ['transcript'] });
  t.host.list[0].state = 'waiting';
  let seq = 1;
  t.host.sinceImpl = async () => ({ end: end(seq), messages: seq > 1 ? [msg(seq, 'hello')] : [], restarted: false });
  await t.tick();
  seq = 2;
  t.slack.failPosts = 1;
  const post = t.slack.post;
  t.slack.post = async (...args) => {
    try { return await post(...args); } catch { throw Object.assign(new Error('slack chat.postMessage: ratelimited'), { publicMessage: 'slack chat.postMessage: rate-limited', retryAfter: 90 }); }
  };
  await t.tick(1000);
  assert.match(t.bridge.lastError('b0'), /rate-limited/);
  await t.tick(60_000);
  assert.equal(t.slack.posts.length, 0, 'still backed off 60 s later (the default backoff would be over)');
  await t.tick(40_000);
  assert.deepEqual(t.slack.posts.map((p) => p.card.body).filter(Boolean), ['hello']);
});

test('the plain text of a post escapes &, < and >, so agent text cannot notify through it', async () => {
  const sent = [];
  const { adapter } = adapterFor([ok, ok], sent);
  await adapter.post({ channel: 'C0' }, { kind: 'transcript', title: '<!here>', body: '<!channel> <@U123> a & b' });
  await adapter.update({ channel: 'C0', ts: '1.1' }, { kind: 'transcript', body: '<!channel>' });
  assert.equal(sent[0].text, '&lt;!here&gt;\n&lt;!channel&gt; &lt;@U123&gt; a &amp; b');
  assert.equal(sent[1].text, '&lt;!channel&gt;');
});

test('the known values are the named secrets plus any variable ending in TOKEN, API_KEY, SECRET or PASSWORD', () => {
  const env = {
    SLACK_BOT_TOKEN: 'slack-bot-fixture-value-1', SLACK_APP_TOKEN: 'slack-app-fixture-value-2', HF_TOKEN: 'hf-fixture-value-3',
    ANTHROPIC_API_KEY: 'anthropic-fixture-value-4', OPENAI_API_KEY: 'openai-fixture-value-5', GEMINI_API_KEY: 'gemini-fixture-value-6',
    GOOGLE_API_KEY: 'google-fixture-value-7', CODEX_API_KEY: 'codex-fixture-value-8', CLAUDE_CODE_OAUTH_TOKEN: 'claude-oauth-fixture-value-9',
    DEPLOY_SECRET: 'deploy-fixture-value-10', db_password: 'db-fixture-value-11', MY_CUSTOM_API_KEY: 'custom-fixture-value-12',
    SHORT_TOKEN: 'short', TOKEN_COUNT: 'not-a-secret-name-12345', UNRELATED: 'unrelated-fixture-value',
  };
  const values = knownSecretValues(env);
  for (const name of ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'HF_TOKEN', 'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY',
    'GOOGLE_API_KEY', 'CODEX_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'DEPLOY_SECRET', 'db_password', 'MY_CUSTOM_API_KEY']) {
    assert.ok(values.includes(env[name]), `${name} is a known value`);
  }
  assert.ok(!values.includes('short'), 'under 8 characters: the filter would skip it anyway');
  assert.ok(!values.includes(env.TOKEN_COUNT) && !values.includes(env.UNRELATED));
  assert.deepEqual(knownSecretValues({}), []);
  assert.ok(!createFilter(env)(`x ${env.MY_CUSTOM_API_KEY} y`).includes(env.MY_CUSTOM_API_KEY));
});
