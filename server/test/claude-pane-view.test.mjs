// AM never types a prompt into, or presses Enter in, a Claude Code view that
// is not the session's own composer.
//
// Claude Code 2.1.325, checked by hand: in the agents view (left arrow twice)
// the composer belongs to the agents list. It takes a paste exactly as the
// session's composer does — `[Pasted text #N +3 lines]` — and its Enter starts
// a NEW background session with that text as its task. So a delegation result
// or a chat message sent while the operator looked at the agents list would
// have become a stray session. In the detailed transcript view (ctrl+o) a
// paste is dropped. Driven through a real server and a pane that draws the
// captured screens (fixtures/fake-claude-tui.mjs).
//
// Run with:  node test/claude-pane-view.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { freePort } from './free-port.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++; console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-pane-view-'));
const DATA_DIR = path.join(root, 'data'); fs.mkdirSync(DATA_DIR, { recursive: true });
const PUBLIC_DIR = path.join(root, 'public'); fs.mkdirSync(PUBLIC_DIR);
fs.writeFileSync(path.join(PUBLIC_DIR, 'index.html'), '<html>fixture</html>');
const FAKE_DIR = path.join(root, 'fake'); fs.mkdirSync(FAKE_DIR);
const read = (f) => { try { return fs.readFileSync(path.join(FAKE_DIR, f), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const setMode = (m) => {
  fs.writeFileSync(path.join(FAKE_DIR, 'mode'), JSON.stringify(m));
  for (const f of ['pastes', 'enters', 'submitted', 'created-session']) fs.rmSync(path.join(FAKE_DIR, f), { force: true });
};

const PORT = String(await freePort());
const API = `http://127.0.0.1:${PORT}`;
// An allowlist, not process.env: inside a Space the shell exports live agent
// state paths that a child must never inherit.
const inherited = Object.fromEntries(['PATH', 'LANG', 'TZ'].filter((k) => process.env[k] !== undefined).map((k) => [k, process.env[k]]));
const home = path.join(root, 'home'); fs.mkdirSync(home);
const backend = spawn('node', ['src/index.js'], {
  cwd: path.join(HERE, '..'), stdio: ['ignore', 'pipe', 'pipe'],
  env: { ...inherited, HOME: home, PORT, DATA_DIR, PUBLIC_DIR, AM_BASHRC: '/nonexistent', SPACE_HOST: '',
    AM_ALLOW_MISSING_ORIGIN: '1', AM_SUBMIT_CONFIRM_TIMEOUT_MS: '1500', AM_PASTE_SHOWN_TIMEOUT_MS: '3000',
    AM_TEST_CLAUDE_CMD: `env FAKE_DIR=${FAKE_DIR} ${process.execPath} ${path.join(HERE, 'fixtures', 'fake-claude-tui.mjs')}` },
});
let logs = '';
backend.stdout.on('data', (d) => { logs += d; });
backend.stderr.on('data', (d) => { logs += d; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms) => {
  const end = Date.now() + ms;
  while (Date.now() < end) { try { if (await fn()) return true; } catch {} await sleep(150); }
  return false;
};
const post = (p, body) => fetch(API + p, { method: 'POST',
  headers: { 'content-type': 'application/json', 'x-am-request': '1' },
  body: body === undefined ? undefined : JSON.stringify(body) });
// Three newlines, like a delegation result: Claude collapses it to a placeholder.
const PROMPT = '[message from child:] [AM source {}]\n[AM delegation result X]\nOutcome: completed.\nThis is a one-shot follow-up.';
const openPane = async (name, view) => {
  setMode({ view });
  const made = await (await post('/api/sessions', { cli: 'test-claude', name, path: '.' })).json();
  const ws = new WebSocket(`${API.replace('http', 'ws')}/ws?session=${made.id}&cols=120&rows=32`, { headers: { 'x-am-request': '1' } });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  await sleep(2500);
  return { id: made.id, ws };
};
const send = async (pane) => {
  const t0 = Date.now();
  const r = await post(`/api/sessions/${pane.id}/input`, { text: PROMPT });
  return { status: r.status, body: await r.json().catch(() => ({})), ms: Date.now() - t0 };
};

try {
  if (!await until(() => fetch(`${API}/api/health`).then((r) => r.ok), 60_000)) throw new Error(`server did not start:\n${logs.slice(-1200)}`);
  await post('/api/welcome/seen');

  console.log('\n# what agents are told about delegation callbacks');
  // The environment skill AM writes for agents repeats docs/agent-delegation-workflow.md.
  const skillText = () => { try { return fs.readFileSync(path.join(DATA_DIR, 'workspaces', 'skills', 'environment.md'), 'utf8'); } catch { return ''; } };
  await until(() => skillText(), 20_000);
  const skill = skillText();
  check('the environment skill says a callback waits while Claude shows its agents or transcript view', () => {
    assert.ok(skill, 'no environment skill was written');
    assert.match(skill, /input-pane-view/);
    assert.match(skill, /agents view/);
  });

  console.log('\n# the session\'s own composer');
  let pane = await openPane('claude-main', 'main');
  setMode({ view: 'main' });
  const ok = await send(pane);
  check('the prompt is pasted, seen as its placeholder, and submitted with one Enter', () => {
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.deepEqual(read('submitted'), [JSON.stringify('[Pasted text #1 +3 lines]')]);
    assert.deepEqual(read('enters'), ['main']);
  });
  pane.ws.close();

  for (const view of ['agents', 'transcript']) {
    console.log(`\n# the ${view} view, open before the send`);
    pane = await openPane(`claude-${view}`, view);
    setMode({ view });
    const refused = await send(pane);
    check('nothing is typed and no Enter is pressed: the send is refused and says why', () => {
      assert.equal(refused.status, 409, `answered ${refused.status}: ${JSON.stringify(refused.body)}`);
      assert.equal(refused.body.code, 'input-pane-view');
      assert.deepEqual(read('pastes'), [], 'the prompt was typed');
      assert.deepEqual(read('enters'), []);
      assert.deepEqual(read('created-session'), []);
    });
    pane.ws.close();
  }

  console.log('\n# the agents view, opened while AM waits for its paste to show');
  pane = await openPane('claude-agents-race', 'main');
  setMode({ view: 'main', viewOnPaste: 'agents' });
  const raced = await send(pane);
  check('the placeholder in the agents composer is not ours to submit: no Enter, no new session', () => {
    assert.equal(raced.status, 409, `answered ${raced.status}: ${JSON.stringify(raced.body)}`);
    assert.equal(raced.body.code, 'input-pane-view');
    assert.equal(read('pastes').length, 1);
    assert.deepEqual(read('enters'), [], 'an Enter was pressed into the agents composer');
    assert.deepEqual(read('created-session'), []);
  });
  check('and it fails as soon as the view shows, without waiting out the 3 s paste timeout', () => {
    assert.ok(raced.ms < 2500, `took ${raced.ms} ms`);
  });
  pane.ws.close();
} catch (error) {
  failed++; console.log(`  FAIL no unexpected exception\n       ${error.stack}`);
} finally {
  backend.kill('SIGTERM');
  await new Promise((r) => { backend.once('exit', r); setTimeout(r, 2000); });
  fs.rmSync(root, { recursive: true, force: true });
}
if (failed) { console.log(`\n${failed} check(s) failed\n${logs.slice(-1500)}`); process.exit(1); }
console.log('\nclaude-pane-view: all checks passed');
