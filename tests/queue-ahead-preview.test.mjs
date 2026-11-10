// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { nativeQueueAhead } from '../dist/queue-ahead-native.js';
import { queueAheadPreview, QUEUE_AHEAD_LIMIT } from '../dist/queue-ahead-preview.js';
import { firstAttemptLandRate } from '../dist/first-attempt-land-rate.js';

test('unavailable selected records never trigger whole-Work hydration for advisory previews', () => {
  let loads = 0;
  const store = {
    readRecords: () => undefined,
    load: () => {
      loads++;
      throw Error('Advisory preview must not hydrate retained Work');
    },
  };
  const preview = nativeQueueAhead(store, { id: 'entry', status: 'queued' });
  assert.equal(loads, 0);
  assert.deepEqual(preview.unavailable, ['entry']);
  assert.equal(preview.cost.composeCalls, 0);
  assert.deepEqual(preview.conflicts, []);
});

test('advisory work is capped and cached without blocking submission', () => {
  const rows = Array.from({ length: QUEUE_AHEAD_LIMIT + 3 }, (_, n) => ({
    id: String(n),
    head: String(n),
    lanes: ['parent'],
    status: 'checking',
  }));
  const values = new Map();
  const cache = { read: key => values.get(key), write: (key, value) => values.set(key, value) };
  let calls = 0;
  const source = {
    compose: () => {
      calls++;
      return { head: 'composed', conflicts: [] };
    },
  };
  let result = queueAheadPreview(source, cache, '/fixture', 'main', 'mine', rows);
  assert.equal(result.considered, QUEUE_AHEAD_LIMIT);
  assert.equal(result.more, true);
  assert.equal(calls, QUEUE_AHEAD_LIMIT * 2);
  result = queueAheadPreview(source, cache, '/fixture', 'main', 'mine', rows);
  assert.equal(result.cost.composeCalls, 0);
  assert.equal(result.cost.cacheHits, QUEUE_AHEAD_LIMIT);
  assert.equal(result.conflicts.length, 0);
  const unavailable = queueAheadPreview(
    {
      compose() {
        throw Error('unavailable');
      },
    },
    cache,
    '/fixture',
    'new-main',
    'mine',
    rows,
  );
  assert.equal(unavailable.unavailable.length, QUEUE_AHEAD_LIMIT);
});

test('first-entry rate counts Lanes, includes pending, retains pre-window context and reports retry causes', () => {
  const at = n => `2026-10-${String(n).padStart(2, '0')}T00:00:00.000Z`;
  const row = (id, day, laneIds, accepted = false, cause = 'other', pending = false) => ({
    id,
    at: at(day),
    laneIds,
    accepted,
    cause,
    pending,
  });
  const rows = [
    row('old', 1, ['old']),
    row('old-retry', 12, ['old'], true),
    row('first', 11, ['a', 'b'], true),
    row('conflict', 11, ['c'], false, 'conflict'),
    row('retry', 12, ['c'], true),
    row('check', 11, ['d'], false, 'check-failure-or-flake'),
    row('retry-d', 12, ['d'], true),
    row('stall', 11, ['e'], false, 'stall'),
    row('retry-e', 12, ['e'], true),
    row('cancel', 11, ['f'], false, 'cancelled'),
    row('retry-f', 12, ['f'], true),
    row('pending', 11, ['g'], false, 'other', true),
    row('end', 20, ['outside'], true),
  ];
  const metric = firstAttemptLandRate(rows, at(10), at(20));
  assert.equal(metric.lanes, 7);
  assert.equal(metric.accepted, 2);
  assert.equal(metric.rate, 2 / 7);
  assert.equal(metric.pending, 1);
  assert.equal(metric.retriedLanes, 4);
  assert.deepEqual(metric.retryCauses, {
    conflict: 1,
    'check-failure-or-flake': 1,
    stall: 1,
    cancelled: 1,
    other: 0,
  });
  assert.equal(firstAttemptLandRate([], at(10), at(20)).rate, null);
});

test('existing metric read keeps hosted child attempts inside their original land entry', async () => {
  const { calculateSelfMetrics } = await import('../dist/self-metrics.js');
  const records = {
    moves: [],
    runs: [],
    receipts: [],
    gaps: [],
    submissions: [
      {
        id: 'attempt-0',
        entryId: 'entry',
        entryAt: '2026-10-11T00:00:00.000Z',
        entryStatus: 'landed',
        at: '2026-10-11T00:00:00.000Z',
        inputs: [{ laneId: 'lane', intentId: 'intent', head: 'head' }],
        status: 'superseded',
        progressAt: [],
        runIds: [],
      },
      {
        id: 'attempt-1',
        entryId: 'entry',
        entryAt: '2026-10-11T00:00:00.000Z',
        entryStatus: 'landed',
        at: '2026-10-12T00:00:00.000Z',
        inputs: [{ laneId: 'lane', intentId: 'intent', head: 'head' }],
        status: 'landed',
        progressAt: [],
        runIds: [],
      },
    ],
  };
  const result = calculateSelfMetrics(records, {
    from: '2026-10-10T00:00:00.000Z',
    to: '2026-10-20T00:00:00.000Z',
  });
  assert.equal(result.firstAttemptLandRate.rate, 1);
  assert.equal(result.firstAttemptLandRate.lanes, 1);
  assert.equal(result.firstAttemptLandRate.retriedLanes, 0);
});
