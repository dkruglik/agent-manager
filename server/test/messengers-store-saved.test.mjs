import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BindingStore, validateBinding, validateSaved } from '../src/messengers/store.js';
import { base } from './messengers-store-fixtures.mjs';

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

test('a messengers.json without thread state loads with empty sections, and writes them back', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-messengers-oldfile-'));
  const file = path.join(dir, 'messengers.json');
  const good = { id: 'b1', adapter: 'slack', target: { channel: 'C1' }, scope: { type: 'group', id: 'g1' }, events: ['finished'], allowedUsers: [], approvals: false };
  fs.writeFileSync(file, JSON.stringify({ bindings: [good], posted: {}, seen: { 'b1|s1': 'a:1' } }));
  const store = new BindingStore(file);
  assert.deepEqual(store.bindings(), [good]);
  for (const s of ['roots', 'threadMarks', 'channelMarks', 'deliveredTs', 'recent', 'reach']) assert.deepEqual(store.stateKeys(s), [], s);
  assert.equal(store.state('roots', 'slack|C1|s1'), null);
  store.patchState({ roots: { 'slack|C1|s1': [{ ts: '1.1', at: 5, count: 1 }] }, channelMarks: { 'slack|C1': '1.1' } });
  const again = new BindingStore(file);
  assert.deepEqual(again.state('roots', 'slack|C1|s1'), [{ ts: '1.1', at: 5, count: 1 }]);
  assert.equal(again.seen('b1|s1'), 'a:1', 'other keys are kept');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  again.patchState({ roots: { 'slack|C1|s1': null } });
  assert.equal(new BindingStore(file).state('roots', 'slack|C1|s1'), null, 'null deletes');
  assert.throws(() => again.patchState({ nope: { k: 1 } }), /unknown state section/);
});

test('malformed thread state on disk is dropped quietly, and the caps hold', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'am-messengers-state-'));
  const file = path.join(dir, 'messengers.json');
  const warn = t.mock.method(console, 'warn', () => {});
  const root = (i) => ({ ts: `r${i}`, at: i, count: 1 });
  fs.writeFileSync(file, JSON.stringify({
    bindings: [],
    roots: {
      'a|C|s1': [...Array.from({ length: 25 }, (_, i) => root(i)), null, { ts: 'x' }, { ts: 'y', at: 'now', count: 1 }, { ts: 'z', at: 1, count: -1 }],
      'a|C|s2': 'nope', 'a|C|s3': [{ ts: 'x' }],
    },
    threadMarks: { 'a|C|s1': '9.9', 'a|C|s2': 5, 'a|C|s3': '' },
    channelMarks: { 'a|C': '9.9', 'a|D': {} },
    deliveredTs: {
      'a|C': [...Array.from({ length: 60 }, (_, i) => ({ ts: `d${i}`, sessionId: 's1' })), { ts: 'bad' }, 'x'],
      'a|D': 'x',
    },
    recent: {
      'a|C|s1': { lastSrc: 'src', texts: ['1', '2', 'x'.repeat(3000), '4', 7] },
      'a|C|s2': 'x', 'a|C|s3': { texts: 'x', lastSrc: 3 },
    },
    reach: { 'a|C': 2, 'a|D': 'many', 'a|E': -1 },
    deliveredIds: { 'a|C': ['ok-id', 4, ''], 'a|D': 'nope' },
    submittedIds: { 'a|C': [false, 'sub-id'] },
    outbound: {
      'a|C|s1': { src: 'src', seq: 2, hash: 'h', refs: ['1.0', 5], finished: 'fin' },
      'a|C|s2': { src: 1, seq: 1, hash: 'h' },
    },
  }));
  const store = new BindingStore(file);
  assert.equal(warn.mock.callCount(), 0, 'dropped state entries are not worth a warning');
  assert.equal(fs.readdirSync(dir).length, 1, 'and the file is not set aside');
  const list = store.state('roots', 'a|C|s1');
  assert.deepEqual([list.length, list[0].ts, list.at(-1).ts], [20, 'r5', 'r24']);
  assert.deepEqual(store.stateKeys('roots'), ['a|C|s1']);
  assert.deepEqual(store.stateKeys('threadMarks'), ['a|C|s1']);
  assert.deepEqual(store.stateKeys('channelMarks'), ['a|C']);
  const delivered = store.state('deliveredTs', 'a|C');
  assert.deepEqual([delivered.length, delivered[0].ts, delivered.at(-1).ts], [50, 'd10', 'd59']);
  assert.deepEqual(store.stateKeys('deliveredTs'), ['a|C']);
  const recent = store.state('recent', 'a|C|s1');
  assert.deepEqual(recent.texts.map((x) => x.length), [1, 2048, 1], 'last 3 strings, each cut at 2 KB');
  assert.deepEqual(store.state('recent', 'a|C|s3'), { lastSrc: '', texts: [] });
  assert.deepEqual(store.stateKeys('reach'), ['a|C']);
  assert.deepEqual(store.state('deliveredIds', 'a|C'), ['ok-id']);
  assert.deepEqual(store.state('submittedIds', 'a|C'), ['sub-id']);
  assert.deepEqual(store.state('outbound', 'a|C|s1').refs, ['1.0']);
  assert.equal(store.state('outbound', 'a|C|s2'), null);
});

test('transcript is an event a binding can opt into, and never a default', () => {
  const input = { adapter: 'slack', target: { channel: 'C1' }, scope: { type: 'group', id: 'g1' }, allowedUsers: ['U1'] };
  const fresh = validateBinding(input, { adapters: ['slack'] });
  assert.deepEqual(fresh.events, ['input-required', 'finished']);
  const opted = validateBinding({ ...input, events: ['transcript'] }, { adapters: ['slack'] });
  assert.deepEqual(opted.events, ['transcript']);
  const kept = validateBinding({ approvals: true }, { adapters: ['slack'], existing: opted });
  assert.deepEqual(kept.events, ['transcript']);
  assert.throws(() => validateBinding({ ...input, events: ['nope'] }, { adapters: ['slack'] }), /events/);
});

test('a commit syncs the temp file before the rename and the directory after it', (t) => {
  const file = tmpFile('sync');
  const store = new BindingStore(file);
  const paths = new Map();
  const events = [];
  const open = fs.openSync;
  const fsync = fs.fsyncSync;
  const rename = fs.renameSync;
  t.mock.method(fs, 'openSync', (p, ...rest) => { const fd = open(p, ...rest); paths.set(fd, String(p)); return fd; });
  t.mock.method(fs, 'fsyncSync', (fd) => { events.push(`fsync ${path.basename(paths.get(fd))}`); return fsync(fd); });
  t.mock.method(fs, 'renameSync', (a, b) => { events.push(`rename ${path.basename(b)}`); return rename(a, b); });
  store.putSaved({ adapter: 'slack', channels: [{ id: 'C1', name: 'a' }], users: [] });
  assert.deepEqual(events, ['fsync messengers.json.tmp', 'rename messengers.json', `fsync ${path.basename(path.dirname(file))}`]);
});

test('a directory that cannot be synced is a warning: the file is already in place', (t) => {
  const file = tmpFile('syncdir');
  const store = new BindingStore(file);
  const fsync = fs.fsyncSync;
  let calls = 0;
  t.mock.method(fs, 'fsyncSync', (fd) => { calls += 1; if (calls === 2) throw Object.assign(new Error('EINVAL'), { code: 'EINVAL' }); return fsync(fd); });
  t.mock.method(console, 'warn', () => {});
  store.putSaved({ adapter: 'slack', channels: [{ id: 'C1', name: 'a' }], users: [] });
  assert.deepEqual(store.saved().slack.channels, [{ id: 'C1', name: 'a' }]);
  assert.equal(new BindingStore(file).saved().slack.channels.length, 1);
});
