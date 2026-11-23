// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { orderLandingEntries } from '../dist/landing-batch-order.js';

test('priority and submitter fairness only change ordering and keep original age', () => {
  const entries = ['a', 'a', 'a', 'a', 'b', 'c'].map((submitter, index) => ({
    id: index,
    submitter,
    priority: 'normal',
    arrivedAt: String(index),
  }));
  const before = JSON.stringify(entries);
  assert.deepEqual(
    orderLandingEntries(entries).map(entry => entry.id),
    [0, 1, 4, 2, 5, 3],
  );
  const urgent = { id: 6, submitter: 'd', priority: 'urgent', arrivedAt: '9' };
  assert.equal(orderLandingEntries([...entries, urgent])[0], urgent);
  assert.equal(JSON.stringify(entries), before);
});
