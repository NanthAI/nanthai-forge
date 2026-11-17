// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { hostedStartSchema } from '../dist/hosted-lane.js';
import { saveRequestSchema } from '../dist/hosted-save.js';
import { syncRequestSchema } from '../dist/hosted-sync.js';
import { composeRequestSchema } from '../dist/hosted-compose.js';
import { sessionMetadataSchema } from '../dist/hosted-lane.js';
const hash = 'a'.repeat(64),
  id = randomUUID(),
  object = { sha256: hash, size: 1 };
const main = { head: hash, receiptId: id };
const expected = { head: hash, version: 0, sourceVersion: 0, lifecycleVersion: 0 };
const command = { operationId: id, authorityEpoch: 1 };

test('reader-first holder requests preserve legacy pins and accept a thread without inventing one', () => {
  const cases = [
    [
      hostedStartSchema,
      { ...command, expectedMain: main, intent: { kind: 'new', outcome: 'A change', constraints: '' } },
    ],
    [
      saveRequestSchema,
      { ...command, laneId: id, expected, message: 'Save', pages: null, pageCount: 0, changeCount: 0 },
    ],
    [
      syncRequestSchema,
      { ...command, kind: 'sync', laneId: id, expected, target: { kind: 'main', ...main }, message: 'Sync' },
    ],
    [
      composeRequestSchema,
      {
        ...command,
        intentId: id,
        expectedMain: main,
        inputs: { root: object, count: 1, pages: 1 },
        dependencies: { root: object, count: 0, pages: 1 },
        message: 'Compose',
      },
    ],
  ];
  for (const [schema, request] of cases) {
    assert.deepEqual(schema.parse(request), request);
    assert.deepEqual(schema.parse({ ...request, holderSessionId: hash }), {
      ...request,
      holderSessionId: hash,
    });
    assert.equal(schema.safeParse({ ...request, holderSessionId: 'raw-native-thread' }).success, false);
  }
});
test('display provenance cannot carry a client-asserted device identity', () => {
  const request = {
    ...command,
    expectedMain: main,
    intent: { kind: 'new', outcome: 'A change', constraints: '' },
    session: { app: 'fixture-app', identityFrom: 'declared' },
  };
  assert.deepEqual(hostedStartSchema.parse(request), request);
  assert.equal(
    hostedStartSchema.safeParse({ ...request, session: { ...request.session, device: { id: 'untrusted' } } })
      .success,
    false,
  );
  const snapshot = {
    ...request.session,
    sessionId: hash,
    startedAt: 1,
    device: { id, code: 'fixture', approvedAt: 1, owner: 'synthetic-owner' },
  };
  assert.deepEqual(sessionMetadataSchema.parse(snapshot), snapshot);
});
