import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  checkAgentPermissions, normalizeAgentPermissions, claudeSettingsJson, mergeCursorRules, applyCursorPermissions,
} from '../src/agent-permissions.js';

const tmp = (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-perms-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
};

test('a bad rule is refused on write, with the reason', () => {
  assert.equal(checkAgentPermissions(undefined), null);
  assert.match(checkAgentPermissions('x'), /must be an object/);
  assert.match(checkAgentPermissions({ claude: { allow: 'Read(x)' } }), /must be a list/);
  assert.match(checkAgentPermissions({ claude: { deny: [3] } }), /must be text/);
  assert.match(checkAgentPermissions({ cursor: { allow: ['  '] } }), /empty rule/);
  assert.match(checkAgentPermissions({ cursor: { allow: ['a\nb'] } }), /control character/);
  assert.match(checkAgentPermissions({ cursor: { allow: ['x'.repeat(201)] } }), /longer than 200/);
  assert.match(checkAgentPermissions({ cursor: { allow: Array.from({ length: 101 }, (_, i) => `r${i}`) } }), /more than 100/);
  assert.equal(checkAgentPermissions({ claude: { allow: ['Bash(npm test)'], deny: ['Read(/etc/**)'] }, cursor: {} }), null);
});

test('read normalization trims, drops junk and de-duplicates', () => {
  const out = normalizeAgentPermissions({ claude: { allow: [' Bash(ls) ', 'Bash(ls)', 7, ''], deny: 'nope' }, extra: { allow: ['x'] } });
  assert.deepEqual(out, { claude: { allow: ['Bash(ls)'], deny: [] }, cursor: { allow: [], deny: [] } });
  assert.deepEqual(normalizeAgentPermissions(undefined), { claude: { allow: [], deny: [] }, cursor: { allow: [], deny: [] } });
});

test('Claude gets one --settings JSON only when it has rules', () => {
  assert.equal(claudeSettingsJson(normalizeAgentPermissions({})), '');
  const json = claudeSettingsJson(normalizeAgentPermissions({ claude: { deny: ['Read(/etc/**)'] } }));
  assert.deepEqual(JSON.parse(json), { permissions: { deny: ['Read(/etc/**)'] } });
});

test('Cursor merge keeps rules it never wrote and drops rules it removed', () => {
  const existing = { allow: ['Shell(ls)', 'Shell(old)'], deny: [] };
  const previously = { allow: ['Shell(old)'], deny: [] };
  const desired = { allow: ['Shell(new)'], deny: ['Shell(rm)'] };
  assert.deepEqual(mergeCursorRules(existing, desired, previously), { allow: ['Shell(ls)', 'Shell(new)'], deny: ['Shell(rm)'] });
  assert.deepEqual(mergeCursorRules(existing, desired, previously), mergeCursorRules(
    { allow: ['Shell(ls)', 'Shell(new)'], deny: ['Shell(rm)'] }, desired, { allow: ['Shell(new)'], deny: [] }), 'idempotent');
});

test('writing Cursor rules keeps every other key and refuses an unreadable file', (t) => {
  const root = tmp(t);
  const file = path.join(root, '.cursor', 'cli-config.json');
  const stateFile = path.join(root, 'state', 'applied.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ model: 'x', permissions: { allow: ['Shell(ls)'], other: 1 } }));
  const perms = normalizeAgentPermissions({ cursor: { deny: ['Shell(rm)'] } });
  assert.deepEqual(applyCursorPermissions({ file, stateFile, desired: perms }), { ok: true, changed: true });
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.model, 'x');
  assert.deepEqual(saved.permissions, { allow: ['Shell(ls)'], deny: ['Shell(rm)'], other: 1 });

  // Removing the UI rule removes what the app wrote, and nothing else.
  applyCursorPermissions({ file, stateFile, desired: normalizeAgentPermissions({}) });
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')).permissions, { allow: ['Shell(ls)'], deny: [], other: 1 });

  fs.writeFileSync(file, '{ not json');
  const before = fs.readFileSync(file, 'utf8');
  const refused = applyCursorPermissions({ file, stateFile, desired: perms });
  assert.equal(refused.ok, false);
  assert.match(refused.error, /not valid JSON/);
  assert.equal(fs.readFileSync(file, 'utf8'), before, 'nothing written over a file that cannot be parsed');
});
