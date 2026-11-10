// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { entryStall } from '../dist/landing-entry-stall.js';
import { LANDING_STALL_MS } from '../dist/landing-stall.js';

test('run and canonical acceptance events reset the stall deadline, and a reviewer is named explicitly', () => {
  const old = '2026-10-23T19:00:00.000Z',
    fresh = '2026-10-23T19:16:00.000Z';
  const entry = { id: 'entry', batchId: 'batch', status: 'checking', arrivedAt: old };
  const batch = {
    id: 'batch',
    status: 'checking',
    prefixes: [{ entryIds: ['entry'], viewId: 'view', runId: 'run' }],
  };
  const data = {
    landingBatches: [batch],
    runs: [{ id: 'run', status: 'running', startedAt: fresh }],
    channelMoves: [],
  };
  assert.equal(entryStall(data, entry, Date.parse(fresh) + 1), undefined);
  data.runs[0].status = 'passed';
  data.runs[0].endedAt = old;
  data.channelMoves.push({ id: 'receipt', viewId: 'view', status: 'accepted', at: fresh });
  assert.equal(
    entryStall(data, entry, Date.parse(fresh) + 1),
    undefined,
    'acceptance counts before entry settlement',
  );
  entry.status = 'awaiting-review';
  const alarm = entryStall(data, entry, Date.parse(fresh) + LANDING_STALL_MS);
  assert.equal(alarm.step, 'review');
  assert.equal(alarm.missingOwner, 'reviewer');
});
