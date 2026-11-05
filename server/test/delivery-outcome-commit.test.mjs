// The commit point of a chat prompt for a never-started session, against the real session store
// (sessions.js on a temp DATA_DIR): the text is written first, and only then does the delivery count as committed.
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'am-delivery-commit-'));
process.env.DATA_DIR = TMP;
const sessions = await import('../src/sessions.js');
const { deliverToSession, commitPendingPrompt } = await import('../src/delivery-outcome.js');
sessions.init();

const onDisk = (id) => JSON.parse(fs.readFileSync(path.join(TMP, 'sessions.json'), 'utf8')).find((s) => s.id === id);
const launchFailed = Object.assign(new Error('launch failed'), { statusCode: 500, code: 'launch-failed' });
const wiring = (sendLocal) => ({
  shared: () => false, remote: () => false, limit: 1 << 16, log: () => {}, touch: () => {},
  sendCodex: async () => {}, sendLocal,
});
// What index.js does for a never-started withPrompt session, with the launch failing afterwards.
const viaStore = (failLaunch) => wiring(async (session, text, onCommitted) => {
  commitPendingPrompt(sessions, session, { prompt: text, onCommitted });
  if (failLaunch) throw launchFailed;
});

test('the prompt is written to the real store before the delivery counts as committed, even if the launch then fails', async () => {
  const s = sessions.create({ name: 'fresh', cli: 'claude' });
  const out = await deliverToSession(sessions.get(s.id), { text: 'from slack', requestId: 'r1' }, viaStore(true));
  assert.deepEqual(out, { state: 'delivered' });
  assert.equal(sessions.get(s.id).pendingPrompt, 'from slack');
  assert.equal(onDisk(s.id).pendingPrompt, 'from slack', 'on disk, not only in memory');
});

test('a pendingPrompt already in the store is never overwritten, and nothing is sent', async () => {
  const s = sessions.create({ name: 'webbed', cli: 'claude' });
  sessions.update(s.id, { pendingPrompt: 'typed in the web composer' });
  let sent = 0;
  const io = wiring(async () => { sent += 1; });
  const out = await deliverToSession(sessions.get(s.id), { text: 'from slack', requestId: 'r2' }, io);
  assert.deepEqual(out, { state: 'pending', reason: 'pending-prompt-set' });
  assert.equal(sent, 0);
  assert.equal(onDisk(s.id).pendingPrompt, 'typed in the web composer');
});

test('a second chat prompt after the first was committed waits instead of replacing it', async () => {
  const s = sessions.create({ name: 'twice', cli: 'claude' });
  await deliverToSession(sessions.get(s.id), { text: 'first', requestId: 'r3' }, viaStore(false));
  const out = await deliverToSession(sessions.get(s.id), { text: 'second', requestId: 'r4' }, viaStore(false));
  assert.deepEqual(out, { state: 'pending', reason: 'pending-prompt-set' });
  assert.equal(sessions.get(s.id).pendingPrompt, 'first');
});

test('onCommitted does not run when the session is gone, so the delivery stays pending', async () => {
  let committed = false;
  assert.throws(() => commitPendingPrompt(sessions, { id: 'missing-session' }, { prompt: 'x', onCommitted: () => { committed = true; } }), /no longer exists/);
  assert.equal(committed, false);
  const io = wiring(async (session, text, onCommitted) => commitPendingPrompt(sessions, { id: 'missing-session' }, { prompt: text, onCommitted }));
  const out = await deliverToSession({ id: 'missing-session', cli: 'claude', everStarted: false }, { text: 'x', requestId: 'r5' }, io);
  assert.equal(out.state, 'pending');
});
