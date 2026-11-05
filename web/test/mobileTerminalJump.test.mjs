// Real TerminalPane + xterm; only the websocket transport is fake. No agents start.
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
      constructor(){window.socket=this;setTimeout(()=>{this.onopen?.();this.grid(true);this.onmessage?.({data:'\\x1b[?2004hReady> '});},20);}
      send(data){window.sent.push(JSON.parse(data));}
      grid(controller){this.onmessage?.({data:'\\x00\\x00AM:'+JSON.stringify({t:'grid',cols:40,rows:12,controller})});}
      close(){this.readyState=3;}
    }
    window.WebSocket=Socket;
    createRoot(document.getElementById('root')).render(<TerminalPane
      session={{id:'jump',cli:'shell',name:'Jump fixture',state:'idle',running:true,everStarted:true,path:null}}
      mode="terminal" theme="light" zoom={100} isMobile focused active visible onClose={()=>{}}/>);
  ` }, bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' },
  define: { 'process.env.NODE_ENV': '"production"' },
});
const browser = await chromium.launch(chromiumLaunchOptions());
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const css = ['src/styles.css', 'src/conversation.css', 'node_modules/@xterm/xterm/css/xterm.css']
    .map((file) => fs.readFileSync(path.join(web, file), 'utf8')).join('\n');
  await page.route('http://jump.test/**', (route) => route.fulfill({ contentType: 'text/html',
    body: `<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n#root{height:100vh}.slot{height:100%}</style><div id="root"></div>` }));
  await page.goto('http://jump.test/');
  await page.addScriptTag({ content: result.outputFiles[0].text });
  await page.locator('.xterm-helper-textarea').waitFor({ state: 'attached' });
  await page.waitForFunction(() => window.sent.some((m) => m.t === 'claim'));
  // Fill the scrollback: 200 numbered lines as one plain-output frame, the same kind of data message the sibling test's socket handles.
  await page.evaluate(() => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\r\n');
    window.socket.onmessage?.({ data: lines + '\r\n' });
  });
  const view = page.locator('.xterm-viewport');
  await page.waitForFunction(() => {
    const v = document.querySelector('.xterm-viewport');
    return v && v.scrollHeight > v.clientHeight + 2;
  });
  // Scroll up to the top of the scrollback.
  await view.evaluate((el) => { el.scrollTop = 0; });
  const gap = () => view.evaluate((el) => el.scrollHeight - el.clientHeight - el.scrollTop);
  assert.ok(await gap() > 2, 'viewport is scrolled away from the bottom before tapping');
  const bottom = page.locator('.term-keybar').getByRole('button', { name: 'bottom', exact: true });
  assert.equal(await bottom.count(), 1, 'key bar has a "bottom" button');
  const sentBefore = await page.evaluate(() => window.sent.length);
  await bottom.click();
  await page.waitForFunction(() => {
    const el = document.querySelector('.xterm-viewport');
    return el && el.scrollHeight - el.clientHeight - el.scrollTop <= 2;
  });
  assert.ok(await gap() <= 2, 'bottom button returns the viewport to the end of output');
  assert.equal(await page.evaluate(() => window.sent.length), sentBefore, 'the key sends no bytes to the PTY');
  assert.equal(await page.evaluate(() => document.activeElement?.className), 'xterm-helper-textarea', 'the terminal keeps focus');
  console.log('mobile-terminal: bottom key returns the scrollback to the end passed');
} finally { await browser.close(); }
