export type TouchScrollRoute = 'scrollback' | 'application';

// The alternate screen has no scrollback, so only the application can scroll it.
export function touchScrollRoute(bufferType: 'normal' | 'alternate'): TouchScrollRoute {
  return bufferType === 'alternate' ? 'application' : 'scrollback';
}

// Positive rows = toward the end of output, like Terminal.scrollLines. deltaMode 1
// is WheelEvent.DOM_DELTA_LINE (the global is undefined under node): xterm turns
// one line-mode event of deltaY +-1 into exactly one wheel report or arrow key,
// whatever the row height.
export function touchWheelSteps(rows: number, clientX: number, clientY: number): WheelEventInit[] {
  const count = Number.isFinite(rows) ? Math.abs(Math.trunc(rows)) : 0;
  const deltaY = rows > 0 ? 1 : -1;
  return Array.from({ length: count }, () => ({
    deltaX: 0, deltaY, deltaMode: 1, clientX, clientY, bubbles: true, cancelable: true,
  }));
}

// Enough for any real scroll-back, small enough that one press of the bottom
// key cannot flood the PTY.
export const MAX_BOTTOM_STEPS = 2000;

// How many wheel steps the application is above its bottom after `rows` more
// (negative = up). Overshooting is harmless because the application stops at
// its own bottom, so this never goes below 0.
export function stepsAboveBottom(above: number, rows: number): number {
  return Math.min(MAX_BOTTOM_STEPS, Math.max(0, above - Math.trunc(rows)));
}
