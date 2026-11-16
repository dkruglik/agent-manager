// Settings → Agent permissions: the Claude switches and rules reach the save.
//
// The page is built against a stub of api.ts that records what a save sends, so
// the assertions are on the request body: a switch that is on is sent as true, a
// switch that is turned off is removed instead of saved as false, and a rule
// added in the box is part of the same save.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(HERE, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-perms-toggle-'));
const bundle = path.join(tmp, 'app.js');
const stub = path.join(tmp, 'api-stub.ts');

fs.writeFileSync(stub, `
export * from ${JSON.stringify(path.join(WEB, 'src/api.ts'))};
const clean = { pending: false, error: null, at: null };
const state = {
  config: {
    artifacts: { enabled: true, space: 'me/artifacts', visibility: 'private' }, jobs: { askAboveUsd: 5 },
    archive: { after: 'month' }, revive: { enabled: true, days: 3, continue: true },
    backup: { every: 'never', dataset: '', exclude: [] }, defaultArtifactsSpace: 'me/agent-artifacts',
    agentPermissions: { claude: { allow: [], deny: [] }, cursor: { allow: [], deny: [] } },
  },
  rev: 'rev-0',
};
let n = 0;
window.__saves = [];
export const getConfig = () => Promise.resolve({ ...structuredClone(state.config), rev: state.rev, readError: null, derived: clean });
export const getDerivedStatus = () => Promise.resolve(clean);
export const saveConfig = (c) => {
  window.__saves.push(structuredClone(c));
  state.config = structuredClone(c);
  state.rev = 'rev-' + (++n);
  return Promise.resolve({ ok: true, ...structuredClone(c), rev: state.rev, derived: clean });
};
export const getSecrets = () => Promise.resolve({ detected: [], notes: {}, rev: 'n0', readError: null, derived: clean });
export const saveSecrets = (notes) => Promise.resolve({ ok: true, notes, rev: 'n1', derived: clean });
export const getTree = () => Promise.resolve({ order: [], groups: [], hidden: [], sessions: [] });
export const getCrons = () => Promise.resolve({ crons: [] });
export const backupStatus = () => new Promise(() => {});
export const checkUpdate = () => new Promise(() => {});
export const getSkills = () => Promise.resolve([]);
export const getUsage = () => new Promise(() => {});
`);

await build({
  stdin: {
    resolveDir: WEB,
    loader: 'tsx',
    contents: `
      import React from 'react';
      import { createRoot } from 'react-dom/client';
      import SettingsView from './src/components/SettingsView.tsx';
      createRoot(document.getElementById('root')).render(
        <SettingsView page="general" onPage={() => {}} onClose={() => {}} theme="light" onToggleTheme={() => {}} clis={[]} info={{ dataDir: '/data' }} />);
    `,
  },
  outfile: bundle, bundle: true, format: 'iife', platform: 'browser', logLevel: 'error',
  plugins: [{ name: 'stub-api', setup(b) { b.onResolve({ filter: /(^|\/)\.\.?\/api$/ }, () => ({ path: stub })); } }],
});

const css = fs.readFileSync(path.join(WEB, 'src/styles.css'), 'utf8');
let failed = 0;
const check = (what, fn) => {
  try { fn(); console.log(`  ok  ${what}`); } catch (e) { failed++; console.log(`  FAIL ${what}\n       ${String(e.message).split('\n')[0]}`); }
};
const browser = await chromium.launch(chromiumLaunchOptions());
const page = await browser.newPage({ viewport: { width: 1000, height: 1200 } });
page.on('pageerror', (e) => console.log('[pageerror]', String(e).slice(0, 200)));
const lastSave = () => page.evaluate(() => window.__saves[window.__saves.length - 1]?.agentPermissions?.claude);
const saves = () => page.evaluate(() => window.__saves.length);
const until = (fn) => page.waitForFunction(fn, null, { timeout: 3000 }).catch(() => {});

try {
  await page.setContent(`<style>${css}</style><div id="root"></div>`);
  await page.addScriptTag({ path: bundle });
  const reads = page.getByRole('button', { name: /Block reads outside the working directory/ });
  await reads.waitFor({ timeout: 15000 });

  const pressedBefore = await reads.getAttribute('aria-pressed');
  check('both switches start off', () => assert.equal(pressedBefore, 'false'));

  await reads.click();
  await until(() => window.__saves.length >= 1);
  const on = await lastSave();
  check('turning a switch on sends it as true', () => assert.equal(on?.blockReadsOutsideWorkingDirectories, true));
  check('the other switch is not sent', () => assert.equal('blockWritesOutsideWorkingDirectories' in (on || {}), false));
  const pressedOn = await reads.getAttribute('aria-pressed');
  check('the button shows it is on', () => assert.equal(pressedOn, 'true'));

  const before = await saves();
  await reads.click();
  await page.waitForFunction((n) => window.__saves.length > n, before, { timeout: 3000 }).catch(() => {});
  const off = await lastSave();
  check('turning it off removes the key instead of saving false',
    () => assert.equal('blockReadsOutsideWorkingDirectories' in (off || {}), false, JSON.stringify(off)));

  await page.getByLabel('Claude Code deny rule').fill('Read(/etc/**)');
  await page.getByLabel('Claude Code deny rule').press('Enter');
  await page.waitForFunction(() => window.__saves.some((s) => s.agentPermissions?.claude?.deny?.length), null, { timeout: 3000 }).catch(() => {});
  const withRule = await lastSave();
  check('a rule added with Enter is saved in the same lists', () => assert.deepEqual(withRule?.deny, ['Read(/etc/**)']));
} catch (e) {
  failed++;
  console.log(`  FAIL ${e.message.split('\n')[0]}`);
} finally {
  await browser.close();
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} failed` : '\nagent-permissions-toggle: ok');
process.exit(failed ? 1 : 0);
