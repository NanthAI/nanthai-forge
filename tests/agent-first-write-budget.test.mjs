// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { runResourceWorker } from './resource-budget.mjs';

test('hosted first-write: one bounded query, zero cached/idle calls, bounded memory; CPU timings are diagnostic only', t => {
  t.diagnostic(JSON.stringify(runResourceWorker('./agent-first-write-budget-worker.mjs')));
});
