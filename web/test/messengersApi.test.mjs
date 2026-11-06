// Pure helpers of the messenger settings code, without a browser.
// Run with:  node test/messengersApi.test.mjs
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'messengers-api-')), 'messengersApi.mjs');
await build({
  entryPoints: [path.join(HERE, '../src/lib/messengersApi.ts')],
  outfile: out, format: 'esm', bundle: true, platform: 'node', logLevel: 'error',
});
const { parseScope } = await import(pathToFileURL(out).href);

assert.deepEqual(parseScope('session:abc'), { type: 'session', id: 'abc' });
assert.deepEqual(parseScope('group:g1'), { type: 'group', id: 'g1' });
// Only the first ':' separates; the rest belongs to the id.
assert.deepEqual(parseScope('session:a:b:c'), { type: 'session', id: 'a:b:c' });
assert.equal(parseScope(''), null);
assert.equal(parseScope('session'), null);
assert.equal(parseScope('other:x'), null);
assert.equal(parseScope('group:'), null);
console.log('messengersApi: ok');
