// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { qualifyConcurrentWork } from '../scripts/qualify-concurrent-work.mjs';
test(
  'eight process clients retain distinct work, original retries and an explicit shared-source conflict resolution',
  { timeout: 240000 },
  async t => {
    const result = await qualifyConcurrentWork();
    assert.equal(result.independentClients, 8);
    assert.equal(result.conflict.status, 'conflict');
    assert.equal(result.resolution.status, 'clean');
    assert.equal(result.unknownFieldsPreserved, true);
    assert.equal(result.originalConflictPreserved, true);
    assert.equal(new Set(result.workers.map(worker => worker.lane.laneId)).size, 8);
    t.diagnostic(
      JSON.stringify({
        independentClients: result.independentClients,
        independentMs: result.independentMs,
        totalMs: result.totalMs,
        busyRetries: result.workers.reduce((sum, worker) => sum + worker.retries.WORK_BUSY, 0),
        staleRetries: result.workers.reduce((sum, worker) => sum + worker.retries.WORK_STALE, 0),
        sourceChangedRetries: result.workers.reduce((sum, worker) => sum + worker.retries.SOURCE_CHANGED, 0),
        conflictRetained: true,
      }),
    );
  },
);
