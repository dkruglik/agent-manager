import assert from 'node:assert/strict';
import test from 'node:test';
import { covers } from '../src/read-marks.js';

const latest = { src: 'g1', seq: 3, hash: 'h3' };

test('a mark covers exactly the newest reply: same src, seq and hash', () => {
  assert.equal(covers({ src: 'g1', seq: 3, hash: 'h3' }, latest), true);
  assert.equal(covers({ src: 'g1', seq: 2, hash: 'h2' }, latest), false, 'older reply');
  assert.equal(covers({ src: 'g1', seq: 4, hash: 'h3' }, latest), false, 'a cursor further along is not a match');
  assert.equal(covers({ src: 'g1', seq: 3, hash: 'grew' }, latest), false, 'same position, other content');
  assert.equal(covers({ src: 'g0', seq: 3, hash: 'h3' }, latest), false, 'another transcript generation');
  assert.equal(covers(null, latest), false);
  assert.equal(covers({ src: 'g1', seq: 3, hash: 'h3' }, null), false);
});
