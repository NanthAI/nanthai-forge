// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { runResourceWorker } from './resource-budget.mjs';

test('560 Lanes and 2200 Views: zero network calls, five header pages, bounded retained memory and first-edit CPU p95 under 200 ms', t => {
  t.diagnostic(JSON.stringify(runResourceWorker('./agent-first-write-budget-worker.mjs')));
});
