// Cursor CLI 2026.10.22 reads from its screen: Cursor's hooks do not fire in
// this version and it hides the terminal cursor, so the approval dialog and the
// empty composer are both found in the visible text. Screens are real captures
// (fixtures/cursor-screens.json, 120x40, replayed through libghostty-vt).
// Run with: node --test test/cursor-screen.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-screen-'));
Object.assign(process.env, {
  DATA_DIR: path.join(root, 'data'), HOME: path.join(root, 'home'),
  AM_INPUT_REQUIRED_DIR: path.join(root, 'input-required'), AM_REPIN_DIR: path.join(root, 'repin'),
});
fs.mkdirSync(process.env.DATA_DIR, { recursive: true });
const runner = await import('../src/runner.js');
const { createInputRequiredTracker } = await import('../src/input-required.js');
const { cliById } = await import('../src/config.js');

const SCREENS = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/cursor-screens.json'), 'utf8'));
const text = (snap) => snap.visibleLines.map((l) => l.text).join('\n');
const snapOf = (rows) => ({ cursorRow: 0, cursorCol: 0, isAltScreen: false, visibleLines: rows.map((t, row) => ({ row, text: t })) });

test('fixtures are the captured screens, with the working directory scrubbed', () => {
  for (const k of ['empty', 'typed', 'busy', 'approval']) assert.ok(SCREENS[k].visibleLines.length >= 30, k);
  assert.ok(!JSON.stringify(SCREENS).includes('claude-1000'));
  assert.match(text(SCREENS.approval), /Run this command\?/);
  assert.match(text(SCREENS.busy), /→ Add a follow-up\s+ctrl\+c to stop/);
});

test('approval dialog: a permission hit with a stable token', () => {
  const hit = runner.cursorApprovalOnScreen(text(SCREENS.approval));
  assert.equal(hit.kind, 'permission');
  assert.equal(hit.source, 'cursor-screen');
  assert.match(hit.token, /^[0-9a-f]{8,}$/);
  assert.equal(runner.cursorApprovalOnScreen(text(SCREENS.approval)).token, hit.token);
});

test('a different command is a different token', () => {
  const other = text(SCREENS.approval).replace('touch spike-file.txt in .', 'rm -rf build in .');
  const a = runner.cursorApprovalOnScreen(text(SCREENS.approval));
  const b = runner.cursorApprovalOnScreen(other);
  assert.ok(b, 'still a dialog');
  assert.notEqual(a.token, b.token);
});

test('idle, typed and busy screens are not approvals', () => {
  for (const k of ['empty', 'typed', 'busy']) assert.equal(runner.cursorApprovalOnScreen(text(SCREENS[k])), null, k);
});

test('the question quoted in an assistant message, with no option rows, is not an approval', () => {
  const said = ['  Cursor Agent', '', '  To do that I would ask:', '  Run this command?', '  and wait for you.', '', '  → Add a follow-up'].join('\n');
  assert.equal(runner.cursorApprovalOnScreen(said), null);
  assert.equal(runner.cursorApprovalOnScreen(''), null);
  assert.equal(runner.cursorApprovalOnScreen(undefined), null);
  const optionsOnly = ['  → Run (once) (y)', '    Run Everything (shift+tab)'].join('\n');
  assert.equal(runner.cursorApprovalOnScreen(optionsOnly), null, 'options without the question');
});

test('the tracker shows the dialog, and a dismissed one stays dismissed until a new command', () => {
  let screen = text(SCREENS.approval);
  const t = createInputRequiredTracker({ id: 'cur-1', runId: 'r1', cli: 'cursor', native: () => runner.cursorApprovalOnScreen(screen) });
  const state = t.get();
  assert.equal(state?.kind, 'permission');
  t.observeInput(); // the operator answers
  assert.equal(t.get(), null, 'same dialog, dismissed');
  screen = text(SCREENS.busy);
  assert.equal(t.get(), null, 'dialog gone');
  screen = text(SCREENS.approval).replace('touch spike-file.txt in .', 'ls in .');
  assert.equal(t.get()?.kind, 'permission', 'a new command shows again');
  t.close();
});

test('emptyPrompt (cursor): the placeholder composer is empty, typed text and a busy turn are not', () => {
  const ep = (k) => runner.emptyPrompt(SCREENS[k], text(SCREENS[k]), 'cursor');
  assert.equal(ep('empty'), true, 'fresh chat: "→ Plan, search, build anything"');
  assert.equal(ep('typed'), false);
  assert.equal(ep('busy'), false, 'ctrl+c to stop on the composer row');
  assert.equal(ep('approval'), false);
});

test('emptyPrompt (cursor): "→ Add a follow-up" after a turn is empty; with ctrl+c to stop it is busy', () => {
  const rows = (composer) => ['  Cursor Agent', '', '  PONG', '', '  ' + composer, '', '  Grok 4.7 256K Low', '  /data/workspaces/cursor-fixture · main'];
  const ep = (composer) => runner.emptyPrompt(snapOf(rows(composer)), rows(composer).join('\n'), 'cursor');
  assert.equal(ep('→ Add a follow-up'), true);
  assert.equal(ep('→ Add a follow-up' + ' '.repeat(80) + 'ctrl+c to stop'), false);
  assert.equal(ep('→ Add a follow-up now'), false, 'typed text that starts like the placeholder');
  assert.equal(emptyOf(['plain output, no composer']), false);
  function emptyOf(r) { return runner.emptyPrompt(snapOf(r), r.join('\n'), 'cursor'); }
});

test('cursor is a promptDetector CLI', () => {
  assert.equal(!!cliById('cursor').promptDetector, true);
  assert.equal(runner.hasPromptDetector('cursor'), true);
});

test('approval screens: the waiting status alone, or the option row alone, is a hit; the question alone is not', () => {
  const statusOnly = ['  $  touch x in .', '', '  Run this command?', '', '  Waiting for approval...'].join('\n');
  const optionOnly = ['  $  touch x in .', '', '  Run this command?', '', '  \u2192 Run (once) (y)', '    Run Everything (shift+tab)'].join('\n');
  const questionOnly = ['  $  touch x in .', '', '  Run this command?', '', '  something else'].join('\n');
  assert.equal(runner.cursorApprovalOnScreen(statusOnly)?.kind, 'permission', 'status without an option row');
  assert.equal(runner.cursorApprovalOnScreen(optionOnly)?.kind, 'permission', 'option row without the status');
  assert.equal(runner.cursorApprovalOnScreen(questionOnly), null, 'question alone');
  assert.equal(runner.cursorApprovalOnScreen(statusOnly).token, runner.cursorApprovalOnScreen(optionOnly).token, 'same command, same token');
});

test('cursorNativePoll: a throwing screen read keeps the last hit, logs once, and a later null clears it', () => {
  const logs = [];
  let screen = text(SCREENS.approval);
  const poll = runner.cursorNativePoll(() => { if (screen instanceof Error) throw screen; return screen; }, (m) => logs.push(m));
  const hit = poll();
  assert.equal(hit?.kind, 'permission');
  screen = new Error('vt gone');
  assert.deepEqual(poll(), hit, 'a throw keeps the badge');
  assert.deepEqual(poll(), hit, 'and keeps it on the next throw');
  assert.equal(logs.length, 1, 'logged once, not every poll');
  assert.match(logs[0], /vt gone/);
  screen = text(SCREENS.busy);
  assert.equal(poll(), null, 'a real read without the dialog clears it');
  screen = new Error('again');
  assert.equal(poll(), null, 'nothing to keep once cleared');
});

test('the tracker keeps a shown badge through a throwing poll', () => {
  let screen = text(SCREENS.approval);
  const poll = runner.cursorNativePoll(() => { if (screen instanceof Error) throw screen; return screen; }, () => {});
  const t = createInputRequiredTracker({ id: 'cur-2', runId: 'r2', cli: 'cursor', native: poll });
  assert.equal(t.get()?.kind, 'permission');
  screen = new Error('boom');
  assert.equal(t.get()?.kind, 'permission', 'badge not cleared by a failed read');
  t.close();
});

test.after(() => fs.rmSync(root, { recursive: true, force: true }));
