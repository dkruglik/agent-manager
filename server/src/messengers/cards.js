// Cards are the neutral message model every adapter renders: a title, a body,
// optional preformatted details, and options that become buttons. Nothing here
// knows about Slack or about how a session is run.

const FINISHED_MAX = 2800;
const DETAILS_MAX = 1800;

export function clip(s, n) {
  const t = String(s || '').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
}

// Invisible and reordering characters (U+202E, U+2066-2069, U+200B, …) could
// make a chat show a different command from the one asked about: the approver
// sees them as \uXXXX instead. Escaped before trimming, which would drop some.
const INVISIBLE = /[\p{Cf}\u2028\u2029]/gu;
const hex = (c) => c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0');
const shownDetails = (details) => String(details || '')
  .replace(INVISIBLE, (c) => (c.codePointAt(0) > 0xffff ? `\\u{${hex(c)}}` : `\\u${hex(c)}`)).trim();

// A decision may only be taken from chat when the approver saw all of the request
// (as shown, escapes included): not clipped, and without a code fence, which a
// chat message cannot show as written. inputCard clips the same shown text;
// an adapter must show all of it (Slack splits it: adapters/slack.js detailBlocks).
export const reviewable = (item) => {
  const details = shownDetails(item.details);
  return details.length <= DETAILS_MAX && !details.includes('```');
};
export const TOO_LONG = 'Too long to review here — answer in the terminal.';

function questionOptions(questions, partial) {
  const options = [];
  questions.forEach((q, qi) => {
    if (partial[q.id] !== undefined || q.secret) return;
    (q.options || []).forEach((o, oi) => options.push({ id: `q:${qi}:${oi}`, label: clip(o.label ?? o, 70) }));
  });
  return options;
}

function decisionOptions(choices) {
  return choices.map((c) => ({ id: `d:${c.value}`, label: c.label, style: c.value === 'accept' ? 'primary' : 'danger' }));
}

// Which buttons a needs-input card carries, and the line that explains the rest.
function inputActions(item, approvals, partial) {
  const questions = item.questions || [];
  if (questions.length) {
    return {
      options: questionOptions(questions, partial),
      hint: questions.some((q) => q.secret)
        ? 'A question asks for a secret — answer it in the terminal.'
        : 'Pick an option, or reply in this thread to answer in your own words.',
    };
  }
  if (item.choices?.length) {
    if (!reviewable(item)) return { options: [], hint: TOO_LONG };
    return approvals
      ? { options: decisionOptions(item.choices), hint: null }
      : { options: [], hint: 'Approvals from chat are off for this binding — answer in the terminal.' };
  }
  return { options: [], hint: 'This dialog cannot be answered from chat yet — open the terminal.' };
}

function inputBody(agentName, item, partial) {
  const questions = item.questions || [];
  if (!questions.length) {
    let wanted = 'confirmation';
    if (item.kind === 'permission') wanted = 'a permission decision';
    else if (item.kind === 'question') wanted = 'an answer';
    return `${agentName} is waiting for ${wanted}.`;
  }
  return questions.map((q, i) => {
    const n = questions.length > 1 ? `${i + 1}. ` : '';
    const answered = partial[q.id] !== undefined ? `  → ${partial[q.id]}` : '';
    return `${n}${q.text}${answered}`;
  }).join('\n');
}

/** A card for an open dialog. `partial` holds answers collected so far; `resolved` closes it. */
export function inputCard({ agent, link, item, approvals, partial = {}, resolved = null }) {
  return {
    kind: 'input',
    title: `${item.kind === 'permission' ? '🔐' : '❓'} ${agent.name} needs input`,
    agent,
    body: inputBody(agent.name, item, partial),
    details: item.details ? clip(shownDetails(item.details), DETAILS_MAX) : null,
    ...inputActions(item, approvals, partial),
    link,
    resolved,
  };
}

export function finishedCard({ agent, link, text }) {
  return {
    kind: 'finished',
    title: `✅ ${agent.name} finished`,
    agent,
    body: clip(text, FINISHED_MAX),
    details: null,
    options: [],
    hint: 'Reply in this thread to send the agent a follow-up.',
    link,
    resolved: null,
  };
}

export function noticeCard(body, title = null) {
  return { kind: 'notice', title, body, options: [] };
}

/** Posts a notice card. A Slack failure is a log line; the caller still finishes its own work. */
export async function postNotice(adapters, adapterId, target, text, log) {
  try {
    await adapters.get(adapterId)?.post(target, noticeCard(text));
  } catch (e) {
    log({ event: 'notice-failed', adapter: adapterId, channel: target.channel, error: e.message });
  }
}
