import assert from 'node:assert/strict';
import test from 'node:test';
import { finishedDigest } from '../src/messengers/finished-digest.js';

const out = { src: 'rollout', seq: 4, hash: 'h4' };

test('a mark equal to the latest output marks the digest read', () => {
  const d = finishedDigest(out, { lastAssistantMd: 'md', lastAssistantText: 'txt' }, { ...out });
  assert.deepEqual(d, { id: 'rollout:4:h4', read: true, text: 'md' });
});

test('a mark with another hash, or no mark, is unread; text falls back to plain', () => {
  assert.equal(finishedDigest(out, { lastAssistantText: 'txt' }, { ...out, hash: 'old' }).read, false);
  assert.deepEqual(finishedDigest(out, { lastAssistantText: 'txt' }, null), { id: 'rollout:4:h4', read: false, text: 'txt' });
});

test('no output gives null', () => {
  assert.equal(finishedDigest(null, { lastAssistantMd: 'md' }, { ...out }), null);
});
