// Messenger binding routes on the real route stack: validation and error
// envelopes, admission, and that tokens never reach a response.
import { nativeFetch as fetch } from './native-client.mjs';
import { freePort } from './free-port.mjs';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const PORT = await freePort();
const API = `http://127.0.0.1:${PORT}`;
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-messengers-http-'));
const DATA_DIR = path.join(root, 'data');
fs.mkdirSync(DATA_DIR);
fs.writeFileSync(path.join(DATA_DIR, 'groups.json'), JSON.stringify([{ id: 'g_fixture', name: 'fixture', sessionIds: [] }]));
// Configured tokens make the Slack adapter try to connect. No network here:
// every outbound fetch fails, so the adapter stays offline and retries.
const preload = path.join(root, 'preload.mjs');
fs.writeFileSync(preload, "globalThis.fetch = async () => { throw new Error('offline fixture'); };\n");

const BOT = 'xoxb-fixture-secret';
const APP = 'xapp-fixture-secret';
const { SPACE_ID, ...BASE_ENV } = process.env;
const server = spawn(process.execPath, ['--import', preload, 'src/index.js'], {
  env: {
    ...BASE_ENV, PORT: String(PORT), DATA_DIR, HOME: path.join(root, 'home'), AM_BASHRC: '/nonexistent',
    AM_INPUT_REQUIRED_DIR: path.join(root, 'input-required'), SLACK_BOT_TOKEN: BOT, SLACK_APP_TOKEN: APP,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
server.stdout.on('data', (c) => { log += c; });
server.stderr.on('data', (c) => { log += c; });

const api = async (route, { method = 'GET', body, origin = true } = {}) => {
  const headers = new Headers();
  if (body !== undefined) headers.set('content-type', 'application/json');
  if (method !== 'GET' && origin) headers.set('x-am-origin', 'operator');
  const response = await fetch(`${API}${route}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await response.text();
  return { status: response.status, text, body: text ? JSON.parse(text) : null };
};
const binding = { adapter: 'slack', target: { channel: 'C123' }, scope: { type: 'group', id: 'g_fixture' }, allowedUsers: ['U1'] };

try {
  for (let i = 0; i < 80; i++) {
    if (await fetch(`${API}/api/health`).then((r) => r.ok).catch(() => false)) break;
    await new Promise((r) => setTimeout(r, 250));
  }

  let r = await api('/api/messengers');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.adapters.map(({ id, configured, connected }) => ({ id, configured, connected })),
    [{ id: 'slack', configured: true, connected: false }]);
  assert.ok(!r.text.includes(BOT) && !r.text.includes(APP), 'tokens never reach a response');

  // Validation failures use the shared envelope, field included.
  r = await api('/api/messengers/bindings', { method: 'POST', body: { ...binding, adapter: 'nope' } });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'invalid-input');
  assert.equal(r.body.details?.[0]?.field, 'adapter');
  r = await api('/api/messengers/bindings', { method: 'POST', body: { ...binding, scope: { type: 'group', id: 'g_missing' } } });
  assert.equal(r.status, 400);
  assert.equal(r.body.details?.[0]?.field, 'scope');
  r = await api('/api/messengers/bindings', { method: 'POST', body: { ...binding, approvals: 'yes' } });
  assert.equal(r.body.details?.[0]?.field, 'approvals');

  // Saved channels and users: validated, normalized, listed, and behind the same admission.
  const saved = { adapter: 'slack', channels: [{ id: 'C0123ABCD', name: ' alerts ' }], users: [{ id: 'U0123ABCD' }] };
  const expectedSaved = { slack: { channels: [{ id: 'C0123ABCD', name: 'alerts' }], users: [{ id: 'U0123ABCD', name: '' }] } };
  r = await api('/api/messengers/saved', { method: 'PUT', body: saved, origin: false });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'origin-required');
  r = await api('/api/messengers/saved', { method: 'PUT', body: { ...saved, channels: [{ id: 'bad id!' }] } });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'invalid-input');
  assert.equal(r.body.details?.[0]?.field, 'channels');
  r = await api('/api/messengers/saved', { method: 'PUT', body: { ...saved, adapter: 'nope' } });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'invalid-input');
  assert.equal(r.body.details?.[0]?.field, 'adapter');
  r = await api('/api/messengers/saved', { method: 'PUT', body: saved });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, expectedSaved);
  assert.ok(!r.text.includes(BOT) && !r.text.includes(APP), 'tokens never reach the saved response');
  r = await api('/api/messengers');
  assert.deepEqual(r.body.saved, expectedSaved);
  assert.ok(!r.text.includes(BOT) && !r.text.includes(APP), 'tokens never reach the list with saved targets');

  // Admission still applies: a write without an origin is refused.
  r = await api('/api/messengers/bindings', { method: 'POST', body: binding, origin: false });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'origin-required');

  r = await api('/api/messengers/bindings', { method: 'POST', body: binding });
  assert.equal(r.status, 201);
  const id = r.body.id;
  assert.equal(r.body.approvals, false, 'approvals are opt-in');

  r = await api(`/api/messengers/bindings/${id}`, { method: 'PUT', body: { approvals: true } });
  assert.equal(r.status, 200);
  assert.equal(r.body.approvals, true);
  assert.equal(r.body.target.channel, 'C123', 'a partial update keeps the rest');

  r = await api('/api/messengers/bindings/b_missing', { method: 'PUT', body: { approvals: true } });
  assert.equal(r.status, 404);
  assert.equal(r.body.code, 'not-found');

  // A messenger that is not connected cannot post a test card.
  r = await api(`/api/messengers/bindings/${id}/test`, { method: 'POST' });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'messenger-offline');

  r = await api(`/api/messengers/bindings/${id}`, { method: 'DELETE' });
  assert.equal(r.status, 200);
  r = await api(`/api/messengers/bindings/${id}`, { method: 'DELETE' });
  assert.equal(r.status, 404);
  assert.equal(r.body.code, 'not-found');

  // The Claude hook long-poll: only the live launch of a Claude pane may ask.
  const hook = (from, body) => api(`/api/messengers/claude-hook?from=${encodeURIComponent(from)}`, { method: 'POST', body });
  const permission = { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls' } };
  r = await api('/api/sessions', { method: 'POST', body: { cli: 'claude', name: 'hooked' } });
  assert.equal(r.status, 201);
  const hooked = r.body.id;
  r = await hook(hooked, { runId: 'stale', payload: permission });
  assert.equal(r.status, 409, 'no live launch, so a stale runId gets nothing');
  assert.equal(r.body.code, 'conflict');
  const hookLog = () => fs.readFileSync(path.join(DATA_DIR, 'messengers.log.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const rejected = hookLog().filter((e) => e.event === 'hook-rejected');
  assert.deepEqual(rejected.map(({ session, status, reason }) => ({ session, status, reason })), [{ session: hooked, status: 409, reason: 'conflict' }]);
  // The script sends only X-AM-Request: 1, a JSON body and ?from=<id>, no x-am-origin:
  // it must get past admission and the origin check to the route's own 409.
  r = await api(`/api/messengers/claude-hook?from=${hooked}`, { method: 'POST', body: { runId: 'stale', payload: permission }, origin: false });
  assert.equal(r.status, 409, 'the script request passes admission');
  assert.equal(r.body.code, 'conflict');
  assert.notEqual(r.body.code, 'request-not-allowed');

  // Only Claude panes ask: any other session gets an empty answer, not an error.
  r = await api('/api/sessions', { method: 'POST', body: { cli: 'shell', name: 'plain' } });
  assert.equal(r.status, 201);
  r = await hook(r.body.id, { runId: 'whatever', payload: permission });
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, { output: null });

  r = await hook(hooked, { runId: 'stale' });
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'invalid-input');
  assert.equal(r.body.details?.[0]?.field, 'payload');
  r = await hook(hooked, { payload: permission });
  assert.equal(r.body.details?.[0]?.field, 'runId');
  assert.deepEqual(hookLog().filter((e) => e.event === 'hook-rejected' && e.status === 400).map(({ session, reason }) => ({ session, reason })),
    [{ session: hooked, reason: 'invalid-input' }, { session: hooked, reason: 'invalid-input' }], 'a bad body is logged as rejected too');
  r = await hook('s_unknown', { runId: 'x', payload: permission });
  // The origin middleware resolves ?from first and refuses an unknown session
  // before the route's own 404 can be reached.
  assert.equal(r.status, 400);
  assert.equal(r.body.code, 'unknown-origin');

  const ops = fs.readFileSync(path.join(DATA_DIR, 'operations.jsonl'), 'utf8');
  assert.ok(ops.includes('/api/messengers/bindings'), 'binding changes are in the API log');
  assert.ok(!ops.includes(BOT) && !ops.includes(APP), 'tokens never reach the API log');
  // SIGTERM reaches the bridge, so hooks still waiting are told Agent Manager is stopping.
  server.kill('SIGTERM');
  await new Promise((resolve) => { server.once('exit', resolve); setTimeout(resolve, 5000); });
  assert.ok(hookLog().some((e) => e.event === 'stopping'), 'the signal handler stops the messengers');
  console.log('messengers-http: all assertions passed');
} catch (error) {
  console.error(log.slice(-1500));
  throw error;
} finally {
  server.kill('SIGTERM');
  await new Promise((resolve) => { server.once('exit', resolve); setTimeout(resolve, 3000); });
  fs.rmSync(root, { recursive: true, force: true });
}
