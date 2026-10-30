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
const { scopeName, pickableAgents, failureText, newBinding, settleLoad } = await import(pathToFileURL(out).href);

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
console.log('messengersView: ok');
