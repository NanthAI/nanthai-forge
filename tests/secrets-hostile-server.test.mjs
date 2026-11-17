// SPDX-License-Identifier: Apache-2.0
import './check-runtime.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { SecretTestServer, assertSecretReplyRefused } from './helpers/secret-server.mjs';

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

// These are acceptance slots, not passing encryption evidence. Each needs the real
// verifier/provider and signed synthetic fixtures when the encryption slice starts.
const pending = [
  ['T1', 'untrusted roster signer is refused'],
  ['T2', 'roster and Checks writers need current authority'],
  ['T3', 'older heads and rosters and equal-version forks are refused'],
  ['T4', 'ciphertext must match the signed name digest'],
  ['T5', 'value authentication binds its name, set, project and epoch'],
  ['T6', 'set kind and sharing mode are authenticated'],
  ['T7', 'unknown and downgraded format versions are refused'],
  ['T8', 'concurrent writers reconcile without losing a change'],
  ['T9', 'recipient and epoch wraps must yield the committed key'],
  ['T10', 'invalid agreement public keys are refused'],
  ['T11', 'fixed encoding and cryptographic known-answer vectors match'],
  [
    'T18',
    'stored rows and call arguments contain no plaintext or reversible encoding; sizes use padding buckets',
  ],
  ['T20', 'inbox key matches the verified set key'],
  ['T21', 'each name version respects its pin'],
  ['T22', 'a missing pin index never resets first-contact trust'],
  ['T23', 'notices derive from verified records rather than server sentences'],
  ['T24', 'all hash and signature inputs use the format framing'],
  ['T59', 'set identity changes require an authenticated replacement'],
  ['T60', 'pins distinguish projects and a missing file affects only its project'],
  ['T63', 'same-version records preserve authenticated value and author fields'],
  ['T64', 'new value versions have authenticated authors and valid epoch history, including skipped re-keys'],
  ['T67', 'tombstones and the monotone floor preserve name version history'],
  ['T68', 'recovered devices cannot grant a greater role'],
  ['T69', 'a first Checks view walks from the trusted pointer genesis'],
  ['T71', 'reserved head and name flags are refused'],
  ['T77', 'non-holders retain Checks rollback protection'],
  ['T79', 'removals preserve owner authority and previously trusted heads'],
  ['T80', 'added entries bind signer, keys, account, role and transition version'],
  ['T83 set/import/apply', 'all writers share the release name policy'],
  ['T86', 'pin counters survive interrupted writes and serialize concurrent processes'],
  ['T92', 'skipped re-keys, dropped tombstones and newly joined devices retain readable version history'],
  ['T93', 'former signing identities authenticate retained changes without granting current authority'],
  ['T94', 'a lone holder rebuilds trust only from an authenticated local anchor and a person confirmation'],
  ['T96', 'the version floor is monotone and advances only for dropped tombstones'],
];
for (const [id, behavior] of pending)
  test(
    `${id} ${behavior}`,
    {
      skip: 'Deferred: encryption provider and verified fixtures are outside this non-encryption slice; no encryption acceptance is claimed.',
    },
    () => {
      assert.fail(
        'Connect the real verifier to SecretTestServer and assertSecretReplyRefused before enabling this acceptance case.',
      );
    },
  );

test(
  'T84 added-name owner alerts remain when approval is off',
  {
    skip: 'Deferred to slice 3 by the lead: per-added-name owner alerts are outside this Lane; default protection and case matching are covered in secret-run-names.',
  },
  () => assert.fail('Connect the slice 3 landing alert integration and exercise both approval settings.'),
);
