// Opening a session from a `#session=<id>` link, without a browser: the module
// is bundled for node and run against a stub location/history/window.
// Run with:  node test/sessionLink.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'session-link-')), 'sessionLink.mjs');
await build({
  entryPoints: [path.join(HERE, '../src/lib/sessionLink.ts')],
  outfile: out, format: 'esm', bundle: true, platform: 'node', logLevel: 'error',
});

const opened = [];
const replaced = [];
globalThis.CustomEvent = class { constructor(type, init) { this.type = type; this.detail = init?.detail; } };
globalThis.window = { dispatchEvent: (e) => { opened.push(e.detail.id); } };
globalThis.history = { state: { keep: 1 }, replaceState: (state, _t, url) => { replaced.push({ state, url }); } };
const at = (href) => { globalThis.location = new URL(href); };
const reset = () => { opened.length = 0; replaced.length = 0; };

const { openLinkedSession } = await import(pathToFileURL(out).href);
const sessions = [{ id: 'a1' }, { id: 'b2' }];

at('http://app.test/x#session=zzz');
openLinkedSession(sessions);
assert.deepEqual([opened, replaced], [[], []], 'an unknown id leaves the hash and opens nothing');

at('http://app.test/x');
openLinkedSession(sessions);
assert.deepEqual([opened, replaced], [[], []], 'no link, nothing to do');

at('http://app.test/some/path?token=secret&vvdebug=1#session=b2');
openLinkedSession(sessions);
assert.deepEqual(opened, ['b2']);
assert.equal(replaced.length, 1);
assert.equal(replaced[0].url, 'http://app.test/some/path?vvdebug=1', 'hash cleared, foreign params dropped');
assert.deepEqual(replaced[0].state, { keep: 1 });
reset();

console.log('sessionLink: ok');
