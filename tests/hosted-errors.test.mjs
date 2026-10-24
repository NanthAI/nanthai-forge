// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { ConvexError } from 'convex/values';
import { ForgeError } from '../dist/errors.js';
import { moduleUrl } from './convex-module.mjs';
const { report } = await import(moduleUrl('../convex/errors.ts'));

test('unexpected errors log diagnostic strings, preserve generic client errors and omit custom payloads', t => {
  const logged = [];
  t.mock.method(console, 'error', (...args) => logged.push(args));
  const error = new TypeError('Synthetic backend failure');
  error.request = { token: 'synthetic-secret', payload: 'private-source' };
  assert.throws(
    () => report(error),
    e => e.data.code === 'HOSTED_REQUEST_FAILED',
  );
  assert.deepEqual(logged, [
    [
      'Unexpected Forge error',
      {
        name: error.name,
        message: error.message,
        stack: error.stack,
      },
    ],
  ]);
  assert(!JSON.stringify(logged).includes('synthetic-secret'));
  assert(!JSON.stringify(logged).includes('private-source'));
  assert.throws(
    () => report({ token: 'synthetic-secret' }),
    e => e.data.code === 'HOSTED_REQUEST_FAILED',
  );
  assert.equal(logged[1][1].name, 'NonError');
  assert(!JSON.stringify(logged).includes('synthetic-secret'));
});

test('Convex validation document payloads are redacted from diagnostic message and stack', t => {
  const logged = [];
  t.mock.method(console, 'error', (...args) => logged.push(args));
  const error = new Error('Schema mismatch\nObject: {token: "synthetic-secret"}\nValidator: v.object({})');
  assert.throws(() => report(error));
  assert(!JSON.stringify(logged).includes('synthetic-secret'));
  assert(logged[0][1].message.includes('Schema mismatch'));
  assert(logged[0][1].stack.includes('Validator:'));
});

test('structured Forge and Convex errors retain their protocol without unexpected-error logs', t => {
  const logged = [];
  t.mock.method(console, 'error', (...args) => logged.push(args));
  const error = new ConvexError({ code: 'AUTH_REQUIRED' });
  assert.throws(
    () => report(error),
    e => e === error,
  );
  const forge = new ForgeError('WORK_BUSY', 'Retry later.');
  forge.retryAt = 123;
  assert.throws(
    () => report(forge),
    e => e.data.code === 'WORK_BUSY' && e.data.retryAt === 123,
  );
  assert.deepEqual(logged, []);
});
