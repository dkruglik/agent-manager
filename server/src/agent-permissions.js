import fs from 'node:fs';
import path from 'node:path';

// Per-CLI permission rules set in Settings → General → Agent permissions.
// Stored in am-config.json as `agentPermissions`, applied to every agent of
// the CLI: Claude gets them as a `--settings` flag on each launch (so existing
// sessions pick them up on their next launch), Cursor gets them merged into
// its own cli-config.json. Rule syntax belongs to each CLI, not to this file.

export const PERMISSION_CLIS = ['claude', 'cursor'];
const MAX_RULES = 100;
const MAX_RULE_LENGTH = 200;
const CONTROL = /[\x00-\x1f\x7f]/;

const emptyLists = () => ({ allow: [], deny: [] });

export function emptyAgentPermissions() {
  return Object.fromEntries(PERMISSION_CLIS.map((cli) => [cli, emptyLists()]));
}

/**
 * Why a PUT body is refused, or null. The save path refuses rather than
 * silently dropping: an operator who typed a rule must see it was not kept.
 */
export function checkAgentPermissions(raw) {
  if (raw === undefined) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'agentPermissions must be an object';
  for (const cli of PERMISSION_CLIS) {
    const lists = raw[cli];
    if (lists === undefined) continue;
    if (!lists || typeof lists !== 'object' || Array.isArray(lists)) return `agentPermissions.${cli} must be an object`;
    for (const kind of ['allow', 'deny']) {
      const rules = lists[kind];
      if (rules === undefined) continue;
      if (!Array.isArray(rules)) return `agentPermissions.${cli}.${kind} must be a list`;
      if (rules.length > MAX_RULES) return `agentPermissions.${cli}.${kind} has more than ${MAX_RULES} rules`;
      for (const rule of rules) {
        if (typeof rule !== 'string') return `agentPermissions.${cli}.${kind} entries must be text`;
        const t = rule.trim();
        if (!t) return `agentPermissions.${cli}.${kind} has an empty rule`;
        if (t.length > MAX_RULE_LENGTH) return `a rule is longer than ${MAX_RULE_LENGTH} characters`;
        if (CONTROL.test(t)) return 'a rule contains a control character';
      }
    }
  }
  return null;
}

// Trimmed, de-duplicated, invalid entries dropped. Used on read, after
// checkAgentPermissions has already refused bad input on write.
function cleanList(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    if (typeof item !== 'string') continue;
    const rule = item.trim();
    if (!rule || rule.length > MAX_RULE_LENGTH || CONTROL.test(rule) || out.includes(rule)) continue;
    out.push(rule);
    if (out.length >= MAX_RULES) break;
  }
  return out;
}

export function normalizeAgentPermissions(raw) {
  const out = emptyAgentPermissions();
  for (const cli of PERMISSION_CLIS) {
    out[cli] = { allow: cleanList(raw?.[cli]?.allow), deny: cleanList(raw?.[cli]?.deny) };
  }
  return out;
}

/** The JSON for `claude --settings`, or '' when Claude has no rules. */
export function claudeSettingsJson(perms) {
  const lists = perms?.claude;
  if (!lists || (!lists.allow.length && !lists.deny.length)) return '';
  const permissions = {};
  if (lists.allow.length) permissions.allow = lists.allow;
  if (lists.deny.length) permissions.deny = lists.deny;
  return JSON.stringify({ permissions });
}

/**
 * The Cursor rules to write. Rules this app wrote last time and that are no
 * longer wanted are removed; rules already in the file that the app never
 * wrote (cursor-agent's own, or the user's) are kept as they are.
 */
export function mergeCursorRules(existing, desired, previouslyApplied) {
  const out = {};
  for (const kind of ['allow', 'deny']) {
    const before = Array.isArray(existing?.[kind]) ? existing[kind] : [];
    const ours = previouslyApplied?.[kind] || [];
    const kept = before.filter((rule) => !ours.includes(rule) || desired[kind].includes(rule));
    out[kind] = [...new Set([...kept, ...desired[kind]])];
  }
  return out;
}

function readJsonIfPresent(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { value: {} };
    return { error: `${path.basename(file)} could not be read — ${String((e && e.message) || e)}` };
  }
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== 'object' || Array.isArray(value)) return { error: `${path.basename(file)} is not a settings object` };
    return { value };
  } catch (e) {
    return { error: `${path.basename(file)} is not valid JSON — ${String((e && e.message) || e)}` };
  }
}

/**
 * Write the Cursor rules into cursor-agent's cli-config.json, keeping every
 * other key. Refuses (and writes nothing) when that file cannot be parsed, so a
 * hand-edited file is never overwritten. `stateFile` remembers what was written
 * so a later removal can be undone in the file.
 */
export function applyCursorPermissions({ file, stateFile, desired }) {
  const current = readJsonIfPresent(file);
  if (current.error) return { ok: false, error: current.error };
  const previous = readJsonIfPresent(stateFile);
  const applied = previous.value && Array.isArray(previous.value.allow) ? previous.value : emptyLists();
  const settings = current.value;
  const permissions = settings.permissions && typeof settings.permissions === 'object' ? settings.permissions : {};
  const merged = mergeCursorRules(permissions, desired.cursor, applied);
  const next = { ...settings, permissions: { ...permissions, ...merged } };
  const nextText = `${JSON.stringify(next, null, 2)}\n`;
  const currentText = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (currentText !== nextText) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, nextText);
    fs.renameSync(tmp, file);
  }
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(desired.cursor));
  return { ok: true, changed: currentText !== nextText };
}
