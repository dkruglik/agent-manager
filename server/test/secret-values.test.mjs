import assert from 'node:assert/strict';
import test from 'node:test';
import { secretValues } from '../src/secret-values.js';

// Which environment variables count as secrets for the chat credential filter, by name. No server.

const VALUE = 'fixture-value-for-the-filter';
const known = (name) => secretValues([], { [name]: VALUE }).includes(VALUE);

test('names ending in a secret word or in a standalone KEY are secrets', () => {
  for (const name of ['SOME_TOKEN', 'DEPLOY_SECRET', 'DB_PASSWORD', 'db_password', 'MY_API_KEY', 'OPENAI_KEY',
    'AWS_SECRET_ACCESS_KEY', 'AWS_ACCESS_KEY', 'SSH_PRIVATE_KEY', 'KEY', 'STRIPE_SECRET_KEY']) {
    assert.ok(known(name), `${name} is a secret name`);
  }
});

test('harmless names are not', () => {
  for (const name of ['KEYBOARD', 'MONKEY', 'KEY_COUNT', 'TOKEN_COUNT', 'SSH_KEY_PATH', 'LANG', 'KEYMAP']) {
    assert.ok(!known(name), `${name} is not a secret name`);
  }
});

test('values under the filter minimum length are left out, and listed names are always included', () => {
  assert.deepEqual(secretValues([], { A_KEY: 'short' }), []);
  assert.deepEqual(secretValues([{ secrets: ['CUSTOM_NAME'] }], { CUSTOM_NAME: VALUE }), [VALUE]);
});
