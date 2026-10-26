// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from './landing-batch-fixture.mjs';
import { batchEdit, selectBatch, composeBatch } from '../dist/landing-batch-store.js';
import { entryStall, entryProgress } from '../dist/landing-entry-stall.js';
import { LANDING_STALL_MS } from '../dist/landing-stall.js';
import { readLaneSubmissions } from '../dist/landing-submission-read.js';
import { formatPendingStatus } from '../dist/pending-status-format.js';
import { pendingStatus } from '../dist/pending-status.js';
import { watchLandingStalls } from '../dist/landing-stall-watch.js';
const select = f => batchEdit(f.work, 'main', data => selectBatch(f.work, data, 'main'), undefined, 'main');

test('2026-10-23 leaderless batch alarms at its composition step and names the missing controller', async t => {
  const f = await fixture(t);
  const candidate = await f.candidate('leaderless.txt');
  await select(f);
  const data = f.store.load(),
    entry = data.landingEntries[0];
  const { at } = entryProgress(data, entry);
  assert.equal(entryStall(data, entry, Date.parse(at) + LANDING_STALL_MS - 1), undefined);
  const alarm = entryStall(data, entry, Date.parse(at) + LANDING_STALL_MS);
  assert.equal(alarm.step, 'composition');
  assert.equal(alarm.missingOwner, 'landing controller');
  const status = pendingStatus(data, {}, new Date(Date.parse(at) + LANDING_STALL_MS).toISOString());
  assert.match(formatPendingStatus(status), /Landing alarms: .*composition; missing landing controller/);
  assert.deepEqual(status.lanes.find(lane => lane.laneId === candidate.lane.laneId).submission.stall, alarm);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.parse(at) });
  const watcher = watchLandingStalls(f.store, new AbortController().signal);
  t.mock.timers.tick(LANDING_STALL_MS);
  assert.equal(
    f.store.select('landingEntries', entry.id).stall.step,
    'composition',
    'the owner timer publishes without a requester',
  );
  watcher.close();
  t.mock.timers.reset();
  await composeBatch(f.work, data.landingBatches[0]);
  const advanced = f.store.load();
  assert.equal(
    entryStall(advanced, advanced.landingEntries[0]),
    undefined,
    'actual composition resets deadline',
  );
});

test('an overlap with no recorded reason alarms by itself, once, and is delivered in receipts', async t => {
  const f = await fixture(t);
  const candidate = await f.candidate('overlap.txt');
  const arrivedAt = new Date(Date.now() - LANDING_STALL_MS).toISOString();
  await batchEdit(f.work, 'fixture', data => {
    data.landingEntries[0].arrivedAt = arrivedAt;
    delete data.landingEntries[0].waitingFor;
  });
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const abort = new AbortController(),
    watcher = watchLandingStalls(f.store, abort.signal);
  t.after(() => {
    watcher.close();
    abort.abort();
  });
  t.mock.timers.tick(1);
  const saved = f.store.select('landingEntries', candidate.command.operationId);
  assert.equal(saved.stall.step, 'unrecorded-wait');
  assert.equal(saved.stall.missingOwner, 'landing controller');
  assert.equal(readLaneSubmissions(f.store, candidate.lane.laneId)[0].stall.step, 'unrecorded-wait');
  const revision = f.store.revision();
  watcher.refresh();
  t.mock.timers.tick(24 * 60 * 60_000);
  assert.equal(f.store.revision(), revision, 'alarmed entries own no recurring timer');
});

test('an idle native controller owns no alarm timer', async t => {
  const f = await fixture(t);
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const watcher = watchLandingStalls(f.store, new AbortController().signal);
  t.after(watcher.close);
  const revision = f.store.revision();
  t.mock.timers.tick(24 * 60 * 60_000);
  assert.equal(f.store.revision(), revision);
});

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
