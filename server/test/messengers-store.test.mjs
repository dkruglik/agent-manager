import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BindingStore, validateBinding, validateSaved } from '../src/messengers/store.js';
import { ApiError } from '../src/api-errors.js';

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

test('a failed write leaves memory as it was and is a 500 ApiError', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-messengers-rollback-'));
  const file = path.join(dir, 'messengers.json');
  const store = new BindingStore(file, { now: () => 1 });
  const b = { ...validateBinding(base, { adapters: ['slack'] }), id: 'b1' };
  store.putBinding(b);
  store.putPosted('b1|s1|k', { bindingId: 'b1', status: 'open' });
  store.putSeen('b1|s1', 'a:1');
  t.mock.method(fs, 'writeFileSync', () => { throw new Error(`ENOSPC: no space, write '${file}.tmp'`); });
  const fails = (fn) => assert.throws(fn, (e) => e instanceof ApiError && e.statusCode === 500 && !e.message.includes(dir));
  fails(() => store.putBinding({ ...b, id: 'b2' }));
  fails(() => store.putBinding({ ...b, approvals: true }));
  fails(() => store.putPosted('b1|s1|k2', { bindingId: 'b1', status: 'open' }));
  fails(() => store.putPosted('b1|s1|k', { bindingId: 'b1', status: 'closed' }));
  fails(() => store.putSeen('b1|s1', 'a:2'));
  fails(() => store.removeBinding('b1'));
  assert.deepEqual(store.bindings().map((x) => [x.id, x.approvals]), [['b1', false]], 'no binding added or changed');
  assert.equal(store.posted('b1|s1|k2'), null, 'an unsaved card is not recorded');
  assert.equal(store.posted('b1|s1|k').status, 'open');
  assert.equal(store.seen('b1|s1'), 'a:1');
});

test('a messengers.json that cannot be read (not missing) is set aside like a corrupt one', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-messengers-unreadable-'));
  const file = path.join(dir, 'messengers.json');
  fs.writeFileSync(file, JSON.stringify({ bindings: [] }));
  const warnings = [];
  t.mock.method(console, 'warn', (...a) => warnings.push(a.join(' ')));
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (p, ...rest) => {
    if (p === file) throw Object.assign(new Error(`EACCES: permission denied, open '${file}'`), { code: 'EACCES' });
    return read(p, ...rest);
  });
  const store = new BindingStore(file, { now: () => 5 });
  assert.deepEqual(store.bindings(), []);
  assert.ok(fs.existsSync(`${file}.corrupt-5`), 'kept aside');
  assert.match(warnings.join('\n'), /EACCES.*kept as .*corrupt-5/);
  store.putSeen('k', 'v');
  assert.ok(fs.existsSync(`${file}.corrupt-5`), 'a later write leaves the copy alone');
});

test('a binding read from the store is a copy', () => {
  const store = new BindingStore(path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'am-messengers-copy-')), 'messengers.json'));
  store.putBinding({ ...validateBinding(base, { adapters: ['slack'] }), id: 'b1' });
  const one = store.binding('b1');
  one.allowedUsers.push('U9');
  one.approvals = true;
  store.bindings()[0].target.channel = 'C9';
  assert.deepEqual([store.binding('b1').allowedUsers, store.binding('b1').approvals, store.binding('b1').target.channel], [['U1'], false, 'C1']);
});

// Saved channels and users: a reusable list per adapter, independent of bindings.

const tmpFile = (tag) => path.join(fs.mkdtempSync(path.join(os.tmpdir(), `am-messengers-${tag}-`)), 'messengers.json');
const fieldOf = (input) => {
  try { validateSaved(input, { adapters: ['slack'] }); } catch (e) { return e.data?.details?.[0]?.field ?? e.message; }
  return null;
};

test('validateSaved trims names, collapses duplicate ids and fills defaults', () => {
  const v = validateSaved({
    adapter: 'slack',
    channels: [{ id: 'C1', name: '  alerts  ' }, { id: 'C1', name: 'other' }, { id: 'C2' }],
  }, { adapters: ['slack'] });
  assert.deepEqual(v, { adapter: 'slack', channels: [{ id: 'C1', name: 'alerts' }, { id: 'C2', name: '' }], users: [] });
  assert.equal(validateSaved({ adapter: 'slack', users: [{ id: 'U1', name: 'x'.repeat(100) }] }, { adapters: ['slack'] }).users[0].name.length, 64);
});

test('validateSaved names the field it rejects', () => {
  assert.equal(fieldOf({ adapter: 'nope' }), 'adapter');
  assert.equal(fieldOf({ adapter: 'slack', channels: [{ id: 'C 1' }] }), 'channels');
  assert.equal(fieldOf({ adapter: 'slack', users: [{ id: 5 }] }), 'users');
  assert.equal(fieldOf({ adapter: 'slack', channels: [{ id: 'C1', name: 1 }] }), 'channels', 'a non-string name');
  assert.equal(fieldOf({ adapter: 'slack', users: ['U1'] }), 'users', 'a non-object entry');
  assert.equal(fieldOf({ adapter: 'slack', channels: 'C1' }), 'channels', 'not an array');
  assert.equal(fieldOf({ adapter: 'slack', users: { id: 'U1' } }), 'users', 'not an array');
  const many = (n) => Array.from({ length: n }, (_, i) => ({ id: `C${i}` }));
  assert.equal(fieldOf({ adapter: 'slack', channels: many(101) }), 'channels');
  assert.equal(fieldOf({ adapter: 'slack', channels: many(100) }), null, '100 is allowed');
  assert.equal(fieldOf({ adapter: 'slack' }), null, 'both lists are optional');
});

test('putSaved persists, survives a reload and keeps the file owner-only', () => {
  const file = tmpFile('saved');
  const store = new BindingStore(file);
  assert.deepEqual(store.saved(), {});
  store.putSaved({ adapter: 'slack', channels: [{ id: 'C1', name: 'alerts' }], users: [{ id: 'U1', name: 'Dima' }] });
  const want = { slack: { channels: [{ id: 'C1', name: 'alerts' }], users: [{ id: 'U1', name: 'Dima' }] } };
  assert.deepEqual(new BindingStore(file).saved(), want);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  store.putSaved({ adapter: 'slack', channels: [], users: [] });
  assert.deepEqual(new BindingStore(file).saved(), { slack: { channels: [], users: [] } }, 'replaces, not merges');
  store.saved().slack.channels.push({ id: 'C9', name: '' });
  assert.deepEqual(store.saved().slack.channels, [], 'saved() is a copy');
});

test('putSaved copies the lists, so later caller changes do not reach the store', () => {
  const store = new BindingStore(tmpFile('saved-copy'));
  const channels = [{ id: 'C1', name: 'a' }];
  const users = [{ id: 'U1', name: 'b' }];
  store.putSaved({ adapter: 'slack', channels, users });
  channels.push({ id: 'C9', name: '' });
  users[0].name = 'changed';
  assert.deepEqual(store.saved(), { slack: { channels: [{ id: 'C1', name: 'a' }], users: [{ id: 'U1', name: 'b' }] } });
});

test('putSaved for one adapter leaves another adapter and the delivery state alone', () => {
  const file = tmpFile('saved-other');
  const store = new BindingStore(file, { now: () => 1000 });
  store.putBinding({ ...validateBinding(base, { adapters: ['slack'] }), id: 'b1' });
  store.putPosted('b1|s1|k', { bindingId: 'b1', sessionId: 's1', key: 'k', status: 'open' });
  store.putSeen('b1|s1', 'a:1');
  const other = { channels: [{ id: 'T1', name: 'tg' }], users: [] };
  store.putSaved({ adapter: 'telegram', ...other });
  store.putSaved({ adapter: 'slack', channels: [{ id: 'C1', name: 'a' }], users: [] });
  for (const s of [store, new BindingStore(file)]) {
    assert.deepEqual(s.saved().telegram, other);
    assert.deepEqual(s.saved().slack, { channels: [{ id: 'C1', name: 'a' }], users: [] });
    assert.deepEqual(s.bindings().map((b) => b.id), ['b1']);
    assert.ok(s.posted('b1|s1|k'));
    assert.equal(s.seen('b1|s1'), 'a:1');
  }
});

test('removing a binding keeps the saved lists', () => {
  const file = tmpFile('saved-remove');
  const store = new BindingStore(file);
  store.putBinding({ ...validateBinding(base, { adapters: ['slack'] }), id: 'b1' });
  store.putSaved({ adapter: 'slack', channels: [{ id: 'C1', name: 'a' }], users: [] });
  assert.equal(store.removeBinding('b1'), true);
  const want = { slack: { channels: [{ id: 'C1', name: 'a' }], users: [] } };
  assert.deepEqual(store.saved(), want);
  assert.deepEqual(new BindingStore(file).saved(), want, 'and on disk');
});

test('malformed saved data on disk is dropped without setting the file aside or losing bindings', (t) => {
  const file = tmpFile('saved-bad');
  const good = { id: 'b1', adapter: 'slack', target: { channel: 'C1' }, scope: { type: 'group', id: 'g1' }, events: ['finished'], allowedUsers: [], approvals: false };
  const saved = {
    slack: { channels: [{ id: 'C1', name: 'ok' }, { id: 'bad id', name: 'x' }, { id: 'C2' }, null, 'C3'], users: 'nope' },
    telegram: 'x',
    other: [],
  };
  fs.writeFileSync(file, JSON.stringify({ bindings: [good], saved }));
  const warnings = [];
  t.mock.method(console, 'warn', (...a) => warnings.push(a.join(' ')));
  const store = new BindingStore(file);
  assert.deepEqual(store.saved(), { slack: { channels: [{ id: 'C1', name: 'ok' }], users: [] } });
  assert.deepEqual(store.bindings(), [good]);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ['messengers.json'], 'nothing set aside');
  assert.deepEqual(warnings, []);
  fs.writeFileSync(file, JSON.stringify({ bindings: [good], saved: [1] }));
  assert.deepEqual(new BindingStore(file).saved(), {}, 'a non-object saved is empty');
});
