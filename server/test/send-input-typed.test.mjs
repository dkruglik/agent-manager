// `sendInput` marks an error `typed: true` once the first byte of the prompt
// went to the terminal, and not before (docs/messengers.md, "Delivery per
// runtime"). The chat outbox reads that flag: an error without it means
// nothing was typed and the send may be tried again; one with it may already be
// on the agent's input line, so it is never replayed.
//
// Driven through real runner PTYs with small fake CLIs: a composer that echoes,
// OpenCode's no-echo mood, and the Codex-like fake of submit-confirm.test.mjs.
//
// Run with: node test/send-input-typed.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, after } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'send-input-typed-'));
for (const k of Object.keys(process.env)) {
  if (/^(CLAUDE_CONFIG_DIR|CODEX_HOME|GEMINI_CLI_HOME|OPENCODE_\w+|HERMES_HOME|OPENCLAW_HOME|FX_HOME|XDG_\w+|AM_\w+)$/.test(k)) delete process.env[k];
}
const FAKE_DIR = path.join(root, 'fake'); fs.mkdirSync(FAKE_DIR);
Object.assign(process.env, {
  DATA_DIR: path.join(root, 'data'), HOME: path.join(root, 'home'), AM_LOCAL: path.join(root, 'local'),
  AM_INPUT_REQUIRED_DIR: path.join(root, 'input-required'), AM_BASHRC: '/nonexistent',
  AM_INPUT_ECHO_TIMEOUT_MS: '1500', AM_PASTE_SHOWN_TIMEOUT_MS: '800', AM_SUBMIT_CONFIRM_TIMEOUT_MS: '500',
  AM_TEST_SUBMIT_CMD: `env FAKE_DIR=${FAKE_DIR} ${process.execPath} ${path.join(HERE, 'fixtures', 'fake-submit-tui.mjs')}`,
});
for (const d of [process.env.DATA_DIR, process.env.HOME, process.env.AM_LOCAL]) fs.mkdirSync(d, { recursive: true });
const config = await import('../src/config.js');
const sessions = await import('../src/sessions.js');
const runner = await import('../src/runner.js');
after(async () => { await runner.stopAll(); fs.rmSync(root, { recursive: true, force: true }); });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(50); } return false; };

// A `> ` composer that echoes what it is given; in mode `silent` it paints the
// OpenCode input box and never echoes (a handler that is not installed yet).
const fixture = path.join(root, 'fake-cli.mjs');
const received = path.join(root, 'received.txt');
fs.writeFileSync(fixture, `
import fs from 'node:fs';
const mode = process.argv[2];
process.stdin.setRawMode(true);
if (mode === 'silent') process.stdout.write('\\r\\n             \\u2503  \\r\\n             \\u2503\\r\\n             \\u2579\\u2580\\u2580\\u2580\\u2580\\u2580\\x1b[2A\\r\\x1b[16C');
else process.stdout.write('Agent composer ready\\r\\n> ');
process.stdin.on('data', (d) => {
  fs.appendFileSync(${JSON.stringify(received)}, d.toString());
  if (mode !== 'silent') process.stdout.write(d.toString().replace(/\\r/g, ''));
});
setInterval(() => {}, 1000);
`);
const as = (id, mode) => { const c = config.cliById(id); c.run = () => `${process.execPath} ${fixture} ${mode}`; c.cont = null; };
let n = 0;
const make = (cli) => {
  const s = sessions.create({ name: `typed-${++n}`, cli, path: `typed-${n}` });
  return sessions.update(s.id, { everStarted: true, lastInputAt: Date.now() });
};
const fakeMode = (m) => fs.writeFileSync(path.join(FAKE_DIR, 'mode'), JSON.stringify(m));
const fails = async (promise) => { try { await promise; } catch (e) { return e; } assert.fail('expected a rejection'); };
const painted = (id, mark) => until(() => String(runner.capturePane(id)).includes(mark));
const ready = (id) => until(() => runner.promptReady(id));

test('before the first write: no pane, and a line that already holds text', async () => {
  const none = await fails(runner.sendInput('missing-session', 'hello'));
  assert.equal(none.code, 'input-not-ready');
  assert.equal(none.typed, undefined);

  as('hermes', 'composer');
  const s = make('hermes');
  runner.ensureRunning(s);
  assert.ok(await ready(s.id), 'the fake composer never became ready');
  runner.pasteInput(s.id, 'half typed');
  assert.ok(await until(() => fs.existsSync(received) && fs.readFileSync(received, 'utf8').includes('half typed')));
  assert.ok(await painted(s.id, 'half typed'), 'the half-typed line never showed in the pane');
  const busy = await fails(runner.sendInput(s.id, 'second message'));
  assert.equal(busy.code, 'input-line-busy');
  assert.equal(busy.typed, undefined, 'nothing was typed, so a retry is safe');
  assert.equal(fs.readFileSync(received, 'utf8').includes('second message'), false);
  runner.stop(s.id);
});

test('OpenCode echo wait: a timeout and a stop never press Enter, so they are not typed; the line is cleared', async () => {
  as('opencode', 'silent');
  const s = make('opencode');
  runner.ensureRunning(s);
  assert.ok(await painted(s.id, '\u2503'), 'the fake box never painted');
  const timedOut = await fails(runner.sendInput(s.id, 'into the void', { confirmEcho: true }));
  assert.equal(timedOut.code, 'input-not-ready');
  assert.match(timedOut.message, /did not acknowledge/);
  assert.equal(timedOut.typed, undefined, 'Enter was never pressed: the send is still pending');
  assert.ok(await until(() => fs.readFileSync(received, 'utf8').endsWith('\x15')), 'the unsent text was cleared with Ctrl+U');
  runner.stop(s.id);

  const t = make('opencode');
  runner.ensureRunning(t);
  assert.ok(await painted(t.id, '\u2503'));
  const pending = fails(runner.sendInput(t.id, 'stopped midway', { confirmEcho: true }));
  assert.ok(await until(() => fs.readFileSync(received, 'utf8').includes('stopped midway')), 'the text never reached the box');
  runner.stop(t.id);
  const stopped = await pending;
  assert.equal(stopped.code, 'input-not-ready');
  assert.match(stopped.message, /stopped while waiting/);
  assert.equal(stopped.typed, undefined);
});

test('submit confirmation: not confirmed, not submitted and a stop are typed; a good send is not an error', async () => {
  const s = make('test-submit');
  runner.ensureRunning(s);
  assert.ok(await ready(s.id), 'the fake TUI never became ready');

  fakeMode({});
  await runner.sendInput(s.id, 'goes\nthrough');

  fakeMode({ paintMs: 5000 });
  const unseen = await fails(runner.sendInput(s.id, 'never\npainted'));
  assert.equal(unseen.code, 'input-not-confirmed');
  assert.equal(unseen.typed, true);
  runner.stop(s.id);

  const t = make('test-submit');
  runner.ensureRunning(t);
  assert.ok(await ready(t.id));
  fakeMode({ swallow: 5 });
  const swallowed = await fails(runner.sendInput(t.id, 'enter does\nnothing'));
  assert.equal(swallowed.code, 'input-not-submitted');
  assert.equal(swallowed.typed, true);
  runner.stop(t.id);

  const u = make('test-submit');
  runner.ensureRunning(u);
  assert.ok(await ready(u.id));
  fakeMode({ paintMs: 5000 });
  const pastes = () => (fs.existsSync(path.join(FAKE_DIR, 'pastes')) ? fs.readFileSync(path.join(FAKE_DIR, 'pastes'), 'utf8').split('\n').filter(Boolean).length : 0);
  const before = pastes();
  const pending = fails(runner.sendInput(u.id, 'stopped in\nconfirmation'));
  assert.ok(await until(() => pastes() > before), 'the paste never reached the fake');
  runner.stop(u.id);
  const stopped = await pending;
  assert.equal(stopped.code, 'input-not-ready');
  assert.match(stopped.message, /stopped while its prompt/);
  assert.equal(stopped.typed, true);
});

test('a pty write that throws marks nothing as typed, on the plain path and on the OpenCode path', async () => {
  as('hermes', 'composer');
  const s = make('hermes');
  runner.ensureRunning(s);
  assert.ok(await ready(s.id), 'the fake composer never became ready');
  const dead = () => { throw Object.assign(new Error('write EIO'), { code: 'EIO' }); };
  runner.__hostForTest(s.id).pty.write = dead;
  const plain = await fails(runner.sendInput(s.id, 'never reaches the terminal'));
  assert.equal(plain.message, 'write EIO');
  assert.equal(plain.typed, undefined, 'the first write threw: nothing was typed, a retry is safe');
  runner.stop(s.id);

  as('opencode', 'silent');
  const t = make('opencode');
  runner.ensureRunning(t);
  assert.ok(await painted(t.id, '┃'), 'the fake box never painted');
  runner.__hostForTest(t.id).pty.write = dead;
  const opencode = await fails(runner.sendInput(t.id, 'nor this one', { confirmEcho: true }));
  assert.equal(opencode.message, 'write EIO');
  assert.equal(opencode.typed, undefined);
  runner.stop(t.id);
});
