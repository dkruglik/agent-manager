// Pure helpers behind Settings → Messengers, without a browser.
// Run with:  node test/messengersView.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'messengers-view-')), 'messengersView.mjs');
await build({
  entryPoints: [path.join(HERE, '../src/lib/messengersView.ts')],
  outfile: out, format: 'esm', bundle: true, platform: 'node', logLevel: 'error',
});
const { scopeName, pickableAgents, failureText, newBinding, settleLoad, savedFor, addSaved, newUserIds, usersToSave, removeSaved, addUserToDraft, savedLabel } = await import(pathToFileURL(out).href);

const tree = {
  order: [], hidden: [],
  groups: [{ id: 'g1', name: 'proj', sessionIds: [] }],
  sessions: [
    { id: 's1', name: 'alpha', cli: 'claude' },
    { id: 's2', name: 'old', cli: 'codex', archivedAt: '2026-01-01' },
    { id: 's3', name: 'term', cli: 'shell' },
    { id: 's4', name: 'beta', cli: 'codex' },
  ],
};
const binding = (scope) => ({ id: 'b1', adapter: 'slack', target: { channel: 'C1' }, scope, events: ['finished'], allowedUsers: [], approvals: false, createdAt: 'x', lastError: null });

// The scope a binding points at, by name, and said plainly when it is gone.
assert.equal(scopeName(binding({ type: 'group', id: 'g1' }), tree), 'group proj');
assert.equal(scopeName(binding({ type: 'session', id: 's1' }), tree), 'alpha');
assert.equal(scopeName(binding({ type: 'session', id: 's9' }), tree), 's9 (agent removed)');
assert.equal(scopeName(binding({ type: 'group', id: 'g9' }), tree), 'group g9 (group removed)');
assert.equal(scopeName(binding({ type: 'session', id: 's9' }), null), 's9', 'without the tree nothing is called removed');

// The picker offers live agents only: no archived, shell or passive sessions.
assert.deepEqual(pickableAgents(tree).map((s) => s.id), ['s1', 's4']);
assert.deepEqual(pickableAgents(null), []);

// One "no error" state.
assert.equal(failureText({ lastError: null }), null);
assert.equal(failureText({ lastError: '' }), null);
assert.equal(failureText({}), null);
assert.equal(failureText({ lastError: 'slack chat.postMessage: channel_not_found' }), 'slack chat.postMessage: channel_not_found');

// The draft becomes a binding only with a scope; ids are split on spaces and commas.
assert.throws(() => newBinding({ channel: 'C1', scope: '', users: 'U1', approvals: false }), /Choose an agent or a group/);
assert.throws(() => newBinding({ channel: 'C1', scope: 'other:x', users: 'U1', approvals: false }), /Choose an agent or a group/);
const made = newBinding({ channel: ' C1 ', scope: 'session:s1', users: 'U1, U2  U3', approvals: true });
assert.deepEqual(made, {
  adapter: 'slack', target: { channel: 'C1' }, scope: { type: 'session', id: 's1' },
  events: ['input-required', 'finished'], allowedUsers: ['U1', 'U2', 'U3'], approvals: true,
});
assert.ok(!('lastError' in made));

// A failed tree load does not hide the bindings.
const ok = (value) => ({ status: 'fulfilled', value });
const no = (message) => ({ status: 'rejected', reason: new Error(message) });
const m = { adapters: [{ id: 'slack', configured: true, connected: true, error: null }], bindings: [binding({ type: 'group', id: 'g1' })] };
assert.deepEqual(settleLoad(ok(m), no('tree down')), { messengers: m, tree: null, error: 'tree down' });
assert.deepEqual(settleLoad(no('api down'), ok(tree)), { messengers: null, tree, error: 'api down' });
assert.deepEqual(settleLoad(ok(m), ok(tree)), { messengers: m, tree, error: '' });

// Saved ids: missing adapters give empty lists.
assert.deepEqual(savedFor(undefined, 'slack'), { channels: [], users: [] });
assert.deepEqual(savedFor({}, 'slack'), { channels: [], users: [] });
const savedMap = { slack: { channels: [{ id: 'C1', name: 'ops' }], users: [] } };
assert.deepEqual(savedFor(savedMap, 'slack'), { channels: [{ id: 'C1', name: 'ops' }], users: [] });
assert.deepEqual(savedFor(savedMap, 'other'), { channels: [], users: [] });

// addSaved trims, ignores empty ids, replaces a name in place, never mutates.
const list = [{ id: 'C1', name: 'ops' }];
assert.deepEqual(addSaved(list, ' C2 ', ' dev '), [{ id: 'C1', name: 'ops' }, { id: 'C2', name: 'dev' }]);
assert.deepEqual(addSaved(list, '  ', 'x'), list);
assert.deepEqual(addSaved(list, 'C1', 'renamed'), [{ id: 'C1', name: 'renamed' }]);
assert.deepEqual(addSaved(list, 'C3', ''), [{ id: 'C1', name: 'ops' }, { id: 'C3', name: '' }]);
assert.deepEqual(list, [{ id: 'C1', name: 'ops' }], 'input is not mutated');

// removeSaved drops one id only.
assert.deepEqual(removeSaved([{ id: 'C1', name: '' }, { id: 'C2', name: '' }], 'C1'), [{ id: 'C2', name: '' }]);
assert.deepEqual(removeSaved(list, 'zz'), list);

// A picked user is appended once, keeping the manual text.
assert.equal(addUserToDraft('', 'U1'), 'U1');
assert.equal(addUserToDraft('U1', 'U2'), 'U1, U2');
assert.equal(addUserToDraft('U1, U2 ', 'U2'), 'U1, U2 ');
assert.equal(addUserToDraft('U1 U2', 'U3'), 'U1 U2, U3');
assert.equal(addUserToDraft('U1', ''), 'U1');

assert.equal(savedLabel({ id: 'C1', name: 'ops' }), 'ops (C1)');
assert.equal(savedLabel({ id: 'C1', name: '' }), 'C1');

console.log('messengersView: ok');

// Saving users from the draft never renames or blanks an entry that is already saved.
{
  const saved = [{ id: 'U1', name: 'Ada' }];
  assert.deepEqual(newUserIds('U1, U2 U2,,U3', saved), ['U2', 'U3'], 'saved ids dropped, repeats once');
  assert.deepEqual(usersToSave(saved, 'U1'), [{ id: 'U1', name: 'Ada' }], 'U1 keeps its name, not {id:U1,name:""}');
  assert.deepEqual(usersToSave(saved, 'U1, U2'), [{ id: 'U1', name: 'Ada' }, { id: 'U2', name: '' }]);
  assert.deepEqual(usersToSave([], ''), []);
  assert.deepEqual(saved, [{ id: 'U1', name: 'Ada' }], 'input is not changed');
}
