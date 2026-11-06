// Claude Code approval hook: asks Agent Manager for a chat decision.
// Run with: node server/test/messengers-claude-hook.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { freePort } from './free-port.mjs';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-hook-'));
process.env.CLAUDE_CONFIG_DIR = path.join(TMP, 'cfg');
process.env.DATA_DIR = path.join(TMP, 'data');
fs.mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });

const hook = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'am-claude-approval-hook.sh');

const requests = [];
let reply = { status: 200, body: { output: null } };
const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', () => {
    let body = null;
    try { body = JSON.parse(Buffer.concat(chunks).toString()); } catch { /* recorded as null */ }
    requests.push({ method: req.method, url: req.url, headers: req.headers, body });
    res.writeHead(reply.status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(reply.body));
  });
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const port = server.address().port;

const baseEnv = () => ({
  PATH: process.env.PATH,
  AM_ID: 's_test',
  AM_RUN_ID: 'run-1',
  AM_CLI: 'claude',
  AM_PANE_PID: String(process.pid),
  CLAUDE_PID: String(process.pid),
  CLAUDE_CODE_ENTRYPOINT: 'cli',
  AM_HOST: '127.0.0.1',
  AM_PORT: String(port),
});

function run(payload, env = baseEnv()) {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', [hook], { env });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('error', reject);
    child.on('close', (status) => resolve({ status, stdout, stderr }));
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify(payload));
  });
}

const permission = { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls "$HOME" \'x\'' } };
const decision = { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } } };

// PermissionRequest with a decision
reply = { status: 200, body: { output: decision } };
requests.length = 0;
let r = await run(permission);
assert.equal(r.status, 0, r.stderr);
assert.equal(requests.length, 1);
assert.equal(requests[0].method, 'POST');
assert.equal(requests[0].url, '/api/messengers/claude-hook?from=s_test');
assert.equal(requests[0].headers['x-am-request'], '1');
assert.match(requests[0].headers['content-type'], /application\/json/);
assert.deepEqual(requests[0].body, { runId: 'run-1', payload: permission });
assert.deepEqual(JSON.parse(r.stdout), decision);

// output null / 409 / non-object / unreachable: silent
for (const [name, rep] of [
  ['null output', { status: 200, body: { output: null } }],
  ['409', { status: 409, body: { error: 'x' } }],
  ['string output', { status: 200, body: { output: 'nope' } }],
]) {
  reply = rep;
  r = await run(permission);
  assert.equal(r.status, 0, name);
  assert.equal(r.stdout, '', name);
  if (name === '409') assert.match(r.stderr, /am-claude-approval-hook: .*409/, 'a refused request is reported on stderr, which Claude shows only in verbose mode');
  else assert.equal(r.stderr, '', `${name}: nothing on stderr`);
}
r = await run(permission, { ...baseEnv(), AM_PORT: String(await freePort()) });
assert.equal(r.status, 0);
assert.equal(r.stdout, '', 'unreachable server prints no decision');
assert.match(r.stderr, /am-claude-approval-hook: /, 'and says why on stderr');

// AskUserQuestion vs other PreToolUse
const answer = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow', updatedInput: { answers: { q: 'a' } } } };
reply = { status: 200, body: { output: answer } };
requests.length = 0;
r = await run({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion', tool_input: { questions: [] } });
assert.equal(requests.length, 1);
assert.deepEqual(JSON.parse(r.stdout), answer);
requests.length = 0;
r = await run({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: {} });
assert.equal(r.status, 0);
assert.equal(r.stdout, '');
assert.equal(requests.length, 0, 'other PreToolUse tools make no request');

// guards
const guards = {
  'missing AM_ID': (e) => { delete e.AM_ID; },
  'AM_ID with a space': (e) => { e.AM_ID = 's test'; },
  'bad AM_RUN_ID': (e) => { e.AM_RUN_ID = 'a/b'; },
  'AM_PANE_PID not numeric': (e) => { e.AM_PANE_PID = 'x1'; },
  'AM_PORT not numeric': (e) => { e.AM_PORT = '80a'; },
  'entrypoint sdk': (e) => { e.CLAUDE_CODE_ENTRYPOINT = 'sdk'; },
  'CLAUDE_PID outside the pane': (e) => { e.CLAUDE_PID = '1'; },
  'AM_CLI gemini': (e) => { e.AM_CLI = 'gemini'; },
};
reply = { status: 200, body: { output: decision } };
for (const [name, mutate] of Object.entries(guards)) {
  requests.length = 0;
  const env = baseEnv();
  mutate(env);
  r = await run(permission, env);
  assert.equal(r.status, 0, name);
  assert.equal(r.stdout, '', name);
  assert.equal(requests.length, 0, `${name}: no request`);
}

// A real child of the pane process passes the check (a /proc parent lookup).
const sleeper = spawn('sleep', ['30'], { stdio: 'ignore' });
try {
  assert.ok(sleeper.pid, 'the child started');
  requests.length = 0;
  r = await run(permission, { ...baseEnv(), CLAUDE_PID: String(sleeper.pid) });
  assert.equal(r.status, 0, r.stderr);
  assert.equal(requests.length, 1, 'a child of the pane process asks');
  assert.deepEqual(JSON.parse(r.stdout), decision);
} finally {
  sleeper.kill();
}
server.close();

// install
const runner = await import('../src/runner.js');
const settings = path.join(process.env.CLAUDE_CONFIG_DIR, 'settings.json');
const userHook = { matcher: 'Bash', hooks: [{ type: 'command', command: '/usr/bin/user-hook.sh' }] };
fs.writeFileSync(settings, JSON.stringify({ hooks: { PreToolUse: [userHook] } }));
assert.equal(runner.installClaudeRepinHook('/x/am-repin-hook.sh', '/x/am-input-required-hook.sh', '/x/am-claude-approval-hook.sh'), true);
const s = JSON.parse(fs.readFileSync(settings, 'utf8'));
assert.deepEqual(s.hooks.PermissionRequest, [{ hooks: [{ type: 'command', command: '/x/am-claude-approval-hook.sh', timeout: 150 }] }]);
assert.deepEqual(s.hooks.PreToolUse, [userHook, { matcher: 'AskUserQuestion', hooks: [{ type: 'command', command: '/x/am-claude-approval-hook.sh', timeout: 150 }] }]);
const before = fs.readFileSync(settings);
assert.equal(runner.installClaudeRepinHook('/x/am-repin-hook.sh', '/x/am-input-required-hook.sh', '/x/am-claude-approval-hook.sh'), true);
assert.ok(before.equals(fs.readFileSync(settings)), 'second install leaves the file byte-identical');


// A user's own PermissionRequest hook stays, and a missing hook is added without duplicating the approval hook.
const cmd = (command) => ({ hooks: [{ type: 'command', command }] });
const approval = (extra = {}) => ({ hooks: [{ type: 'command', command: '/x/am-claude-approval-hook.sh', timeout: 150 }], ...extra });
const mine = cmd('/usr/bin/my-permission-hook.sh');
fs.writeFileSync(settings, JSON.stringify({ hooks: { PermissionRequest: [mine, approval()] } }));
assert.equal(runner.installClaudeRepinHook('/x/am-repin-hook.sh', '/x/am-input-required-hook.sh', '/x/am-claude-approval-hook.sh'), true);
const kept = JSON.parse(fs.readFileSync(settings, 'utf8'));
assert.deepEqual(kept.hooks.PermissionRequest, [mine, approval()], 'own hook kept, approval hook not duplicated');
assert.deepEqual(kept.hooks.PreToolUse, [approval({ matcher: 'AskUserQuestion' })], 'the missing question hook was added');
assert.equal(kept.hooks.SessionStart.length, 1);

fs.writeFileSync(settings, JSON.stringify({ hooks: { PermissionRequest: [mine] } }));
assert.equal(runner.installClaudeRepinHook('/x/am-repin-hook.sh', '/x/am-input-required-hook.sh', '/x/am-claude-approval-hook.sh'), true);
assert.deepEqual(JSON.parse(fs.readFileSync(settings, 'utf8')).hooks.PermissionRequest, [mine, approval()], 'appended after the user\'s hook');

fs.rmSync(TMP, { recursive: true, force: true });
console.log('messengers-claude-hook: all assertions passed');
process.exit(0);
