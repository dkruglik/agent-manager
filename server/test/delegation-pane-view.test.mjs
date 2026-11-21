// A delegation callback to a Claude parent that shows its agents view.
//
// The callback goes through notifyClaudeOnce (delegations.js), which writes a
// receipt before the paste. Refused before the paste (`input-pane-view`, not
// typed), the receipt is cleared and the next tick may try again; once the
// operator is back in the conversation it is delivered exactly once. Refused
// after the paste (the view opened while AM waited for it to show), it is
// `delegation-notify-uncertain` with a `submitted` receipt, and it is never
// pasted again. Driven through real runner PTYs and the Claude screen fake
// (fixtures/fake-claude-tui.mjs); no server, no model.
//
// Run with: node test/delegation-pane-view.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { test, after } from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'delegation-pane-view-'));
for (const k of Object.keys(process.env)) {
  if (/^(CLAUDE_CONFIG_DIR|CODEX_HOME|GEMINI_CLI_HOME|OPENCODE_\w+|HERMES_HOME|OPENCLAW_HOME|FX_HOME|XDG_\w+|AM_\w+)$/.test(k)) delete process.env[k];
}
const FAKE_DIR = path.join(root, 'fake'); fs.mkdirSync(FAKE_DIR);
Object.assign(process.env, {
  DATA_DIR: path.join(root, 'data'), HOME: path.join(root, 'home'), AM_LOCAL: path.join(root, 'local'),
  AM_INPUT_REQUIRED_DIR: path.join(root, 'input-required'), AM_BASHRC: '/nonexistent',
  AM_PASTE_SHOWN_TIMEOUT_MS: '2000', AM_SUBMIT_CONFIRM_TIMEOUT_MS: '1000',
  AM_TEST_CLAUDE_CMD: `env FAKE_DIR=${FAKE_DIR} ${process.execPath} ${path.join(HERE, 'fixtures', 'fake-claude-tui.mjs')}`,
});
for (const d of [process.env.DATA_DIR, process.env.HOME, process.env.AM_LOCAL]) fs.mkdirSync(d, { recursive: true });
const sessions = await import('../src/sessions.js');
const runner = await import('../src/runner.js');
const { notifyClaudeOnce, readNotifyReceipt } = await import('../src/delegations.js');
after(async () => { await runner.stopAll(); fs.rmSync(root, { recursive: true, force: true }); });

const JOURNAL = path.join(root, 'delegations');
const RESULT = '[message from child:] [AM source {}]\n[AM delegation result X]\nOutcome: completed.\nThis is a one-shot follow-up.';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await sleep(50); } return false; };
const lines = (f) => { try { return fs.readFileSync(path.join(FAKE_DIR, f), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
const setMode = (m) => {
  fs.writeFileSync(path.join(FAKE_DIR, 'mode'), JSON.stringify(m));
  for (const f of ['pastes', 'enters', 'submitted', 'created-session']) fs.rmSync(path.join(FAKE_DIR, f), { force: true });
};
const fails = async (promise) => { try { await promise; } catch (e) { return e; } assert.fail('expected a rejection'); };
let n = 0;
const parent = async (mark) => {
  const s = sessions.create({ name: `parent-${++n}`, cli: 'test-claude', path: `parent-${n}` });
  sessions.update(s.id, { everStarted: true, lastInputAt: Date.now() });
  runner.ensureRunning(sessions.get(s.id));
  assert.ok(await until(() => String(runner.capturePane(s.id)).includes(mark)), `the pane never showed ${mark}`);
  return s.id;
};
const callback = (id, callbackId) => notifyClaudeOnce(JOURNAL, callbackId, () => runner.sendInput(id, RESULT));

test('agents view before the paste: nothing typed, receipt cleared, delivered once the operator is back', async () => {
  setMode({ view: 'agents' });
  const id = await parent('describe a task for a new session');
  const callbackId = randomUUID();
  const refused = await fails(callback(id, callbackId));
  assert.equal(refused.code, 'input-pane-view');
  assert.equal(readNotifyReceipt(JOURNAL, callbackId), null, 'the next tick may try again');
  assert.deepEqual(lines('pastes'), []);

  setMode({ view: 'main' });
  assert.ok(await until(() => String(runner.capturePane(id)).includes('Try "')), 'the operator never got back to the conversation');
  await callback(id, callbackId);
  assert.equal(readNotifyReceipt(JOURNAL, callbackId)?.status, 'accepted');
  assert.deepEqual(lines('submitted'), [JSON.stringify('[Pasted text #1 +3 lines]')]);
  assert.deepEqual(lines('created-session'), []);
  runner.stop(id);
});

test('agents view opened after the paste: no Enter, uncertain, never pasted again', async () => {
  setMode({ view: 'main', viewOnPaste: 'agents' });
  const id = await parent('Try "');
  const callbackId = randomUUID();
  const uncertain = await fails(callback(id, callbackId));
  assert.equal(uncertain.code, 'delegation-notify-uncertain');
  assert.equal(readNotifyReceipt(JOURNAL, callbackId)?.status, 'submitted');
  assert.equal(lines('pastes').length, 1);
  assert.deepEqual(lines('enters'), [], 'an Enter went into the agents composer');
  assert.deepEqual(lines('created-session'), []);

  const again = await fails(callback(id, callbackId));
  assert.equal(again.code, 'delegation-notify-uncertain');
  assert.match(again.message, /not pasted again/);
  assert.equal(lines('pastes').length, 1, 'the callback was pasted twice');
  runner.stop(id);
});
