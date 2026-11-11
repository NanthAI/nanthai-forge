// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { decision, isolateBytes, costModel } from './workers-source-step-spike-metrics.mjs';
const evidence = JSON.parse(
  readFileSync(new URL('../spikes/workers-source-step/evidence.json', import.meta.url)),
);
test('S8a kill counts live backing storage and embedder memory, without double-counting heap capacity', () => {
  assert.equal(
    isolateBytes({
      usedSize: 74_888_188,
      totalSize: 125_599_744,
      embedderHeapUsedSize: 336_592,
      backingStorageSize: 27_513_386,
    }),
    102_738_166,
  );
});
test('S8a cannot turn unsupported zero or missing telemetry into a memory pass', () => {
  assert.throws(() => isolateBytes({ usedSize: 0, backingStorageSize: 0 }), /embedder/);
  assert.throws(
    () => isolateBytes({ usedSize: -1, embedderHeapUsedSize: 0, backingStorageSize: 0 }),
    /invalid/,
  );
  assert.match(decision({ count: 29000, samples: [], output: null }), /^unproven/);
});
test('S8a stops on any output pin mismatch including same digest with different size', () => {
  for (const output of [
    { sha256: 'other', size: 1 },
    { sha256: 'same', size: 2 },
  ])
    assert.equal(
      decision({ count: 10, samples: [], expected: { sha256: 'same', size: 1 }, output }),
      'kill: differing output pin',
    );
});
test('S8a applies the strict decimal 100 MB kill only to the 29k fixture', () => {
  const sample = { usedSize: 100_000_000, embedderHeapUsedSize: 0, backingStorageSize: 0 };
  assert.match(decision({ count: 29000, samples: [sample] }), /^unproven/);
  assert.match(decision({ count: 29000, samples: [{ ...sample, backingStorageSize: 1 }] }), /^kill/);
  assert.match(decision({ count: 58000, samples: [{ ...sample, backingStorageSize: 1 }] }), /^unproven/);
});
test('S8a captured observation triggers the kill and retains exact provider output parity', () => {
  assert.deepEqual(evidence.worker.input, evidence.baseline.input);
  assert.deepEqual(evidence.worker.output, evidence.baseline.output);
  assert.equal(
    decision({
      count: 29000,
      samples: evidence.worker.samples,
      expected: evidence.baseline.output,
      output: evidence.worker.output,
    }),
    evidence.stop,
  );
});
test('S8a source subtotal includes HEAD requests and exposes unknown Worker bridge compute separately', () => {
  const model = costModel(evidence.baseline, evidence.worker);
  assert.equal(model.r2Per1000.baseline, 0.03132);
  assert.equal(model.r2Per1000.worker, 0.01116);
  const withBridge = costModel(evidence.baseline, evidence.worker, 0.25);
  assert.equal(
    withBridge.professionalPer1000.workerOptimistic,
    model.professionalPer1000.workerOptimistic + 0.25,
  );
});
