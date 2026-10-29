import assert from 'node:assert/strict';
import { hookItem, hookOutput } from '../src/messengers/claude-approvals.js';

const perm = { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'ls -la' } };
const ask = (questions) => ({
  hook_event_name: 'PreToolUse',
  tool_name: 'AskUserQuestion',
  tool_input: { questions, metadata: { source: 'x' } },
});
const q1 = { question: 'Which DB?', header: 'DB', options: [{ label: 'pg', description: 'Postgres' }, { label: 'sqlite' }] };
const q2 = { question: 'Which lang?', options: [{ label: 'js' }, { label: 'ts' }] };

// Permission mapping.
const p = hookItem(perm);
assert.equal(p.kind, 'permission');
assert.equal(p.source, 'claude-hook');
assert.equal(p.event, 'PermissionRequest');
assert.equal(p.tool, 'Bash');
assert.deepEqual(JSON.parse(p.details), { tool: 'Bash', input: { command: 'ls -la' } });
assert.ok(p.details.includes('\n  "tool": "Bash"'));
assert.deepEqual(p.choices, [{ value: 'accept', label: 'Approve once' }, { value: 'decline', label: 'Deny' }]);

assert.deepEqual(hookOutput(p, { decision: 'accept' }), {
  hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
});
assert.deepEqual(hookOutput(p, { decision: 'decline' }, { by: 'alice' }), {
  hookSpecificOutput: {
    hookEventName: 'PermissionRequest',
    decision: { behavior: 'deny', message: 'Denied from chat by alice.', interrupt: false },
  },
});
assert.equal(hookOutput(p, { decision: 'decline' }).hookSpecificOutput.decision.message, 'Denied from chat by chat.');
assert.equal(hookOutput(p, { decision: 'maybe' }), null);
assert.equal(hookOutput(p, {}), null);

// AskUserQuestion mapping.
const one = hookItem(ask([q1]));
assert.deepEqual(one, {
  kind: 'question',
  source: 'claude-hook',
  event: 'PreToolUse',
  toolInput: ask([q1]).tool_input,
  questions: [{ id: 'q0', text: 'Which DB?', secret: false, options: [{ label: 'pg' }, { label: 'sqlite' }] }],
});
const two = hookItem(ask([q1, { ...q2, multiSelect: false }]));
assert.deepEqual(two.questions.map((q) => q.id), ['q0', 'q1']);
assert.equal(two.questions[1].text, 'Which lang?');

// Not handled: multiSelect and invalid shapes.
assert.equal(hookItem(ask([q1, { ...q2, multiSelect: true }])), null);
assert.equal(hookItem(ask([])), null);
assert.equal(hookItem(ask([q1, q2, q1, q2, q1])), null);
assert.equal(hookItem(ask([{ ...q1, options: [] }])), null);
assert.equal(hookItem(ask([{ ...q1, question: '' }])), null);
assert.equal(hookItem(ask([{ ...q1, options: [{ label: '' }] }])), null);
assert.equal(hookItem({ hook_event_name: 'PreToolUse', tool_name: 'AskUserQuestion' }), null);
assert.equal(hookItem({ hook_event_name: 'PermissionRequest', tool_name: 'Bash' }), null);
assert.equal(hookItem({ ...ask([q1]), hook_event_name: 'PostToolUse' }), null);
assert.equal(hookItem({ ...ask([q1]), tool_name: 'Bash' }), null);
assert.equal(hookItem(null), null);
assert.equal(hookItem([]), null);
assert.equal(hookItem('x'), null);
assert.equal(hookItem(undefined), null);

// Answers output.
const item = hookItem(ask([q1, q2]));
assert.deepEqual(hookOutput(item, { answers: { q0: 'pg', q1: 'custom text' } }), {
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'allow',
    updatedInput: {
      questions: [q1, q2],
      metadata: { source: 'x' },
      answers: { 'Which DB?': 'pg', 'Which lang?': 'custom text' },
    },
  },
});
assert.equal(hookOutput(item, { answers: { q0: 'pg' } }), null);
assert.equal(hookOutput(item, { answers: { q0: 'pg', q1: '' } }), null);
assert.equal(hookOutput(item, { answers: { q0: 'pg', q1: 3 } }), null);
assert.equal(hookOutput(item, {}), null);
assert.equal(hookOutput({ event: 'Other' }, { decision: 'accept' }), null);
assert.equal(hookOutput(null, {}), null);

console.log('messengers-claude: all assertions passed');
