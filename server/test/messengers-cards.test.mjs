import assert from 'node:assert/strict';
import { inputCard, reviewable } from '../src/messengers/cards.js';
import { ReplyRouter } from '../src/messengers/replies.js';

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

console.log('messengers-cards: all assertions passed');
