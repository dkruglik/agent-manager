// The Claude hook route with a connected (fake) Slack: a hook whose client goes
// away is cancelled — its card closes — and the lost response is logged.
// Slack is faked twice over: a preload answers the Web API calls and records
// them, and a local WebSocket server plays Socket Mode.
import { nativeFetch as fetch } from './native-client.mjs';
import { freePort } from './free-port.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { WebSocketServer } from 'ws';

const PORT = await freePort();
const API = `http://127.0.0.1:${PORT}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-messengers-hook-http-'));
const DATA_DIR = path.join(root, 'data');
const HOME = path.join(root, 'home');
const bin = path.join(root, 'bin');
for (const d of [DATA_DIR, HOME, bin]) fs.mkdirSync(d, { recursive: true });

// A Claude that only says which launch it is.
fs.writeFileSync(path.join(bin, 'claude'), `#!/bin/sh\nprintf '%s' "$AM_RUN_ID" > "${root}/run-$AM_ID"\nexec sleep 600\n`, { mode: 0o755 });
// Sessions run in a login shell whose profile rebuilds PATH: put the fake back first.
fs.writeFileSync(path.join(HOME, '.profile'), `export PATH="${bin}:$PATH"\n`);

const sockets = new WebSocketServer({ host: '127.0.0.1', port: 0 });
await new Promise((r) => sockets.once('listening', r));
sockets.on('connection', (ws) => ws.send(JSON.stringify({ type: 'hello' })));
const calls = path.join(root, 'slack-calls.jsonl');
const preload = path.join(root, 'preload.mjs');
fs.writeFileSync(preload, `import fs from 'node:fs';
let n = 0;
globalThis.fetch = async (url, init) => {
  const method = String(url).split('/').pop();
  const body = JSON.parse(init?.body || '{}');
  fs.appendFileSync(${JSON.stringify(calls)}, JSON.stringify({ method, body }) + '\\n');
  const out = {
    'auth.test': { ok: true, user_id: 'UBOT' },
    'apps.connections.open': { ok: true, url: 'ws://127.0.0.1:${sockets.address().port}' },
    'chat.postMessage': { ok: true, channel: body.channel, ts: 't' + (++n) },
    'chat.update': { ok: true },
  }[method] || { ok: false, error: 'unknown_method' };
  return { status: 200, json: async () => out };
};
`);

const { SPACE_ID, AM_DISTRIBUTE_SKILLS, ...BASE_ENV } = process.env;
const server = spawn(process.execPath, ['--import', preload, 'src/index.js'], {
  env: {
    ...BASE_ENV, PATH: `${bin}:${BASE_ENV.PATH || ''}`, PORT: String(PORT), DATA_DIR, HOME, AM_BASHRC: '/nonexistent',
    CLAUDE_CONFIG_DIR: path.join(HOME, '.claude'), AM_INPUT_REQUIRED_DIR: path.join(root, 'input-required'),
    SLACK_BOT_TOKEN: 'xoxb-fixture', SLACK_APP_TOKEN: 'xapp-fixture', AM_BIND_HOST: '127.0.0.1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (c) => { log += c; });
server.stderr.on('data', (c) => { log += c; });

const api = async (route, { method = 'GET', body, signal } = {}) => {
  const headers = new Headers();
  if (body !== undefined) headers.set('content-type', 'application/json');
  if (method !== 'GET') headers.set('x-am-origin', 'operator');
  const response = await fetch(`${API}${route}`, { method, headers, signal, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : null };
};
const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const slackCalls = () => lines(calls);
const events = () => lines(path.join(DATA_DIR, 'messengers.log.jsonl'));
async function waitFor(predicate, what, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 50));
  }
}

try {
  await waitFor(() => fetch(`${API}/api/health`).then((r) => r.ok).catch(() => false), 'the server');
  await waitFor(async () => (await api('/api/messengers')).body?.adapters?.[0]?.connected, 'Slack to connect');

  let r = await api('/api/sessions', { method: 'POST', body: { cli: 'claude', name: 'hooked', prompt: 'hello' } }); // a prompt starts it
  assert.equal(r.status, 201);
  const id = r.body.id;
  const runFile = path.join(root, `run-${id}`);
  await waitFor(() => fs.existsSync(runFile) && fs.readFileSync(runFile, 'utf8'), 'the launch');
  const runId = fs.readFileSync(runFile, 'utf8');
  r = await api('/api/messengers/bindings', {
    method: 'POST',
    body: { adapter: 'slack', target: { channel: 'C1' }, scope: { type: 'session', id }, allowedUsers: ['U1'], approvals: true },
  });
  assert.equal(r.status, 201);

  // The hook's client goes away while the card waits for an answer.
  const client = new AbortController();
  const permission = { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } };
  const asked = api(`/api/messengers/claude-hook?from=${id}`, { method: 'POST', body: { runId, payload: permission }, signal: client.signal });
  asked.catch(() => {});
  await waitFor(() => slackCalls().some((c) => c.method === 'chat.postMessage'), 'the card');
  client.abort();

  await waitFor(() => slackCalls().some((c) => c.method === 'chat.update' && JSON.stringify(c.body).includes('Stopped waiting')), 'the card to close');
  await waitFor(() => events().some((e) => e.event === 'hook-response-lost'), 'the lost response to be logged');
  const lost = events().find((e) => e.event === 'hook-response-lost');
  assert.deepEqual([lost.session, lost.decided], [id, false]);
  console.log('messengers-hook-http: all assertions passed');
} catch (error) {
  console.error(log.slice(-2000));
  throw error;
} finally {
  server.kill('SIGTERM');
  await new Promise((resolve) => { server.once('exit', resolve); setTimeout(resolve, 3000); });
  sockets.close();
  fs.rmSync(root, { recursive: true, force: true });
}
