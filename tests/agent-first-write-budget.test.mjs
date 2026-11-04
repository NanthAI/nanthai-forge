// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import { runResourceWorker } from './resource-budget.mjs';

test('hosted first-write: one bounded query, zero cached/idle calls, bounded memory and worker CPU p95 under 200 ms', t => {
  t.diagnostic(JSON.stringify(runResourceWorker('./agent-first-write-budget-worker.mjs')));
});
