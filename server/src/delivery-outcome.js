/**
 * @typedef {'codex'|'tui'|'remote'} DeliveryRuntime
 * @typedef {'sent'|'skipped'|'gave-up'} ReviveResult
 * @typedef {{state: 'delivered'}
 *   | {state: 'pending', reason: string}
 *   | {state: 'submitted', reason: string}} DeliveryOutcome
 *   Host send result. `reason` is an error code, never prompt text. Distinct from an outbox row's
 *   `pending` / `submitted`, which is whether the file may be sent again.
 */

// How one attempt to hand a chat prompt to an agent ended, per runtime
// (docs/messengers.md, "Delivery per runtime"). The chat outbox keeps a
// row `pending` (try again), `submitted` (the text may have reached the agent;
// never send it again) or `delivered`. Nothing here touches a pane or a socket:
// the caller passes the send in, so the rules are testable on their own.
//
// A reason is an error code, never message text: the message can quote the
// prompt (input-line-busy shows what is on the line).

// Shared Codex: the receipt is the authority. An id already used, or a send
// whose outcome is unknown, must not be replayed.
const CODEX_SUBMITTED = new Set(['codex-send-uncertain', 'codex-request-conflict']);

const isLockAbort = (error) => error?.code === 'locked' && error?.statusCode === 403;

/**
 * 'pending' or 'submitted' for an error thrown by a send.
 * @param {DeliveryRuntime} runtime 'codex' (shared Codex), 'tui' (a local pane) or 'remote'.
 * @returns {'pending'|'submitted'}
 */
export function classifyDeliveryError(runtime, error) {
  if (runtime === 'codex') return CODEX_SUBMITTED.has(error?.code) ? 'submitted' : 'pending';
  // Remote: append has not run when the lock aborted the send; any other throw
  // came from append, which may have written part of the file.
  if (runtime === 'remote') return isLockAbort(error) ? 'pending' : 'submitted';
  // A pane: only typeAndSubmit knows whether a byte reached the terminal.
  return error?.typed === true ? 'submitted' : 'pending';
}

const reasonOf = (error) => (Number.isInteger(error?.statusCode) && typeof error?.code === 'string' ? error.code : 'error');

/**
 * Run `send`; resolve with the outcome instead of throwing.
 * `committed()`: true once a never-started session's `pendingPrompt` has been
 * written. A failure after that point still counts as delivered: the text is
 * in the web composer and is not sent again from chat.
 */
export async function attemptDelivery(runtime, send, { committed = () => false, log = console.error } = {}) {
  try {
    await send();
    return { state: 'delivered' };
  } catch (error) {
    if (committed()) return { state: 'delivered' };
    const reason = reasonOf(error);
    if (reason === 'error') log(`[messengers] delivery failed with an unexpected error (${runtime}); the row stays as classified`);
    return { state: classifyDeliveryError(runtime, error), reason };
  }
}

/**
 * An outcome known before any send, or null. A `pendingPrompt` the web composer
 * stored is never overwritten or extended; a remote with no name cannot be
 * written to.
 */
export function earlyOutcome(session, runtime) {
  if (runtime === 'remote' && !session.remote?.name) return { state: 'pending', reason: 'remote-unnamed' };
  if (!session.everStarted && session.pendingPrompt) return { state: 'pending', reason: 'pending-prompt-set' };
  return null;
}

/**
 * The commit point of a chat prompt for a session that never started: the text becomes the session's
 * `pendingPrompt` (the CLI's launch argument), and only after that is written does `onCommitted()` run, which is
 * what makes a later launch failure still count as delivered (`attemptDelivery`). `sessions` is the session store
 * (`update(id, patch)`); an update that stored nothing throws before anything is reported committed.
 */
export function commitPendingPrompt(sessions, session, { prompt, imagePaths, onCommitted }) {
  if (!sessions.update(session.id, { pendingPrompt: prompt, pendingImagePaths: imagePaths })) {
    throw new Error('the session no longer exists');
  }
  onCommitted?.();
}

/**
 * Text for a remote agent's message file. `remote.append` cuts silently at its
 * limit; a Slack prompt over it is cut here instead, so the agent sees a line
 * saying so. The result stays within `max`, so append does not cut the line.
 */
export function cutForRemote(text, max) {
  if (text.length <= max) return text;
  const note = `\n[truncated: the Slack message was longer than ${Math.round(max / 1024)} KB]`;
  return text.slice(0, max - note.length) + note;
}

/**
 * The whole decision behind the messengers host's `deliver`, with the send
 * paths passed in (`io`): shared / remote predicates, `sendCodex(session,
 * message)`, `sendLocal(session, text, onCommitted)`, `limit`, `touch(id)`.
 */
export async function deliverToSession(session, { text, requestId }, io) {
  const runtime = io.shared(session) ? 'codex' : io.remote(session) ? 'remote' : 'tui';
  const early = earlyOutcome(session, runtime);
  if (early) return early;
  let committed = false;
  const body = runtime === 'remote' ? cutForRemote(text, io.limit) : text;
  const send = () => {
    if (runtime === 'codex') return io.sendCodex(session, { text, attachments: [], requestId });
    return io.sendLocal(session, body, () => { committed = true; });
  };
  const outcome = await attemptDelivery(runtime, send, { committed: () => committed, log: io.log });
  if (outcome.state === 'delivered') io.touch(session.id);
  return outcome;
}

const READY_MS = 30_000;
const READY_POLL_MS = 200;

/**
 * Called before a chat prompt's first send to a session after a restart. Resolves once the boot's revive
 * result for the session has settled (`io.result(id)`: 'sent', 'skipped' or 'gave-up') and returns it, so
 * the continue message is never raced. For a CLI with a prompt detector whose pane is running, and unless
 * revive gave up, it then waits (bounded, stopping when `signal` aborts) for an empty prompt. A CLI
 * without a detector (Gemini, OpenClaw, fx) never waits on the prompt. Antigravity does: it has a detector.
 * If the wait ends with the pane still running and the prompt not empty, this throws `{ code: 'prompt-not-ready' }`
 * so the outbox keeps the row and tries again. `io.log`, when set, records `ready-timeout`.
 * `io`: `{ result, detector(cli), running(id), promptReady(id), sleep(ms), now(), log? }`.
 */
export async function readyAfterRevive(session, io, { signal = null, readyMs = READY_MS } = {}) {
  const result = await io.result(session.id);
  if (result === 'gave-up' || !io.detector(session.cli) || !io.running(session.id)) return result;
  const now = io.now || Date.now;
  const sleep = io.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const deadline = now() + readyMs;
  let waiting = !signal?.aborted && io.running(session.id) && !io.promptReady(session.id);
  while (waiting && now() < deadline) {
    await sleep(READY_POLL_MS);
    waiting = !signal?.aborted && io.running(session.id) && !io.promptReady(session.id);
  }
  if (waiting) {
    io.log?.({ event: 'ready-timeout', session: session.id, result });
    throw Object.assign(new Error('prompt not ready'), { code: 'prompt-not-ready' });
  }
  return result;
}

/** Boot revive, or, when the Space is locked, no revive at all and every waiting session answered 'skipped'. */
export function bootRevive({ locked, skipAll, revive }) {
  if (locked) {
    skipAll();
    return Promise.resolve([]);
  }
  return revive();
}
