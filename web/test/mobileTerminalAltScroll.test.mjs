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
      session={{id:'altscroll',cli:'shell',name:'Alt scroll fixture',state:'idle',running:true,everStarted:true,path:null}}
      mode="terminal" theme="light" zoom={100} isMobile focused active visible onClose={()=>{}}/>);
  ` }, bundle: true, write: false, format: 'iife', loader: { '.css': 'empty' },
  define: { 'process.env.NODE_ENV': '"production"' },
});

// Opens the terminal on a phone viewport. `feed` is written as one plain-output frame; another viewer then holds control.
async function openFixture(browser, feed, { scrollback = false } = {}) {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const css = ['src/styles.css', 'src/conversation.css', 'node_modules/@xterm/xterm/css/xterm.css']
    .map((file) => fs.readFileSync(path.join(web, file), 'utf8')).join('\n');
  await page.route('http://alt.test/**', (route) => route.fulfill({ contentType: 'text/html',
    body: `<meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}\n#root{height:100vh}.slot{height:100%}</style><div id="root"></div>` }));
  await page.goto('http://alt.test/');
  await page.addScriptTag({ content: result.outputFiles[0].text });
  await page.locator('.xterm-helper-textarea').waitFor({ state: 'attached' });
  await page.waitForFunction(() => window.sent.some((m) => m.t === 'claim'));
  await page.evaluate((data) => window.socket.onmessage?.({ data }), feed);
  if (scrollback) {
    await page.waitForFunction(() => {
      const v = document.querySelector('.xterm-viewport');
      return v && v.scrollHeight > v.clientHeight + 2;
    });
  }
  // Another viewer is the controller, so any input from a drag must claim first.
  await page.evaluate(() => { window.socket.grid(false); window.sent.length = 0; });
  return page;
}

// Drags a finger from y0 to y1 in small steps. `rest` lets the finger settle before lifting so no glide follows.
function drag(page, y0, y1, rest, size = 8) {
  return page.evaluate(async ([from, to, settle, size]) => {
    const host = document.querySelector('.term-host');
    const frame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));
    const fire = (type, y) => {
      const touch = new Touch({ identifier: 1, target: host, clientX: 150, clientY: y });
      host.dispatchEvent(new TouchEvent(type, {
        touches: type === 'touchend' ? [] : [touch], targetTouches: type === 'touchend' ? [] : [touch],
        changedTouches: [touch], bubbles: true, cancelable: true,
      }));
    };
    const step = to > from ? size : -size;
    fire('touchstart', from);
    let y = from;
    while (step > 0 ? y < to : y > to) { y += step; await frame(); fire('touchmove', y); }
    if (settle) await new Promise((resolve) => setTimeout(resolve, 200));
    fire('touchend', y);
  }, [y0, y1, rest, size]);
}

const inputs = (page) => page.evaluate(() => window.sent.filter((m) => m.t === 'i').map((m) => m.d));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MOUSE = '\x1b[?1049h\x1b[?1000h\x1b[?1006h';
const wheels = (data) => data.join('').match(/\x1b\[<\d+;\d+;\d+M/g) ?? [];

const browser = await chromium.launch(chromiumLaunchOptions());
try {
  {
    // Alternate screen with SGR mouse tracking: the drag becomes wheel reports to the application.
    const page = await openFixture(browser, MOUSE + 'one\r\ntwo\r\nthree\r\n');
    await drag(page, 200, 500, true);
    await page.waitForFunction(() => window.sent.some((m) => m.t === 'i'));
    const sent = await page.evaluate(() => window.sent);
    const claimAt = sent.findIndex((m) => m.t === 'claim');
    assert.ok(claimAt >= 0 && claimAt < sent.findIndex((m) => m.t === 'i'), 'the drag claims control before any input');
    const down = wheels(await inputs(page));
    assert.ok(down.length >= 3, `a downward drag sends several wheel reports, got ${down.length}`);
    assert.ok(down.every((r) => /^\x1b\[<64;\d+;\d+M$/.test(r)), 'finger down = wheel up (64) only');
    assert.equal((await inputs(page)).join('').replace(/\x1b\[<\d+;\d+;\d+M/g, ''), '', 'nothing but wheel reports is sent');
    await page.evaluate(() => { window.sent.length = 0; });
    await drag(page, 500, 200, true);
    await page.waitForFunction(() => window.sent.some((m) => m.t === 'i'));
    const up = wheels(await inputs(page));
    assert.ok(up.length >= 3 && up.every((r) => /^\x1b\[<65;\d+;\d+M$/.test(r)), 'finger up = wheel down (65) only');
    await page.close();
  }
  {
    // Alternate screen without mouse tracking: arrow keys.
    const page = await openFixture(browser, '\x1b[?1000l\x1b[?1006l\x1b[?1049hone\r\ntwo\r\n');
    await drag(page, 200, 500, true);
    await page.waitForFunction(() => window.sent.some((m) => m.t === 'i'));
    const keys = (await inputs(page)).join('').match(/\x1b[\[O]A/g) ?? [];
    assert.ok(keys.length >= 3, `a downward drag sends up-arrow keys, got ${keys.length}`);
    assert.equal((await inputs(page)).join('').replace(/\x1b[\[O]A/g, ''), '', 'only up-arrow keys are sent');
    await page.close();
  }
  {
    // Primary screen: browser scrollback, nothing for the application.
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join('\r\n') + '\r\n';
    const page = await openFixture(browser, lines, { scrollback: true });
    await drag(page, 200, 500, true);
    await page.waitForFunction(() => {
      const el = document.querySelector('.xterm-viewport');
      return el.scrollHeight - el.clientHeight - el.scrollTop > 2;
    });
    assert.deepEqual(await inputs(page), [], 'a primary-screen drag sends no input');
    await page.close();
  }
  {
    // A flick released while moving keeps sending wheel reports as it coasts.
    const page = await openFixture(browser, MOUSE + 'one\r\ntwo\r\n');
    await drag(page, 100, 700, false, 40);
    const atEnd = await page.evaluate(() => window.sent.filter((m) => m.t === 'i').length);
    await page.waitForFunction((n) => window.sent.filter((m) => m.t === 'i').length > n + 2, atEnd);
    await sleep(150);
    assert.ok((await inputs(page)).length > atEnd + 2, 'the glide keeps sending wheel reports after touchend');
    await page.close();
  }
  console.log('mobile-terminal: alternate-screen drags scroll the application');
} finally { await browser.close(); }
