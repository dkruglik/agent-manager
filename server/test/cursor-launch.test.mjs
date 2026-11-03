// The Cursor CLI (`cursor-agent`) in the registry: how a pane is launched and
// resumed, which flags a session setting maps to, and when it counts as ready.
// `cursor-agent --continue` is cwd-scoped, so there is deliberately no `cont`.
// cliCatalog() memoizes `command -v`, so a stub `cursor-agent` is put on PATH
// before config.js loads; credentials are read live and varied per check.
// Run with: node test/cursor-launch.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-launch-'));
const HOME = path.join(TMP, 'home');
const BIN = path.join(TMP, 'bin');
fs.mkdirSync(HOME, { recursive: true });
fs.mkdirSync(BIN, { recursive: true });
fs.writeFileSync(path.join(BIN, 'cursor-agent'), '#!/bin/sh\necho 0.0.0-stub\n', { mode: 0o755 });

process.env.DATA_DIR = path.join(TMP, 'data');
process.env.HOME = HOME;
process.env.PATH = `${BIN}:${process.env.PATH}`;
delete process.env.XDG_CONFIG_HOME;
delete process.env.CURSOR_API_KEY;

const { cliById, cliCatalog, launchFlags } = await import('../src/config.js');

let pass = 0, fail = 0;
const check = (name, got, want) => {
  const ok = got === want;
  ok ? pass++ : fail++;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n          got ${got}\n         want ${want}`}`);
};
const row = () => cliCatalog().find((c) => c.id === 'cursor');
const cursor = cliById('cursor');

console.log('the catalog entry');
check('cursor is registered', !!cursor, true);
check('binary is cursor-agent', cursor?.bin, 'cursor-agent');
check('not updated through npm', !!cursor?.noUpdate && !cursor?.npm, true);
check('no cont: --continue is cwd-scoped', cursor?.cont, undefined);

console.log('\nlaunch lines');
const ID = '79cd3d9b-b387-44da-91c0-2df98a2ae37e';
check('run trusts the folder, nothing else', cursor?.run(''), 'cursor-agent --trust');
const resumed = cursor?.resume(ID, "--model 'x'");
check('resume keeps trust, id and flags', resumed, `cursor-agent --trust --resume ${ID} --model 'x'`);
check('never auto-approves tools', /--yolo|--force/.test(`${cursor?.run('')} ${resumed}`), false);

console.log('\nsession settings');
check('model only; effort is part of the model id', launchFlags({ cli: 'cursor', model: 'grok-4.7-low', effort: 'high' }), "--model 'grok-4.7-low'");
check('no model, no flags', launchFlags({ cli: 'cursor' }), '');

console.log('\nready');
check('available with the stub on PATH', row().available, true);
check('not ready with no credential', row().ready, false);
process.env.CURSOR_API_KEY = 'key';
check('ready with CURSOR_API_KEY', row().ready, true);
delete process.env.CURSOR_API_KEY;
const dir = path.join(HOME, '.config', 'cursor');
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'auth.json'), '');
check('an empty auth.json is not a credential', row().ready, false);
fs.writeFileSync(path.join(dir, 'auth.json'), '{"accessToken":"t"}');
check('ready with a signed-in auth.json', row().ready, true);
process.env.XDG_CONFIG_HOME = path.join(TMP, 'xdg');
check('XDG_CONFIG_HOME moves the lookup', row().ready, false);
delete process.env.XDG_CONFIG_HOME;

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
