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

test('activated reader keeps exact predecessor recovery pins and legacy advisory behavior', () => {
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
  assert.equal(hostedAgentCommandSchemas.sync.safeParse({ predecessor }).success, true);
  assert.equal(syncRequiredAdvice(advice), undefined);
  assert.deepEqual(syncRequiredAdvice(expanded), expanded);
});

test('compact save advice preserves exact pins and legacy notices retain their continuation', async () => {
  const { exactConflictsSchema, exactConflictNotice } = await import('../dist/hosted-conflict-notice.js');
  const advice = {
    code: 'COMPOSITION_CONFLICT',
    predecessor: { ...predecessor, groupId: randomUUID() },
    resolution: { early: true, mode: 'on', reason: 'enabled' },
    paths: ['shared.txt'],
    more: 0,
    at,
    next: 'Resolve the exact saved predecessor.',
  };
  assert.deepEqual(syncRequiredAdvice(advice), advice);
  const legacy = {
    with: randomUUID(),
    goal: 'synthetic',
    flaggedAt: at,
    files: [{ path: 'shared.txt', mine: [[1, 1]], theirs: [[1, 1]], reason: 'overlap' }],
  };
  const laneId = randomUUID();
  const oldNotice = exactConflictNotice(laneId, exactConflictsSchema.parse([legacy]));
  assert.equal(oldNotice.continuation, undefined);
  assert.match(oldNotice.next, /Agree an order/);
  const notice = exactConflictNotice(
    laneId,
    exactConflictsSchema.parse([{ ...legacy, earlyResolution: advice }]),
  );
  assert.deepEqual(notice.continuation.next.predecessor, predecessor);
  assert.equal(notice.continuation.next.laneId, laneId);
  assert.equal(notice.continuation.next.action, 'sync');
  assert.equal(
    exactConflictsSchema.safeParse([
      { ...legacy, earlyResolution: { ...advice, predecessor: { ...advice.predecessor, head: 'unbound' } } },
    ]).success,
    false,
  );
});
