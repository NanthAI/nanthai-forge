// SPDX-License-Identifier: Apache-2.0
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SecretTestServer, assertSecretReplyRefused } from './helpers/secret-server.mjs';
import { sealedAcceptance } from './helpers/sealed-acceptance.mjs';

test('scripted secret transport records changed replies, conditional writes and reproducible synthetic bytes', async () => {
  const server = new SecretTestServer(17);
  assert.deepEqual(server.bytes(32), new SecretTestServer(17).bytes(32));
  server.rows.set('set', { version: 1, label: 'synthetic' });
  server.rewrite = reply => ({ ...reply, version: 0 });
  assert.equal((await server.query('set')).version, 0);
  assert.equal(server.rows.get('set').version, 1);
  assert.equal((await server.mutation('set', { version: 2 }, 0)).accepted, false);
  assert.equal((await server.mutation('set', { version: 2 }, 1)).accepted, true);
  const dump = server.dump();
  assert.equal(dump.calls.length, 3);
  dump.rows.length = 0;
  assert.equal(server.rows.size, 1);
});

test('refusal harness requires the expected error and an unchanged pin', async () => {
  const server = new SecretTestServer();
  server.rows.set('set', { version: 0 });
  const pin = { version: 1 };
  await assertSecretReplyRefused(assert, {
    server,
    pin,
    request: {},
    code: 'SYNTHETIC_REFUSAL',
    verify: async () => {
      throw Object.assign(new Error(), { code: 'SYNTHETIC_REFUSAL' });
    },
  });
  await assert.rejects(
    assertSecretReplyRefused(assert, {
      server,
      pin,
      request: {},
      code: 'SYNTHETIC_REFUSAL',
      verify: async (_reply, trusted) => {
        trusted.version = 0;
        throw Object.assign(new Error(), { code: 'SYNTHETIC_REFUSAL' });
      },
    }),
  );
});

sealedAcceptance();

test(
  'T84 added-name owner alerts remain when approval is off',
  {
    skip: 'Deferred to slice 3 by the lead: per-added-name owner alerts are outside this Lane; default protection and case matching are covered in secret-run-names.',
  },
  () => assert.fail('Connect the slice 3 landing alert integration and exercise both approval settings.'),
);
