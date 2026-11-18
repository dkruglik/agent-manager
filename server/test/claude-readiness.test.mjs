// Is a Claude Code pane ready to take a pasted prompt — and if not, why?
//
// Claude Code has views where its own composer is not on screen. In the
// detailed transcript view (ctrl+o) a paste is dropped. In the agents view
// (left arrow twice) the composer belongs to the agents list, takes the paste
// as `[Pasted text #N +L lines]` just like the session's own composer, and an
// Enter there starts a NEW background session with that text as its task.
// readiness() names those views and the usual reasons not to type (a dialog,
// a busy line, a placeholder already waiting) from one screen, without a pty.
// The screens are captured from the real CLI (fixtures/claude-screens.json).
//
// Run with:  node test/claude-readiness.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readiness, paneView, pastePlaceholder } from '../src/runner.js';
import { CLIS } from '../src/config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCREENS = JSON.parse(fs.readFileSync(path.join(HERE, 'fixtures/claude-screens.json'), 'utf8'));
const CLAUDE = CLIS.find((c) => c.id === 'claude').confirmSubmit;
const CODEX = CLIS.find((c) => c.id === 'codex').confirmSubmit;
let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++; console.log(`  FAIL ${what}\n       ${e.message.split('\n')[0]}`);
  }
};
const snap = (rows, cursorRow, cursorCol) => ({ cursorRow, cursorCol, isAltScreen: false, visibleLines: rows.map((text, row) => ({ row, text })) });
const RULE = '─'.repeat(60);

console.log('\n# Claude Code 2.1.325 screens');
for (const [screen, expected] of [
  ['empty', 'ready'],
  ['typed', 'line-busy'],
  ['placeholder', 'placeholder-shown'],
  ['transcript', 'transcript-view'],
  ['agents', 'agents-view'],
  ['agentsPlaceholder', 'agents-view'],
  ['dialog', 'dialog'],
]) {
  check(`${screen}: ${expected}`, () => assert.equal(readiness(SCREENS[screen], CLAUDE), expected));
}

console.log('\n# the views, named from the rows below the lowest rule');
check('the session composer is no view', () => {
  assert.equal(paneView(SCREENS.empty, CLAUDE), null);
  assert.equal(paneView(SCREENS.placeholder, CLAUDE), null);
});
check('a paste waiting in the agents composer is the agents view, not a placeholder of ours', () => {
  assert.equal(paneView(SCREENS.agentsPlaceholder, CLAUDE), 'agents-view');
});
check('the same words in the conversation above the composer are not a view', () => {
  const s = snap(['  Showing detailed transcript · ctrl+o to toggle', '  type enter to create a session', RULE, '❯ ', RULE, '  Opus 5.5'], 3, 2);
  assert.equal(paneView(s, CLAUDE), null);
  assert.equal(readiness(s, CLAUDE), 'ready');
});
check('a CLI with no views configured never reports one', () => {
  assert.equal(paneView(SCREENS.agents, CODEX), null);
});

console.log('\n# what else keeps a paste out');
check('a busy pane is not idle, even with an empty composer', () => {
  const s = snap(['✻ Thinking… (3s · esc to interrupt)', RULE, '❯ ', RULE, '  Opus 5.5'], 2, 2);
  assert.equal(readiness(s, CLAUDE), 'not-idle');
});
check('a screen with no composer and no dialog is not idle, never ready', () => {
  assert.equal(readiness(snap(['  some full-screen view', '  nothing to type into'], 1, 0), CLAUDE), 'not-idle');
});
check('a placeholder with text next to it is a busy line, not a waiting placeholder', () => {
  const s = snap([RULE, '❯ [Pasted text #4 +3 lines] and more', RULE], 1, 38);
  assert.equal(readiness(s, CLAUDE), 'line-busy');
});
check('no snapshot is not idle', () => assert.equal(readiness(null, CLAUDE), 'not-idle'));

console.log('\n# the placeholder, parsed');
check('number and line count', () => {
  assert.deepEqual(pastePlaceholder('[Pasted text #5 +3 lines]'), { n: 5, lines: 3 });
  assert.deepEqual(pastePlaceholder('[Pastedtext#12+40lines]'), { n: 12, lines: 40 });
});
check('a paste with no newline has no line count', () => {
  assert.deepEqual(pastePlaceholder('[Pasted text #2]'), { n: 2, lines: 0 });
});
check('anything else is not a placeholder', () => {
  assert.equal(pastePlaceholder('[Pasted text #2 +3 lines] more'), null);
  assert.equal(pastePlaceholder('[Pasted Content 1063 chars]'), null);
  assert.equal(pastePlaceholder(''), null);
});

if (failed) { console.log(`\n${failed} check(s) failed`); process.exit(1); }
console.log('\nclaude-readiness: all checks passed');
