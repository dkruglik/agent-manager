import type { IDisposable, Terminal } from '@xterm/xterm';

// Cursor answers every resize by clearing the scrollback (CSI 3J) and printing
// the whole chat again. The buffer empties and refills within one frame, so the
// viewport element clamps its scrollTop while the scroll area is tiny, and
// xterm then adopts that stale position: the pane lands near the top of the
// chat. On a phone every pane open and every keyboard toggle is such a resize.
// The clear removed the old reading position, so the pane follows the reprint
// to its newest line until the output goes quiet or the user scrolls.
const CLEARS_SCROLLBACK = '\x1b[3J';
const QUIET_MS = 400;
const CLEAR_BYTES = [...CLEARS_SCROLLBACK].map((c) => c.charCodeAt(0));

function clearsScrollback(data: string | Uint8Array): boolean {
  if (typeof data === 'string') return data.includes(CLEARS_SCROLLBACK);
  for (let i = data.indexOf(CLEAR_BYTES[0]); i >= 0; i = data.indexOf(CLEAR_BYTES[0], i + 1)) {
    if (CLEAR_BYTES.every((b, k) => data[i + k] === b)) return true;
  }
  return false;
}

export class TerminalClearFollow {
  private active = false;
  private quietTimer: ReturnType<typeof setTimeout> | null = null;
  private renderSub: IDisposable | null = null;

  constructor(private readonly term: Terminal) {}

  get following(): boolean { return this.active; }

  // Call on receipt, before the chunk is queued for parsing.
  noteChunk(data: string | Uint8Array): void {
    if (clearsScrollback(data)) this.active = true;
  }

  // Call from the write callback, once the chunk is parsed. The viewport
  // element only grows on the next render, so snap again then.
  afterWrite(): void {
    if (!this.active) return;
    this.term.scrollToBottom();
    this.renderSub?.dispose();
    this.renderSub = this.term.onRender(() => {
      this.renderSub?.dispose();
      this.renderSub = null;
      if (this.active) this.term.scrollToBottom();
    });
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = setTimeout(() => this.stop(), QUIET_MS);
  }

  stop(): void {
    this.active = false;
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = null;
    this.renderSub?.dispose();
    this.renderSub = null;
  }
}
