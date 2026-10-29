// Maps Claude Code hook payloads to messenger items and a chat answer back to
// the JSON the hook prints on stdout. Pure: no I/O, never throws.

const CHOICES = [{ value: 'accept', label: 'Approve once' }, { value: 'decline', label: 'Deny' }];
const MAX_QUESTIONS = 4;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.length > 0;

function validQuestion(q) {
  return isObject(q)
    && isText(q.question)
    && q.multiSelect !== true
    && Array.isArray(q.options)
    && q.options.length > 0
    && q.options.every((o) => isObject(o) && isText(o.label));
}

function permissionItem(payload) {
  if (typeof payload.tool_name !== 'string' || !isObject(payload.tool_input)) return null;
  return {
    kind: 'permission',
    source: 'claude-hook',
    event: 'PermissionRequest',
    tool: payload.tool_name,
    details: JSON.stringify({ tool: payload.tool_name, input: payload.tool_input }, null, 2),
    choices: CHOICES.map((c) => ({ ...c })),
  };
}

// multiSelect questions stay in the terminal: Claude's answer format for them is undocumented.
function questionItem(payload) {
  if (payload.tool_name !== 'AskUserQuestion' || !isObject(payload.tool_input)) return null;
  const { questions } = payload.tool_input;
  if (!Array.isArray(questions) || questions.length < 1 || questions.length > MAX_QUESTIONS) return null;
  if (!questions.every(validQuestion)) return null;
  return {
    kind: 'question',
    source: 'claude-hook',
    event: 'PreToolUse',
    toolInput: payload.tool_input,
    questions: questions.map((q, i) => ({
      id: `q${i}`,
      text: q.question,
      secret: false,
      options: q.options.map((o) => ({ label: o.label })),
    })),
  };
}

export function hookItem(payload) {
  if (!isObject(payload)) return null;
  if (payload.hook_event_name === 'PermissionRequest') return permissionItem(payload);
  if (payload.hook_event_name === 'PreToolUse') return questionItem(payload);
  return null;
}

function permissionOutput(response, by) {
  let decision;
  if (response?.decision === 'accept') decision = { behavior: 'allow' };
  else if (response?.decision === 'decline') decision = { behavior: 'deny', message: `Denied from chat by ${by}.`, interrupt: false };
  else return null;
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}

function answersOutput(item, response) {
  const given = response?.answers;
  if (!isObject(given) || !Array.isArray(item.questions)) return null;
  const answers = {};
  for (const q of item.questions) {
    if (!isText(given[q.id])) return null;
    answers[q.text] = given[q.id];
  }
  // updatedInput replaces the whole tool input, so the original questions must travel with the answers.
  return {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { ...item.toolInput, answers },
    },
  };
}

export function hookOutput(item, response, { by = 'chat' } = {}) {
  if (!isObject(item)) return null;
  if (item.event === 'PermissionRequest') return permissionOutput(response, by);
  if (item.event === 'PreToolUse') return answersOutput(item, response);
  return null;
}
