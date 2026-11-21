// Checks touchScrollRoute and touchWheelSteps: buffer routing and line-mode wheel inits.
import assert from 'node:assert/strict';
import { touchScrollRoute, touchWheelSteps } from '../src/lib/touchWheel.ts';

assert.equal(touchScrollRoute('normal'), 'scrollback');
assert.equal(touchScrollRoute('alternate'), 'application');

const down = touchWheelSteps(3, 40, 90);
assert.equal(down.length, 3);
for (const init of down) {
  assert.equal(init.deltaY, 1);
  assert.equal(init.deltaX, 0);
  assert.equal(init.clientX, 40);
  assert.equal(init.clientY, 90);
  assert.equal(init.deltaMode, 1);
  assert.equal(init.bubbles, true);
  assert.equal(init.cancelable, true);
}

const up = touchWheelSteps(-2, 5, 6);
assert.equal(up.length, 2);
assert.ok(up.every(i => i.deltaY === -1));

assert.deepEqual(touchWheelSteps(0, 1, 2), []);
assert.equal(touchWheelSteps(2.7, 0, 0).length, 2);
assert.equal(touchWheelSteps(-2.7, 0, 0).length, 2);
assert.deepEqual(touchWheelSteps(NaN, 0, 0), []);
assert.deepEqual(touchWheelSteps(Infinity, 0, 0), []);
