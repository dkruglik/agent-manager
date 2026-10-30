import assert from 'node:assert/strict';
import test from 'node:test';
import { validateBinding } from '../src/messengers/store.js';

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
