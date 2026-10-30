import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BindingStore, validateBinding } from '../src/messengers/store.js';

// Binding validation and what the store keeps on disk.

const base = { adapter: 'slack', target: { channel: 'C1' }, scope: { type: 'group', id: 'g1' }, allowedUsers: ['U1'] };

test('a binding whose scope is gone can still be edited, but not moved to a missing scope', () => {
  const gone = () => false;
  const existing = validateBinding(base, { adapters: ['slack'] });
  const off = validateBinding({ approvals: false }, { adapters: ['slack'], existing, scopeExists: gone });
  assert.equal(off.approvals, false);
  const same = validateBinding({ scope: { type: 'group', id: 'g1' }, approvals: true }, { adapters: ['slack'], existing, scopeExists: gone });
  assert.equal(same.approvals, true, 'resending the same scope is not a change');
  assert.throws(() => validateBinding({ scope: { type: 'group', id: 'g2' } }, { adapters: ['slack'], existing, scopeExists: gone }),
    (e) => e.data.details?.[0]?.field === 'scope');
  assert.throws(() => validateBinding(base, { adapters: ['slack'], scopeExists: gone }), (e) => e.data.details?.[0]?.field === 'scope', 'create still checks');
});

test('malformed bindings in messengers.json are ignored with one warning', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-messengers-shape-'));
  const file = path.join(dir, 'messengers.json');
  const good = { id: 'b1', adapter: 'slack', target: { channel: 'C1' }, scope: { type: 'group', id: 'g1' }, events: ['finished'], allowedUsers: [], approvals: false };
  const bad = [null, 'x', { ...good, id: '' }, { ...good, target: {} }, { ...good, scope: { type: 'nope', id: 'g' } },
    { ...good, events: 'finished' }, { ...good, allowedUsers: null }, { ...good, approvals: 'yes' }];
  fs.writeFileSync(file, JSON.stringify({ bindings: [good, ...bad] }));
  const warnings = [];
  const warn = console.warn;
  console.warn = (...a) => warnings.push(a.join(' '));
  let store;
  try { store = new BindingStore(file); } finally { console.warn = warn; }
  assert.deepEqual(store.bindings(), [good]);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /ignored 8 malformed/);
});
