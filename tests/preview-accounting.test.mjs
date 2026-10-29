import { digest } from '../dist/hash.js';
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { initNative } from '../dist/native-work.js';
import { WorkStore } from '../dist/work-store.js';
import { retainPreviewMeasurement, previewMeasurements } from '../dist/preview-accounting.js';
import { localCost } from '../dist/check-cost.js';
import { trainAccounting } from '../dist/train-accounting.js';
import { agentCostSummary } from '../dist/agent-cost-summary.js';

test('local preview measurements survive cache loss and shared-input replay without Work writes', t => {
  const root = mkdtempSync(join(tmpdir(), 'forge-preview-cost-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
  writeFileSync(join(root, 'a.txt'), 'synthetic');
  initNative(root);
  const store = new WorkStore(root),
    executionId = randomUUID();
  const measurement = {
    executionId,
    startedAt: '2026-01-01T00:00:00Z',
    durationMs: 34,
    inputs: [0, 1].map(() => ({ laneId: randomUUID(), head: 'a'.repeat(64) })),
    cost: localCost(executionId),
  };
  const before = readFileSync(join(store.directory, 'work.json'));
  retainPreviewMeasurement(store, measurement);
  retainPreviewMeasurement(store, measurement);
  assert.deepEqual(readFileSync(join(store.directory, 'work.json')), before);
  const observed = previewMeasurements(store.directory);
  assert.deepEqual(observed.rows, [measurement]);
  rmSync(join(tmpdir(), `forge-peers-${process.getuid?.() ?? 'user'}`, digest(store.directory)), {
    recursive: true,
    force: true,
  });
  assert.deepEqual(previewMeasurements(store.directory).rows, [measurement]);
  assert.throws(() => retainPreviewMeasurement(store, { ...measurement, durationMs: 99 }), {
    code: 'WORK_OPERATION_CHANGED',
  });
  const summary = trainAccounting([], { previews: [measurement, measurement] });
  assert.equal(summary.total.executions, 1);
  assert.equal(summary.categories.preview.knownGrossCostUsd, 0);
  assert.equal(summary.previews.feedback.p50Ms, 34);
  const status = agentCostSummary(root, store.readRecords());
  assert.equal(status.checkCosts.train.categories.preview.executions, 1);
  const secondId = randomUUID();
  retainPreviewMeasurement(store, { ...measurement, executionId: secondId, cost: localCost(secondId) });
  assert.notEqual(previewMeasurements(store.directory).version, observed.version);
  assert.equal(agentCostSummary(root, store.readRecords()).checkCosts.train.categories.preview.executions, 2);
});
