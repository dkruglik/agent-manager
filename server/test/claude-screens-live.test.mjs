// am-test: manual — drives the installed Claude Code CLI, logged in under $HOME; no model calls.
//
// Does AM still recognise the installed Claude Code's screens?
//
// runner.js readiness()/paneView() name Claude's views from footer phrases
// (CLAUDE_CONFIRM.views in config.js) captured from Claude Code 2.1.325. If a
// newer Claude rewords them, nothing fails: the agents view simply reads as the
// session's composer again, and a message sent while the operator looks at the
// agents list becomes a NEW background session. The other suites replay the
// recorded screens, so only this one notices. Run it after a Claude update and
// before a deploy (docs/testing.md, "Claude screens").
//
// It starts the installed `claude` in a fresh scratch folder through node-pty
// and libghostty-vt, exactly as runner.js reads a pane, and walks the screens
// without submitting anything: trust dialog, empty composer, typed text, a
// pasted placeholder, the transcript view (ctrl+o) and the agents view (left
// arrow twice), with and without a paste in its composer.
//
// Side effects: Claude records the scratch folder as trusted in ~/.claude.json
// (the folder itself is deleted afterwards). Nothing is sent to a model.
//
// AM_CLAUDE_SCREENS_SAVE=<file> also writes the screens it saw in the format of
// fixtures/claude-screens.json, to refresh that fixture after a Claude change.
// Review the file before committing it: the agents view lists this home's other
// sessions by title.
//
// Run with:  npm test -- claude-screens-live --manual
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import pty from 'node-pty';
import { readiness, pastePlaceholder } from '../src/runner.js';
import { CLIS } from '../src/config.js';

const ghostty = await import('@coder/libghostty-vt-node');
const CLAUDE = CLIS.find((c) => c.id === 'claude').confirmSubmit;
const COLS = 120, ROWS = 32, WAIT_MS = 20_000;
let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++; console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};

let version = '';
try { version = execFileSync('claude', ['--version'], { encoding: 'utf8', timeout: 15_000 }).trim(); } catch (e) {
  console.log(`claude-screens-live: no usable claude CLI on PATH (${e.message.split('\n')[0]})`);
  process.exit(1);
}
console.log(`\n# ${version}`);

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-screens-live-'));
const vt = ghostty.createTerminal({ cols: COLS, rows: ROWS, scrollbackLimit: 1 << 20 });
// A Claude started from inside another Claude session inherits markers that
// change its screen (no transcript saving notice, child-session behavior).
const env = Object.fromEntries(Object.entries({ ...process.env, TERM: 'xterm-256color' })
  .filter(([k]) => !/^CLAUDE_?CODE|^CLAUDECODE/.test(k)));
const p = pty.spawn('claude', [], { name: 'xterm-256color', cols: COLS, rows: ROWS, cwd: work, env });
p.onData((d) => vt.feed(d));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const text = () => vt.getVisibleText();
const snapshot = () => {
  const s = vt.snapshot({ includeCells: false });
  return { cursorRow: s.cursorRow, cursorCol: s.cursorCol, isAltScreen: !!s.isAltScreen,
    visibleLines: (s.visibleLines || []).map((l) => ({ row: l.row, text: l.text })) };
};
// Whether the screen shows `re` within `ms`, then lets it settle.
async function seen(re, ms = WAIT_MS) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (re.test(text())) { await sleep(600); return true; } await sleep(100); }
  return false;
}
// The same, for a screen that must appear: a miss is a failure that shows the screen.
async function until(re, what) {
  if (await seen(re)) return true;
  failed++;
  console.log(`  FAIL ${what}: the screen never showed ${re}\n${text().split('\n').filter((l) => l.trim()).map((l) => `       | ${l}`).join('\n')}`);
  return false;
}
const screens = {};
const expect = (name, expected, what) => {
  const s = snapshot(); screens[name] = s;
  check(what, () => {
    const got = readiness(s, CLAUDE);
    if (got !== expected) {
      const shown = s.visibleLines.map((l) => l.text).filter((t) => t.trim()).map((t) => `       | ${t}`).join('\n');
      assert.fail(`readiness() is ${got}, expected ${expected}\n${shown}`);
    }
  });
  return s;
};
// Three newlines, like a delegation result: Claude collapses it to a placeholder.
const PASTE = '[message from child:] [AM source {}]\n[AM delegation result X]\nOutcome: completed.\nThis is a one-shot follow-up.';
const paste = () => p.write(`\x1b[200~${PASTE}\x1b[201~`);
const composerHint = /Try "|❯\s*$/m;

try {
  // A fresh folder asks for trust first, unless trust is already granted globally.
  if (await seen(/trust this folder|Try "/) && /trust this folder/.test(text())) {
    expect('dialog', 'dialog', 'the workspace trust dialog is a dialog');
    p.write('\x1b[B'); await sleep(300); p.write('\r');
  }
  if (await until(composerHint, 'empty composer')) expect('empty', 'ready', 'the empty session composer is ready');

  p.write('half typed thought');
  if (await until(/half typed thought/, 'typed text')) expect('typed', 'line-busy', 'typed text on the composer is a busy line');
  p.write('\x15'); await sleep(800);

  paste();
  if (await until(/\[Pasted text #\d+/, 'placeholder')) {
    const s = expect('placeholder', 'placeholder-shown', 'a collapsed paste is a placeholder in the session composer');
    check('the placeholder carries the paste\'s line count', () => {
      const row = s.visibleLines.map((l) => l.text).find((t) => /\[Pasted text #\d+/.test(t)) || '';
      assert.equal(pastePlaceholder(row.replace(/^[\s❯>]+/, '').trim())?.lines, 3, row);
    });
  }
  p.write('\x15'); await sleep(800);

  p.write('\x0f');
  if (await until(/Showing detailed transcript|transcript/i, 'transcript view')) expect('transcript', 'transcript-view', 'ctrl+o: the transcript view is named');
  p.write('\x1b'); await until(composerHint, 'back from the transcript view');

  p.write('\x1b[D'); await sleep(400); p.write('\x1b[D');
  if (await until(/describe a task for a new session|moved to the background/, 'agents view')) {
    expect('agents', 'agents-view', 'left arrow twice: the agents view is named');
    paste();
    if (await until(/\[Pasted text #\d+/, 'paste in the agents view')) {
      expect('agentsPlaceholder', 'agents-view', 'a paste in the agents composer is still the agents view, never a placeholder of ours');
    }
    // Clear the agents composer without pressing Enter: Enter would start a session.
    p.write('\x1b'); await sleep(400); p.write('\x1b'); await sleep(800);
  }
} finally {
  p.write('\x03'); await sleep(300); p.write('\x03'); await sleep(800);
  try { p.kill(); } catch {}
  fs.rmSync(work, { recursive: true, force: true });
}

const out = process.env.AM_CLAUDE_SCREENS_SAVE;
if (out) {
  const json = JSON.stringify({ _about: `${version} screens (${COLS}x${ROWS}), captured by claude-screens-live.test.mjs. Review before committing: paths and the agents list come from this machine.`, ...screens }, null, 1)
    .split(work).join('/data/workspaces/claude-fixture').split(path.basename(work)).join('claude-fixture');
  fs.writeFileSync(out, `${json}\n`);
  console.log(`\nscreens written to ${out}`);
}
if (failed) {
  console.log(`\n${failed} check(s) failed: this Claude's screens no longer match CLAUDE_CONFIRM.views (server/src/config.js). See docs/testing.md, "Claude screens".`);
  process.exit(1);
}
console.log('\nclaude-screens-live: all checks passed');
