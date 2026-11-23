// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import { runResourceWorker } from './resource-budget.mjs';

test('hosted first-write: one bounded query, zero cached/idle calls, bounded memory; CPU timings are diagnostic only', t => {
  t.diagnostic(JSON.stringify(runResourceWorker('./agent-first-write-budget-worker.mjs')));
});
