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
      // Strict BFS reads at most the unresolved 40-State branches' depth of
      // speculative history. The owner accepted this fixed tradeoff from
      // 54/971/286; lock its new call/document ceilings without numeric slack.
      assert(report.functionCalls <= (shape === 'deep' ? 57 : 110), JSON.stringify(report));
      assert(report.documentsRead <= (shape === 'deep' ? 1155 : 2500), JSON.stringify(report));
      assert(report.documentsWritten <= (shape === 'deep' ? 311 : 750), JSON.stringify(report));
      if (shape === 'deep') {
        assert(report.readObjects <= 185, JSON.stringify(report));
        assert(report.readBytes <= 38721268 + 1024, 'only cursor/receipt encoding may vary');
      } else assert(report.readBytes <= 120 * 1024 * 1024, JSON.stringify(report));
      assert(report.maxRssBytes < 400 * 1024 * 1024, JSON.stringify(report));
      assert.equal(report.convexStorageCalls, 0);
      assert.equal(report.idleCalls, 0);
      t.diagnostic(JSON.stringify(report));
    });
  }
}
