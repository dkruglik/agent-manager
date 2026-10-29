import fs from 'node:fs';
import path from 'node:path';
import { ApiError } from '../api-errors.js';
import { createBridge } from './bridge.js';
import { createStore, validateBinding } from './store.js';
import { createSlackAdapter } from './adapters/slack.js';

// Built-in messengers. An adapter is a plain object — see docs/messengers.md —
// so adding Telegram or Discord is one file here and nothing in the bridge.
export const ADAPTERS = {
  slack: createSlackAdapter,
};

const notFound = () => new ApiError(404, 'not-found', 'Binding not found.');

export function createMessengers({ host, dataDir, config, scopeExists = () => true, factories = ADAPTERS, bridgeOptions = {} }) {
  const store = createStore(path.join(dataDir, 'messengers.json'));
  const logFile = path.join(dataDir, 'messengers.log.jsonl');
  const log = (entry) => {
    const line = JSON.stringify({ at: new Date().toISOString(), ...entry });
    try { fs.appendFileSync(logFile, `${line}\n`); } catch {}
    if (entry.error) console.error('[messengers]', line);
  };
  const adapters = new Map(Object.entries(factories).map(([id, make]) => [id, make(config[id] || {})]));
  const bridge = createBridge({ host, store, adapters, log, ...bridgeOptions });
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
    async test(id) {
      const b = existing(id);
      if (!bridge.status()[b.adapter]?.connected) throw new ApiError(409, 'messenger-offline', `${b.adapter} is not connected.`);
      await bridge.testBinding(b);
      return { ok: true };
    },
  };
}
