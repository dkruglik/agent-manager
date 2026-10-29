import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { createBridge } from './bridge.js';
import { createStore, validateBinding, BindingError } from './store.js';
import { createSlackAdapter } from './adapters/slack.js';

// Built-in messengers. An adapter is a plain object — see docs/messengers.md —
// so adding Telegram or Discord is one file here and nothing in the bridge.
export const ADAPTERS = {
  slack: createSlackAdapter,
};

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

  const router = express.Router();
  const ids = [...adapters.keys()];
  const fail = (res, e) => res.status(e.status || 500).json({ code: e.code || 'messenger-error', error: e.message });

  router.get('/api/messengers', (_req, res) => {
    const status = bridge.status();
    res.json({
      adapters: ids.map((id) => ({ id, configured: adapters.get(id).configured(), ...status[id] })),
      bindings: store.bindings(),
    });
  });
  router.post('/api/messengers/bindings', (req, res) => {
    try { res.status(201).json(store.putBinding(validateBinding(req.body, { adapters: ids, scopeExists }))); }
    catch (e) { fail(res, e); }
  });
  router.put('/api/messengers/bindings/:id', (req, res) => {
    const existing = store.binding(req.params.id);
    if (!existing) return res.status(404).json({ code: 'not-found', error: 'binding not found' });
    try { res.json(store.putBinding(validateBinding(req.body, { adapters: ids, existing, scopeExists }))); }
    catch (e) { fail(res, e); }
  });
  router.delete('/api/messengers/bindings/:id', (req, res) => {
    if (!store.removeBinding(req.params.id)) return res.status(404).json({ code: 'not-found', error: 'binding not found' });
    res.json({ ok: true });
  });
  router.post('/api/messengers/bindings/:id/test', async (req, res) => {
    const b = store.binding(req.params.id);
    if (!b) return res.status(404).json({ code: 'not-found', error: 'binding not found' });
    try { await bridge.testBinding(b); res.json({ ok: true }); }
    catch (e) { fail(res, new BindingError(e.message)); }
  });

  return { bridge, store, router, start: () => bridge.start(), stop: () => bridge.stop() };
}
