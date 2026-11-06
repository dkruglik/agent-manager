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
fs.mkdirSync(path.join(TMP, 'data'), { recursive: true });
fs.writeFileSync(path.join(BIN, 'cursor-agent'), '#!/bin/sh\necho 0.0.0-stub\n', { mode: 0o755 });

process.env.DATA_DIR = path.join(TMP, 'data');
process.env.HOME = HOME;
process.env.AM_REPIN_DIR = path.join(TMP, 'repin');
process.env.AM_INPUT_REQUIRED_DIR = path.join(TMP, 'input-required');
process.env.PATH = `${BIN}:${process.env.PATH}`;
delete process.env.XDG_CONFIG_HOME;
delete process.env.CURSOR_API_KEY;

const { cliById, cliCatalog, launchFlags } = await import('../src/config.js');
const sessions = await import('../src/sessions.js');
const runner = await import('../src/runner.js');
sessions.init();

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
check('noUpdate names the image pin', /prebuilt build in the image/.test(cursor?.noUpdate || ''), true);
check('noUpdate says it is not an npm package', /not an npm package/.test(cursor?.noUpdate || ''), true);
check('has withPrompt, so a quickstart prompt is queued for the launch line', typeof cursor?.withPrompt, 'function');
check('unpinned withPrompt carries flags and prompt', cursor?.withPrompt("'hi'", [], "--model 'm'"), "cursor-agent --trust --model 'm' -- 'hi'");
console.log('\nsetup text and credentials');
check('secrets list the key', JSON.stringify(row().secrets), '["CURSOR_API_KEY"]');
check('signIn is null', row().signIn ?? null, null);
check('setup recommends the key', /CURSOR_API_KEY/.test(row().setup || ''), true);
check('setup does not promise a sign-in walkthrough', /walks you through/.test(row().setup || ''), false);

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

console.log('\nevery pane is pinned to its own chat id');
const mk = (fields = {}) => {
  const c = sessions.create({ name: 'cur', cli: 'cursor', path: fields.path ?? 'proj-a' });
  return sessions.update(c.id, fields);
};
const first = mk();
check('sessionUuid is minted', /^[0-9a-f-]{36}$/.test(first.sessionUuid), true);
check('first launch resumes its own id', runner.commandFor(first), `exec cursor-agent --trust --resume ${first.sessionUuid}`);
const seeded = mk({ pendingPrompt: "fix it; don't" });
check('a queued first prompt is appended, quoted', runner.commandFor(seeded),
  `exec cursor-agent --trust --resume ${seeded.sessionUuid} -- 'fix it; don'\\''t'`);
const again = sessions.update(seeded.id, { everStarted: true, pendingPrompt: "fix it; don't" });
check('a later launch is the same line without the prompt', runner.commandFor(again),
  `exec cursor-agent --trust --resume ${seeded.sessionUuid}`);
const modelled = mk({ model: 'grok-4.7-low' });
check('the model flag rides the resume line', runner.commandFor(modelled),
  `exec cursor-agent --trust --resume ${modelled.sessionUuid} --model 'grok-4.7-low'`);
const modelledSeeded = mk({ model: 'grok-4.7-low', pendingPrompt: 'hi' });
check('flags come before the positional prompt', runner.commandFor(modelledSeeded),
  `exec cursor-agent --trust --resume ${modelledSeeded.sessionUuid} --model 'grok-4.7-low' -- 'hi'`);
const bad = mk({ sessionUuid: 'x; rm -rf /', pendingPrompt: 'hi' });
const badLine = runner.commandFor(bad);
check('a malformed id runs unpinned, keeping the queued prompt', badLine, "exec cursor-agent --trust -- 'hi'");
check('the malformed id never reaches the line', badLine.includes('rm -rf'), false);
const badQ = mk({ sessionUuid: 'x; rm -rf /', pendingPrompt: "it's" });
check('a malformed id keeps the queued prompt, unpinned', runner.commandFor(badQ), "exec cursor-agent --trust -- 'it'\\''s'");
check('a malformed id never gets --resume', runner.commandFor(badQ).includes('--resume'), false);
const yolo = mk({ pendingPrompt: '--yolo' });
const yoloLine = runner.commandFor(yolo);
check('a prompt that looks like a flag follows --', yoloLine.includes(" -- '--yolo'"), true);
check('a flag-looking prompt is never a bare argument', yoloLine.replace(" -- '--yolo'", '').includes('--yolo'), false);
const gone = mk({ sessionUuid: null });
check('a missing id falls back to a plain run', runner.commandFor(gone), 'exec cursor-agent --trust');
const a = mk({ path: 'shared' }), b = mk({ path: 'shared' });
check('two panes in one folder get different ids', runner.commandFor(a) !== runner.commandFor(b), true);
check('never --continue', [first, seeded, again, modelled, bad, gone, a, b].some((x) => runner.commandFor(x).includes('--continue')), false);

fs.rmSync(TMP, { recursive: true, force: true });
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
