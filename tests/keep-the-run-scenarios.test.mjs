// SPDX-License-Identifier: Apache-2.0
// Keep the run (Item fa2c1383), the owner's condition (00a694d5): per kept run, the Convex cost
// against the runner-minutes and time to main saved, at 1-2, 3-5 and 10 agents. The wiring ships
// only if every multi-agent case saves clearly more than it costs, a quiet project stays near +0,
// and the cost per 1,000 landings stays within +$0.10 (above that it goes back to the owner).
import test from 'node:test';
import assert from 'node:assert/strict';
import { KEPT_CONVEX, MEASURED, scenarioTable, servingUsd } from './keep-the-run-scenarios.mjs';

const table = scenarioTable();

test('fa2c1383 scenarios: every kept case saves runner-minutes and time to main at every project size', t => {
  t.diagnostic(JSON.stringify(table));
  for (const tier of table)
    for (const row of tier.rows) {
      const at = JSON.stringify({ tier: tier.name, row });
      assert(row.savedJobMinutes > 0, at);
      assert(row.savedWallMinutes > 0, at);
      // Clearly more than it costs: a saved runner-minute at private-repository list price against
      // the full-list Convex price of the kept run (calls and compute included).
      assert(row.savedRunnerUsd >= 100 * Math.max(row.convexFullListUsd, 0), at);
    }
});

test('fa2c1383 scenarios: a quiet project stays near +0 and no project size passes the owner cap', () => {
  const [quiet, mid, busy] = table;
  assert(quiet.servingUsdPer1000Landings <= 0.005, JSON.stringify(quiet));
  for (const tier of table) assert(tier.fullListUsdPer1000Landings <= 0.1, JSON.stringify(tier));
  // Cost is paid only when a run is kept, and a run is kept more often the busier main is.
  assert(quiet.servingUsdPer1000Landings < mid.servingUsdPer1000Landings);
  assert(mid.servingUsdPer1000Landings < busy.servingUsdPer1000Landings);
  // The saving per kept run grows with cascades of retires at 10 agents.
  for (const [i, row] of busy.rows.entries()) assert(row.savedJobMinutes > quiet.rows[i].savedJobMinutes);
});

test('fa2c1383 scenarios: a kept carry or red run costs less Convex than the retire it replaces', () => {
  // The retire's replacement resolves its source and, red, runs and fails again; the scoped recheck
  // is the one kept case that costs more (its own completion ingest and a prove action).
  for (const kind of ['carry', 'carry, C1 follower', 'red']) assert(servingUsd(KEPT_CONVEX[kind]) < 0, kind);
  assert(servingUsd(KEPT_CONVEX['scoped-recheck']) > 0);
});

test('fa2c1383 scenarios: a project with no checking row pays nothing extra for the sweep', () => {
  // Strict and fast settle the same lone landing at the same cost: the fast-main and main-gate reads
  // happen only when a checking row reaches the keep rule.
  assert.equal(MEASURED['no checking row, strict'].calls, MEASURED['no checking row, fast'].calls);
  assert.equal(MEASURED['no checking row, strict'].documents, MEASURED['no checking row, fast'].documents);
});
