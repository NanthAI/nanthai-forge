// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { compactOperationReceipt, expandOperationReceipt } from '../dist/compact-operation-receipt.js';
import {
  hostedPayloadHash,
  prepareHostedOperation,
  canonicalPayload,
} from '../dist/hosted-source-operation.js';
for (const outcome of [
  {
    status: 'completed',
    result: { candidate: { head: 'a'.repeat(64), governance: { paths: ['old/path'] } } },
  },
  { status: 'failed', error: { code: 'SOURCE_UNAVAILABLE', message: 'Original evidence is missing.' } },
])
  test(`compact receipt alone preserves the original ${outcome.status} retry result and rejects a different payload`, async () => {
    const projectId = 'project',
      actor = 'actor',
      operationId = randomUUID(),
      expected = { authorityEpoch: 1, head: 'b'.repeat(64) },
      payload = { kind: 'save', message: 'Original' };
    const firstAttempt = {
      projectId,
      operationId,
      id: randomUUID(),
      parentAttemptId: null,
      at: '2026-01-01T00:00:00.000Z',
      expected,
      ids: { save: randomUUID() },
    };
    const original = {
      schema: 1,
      projectId,
      actor,
      operationId,
      payloadHash: hostedPayloadHash(payload, expected),
      expected,
      firstAttempt,
      terminal: { attemptId: firstAttempt.id, at: firstAttempt.at, outcome },
    };
    const row = {
      projectId,
      actor,
      operationId,
      value: compactOperationReceipt(original),
      journalSegment: 'verified-segment',
    };
    const receipt = expandOperationReceipt(row);
    assert.deepEqual(receipt, original);
    assert(row.value.length < canonicalPayload(original).length);
    let authorized = 0;
    const request = { schema: 1, projectId, actor, operationId, payloadHash: original.payloadHash, expected };
    const replay = await prepareHostedOperation(
      request,
      payload,
      { ...firstAttempt, id: randomUUID() },
      receipt,
      async () => {
        authorized++;
      },
    );
    assert(replay.replayed);
    assert.deepEqual(replay.operation, original);
    assert.equal(authorized, 1);
    await assert.rejects(
      prepareHostedOperation(
        request,
        { ...payload, message: 'Changed' },
        firstAttempt,
        receipt,
        async () => {},
      ),
      error => error.code === 'WORK_OPERATION_CHANGED',
    );
  });

test('the shared operation loader and terminal retry accept the compact row without reinflating stored transport bytes', async () => {
  const { recordsFixture } = await import('./hosted-records-fixture.mjs');
  const { moduleUrl } = await import('./convex-module.mjs');
  const { hostedOperationRow, finishHostedOperation } = await import(
    moduleUrl('../convex/projectHostedOperations.ts')
  );
  const f = recordsFixture(),
    auth = await f.setup(),
    operationId = randomUUID(),
    expected = { authorityEpoch: 1 },
    payload = { kind: 'save' };
  const firstAttempt = {
    projectId: auth.projectId,
    operationId,
    id: randomUUID(),
    parentAttemptId: null,
    at: '2026-01-01T00:00:00.000Z',
    expected,
    ids: {},
  };
  const terminal = {
    attemptId: firstAttempt.id,
    at: firstAttempt.at,
    outcome: { status: 'completed', result: { original: true } },
  };
  const original = {
    schema: 1,
    projectId: auth.projectId,
    actor: auth.actor,
    operationId,
    payloadHash: hostedPayloadHash(payload, expected),
    expected,
    firstAttempt,
    terminal,
  };
  const stored = compactOperationReceipt(original),
    id = await f.ctx.db.insert('projectHostedOperations', {
      projectId: auth.projectId,
      actor: auth.actor,
      operationId,
      value: stored,
      journalSegment: 'verified',
    });
  const row = await hostedOperationRow(f.ctx, auth.projectId, auth.actor, operationId);
  assert.deepEqual(JSON.parse(row.value), original);
  const result = await finishHostedOperation(f.ctx, {
    projectId: auth.projectId,
    actor: auth.actor,
    operationId,
    receipt: { ...terminal, outcome: { status: 'completed', result: { later: true } } },
  });
  assert.deepEqual(result, original);
  assert.equal((await f.ctx.db.get(id)).value, stored);
});
