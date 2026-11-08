// SPDX-License-Identifier: Apache-2.0
// Review 3aa618e2 F3: begin hints only the shape the small save runs, so a save the V8 step hands
// to Node does not first download its baseline and page for nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
const { saveStepReads } = await import(moduleUrl('../convex/projectSourceBeginReads.ts'));
const pin = size => ({ sha256: 'a'.repeat(63) + String(size % 10), size });
function ctx(pageSize, baselineSize = 1024, recipe = null) {
  const state = {
    request: {
      operationId: randomUUID(),
      laneId: randomUUID(),
      authorityEpoch: 1,
      expected: { head: 'b'.repeat(64), version: 0, sourceVersion: 0, lifecycleVersion: 0 },
      message: 'm',
      pages: pin(pageSize),
      pageCount: 1,
      changeCount: 1,
    },
    baseline: { object: pin(baselineSize), recipe },
    next: null,
    stagedPages: 1,
    stagedChanges: 1,
    lastPath: 'a.txt',
    jobOperationId: randomUUID(),
    status: 'submitted',
  };
  const row = { value: JSON.stringify(state) };
  return {
    db: { query: () => ({ withIndex: () => ({ unique: async () => row }) }) },
  };
}
test('begin hints the baseline and page only for a page of at most 128 KiB and a raw baseline of at most 4 MiB', async () => {
  assert.equal((await saveStepReads(ctx(128 * 1024), 'p', 'j')).length, 2);
  assert.deepEqual(await saveStepReads(ctx(128 * 1024 + 1), 'p', 'j'), []);
  assert.deepEqual(await saveStepReads(ctx(1024, 4 * 1024 * 1024 + 1), 'p', 'j'), []);
  assert.deepEqual(await saveStepReads(ctx(1024, 1024, pin(64)), 'p', 'j'), []);
});
