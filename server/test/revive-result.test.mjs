// Revive reports a settled result per session: sent, skipped or gave-up.
//
// The Slack drain must not send a prompt before the continue message, nor race
// it, so it waits on reviveResult(id). Definitions (docs/session-revive.md):
//   sent     the continue message was delivered
//   gave-up  revive wanted to tell it and could not: no empty prompt in time,
//            over the cap, a privacy lock, or the delivery failed
//   skipped  nothing will be sent: continue off, not in the plan, no prompt
//            detector, not a revived agent, or revive did not run
// Real runner PTYs with a small fake CLI; clocks are injected (gapMs, readyMs,
// max) so nothing waits for the production 4 s stagger or 120 s limit.
//
// Run with: node test/revive-result.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'revive-result-'));
for (const k of Object.keys(process.env)) {
  if (/^(CLAUDE_CONFIG_DIR|CODEX_HOME|GEMINI_CLI_HOME|OPENCODE_\w+|HERMES_HOME|OPENCLAW_HOME|FX_HOME|XDG_\w+|AM_\w+)$/.test(k)) delete process.env[k];
}
Object.assign(process.env, {
  DATA_DIR: path.join(root, 'data'), HOME: path.join(root, 'home'), AM_LOCAL: path.join(root, 'local'),
  AM_INPUT_REQUIRED_DIR: path.join(root, 'input-required'), AM_BASHRC: '/nonexistent',
  AM_INPUT_READY_QUIET_MS: '300',
});
for (const d of [process.env.DATA_DIR, process.env.HOME, process.env.AM_LOCAL]) fs.mkdirSync(d, { recursive: true });
const config = await import('../src/config.js');
const sessions = await import('../src/sessions.js');
const runner = await import('../src/runner.js');
const runstate = await import('../src/runstate.js');

let failed = 0;
const check = async (what, fn) => {
  try { await fn(); console.log(`  ok  ${what}`); } catch (e) {
    failed++; console.log(`  FAIL ${what}\n       ${String(e.message).split('\n')[0]}`);
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// 'pending' if the promise has not settled by the time the loop has turned a few times.
const state = async (p) => Promise.race([p, sleep(150).then(() => 'pending')]);
const gate = () => { let open; const p = new Promise((r) => { open = r; }); return { p, open }; };

const fixture = path.join(root, 'fake-cli.mjs');
fs.writeFileSync(fixture, `
process.stdin.setRawMode(true);
import fs from 'node:fs';
const dialogIds = (() => { try { return fs.readFileSync(process.argv[2], 'utf8').split('\\n'); } catch { return []; } })();
if (dialogIds.includes(process.env.AM_ID)) process.stdout.write('Trust this folder?\\r\\n  1. Yes\\r\\n  2. No\\r\\n');
else process.stdout.write('Agent composer ready\\r\\n> ');
process.stdin.on('data', () => {});
setInterval(() => {}, 1000);
`);
const agent = config.cliById('hermes');
const dialogFile = path.join(root, 'dialog-ids');
agent.run = () => `${process.execPath} ${fixture} ${dialogFile}`; agent.cont = null;
const as = () => {};
let clock = 0;
const make = (name, cli = 'hermes') => {
  const s = sessions.create({ name, cli, path: name });
  return sessions.update(s.id, { everStarted: true, lastInputAt: Date.now() + (clock++) * 1000 });
};
const wentDown = (...ids) => {
  fs.writeFileSync(path.join(process.env.DATA_DIR, 'runstate.json'), JSON.stringify({
    at: new Date().toISOString(), sessions: Object.fromEntries(ids.map((id) => [id, { running: true }])) }));
  runstate.init();
};
const FAST = { gapMs: 0, readyMs: 1500 };

try {
  console.log('\n# 1. revive did not run, or ran with nothing to do');
  await check('a waiter registered before reviveOnBoot resolves skipped when revive is disabled', async () => {
    runstate.init();
    const w = runstate.reviveResult('anyone');
    assert.equal(await state(w), 'pending');
    await runstate.reviveOnBoot({ enabled: false });
    assert.equal(await state(w), 'skipped');
    assert.equal(await state(runstate.reviveResult('later')), 'skipped');
  });
  await check('no previous run: skipped for everyone', async () => {
    fs.rmSync(path.join(process.env.DATA_DIR, 'runstate.json'), { force: true });
    runstate.init();
    const w = runstate.reviveResult('anyone');
    await runstate.reviveOnBoot({ ...FAST });
    assert.equal(await state(w), 'skipped');
  });
  await check('reviveSkipAll() frees waiters when index.js never calls reviveOnBoot (locked Space)', async () => {
    runstate.init();
    const w = runstate.reviveResult('anyone');
    assert.equal(await state(w), 'pending');
    runstate.reviveSkipAll();
    assert.equal(await state(w), 'skipped');
  });
  await check('init() starts a new round: an earlier verdict does not answer for it', async () => {
    runstate.init();
    assert.equal(await state(runstate.reviveResult('x')), 'pending');
    runstate.reviveSkipAll();
  });

  console.log('\n# 2. one boot, every branch');
  as('composer');
  const told = make('told');
  const stuck = make('stuck');        // a dialog: never an empty prompt
  const over = make('over-cap');
  const sh = make('a-shell', 'shell');
  const absent = make('not-in-snapshot');
  sessions.update(told.id, { lastInputAt: Date.now() + 9000 });
  sessions.update(stuck.id, { lastInputAt: Date.now() + 8000 });
  sessions.update(sh.id, { lastInputAt: Date.now() + 7000 });
  sessions.update(over.id, { lastInputAt: Date.now() + 6000 });
  // The dialog session needs the dialog fake; the others the composer. The
  // command is read at launch, so switch it per session by name.
  fs.writeFileSync(dialogFile, stuck.id);   // the fake CLI shows a dialog for this one
  const hold = gate();
  const sentTo = [];
  wentDown(told.id, stuck.id, sh.id, over.id);
  const early = [told, stuck, over, sh, absent].map((s) => runstate.reviveResult(s.id));
  const run = runstate.reviveOnBoot({
    ...FAST, max: 3,
    send: async (s) => { sentTo.push(s.id); await hold.p; },
  });
  await check('over the cap: gave-up as soon as the plan is known, without waiting for CONTINUE_TEXT', async () => {
    assert.equal(await Promise.race([early[2], sleep(3000).then(() => 'late')]), 'gave-up');
  });
  await check('a session the plan did not include: skipped', async () => assert.equal(await early[4], 'skipped'));
  await check('no empty prompt in time: gave-up, while another send is still unfinished', async () => {
    assert.equal(await early[1], 'gave-up');
    assert.equal(await state(early[0]), 'pending');   // told: send is held, not yet sent
  });
  await check('a shell (never told): skipped', async () => assert.equal(await early[3], 'skipped'));
  hold.open();
  await check('delivered: sent, only after send() returned', async () => {
    assert.equal(await early[0], 'sent');
    assert.deepEqual(sentTo, [told.id]);
  });
  await run;
  await check('asking again after it settled gives the same answer', async () => {
    assert.equal(await runstate.reviveResult(told.id), 'sent');
    assert.equal(await runstate.reviveResult(over.id), 'gave-up');
  });
  await runner.stopAll();

  console.log('\n# 3. continue off');
  as('composer');
  const quiet = make('quiet');
  wentDown(quiet.id);
  const q = runstate.reviveResult(quiet.id);
  await runstate.reviveOnBoot({ ...FAST, continue: false, send: async () => { throw new Error('must not send'); } });
  await check('continue: false is skipped for a revived session and for the rest', async () => {
    assert.equal(await q, 'skipped');
    assert.equal(await runstate.reviveResult(absent.id), 'skipped');
  });
  await runner.stopAll();

  console.log('\n# 4. a privacy lock');
  as('composer');
  const locked = make('locked');
  wentDown(locked.id);
  const c = new AbortController();
  const lockRes = runstate.reviveResult(locked.id);
  await runstate.reviveOnBoot({
    ...FAST, gapMs: 200,
    scope: () => ({ signal: c.signal, release() {} }),
    send: async () => { throw new Error('must not send'); },
  });
  c.abort();
  await check('a lock landing before delivery: gave-up', async () => assert.equal(await lockRes, 'gave-up'));
  await runner.stopAll();

  console.log('\n# 5. delivery fails');
  as('composer');
  const broken = make('broken');
  wentDown(broken.id);
  const b = runstate.reviveResult(broken.id);
  const logged = [];
  const consoleError = console.error;
  console.error = (...args) => logged.push(args.join(' '));
  const quoting = Object.assign(new Error('unsent text on its input line ("PASSWORD=hunter2-from-the-terminal")'), { code: 'input-line-busy' });
  try {
    await runstate.reviveOnBoot({ ...FAST, send: async () => { throw quoting; } });
    await b; // the message goes out after the slot, off the stagger
  } finally { console.error = consoleError; }
  await check('send() throwing is gave-up', async () => assert.equal(await b, 'gave-up'));
  await check('the log names the error code, never the terminal text its message quotes', async () => {
    assert.ok(logged.some((l) => l.includes('input-line-busy')), logged.join('\n'));
    assert.ok(logged.every((l) => !l.includes('hunter2')), logged.join('\n'));
  });
  await runner.stopAll();

  console.log('\n# 6. the operator got there first');
  as('composer');
  const mine = make('mine');
  wentDown(mine.id);
  const m = runstate.reviveResult(mine.id);
  runner.ensureRunning(sessions.get(mine.id));   // launched since boot: the slot leaves it alone
  await runstate.reviveOnBoot({ ...FAST, send: async () => { throw new Error('must not send'); } });
  await check('a session launched by someone else before its slot: skipped', async () => assert.equal(await m, 'skipped'));
} catch (e) {
  failed++;
  console.log(`  FAIL ${e.stack}`);
} finally {
  await runner.stopAll();
  fs.rmSync(root, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
