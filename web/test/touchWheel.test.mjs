// Checks touchScrollRoute and touchWheelSteps: buffer routing and line-mode wheel inits.
import assert from 'node:assert/strict';
import { touchScrollRoute, touchWheelSteps, stepsAboveBottom, MAX_BOTTOM_STEPS } from '../src/lib/touchWheel.ts';

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

// How far the application is above its bottom, in wheel steps we sent.
assert.equal(stepsAboveBottom(0, -5), 5, 'scrolling up 5 puts it 5 above the bottom');
assert.equal(stepsAboveBottom(5, 3), 2, 'scrolling down 3 of them leaves 2');
assert.equal(stepsAboveBottom(2, 10), 0, 'past the bottom the application stops, so never below 0');
assert.equal(stepsAboveBottom(3, -2.7), 5, 'whole steps only, like touchWheelSteps');
assert.equal(stepsAboveBottom(MAX_BOTTOM_STEPS, -100), MAX_BOTTOM_STEPS, 'capped: bottom never floods the PTY');
