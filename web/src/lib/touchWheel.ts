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
