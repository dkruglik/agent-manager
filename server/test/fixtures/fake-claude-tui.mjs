#!/usr/bin/env node
// A pane that draws Claude Code 2.1.325's own screens (claude-screens.json)
// for server/test/claude-pane-view.test.mjs. Where it matters for delivery:
//   - main view: a bracketed paste shows as `❯ [Pasted text #N +L lines]`
//     (L = newlines in it, N counts up and is never reused), Enter submits it;
//   - agents view: the same paste goes into the agents list's composer, and
//     Enter there starts a NEW session (logged as `created-session`);
//   - transcript view (ctrl+o): a paste is dropped.
// $FAKE_DIR/mode is JSON, re-read every 100 ms:
//   view        — 'main' | 'agents' | 'transcript', the view drawn now;
//   viewOnPaste — switch to this view the moment a paste arrives (the
//                 operator opening the agents view while AM confirms).
// Every paste received is appended to $FAKE_DIR/pastes, every Enter to
// $FAKE_DIR/enters (with the view it landed in), every submit to
// $FAKE_DIR/submitted, and every session the agents composer would start to
// $FAKE_DIR/created-session.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const dir = process.env.FAKE_DIR;
const SCREENS = JSON.parse(fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'claude-screens.json'), 'utf8'));
const log = (file, line) => fs.appendFileSync(path.join(dir, file), `${line}\n`);
const mode = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'mode'), 'utf8')); } catch { return {}; } };
let view = mode().view || 'main';
let asked = view;   // the last view the mode file asked for
let composer = '';
let pastes = 0;
const draw = () => {
  const name = view === 'transcript' ? 'transcript'
    : view === 'agents' ? (composer ? 'agentsPlaceholder' : 'agents')
      : (composer ? 'placeholder' : 'empty');
  const screen = SCREENS[name];
  const rows = screen.visibleLines.map((l) => l.text.replace(/\[Pasted text #\d+ \+\d+ lines\]/, composer));
  const col = composer ? screen.cursorCol - '[Pasted text #1 +3 lines]'.length + composer.length : screen.cursorCol;
  process.stdout.write(`\x1b[2J\x1b[H${rows.join('\r\n')}\x1b[${screen.cursorRow + 1};${col + 1}H`);
};
// Only a change in the mode file moves the view; a switch made by a paste stays.
setInterval(() => { const m = mode(); if (m.view && m.view !== asked) { asked = view = m.view; draw(); } }, 100);
process.stdin.setRawMode?.(true);
draw();
let buf = '', inPaste = false, pasted = '';
process.stdin.on('data', (chunk) => {
  buf += chunk.toString('utf8');
  while (buf) {
    if (inPaste) {
      const end = buf.indexOf('\x1b[201~');
      if (end < 0) { pasted += buf; buf = ''; break; }
      pasted += buf.slice(0, end); buf = buf.slice(end + 6); inPaste = false;
      log('pastes', JSON.stringify(pasted.length));
      const m = mode();
      if (m.viewOnPaste) view = m.viewOnPaste;
      if (view !== 'transcript') composer = `[Pasted text #${++pastes} +${(pasted.match(/\r\n|\r|\n/g) || []).length} lines]`;
      draw();
      continue;
    }
    if (buf.startsWith('\x1b[200~')) { inPaste = true; pasted = ''; buf = buf.slice(6); continue; }
    const ch = buf[0]; buf = buf.slice(1);
    if (ch === '\r') {
      log('enters', `${view}${composer ? '' : '-empty'}`);
      if (!composer || view === 'transcript') continue;
      log(view === 'agents' ? 'created-session' : 'submitted', JSON.stringify(composer));
      composer = ''; draw();
    } else if (ch === '\x15') { composer = ''; draw(); }
  }
});
