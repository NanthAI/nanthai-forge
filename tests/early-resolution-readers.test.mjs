// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { hostedAgentCommandSchemas } from '../dist/hosted-agent-contract.js';
import { hostedRecordSchema } from '../dist/hosted-records.js';
import { syncRequiredAdvice, wouldConflictSchema } from '../dist/hosted-would-conflict.js';

const head = 'a'.repeat(64),
  at = '2026-01-01T00:00:00.000Z';
const predecessor = { submissionId: randomUUID(), head, receiptId: randomUUID() };
const earlyResolution = { predecessor, laneId: randomUUID(), originalHead: head, startedAt: at };
const common = {
  id: randomUUID(),
  version: 0,
  at,
  intentId: randomUUID(),
  base: { head, receiptId: 'base' },
};
const lane = {
  ...common,
  kind: 'lane',
  actor: 'synthetic',
  head,
  sourceVersion: 0,
  lifecycleVersion: 0,
  state: 'active',
  authorityEpoch: 1,
};
const object = { sha256: head, size: 0 };
const candidate = {
  ...common,
  kind: 'candidate',
  inputs: object,
  dependencies: object,
  algorithm: 'synthetic',
  result: { status: 'clean', head },
};

for (const [record, field, value] of [
  [lane, 'earlyResolution', earlyResolution],
  [candidate, 'earlyResolutions', [earlyResolution]],
]) {
  test(`stored ${record.kind} accepts legacy and exact predecessor metadata without dropping pins`, () => {
    assert.deepEqual(hostedRecordSchema.parse(JSON.parse(JSON.stringify(record))), record);
    const expanded = { ...record, [field]: value };
    assert.deepEqual(hostedRecordSchema.parse(JSON.parse(JSON.stringify(expanded))), expanded);
    const invalid = { ...earlyResolution, predecessor: { ...predecessor, head: 'unbound' } };
    assert.equal(
      hostedRecordSchema.safeParse({ ...record, [field]: Array.isArray(value) ? [invalid] : invalid })
        .success,
      false,
    );
  });
}

test('reader expansion preserves queued advisory behavior before writer activation', () => {
  const advice = {
    code: 'COMPOSITION_CONFLICT',
    predecessor: { ...predecessor, groupId: randomUUID() },
    paths: ['shared.txt'],
    more: 0,
    at,
    next: 'Retain this queued entry.',
  };
  const expanded = {
    ...advice,
    resolution: {
      early: true,
      mode: 'automatic',
      failureRate: null,
      resolveMs: null,
      waitSavedMs: null,
      breakEven: null,
      samples: 0,
      measuredCosts: 0,
      reason: 'cold-start',
    },
  };
  assert.deepEqual(wouldConflictSchema.parse(expanded), expanded);
  assert.equal(hostedAgentCommandSchemas.sync.safeParse({ predecessor }).success, false);
  assert.equal(syncRequiredAdvice(advice), undefined);
  assert.equal(syncRequiredAdvice(expanded), undefined);
});
