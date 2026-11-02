// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { measureResolutionAncestry } from './measure-resolution-ancestry.mjs';

for (const count of [2800, 5600]) {
  for (const shape of ['deep', 'wide']) {
    test(`${count}-State ${shape} resolution stays within verified frontier transport budgets`, async t => {
      const report = await measureResolutionAncestry(count, shape);
      // Fixed selected tips make retained history irrelevant once the common
      // frontier is proven. Budgets include real handler control, descriptors,
      // R2 progress and native conflict-draft computation, not just the reducer.
      assert(report.stateTasks <= 16, JSON.stringify(report));
      assert(report.stateFanoutBatches <= 5, JSON.stringify(report));
      assert(report.functionCalls <= 110, JSON.stringify(report));
      assert(report.documentsRead <= 2500, JSON.stringify(report));
      assert(report.documentsWritten <= 750, JSON.stringify(report));
      assert(report.readBytes <= 120 * 1024 * 1024, JSON.stringify(report));
      assert(report.maxRssBytes < 400 * 1024 * 1024, JSON.stringify(report));
      assert.equal(report.convexStorageCalls, 0);
      assert.equal(report.idleCalls, 0);
      t.diagnostic(JSON.stringify(report));
    });
  }
}
