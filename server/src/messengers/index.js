import fs from 'node:fs';
import path from 'node:path';
import { ApiError } from '../api-errors.js';
import { MessengerBridge } from './bridge.js';
import { BindingStore, validateBinding } from './store.js';
import { hookItem, hookOutput } from './claude-approvals.js';
import { SlackAdapter } from './adapters/slack.js';

// Built-in messengers. An adapter is a plain object — see docs/messengers.md —
// so adding Telegram or Discord is one file here and nothing in the bridge.
export const ADAPTERS = {
  slack: (config) => new SlackAdapter(config),
};

const notFound = () => new ApiError(404, 'not-found', 'Binding not found.');

export function createMessengers({ host, dataDir, config, scopeExists = () => true, factories = ADAPTERS, bridgeOptions = {} }) {
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
  const adapters = new Map(Object.entries(factories).map(([id, make]) => [id, make(config[id] || {})]));
  const bridge = new MessengerBridge({ host, store, adapters, log, ...bridgeOptions });
  const ids = [...adapters.keys()];
  const existing = (id) => {
    const b = store.binding(id);
    if (!b) throw notFound();
    return b;
  };

  // The operations behind /api/messengers; index.js registers the routes so
  // they pass the same admission and validation as every other route.
  return {
    bridge,
    store,
    log,
    start: () => bridge.start(),
    stop: () => bridge.stop(),
    list() {
      const status = bridge.status();
      return {
        adapters: ids.map((id) => ({ id, configured: adapters.get(id).configured(), ...status[id] })),
        bindings: store.bindings(),
      };
    },
    create: (body) => store.putBinding(validateBinding(body, { adapters: ids, scopeExists })),
    update: (id, body) => store.putBinding(validateBinding(body, { adapters: ids, existing: existing(id), scopeExists })),
    remove(id) {
      if (!store.removeBinding(id)) throw notFound();
      return { ok: true };
    },
    // A Claude hook asks for a chat decision; { output: null } means none.
    async claudeHook({ sessionId, payload, signal }) {
      const item = hookItem(payload);
      if (!item) return { output: null };
      const decision = await bridge.awaitDecision(sessionId, item, { signal });
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
