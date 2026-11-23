// Real TerminalPane + xterm; only the websocket transport is fake. No agents start.
// Cursor answers every resize by clearing the scrollback (CSI 3J) and printing
// the whole chat again. On a phone, opening the pane or the keyboard resizes it,
// and the reprint lands in the same frame as the server's canonical snapshot.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { chromium } from 'playwright';
import { chromiumLaunchOptions } from '../../scripts/test-chromium.mjs';

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const result = await build({
  stdin: { resolveDir: web, loader: 'tsx', contents: `
    import React from 'react'; import {createRoot} from 'react-dom/client';
    import TerminalPane from './src/components/TerminalPane';
    window.sent=[];
    class Socket {
      static OPEN=1; readyState=1;
      constructor(){window.socket=this;setTimeout(()=>{this.onopen?.();window.FIRST.forEach((data)=>this.onmessage?.({data}));},20);}
      send(data){window.sent.push(JSON.parse(data));}
      close(){this.readyState=3;}
    }
    window.WebSocket=Socket;
    createRoot(document.getElementById('root')).render(<TerminalPane
      session={{id:'reprint',cli:'cursor',name:'Reprint fixture',state:'waiting',running:true,everStarted:true,path:null}}
      mode="terminal" theme="dark" zoom={100} isMobile focused active visible onClose={()=>{}}/>);
  ` }, bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' },
  define: { 'process.env.NODE_ENV': '"production"' },
});

const CTRL = '\x00\x00AM:';
const chat = (n, tag) => Array.from({ length: n }, (_, i) => `  ${tag} line ${i + 1} of the conversation`).join('\r\n') + '\r\n';
const restore = (cols, rows) => CTRL + JSON.stringify({ t: 'restore', cols, rows, viewers: 1, controller: true, reset: true });
const grid = (cols, rows) => CTRL + JSON.stringify({ t: 'grid', cols, rows, controller: true, viewers: 1, reset: true });
// Cursor's reprint, split into frames the size the PTY delivers them.
const chunks = (text, size = 4000) => Array.from({ length: Math.ceil(text.length / size) }, (_, i) => text.slice(i * size, (i + 1) * size));
const reprint = ['\x1b[H\x1b[2J\x1b[3J', ...chunks(chat(400, 'new') + '  → Add a follow-up\r\n')];

async function openFixture(browser) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const css = ['src/styles.css', 'src/conversation.css', 'node_modules/@xterm/xterm/css/xterm.css']
    .map((file) => fs.readFileSync(path.join(web, file), 'utf8')).join('\n');
  await page.route('http://reprint.test/**', (route) => route.fulfill({ contentType: 'text/html',
    body: `<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n#root{height:100vh}</style><div id="root"></div>` }));
  await page.goto('http://reprint.test/');
  await page.evaluate((first) => { window.FIRST = first; }, [restore(59, 40), '\x1b[?1004h\x1b[?2004h' + chat(300, 'old')]);
  await page.addScriptTag({ content: result.outputFiles[0].text });
  await page.waitForFunction(() => {
    const v = document.querySelector('.xterm-viewport');
    return v && v.scrollHeight > v.clientHeight + 100;
  });
  await page.waitForTimeout(300);
  return page;
}

// Lines above the viewport's bottom edge, in pixels (0 = following the newest output).
const gap = (page) => page.evaluate(() => {
  const v = document.querySelector('.xterm-viewport');
  return Math.round(v.scrollHeight - v.clientHeight - v.scrollTop);
});
const lastRow = (page) => page.evaluate(() => [...document.querySelectorAll('.xterm-rows > div')]
  .map((row) => row.textContent.trim()).filter(Boolean).pop() ?? '');
// The resize barrier, the snapshot and Cursor's reprint arrive in one burst.
const burst = (page, frames) => page.evaluate((list) => list.forEach((data) => window.socket.onmessage?.({ data })), frames);

const browser = await chromium.launch(chromiumLaunchOptions());
try {
  {
    const page = await openFixture(browser);
    assert.ok(await gap(page) <= 2, 'the restored chat opens at its newest line');
    await burst(page, [grid(40, 30), chat(300, 'old'), ...reprint]);
    await page.waitForTimeout(600);
    assert.ok(await gap(page) <= 2, `after the reprint the pane still follows the newest line, ${await gap(page)}px above it`);
    assert.match(await lastRow(page), /Add a follow-up/, 'and shows the reprinted prompt');
    await page.close();
  }
  {
    // Scrolled up before the resize: the clear wiped those lines, so there is
    // nothing left to keep in view. A terminal follows the reprint to its end.
    const page = await openFixture(browser);
    await page.evaluate(() => { const v = document.querySelector('.xterm-viewport'); v.scrollTop -= 400; v.dispatchEvent(new Event('scroll')); });
    await page.waitForTimeout(200);
    assert.ok(await gap(page) > 100, 'fixture scrolled up');
    await burst(page, [grid(40, 30), chat(300, 'old'), ...reprint]);
    await page.waitForTimeout(600);
    assert.ok(await gap(page) <= 2, `a reprint after a clear ends at the newest line, not ${await gap(page)}px above it`);
    await page.close();
  }
  console.log('cursor-reprint: a clear-and-reprint burst keeps the pane at the newest line');
} finally { await browser.close(); }
