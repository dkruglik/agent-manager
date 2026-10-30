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

test('messengers.json and its tmp file are owner-only', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-messengers-mode-'));
  const file = path.join(dir, 'messengers.json');
  fs.writeFileSync(`${file}.tmp`, 'stale', { mode: 0o644 }); // left by a crash, world-readable
  const store = new BindingStore(file);
  store.putSeen('k', 'v');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test('validateBinding names the field it rejects', () => {
  const field = (patch) => {
    try { validateBinding({ ...base, ...patch }, { adapters: ['slack'] }); } catch (e) { return e.data?.details?.[0]?.field ?? e.message; }
    return null;
  };
  assert.equal(field({ allowedUsers: ['U 1'] }), 'allowedUsers');
  assert.equal(field({ allowedUsers: [1] }), 'allowedUsers');
  assert.equal(field({ events: [] }), 'events');
  assert.equal(field({ events: ['x'] }), 'events');
  assert.equal(field({ target: { channel: 'a b' } }), 'target.channel');
  assert.equal(field({ scope: { type: 'group', id: ['g1'] } }), 'scope', 'an array id is not coerced to a string');
  assert.equal(field({}), null, 'the base binding is valid');
});

test('removing a binding drops its posted and seen entries, and only those', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-messengers-store-'));
  const store = new BindingStore(path.join(root, 'messengers.json'), { now: () => 1000 });
  for (const id of ['b1', 'b2']) store.putBinding({ ...validateBinding(base, { adapters: ['slack'] }), id });
  for (const id of ['b1', 'b2']) {
    store.putPosted(`${id}|s1|k`, { bindingId: id, sessionId: 's1', key: 'k', status: 'open' });
    store.putSeen(`${id}|s1`, 'a:1');
  }
  assert.equal(store.removeBinding('b1'), true);
  assert.equal(store.posted('b1|s1|k'), null);
  assert.equal(store.seen('b1|s1'), null);
  assert.ok(store.posted('b2|s1|k'), 'another binding keeps its card');
  assert.equal(store.seen('b2|s1'), 'a:1');
  const reloaded = new BindingStore(path.join(root, 'messengers.json'));
  assert.equal(reloaded.posted('b1|s1|k'), null, 'gone from disk too');
  assert.equal(store.removeBinding('b1'), false);
});

test('posted records older than 7 days are pruned on the next write', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-messengers-store-'));
  const day = 24 * 3600_000;
  let clock = 10 * day;
  const store = new BindingStore(path.join(root, 'messengers.json'), { now: () => clock });
  store.putPosted('old', { bindingId: 'b1', status: 'open' });
  clock += 6 * day;
  store.putPosted('recent', { bindingId: 'b1', status: 'open' });
  assert.ok(store.posted('old'), 'not yet 7 days old');
  clock += 2 * day;
  store.putPosted('new', { bindingId: 'b1', status: 'open' });
  assert.equal(store.posted('old'), null, 'older than 7 days');
  assert.ok(store.posted('recent') && store.posted('new'));
});

test('an unreadable messengers.json that cannot be renamed aside is copied, or never overwritten', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-messengers-aside-'));
  const file = path.join(dir, 'messengers.json');
  const warnings = [];
  t.mock.method(console, 'warn', (...a) => warnings.push(a.join(' ')));
  t.mock.method(fs, 'renameSync', () => { throw Object.assign(new Error('EXDEV: rename refused'), { code: 'EXDEV' }); });
  fs.writeFileSync(file, '{not json');
  const copied = new BindingStore(file, { now: () => 7 });
  assert.equal(fs.readFileSync(`${file}.corrupt-7`, 'utf8'), '{not json', 'copied aside when rename fails');
  assert.match(warnings.join('\n'), /kept as .*corrupt-7/);
  assert.equal(copied.readOnly, false);

  warnings.length = 0;
  t.mock.method(fs, 'copyFileSync', () => { throw new Error('ENOSPC: copy refused'); });
  const stuck = new BindingStore(file, { now: () => 8 });
  assert.ok(!fs.existsSync(`${file}.corrupt-8`));
  assert.doesNotMatch(warnings.join('\n'), /kept as /, 'no false claim');
  assert.match(warnings.join('\n'), /copy refused/);
  assert.throws(() => stuck.putSeen('k', 'v'), /not overwriting/);
  assert.equal(fs.readFileSync(file, 'utf8'), '{not json', 'the unreadable file is left as it was');
});

test('dropping malformed bindings keeps a copy of the original file first', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-messengers-dropped-'));
  const file = path.join(dir, 'messengers.json');
  const good = { id: 'b1', adapter: 'slack', target: { channel: 'C1' }, scope: { type: 'group', id: 'g1' }, events: ['finished'], allowedUsers: [], approvals: false };
  const original = JSON.stringify({ bindings: [good, { ...good, id: 'b2', approvals: 'yes' }] });
  fs.writeFileSync(file, original);
  const warnings = [];
  t.mock.method(console, 'warn', (...a) => warnings.push(a.join(' ')));
  const store = new BindingStore(file, { now: () => 9 });
  store.putSeen('k', 'v');
  assert.equal(fs.readFileSync(`${file}.dropped-9`, 'utf8'), original, 'the dropped binding is still on disk');
  assert.match(warnings.join('\n'), /dropped-9/);
});

test('posted and seen that are not plain objects load as empty', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-messengers-maps-'));
  for (const [posted, seen] of [[[], 'x'], [null, [1]], ['s', 3]]) {
    const file = path.join(dir, `m-${JSON.stringify(posted)}.json`);
    fs.writeFileSync(file, JSON.stringify({ bindings: [], posted, seen }));
    const store = new BindingStore(file);
    assert.deepEqual(store.allPosted(), []);
    assert.equal(store.seen('0'), null);
    store.putSeen('k', 'v');
    assert.equal(store.seen('k'), 'v');
  }
});
