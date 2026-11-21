// SPDX-License-Identifier: Apache-2.0
// Build-failing default/CI/I/O ratchets; changing the implicit mode to full must fail.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { synthetic } from './hosted-landing-batches-fixture.mjs';
import { replayAdmission } from './landing-admission-replay.mjs';
const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/landing-admission-timelines.json', import.meta.url)),
);
const { budgets } = JSON.parse(readFileSync(new URL('../src/speed-budgets.json', import.meta.url)));
const configuration = { ...synthetic, FORGE_HOSTED_CHECK_KEY_SYNTHETIC: 'synthetic-admission-default' };
const prior = Object.fromEntries(Object.keys(configuration).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, configuration));
test.after(() => {
  for (const [key, value] of Object.entries(prior))
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
});
for (const { cell, history } of [
  ...fixture.cells.map(cell => ({ cell, history: 0 })),
  ...[575, 1150].map(history => ({ cell: fixture.cells[0], history })),
])
  test(`queue-only default N=${cell.concurrency} history=${history}: one exact check per change, no reuse audits or idle work`, async t => {
    const result = await replayAdmission(t, cell, { admissionCheck: 'default', history });
    const metrics = {
      admissionQueueOnlyChecks: result.checks,
      admissionQueueOnlyCiMinutes: result.ciMinutes,
      admissionQueueOnlyAudits: result.audits + result.deferredAudits,
      admissionQueueOnlyCalls: result.calls,
      admissionQueueOnlyDocumentsRead: result.documentsRead,
      admissionQueueOnlyDocumentsWritten: result.documentsWritten - result.liveLineWrites - result.feedWrites,
      admissionQueueOnlySubmitOverServiceMs:
        result.submitMaxMs - Math.max(...cell.entries.map(e => e.checkMs)),
    };
    // Every quantity over its budget is named at once, not only the first.
    const over = [];
    for (const [metric, value] of Object.entries(metrics)) {
      const budget = budgets.find(b => b.metric === metric);
      assert(budget, `central budget for ${metric}`);
      if (value > budget.max) over.push(`${metric}: ${value} exceeds ${budget.max}`);
    }
    assert.deepEqual(over, [], JSON.stringify(result.callCounts));
    assert.equal(result.idle, 0);
    assert.equal(result.landed.length, 10);
    assert.equal(result.feedWrites, result.landed.length, 'one feed insert per landed Lane');
    t.diagnostic(
      JSON.stringify({
        N: cell.concurrency,
        metrics,
        physicalWrites: result.documentsWritten,
        liveLineWrites: result.liveLineWrites,
        feedWrites: result.feedWrites,
        peakRssBytes: process.resourceUsage().maxRSS * 1024,
      }),
    );
  });

test('the same queue wave crossing an hour adds only its declared account-order update', async t => {
  const samples = [];
  for (const minute of [0, 55])
    await t.test(`fixed start minute ${minute}`, async subtest => {
      const startAt = Date.UTC(2026, 0, 1, 12, minute);
      const result = await replayAdmission(subtest, fixture.cells[0], {
        admissionCheck: 'default',
        startAt,
      });
      assert.equal(result.startedAt, startAt, 'the whole replay uses the selected synthetic epoch');
      samples.push(result);
    });
  const [withinHour, acrossHour] = samples;
  const { accountOrderTouch: firstTouches, ...firstCalls } = withinHour.callCounts;
  const { accountOrderTouch: nextTouches, ...nextCalls } = acrossHour.callCounts;
  assert.equal(firstTouches, 1);
  assert.equal(nextTouches, 2);
  assert.deepEqual(nextCalls, firstCalls, 'clock phase changes no queue, source or check call');
  assert.equal(acrossHour.calls - withinHour.calls, nextTouches - firstTouches);
  assert.equal(acrossHour.checks, withinHour.checks);
  assert.equal(acrossHour.ciMinutes, withinHour.ciMinutes);
  assert.equal(acrossHour.idle, 0);
  t.diagnostic(
    JSON.stringify({
      withinHourCalls: withinHour.calls,
      acrossHourCalls: acrossHour.calls,
      withinHourOrderUpdates: firstTouches,
      acrossHourOrderUpdates: nextTouches,
    }),
  );
});
