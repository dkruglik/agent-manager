import fs from 'node:fs';
import path from 'node:path';
import { ApiError } from '../api-errors.js';
import { MessengerBridge } from './bridge.js';
import { BindingStore, validateBinding, validateSaved } from './store.js';
import { hookItem, hookOutput } from './claude-approvals.js';
import { SlackAdapter } from './adapters/slack.js';

// Built-in messengers. Any object implementing the adapter interface in
// docs/messengers.md will do (Slack's is a class).
/**
 * @typedef {object} Adapter The messenger contract (docs/messengers.md, "Adding a messenger").
 * @property {() => boolean} configured  True when its tokens are set.
 * @property {(hooks: {
 *   onReply: (resolves once the event is durable, so the adapter acks it only then; a rejection leaves it
 *     unacked and the service redelivers) (r: {channel: string, ts: string, thread: string|null, user: {id: string, name?: string},
 *     messageId: string, optionId?: string, text?: string}) => Promise<unknown>,
 *   onCommand: (c: {channel: string, user: {id: string, name?: string}, text: string}) => Promise<string>,
 *   onStatus: (s: {connected: boolean, error: string|null}) => void,
 *   onConnect: (called once per new connection, not on a service-requested refresh: messages sent while the
 *     socket was down may be missing, so the bridge reads history) () => Promise<void>,
 *   log: (entry: object) => void,
 * }) => void} start
 * @property {() => Promise<void>} [stop]
 * @property {(target: {channel: string, thread: string|null}, card: object) => Promise<{channel: string, ts: string}>} post
 *   Throws on failure; an error's `publicMessage`, if set, may be shown in Settings.
 * @property {(ref: {channel: string, ts: string}, card: object) => Promise<void>} update
 * @property {(e: {channel: string, user: string, text: string}) => Promise<void>} postEphemeral
 *   Shows `text` in the channel to one user only.
 * @property {(q: {channel: string, thread?: string, oldest?: string}) => Promise<object[]>} [history]
 *   Messages after `oldest` (exclusive), oldest first, in the shape of an `onReply` event, bot messages left out.
 *   `thread` reads that thread's replies instead of the channel. Needed for backfill.
 */

/** @type {Record<string, (config: object) => Adapter>} */
export const ADAPTERS = {
  slack: (config) => new SlackAdapter(config),
};

const notFound = () => new ApiError(404, 'not-found', 'Binding not found.');

export function createMessengers({ host, dataDir, config, scopeExists = () => true }) {
  const store = new BindingStore(path.join(dataDir, 'messengers.json'));
  const logFile = path.join(dataDir, 'messengers.log.jsonl');
  let appendWarned = false;
  const log = (entry) => {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    try { fs.appendFileSync(logFile, `${line}\n`); } catch (e) {
      if (!appendWarned) console.error(`[messengers] cannot write ${logFile}: ${e.message}`);
      appendWarned = true;
    }
    if (entry.error) console.error('[messengers]', line);
  };
  const adapters = new Map(Object.entries(ADAPTERS).map(([id, make]) => [id, make(config[id] || {})]));
  const bridge = new MessengerBridge({ host, store, adapters, log, dataDir, settleMs: config.finishedDelayMs });
  const ids = [...adapters.keys()];
  const existing = (id) => {
    const b = store.binding(id);
    if (!b) throw notFound();
    return b;
  };

  // The operations behind /api/messengers; index.js registers the routes so
  // they pass the same admission and validation as every other route.
  return {
    log,
    start: () => bridge.start(),
    // Waiting hooks are told Agent Manager is stopping; adapters disconnect.
    async stop() {
      log({ event: 'stopping' });
      await bridge.stop();
    },
    list() {
      const status = bridge.status();
      return {
        adapters: ids.map((id) => ({ id, configured: adapters.get(id).configured(), ...status[id] })),
        bindings: store.bindings().map((b) => ({ ...b, lastError: bridge.lastError(b.id) })),
        saved: store.saved(),
      };
    },
    create: (body) => store.putBinding(validateBinding(body, { adapters: ids, scopeExists })),
    update: (id, body) => store.putBinding(validateBinding(body, { adapters: ids, existing: existing(id), scopeExists })),
    // Saved channels and users are independent of bindings: neither creating nor removing one touches them.
    saveTargets(body) {
      store.putSaved(validateSaved(body, { adapters: ids }));
      return store.saved();
    },
    remove(id) {
      const removed = store.binding(id);
      if (!store.removeBinding(id)) throw notFound();
      // Thread state stays while another binding in the channel still reaches the session.
      try { bridge.threads.forget(removed); } catch (e) { log({ event: 'forget-failed', binding: id, error: e.message }); }
      return { ok: true };
    },
    // A Claude hook asks for a chat decision; { output: null } means none.
    async claudeHook({ sessionId, payload, signal }) {
      const item = hookItem(payload);
      if (!item) return { output: null };
      const decision = await bridge.hooks.wait(sessionId, item, { signal });
      return { output: decision ? hookOutput(item, decision.response, { by: decision.by }) : null };
    },
    async test(id) {
      const b = existing(id);
      if (!bridge.status()[b.adapter]?.connected) throw new ApiError(409, 'messenger-offline', `${b.adapter} is not connected.`);
      await bridge.testBinding(b);
      return { ok: true };
    },
  };
}
