// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { landing, claims, repository } from './hosted-actions-results-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { resultSlotKey, resultEnvelopeBody } from '../dist/hosted-actions-result-batch.js';
const collector = await import(moduleUrl('../convex/projectHostedActionsBatch.ts'));
const verdict = await import(moduleUrl('../convex/projectHostedActionsVerdict.ts'));

export async function reportFoldFixture(t, { failed = false, conclusion = 'success' } = {}) {
  const l = await landing(t, 2, true, true, true),
    run = l.stored();
  for (let index = 0; index < 2; index++)
    l.inbox.set(
      `/synthetic-bucket/${resultSlotKey(run, index)}`,
      Buffer.from(
        resultEnvelopeBody({
          packed: true,
          result: {
            index,
            exitCode: failed && index === 0 ? 1 : 0,
            contractReports: {
              [`tests/fold-${index}.test.mjs`]: { failed: failed && index === 0, durationMs: 17 },
            },
          },
        }),
      ),
    );
  const input = { ...l.id, fence: run.fence, executionId: run.executionId, claims: JSON.stringify(claims()) };
  const uploader = () => collector.collectResultBatch(l.ctx, input);
  l.provider.conclusion = conclusion;
  const confirmation = () =>
    verdict.confirm._handler(l.ctx, {
      ...l.id,
      fence: run.fence,
      attempt: 0,
      jobs: true,
      target: { repository, executionId: run.executionId, runnerScope: null },
    });
  return { ...l, input, events: { U: uploader, W: () => l.conclude(conclusion), C: confirmation } };
}

export async function guardReportFoldOrders(t) {
  const orders = ['UWC', 'UCW', 'WUC', 'WCU', 'CUW', 'CWU'];
  let batchCalls = 0;
  // A ten-landing mix with eight main-move rechecks has eighteen runs. Each ordering
  // appears three times; replaying all three ingress paths adds no ingestion.
  for (let index = 0; index < 18; index++) {
    const order = orders[index % orders.length];
    await t.test(`${order} run ${index + 1}: one ingestion including ingress replays`, async child => {
      const l = await reportFoldFixture(child),
        start = l.s.counts.length;
      for (const event of order) await l.events[event]();
      const callsBeforeReplay = l.s.counts.length - start;
      assert(callsBeforeReplay <= 6, `ordinary events used ${callsBeforeReplay} transactions`);
      assert.equal(l.stored().status, 'passed');
      assert.equal([...l.s.tables.projectHostedCheckRuns.values()][0].reportTimingComplete, true);
      assert([...l.s.tables.projectHostedOutputHeads.values()][0].final);
      const row = structuredClone([...l.s.tables.projectHostedCheckRuns.values()][0]);
      const timings = structuredClone([...l.s.tables.projectHostedTestTimings.values()]);
      const r2 = structuredClone(l.r2),
        replayStart = l.s.counts.length;
      for (const event of order + [...order].reverse().join('')) await l.events[event]();
      const counts = l.s.counts.slice(start);
      const ingests = counts.filter(count => count.name === 'projectHostedActionsResults:batch');
      assert.equal(ingests.length, 1, `${order}: duplicate ingestion`);
      batchCalls += ingests.length;
      assert.deepEqual([...l.s.tables.projectHostedCheckRuns.values()][0], row);
      assert.deepEqual([...l.s.tables.projectHostedTestTimings.values()], timings);
      assert.deepEqual(l.r2, r2, 'identical replays perform zero object I/O');
      assert(
        l.s.counts.slice(replayStart).every(count => count.written.length === 0),
        'replays rewrite no rows',
      );
      assert.equal(l.s.tables.projectHostedActionsResults.size, 0);
      child.diagnostic(
        JSON.stringify({
          order,
          ingestionCalls: ingests.length,
          callsBeforeReplay,
          replayCalls: l.s.counts.length - replayStart,
        }),
      );
    });
  }
  assert.equal(batchCalls, 18, 'ten landings/eighteen checks stay at the a2 ceiling of 18 ingestions');
  t.diagnostic(`ten-landings result-batch calls ${batchCalls}/18; all six orders plus two rounds of replays`);
}
