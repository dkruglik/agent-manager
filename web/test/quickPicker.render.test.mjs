// The quickstart picker in the sidebar is a six-column grid. Its tiles are the
// agents (row one, then the overflow), the group tile, remote, shell and files.
// The overflow row used to get a spacer cell as well, so with eight agents the
// twelve tiles needed a thirteenth cell and the last tile (files) wrapped alone
// onto a third row. Checked in the real Sidebar, in the production stylesheet:
// every row of tiles is full except the last, and the picker has exactly as
// many rows as its tiles need.
//
//   node test/quickPicker.render.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'am-quick-picker-'));
const bundle = path.join(root, 'fixture.js');

// Eight agents, as in the reported screen. Remote, shell and files complete the picker.
const AGENTS = ['claude', 'codex', 'cursor', 'antigravity', 'opencode', 'hermes', 'openclaw', 'fx'];
const clis = [
  ...AGENTS.map((id) => ({ id, label: id, color: '#777', available: true, ready: true, launch: { model: false, effort: false } })),
  { id: 'remote', label: 'Remote', color: '#555', available: true, ready: true, launch: { model: false, effort: false } },
  { id: 'shell', label: 'Shell', color: '#555', available: true, ready: true, launch: { model: false, effort: false } },
  { id: 'files', label: 'Files', color: '#555', available: true, ready: true, launch: { model: false, effort: false } },
];
const TILES = AGENTS.length + 4; // the agents, group, remote, shell and files

await build({ stdin: { resolveDir: process.cwd(), loader: 'tsx', contents: `
  import React from 'react'; import {createRoot} from 'react-dom/client'; import {flushSync} from 'react-dom';
  import Sidebar from './src/components/Sidebar';
  const clis = ${JSON.stringify(clis)};
  const noop = () => {}; let root;
  window.mount = () => {
    if (root) flushSync(() => root.unmount());
    root = createRoot(document.getElementById('root'));
    flushSync(() => root.render(<Sidebar clis={clis} tree={{sessions:[],groups:[],order:[]}} activeRef={null} focusedId={null} defaultPath="."
      onActivate={noop} onOpenSession={noop} onOpenSettings={noop} onNewSession={noop}
      onNewGroup={noop} onRenameGroup={noop} onRenameSession={noop} onDeleteGroup={noop}
      onArchiveSession={noop} onUnarchiveSession={noop} onSetRemotePaused={noop} onDeleteSession={noop}
      onTraceHandover={async()=>({path:'.'})} handoverFor={null} onHandoverHandled={noop} onMove={noop}
      theme="light" onToggleTheme={noop} onQuickStart={noop} onPrepareQuickStart={async()=>null} onAbandonQuickStart={async()=>{}}
      archived={new Set()} retired={new Set()} showArchived={false} onToggleArchived={noop} overviewHidden={new Set()} onToggleOverviewHidden={noop}/>));
  };
` }, outfile: bundle, bundle: true, platform: 'browser', format: 'iife', define: { 'process.env.NODE_ENV': '"production"' }, logLevel: 'silent' });

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://fixture');
  if (url.pathname === '/fixture.js') { res.setHeader('content-type', 'text/javascript'); res.end(fs.readFileSync(bundle)); }
  else if (url.pathname === '/style.css') { res.setHeader('content-type', 'text/css'); res.end(fs.readFileSync('src/styles.css')); }
  else res.end('<!doctype html><html><head><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/fixture.js"></script></body></html>');
});
server.listen(0, '127.0.0.1'); await once(server, 'listening');

// Tiles per row, top to bottom, read from the rendered boxes of the picker.
const rowsOf = (page) => page.evaluate(() => {
  const tops = [];
  for (const el of document.querySelectorAll('.quick-clis .quick-cli, .quick-clis-2 .quick-cli')) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const top = Math.round(r.top);
    const row = tops.find((t) => Math.abs(t.top - top) <= 2);
    if (row) row.count++; else tops.push({ top, count: 1 });
  }
  return tops.sort((a, b) => a.top - b.top).map((t) => t.count);
});

const browser = await chromium.launch(chromiumLaunchOptions());
try {
  for (const width of [1280, 360]) {
    const page = await browser.newPage({ viewport: { width, height: 860 } });
    const errors = []; page.on('pageerror', (error) => errors.push(error.message));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.evaluate(() => window.mount());
    await page.getByTitle('New agent or group').click();
    await page.locator('.quick-clis .quick-cli').first().waitFor();
    const rows = await rowsOf(page);
    const total = rows.reduce((a, b) => a + b, 0);
    assert.equal(total, TILES, `every tile is shown at ${width}px (rows ${JSON.stringify(rows)})`);
    assert.deepEqual(rows.slice(0, -1).filter((n) => n !== 6), [],
      `every row but the last is full at ${width}px (rows ${JSON.stringify(rows)})`);
    assert.equal(rows.length, Math.ceil(TILES / 6), `no tile wraps alone at ${width}px (rows ${JSON.stringify(rows)})`);
    assert.deepEqual(errors, [], `no page errors at ${width}px`);
    await page.close();
    console.log(`  ok  ${width}px: rows ${JSON.stringify(rows)}`);
  }
  console.log('quick picker layout: all checks passed');
} finally {
  await browser.close();
  server.close();
  fs.rmSync(root, { recursive: true, force: true });
}
