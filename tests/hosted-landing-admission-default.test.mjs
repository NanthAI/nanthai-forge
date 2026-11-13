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
      admissionQueueOnlyDocumentsWritten: result.documentsWritten,
      admissionQueueOnlySubmitOverServiceMs:
        result.submitMaxMs - Math.max(...cell.entries.map(e => e.checkMs)),
    };
    for (const [metric, value] of Object.entries(metrics)) {
      const budget = budgets.find(b => b.metric === metric);
      assert(budget, `central budget for ${metric}`);
      assert(value <= budget.max, `${metric}: ${value} exceeds ${budget.max}`);
    }
    assert.equal(result.idle, 0);
    assert.equal(result.landed.length, 10);
    t.diagnostic(
      JSON.stringify({ N: cell.concurrency, metrics, peakRssBytes: process.resourceUsage().maxRSS * 1024 }),
    );
  });
