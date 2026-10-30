import assert from 'node:assert/strict';
import { inputCard, reviewable } from '../src/messengers/cards.js';
import { ReplyRouter } from '../src/messengers/replies.js';
import { renderBlocks } from '../src/messengers/adapters/slack.js';

const agent = { id: 's1', name: 'alpha', cli: 'claude', group: null };
const choices = [{ value: 'accept', label: 'Approve once' }, { value: 'decline', label: 'Deny' }];
const item = (details) => ({ key: 'k', kind: 'permission', details, choices });
const card = (it) => inputCard({ agent, link: null, item: it, approvals: true });

// Short details: the approver sees everything, so the buttons are offered.
const short = card(item('x'.repeat(1800)));
assert.deepEqual(short.options.map((o) => o.id), ['d:accept', 'd:decline']);
assert.equal(reviewable(item('x'.repeat(1800))), true);

// Long details are clipped, so nothing may be approved from chat.
const long = card(item('x'.repeat(1801)));
assert.deepEqual(long.options, []);
assert.match(long.hint, /Too long to review here — answer in the terminal\./);
assert.ok(long.details.length <= 1800 && long.details.startsWith('xxx'), 'the clipped head still shows');
assert.equal(reviewable(item('x'.repeat(1801))), false);

// Question cards do not depend on details.
const questions = [{ id: 'q0', text: 'Which?', options: [{ label: 'a' }] }];
const ask = inputCard({ agent, link: null, item: { key: 'k', kind: 'question', questions, details: 'x'.repeat(5000) }, approvals: true });
assert.deepEqual(ask.options.map((o) => o.id), ['q:0:0']);

// A press on a decision button for an unreviewable item is refused server-side.
const router = new ReplyRouter({});
const binding = { approvals: true };
assert.deepEqual(router.decision(binding, item('x'.repeat(1801)), 'accept', 'alice'), {
  refused: 'too-long', say: 'Too long to review here — answer in the terminal.',
});
assert.deepEqual(router.decision(binding, item('ok'), 'accept', 'alice'), {
  response: { decision: 'accept' }, text: 'Approve once — by alice',
});

// Invisible and reordering characters could make the approver read a different
// command: they are shown as \uXXXX, both on the card and in what Slack renders.
const sneaky = '{"command":"rm -rf /tmp/x\u202E\u2066\u2069\u200B\u2028 #safe"}';
const shown = card(item(sneaky));
const slackText = renderBlocks(shown).map((b) => b.text?.text || '').join('\n');
for (const text of [shown.details, slackText]) {
  assert.ok(!/[\p{Cf}\u2028\u2029]/u.test(text), 'no invisible character reaches the card');
  assert.ok(text.includes('x\\u202E\\u2066\\u2069\\u200B\\u2028 #safe'), 'each one is shown escaped');
}
assert.equal(reviewable(item(sneaky)), true, 'shown in full, so it can still be decided');
assert.deepEqual(shown.options.map((o) => o.id), ['d:accept', 'd:decline']);
// Escaping grows the text: what is measured is what the approver would see.
const grown = item('\u200B'.repeat(301));
assert.equal(reviewable(grown), false, '301 escapes are 1806 characters, past the limit');
assert.deepEqual(card(grown).options, []);
assert.equal(router.decision(binding, grown, 'accept', 'alice').refused, 'too-long');

console.log('messengers-cards: all assertions passed');
