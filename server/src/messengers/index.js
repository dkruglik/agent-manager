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
 *   onReply: (r: {channel: string, ts: string, thread: string|null, user: {id: string, name?: string},
 *     messageId: string, optionId?: string, text?: string}) => Promise<unknown>,
 *   onCommand: (c: {channel: string, user: {id: string, name?: string}, text: string}) => Promise<string>,
 *   onStatus: (s: {connected: boolean, error: string|null}) => void,
 *   log: (entry: object) => void,
 * }) => void} start
 * @property {() => Promise<void>} [stop]
 * @property {(target: {channel: string, thread: string|null}, card: object) => Promise<{channel: string, ts: string}>} post
 *   Throws on failure; an error's `publicMessage`, if set, may be shown in Settings.
 * @property {(ref: {channel: string, ts: string}, card: object) => Promise<void>} update
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
  const bridge = new MessengerBridge({ host, store, adapters, log });
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
      if (!store.removeBinding(id)) throw notFound();
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
