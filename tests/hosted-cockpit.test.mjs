// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';

import { hostedCockpitFixture } from './hosted-cockpit-fixture.mjs';

import { materializeWork, indexBatches } from '../dist/work-hosted-index.js';
globalThis.location = { href: 'https://forge.example.test/?project=synthetic' };

test('hosted summaries expose cockpit pins, save metadata and check evidence while retaining full payloads', () => {
  const f = hostedCockpitFixture();
  const [lane] = f.records.lanes,
    [view] = f.records.views,
    [run] = f.records.runs;
  assert.deepEqual(lane.checkpoints, []);
  assert.equal(lane.checkpointCount, 2);
  assert.equal(lane.lastCheckpointAt, f.savedAt);
  assert.equal(lane.lastCheckpointMessage.length, 200);
  assert.deepEqual(view.inputs, [{ laneId: f.laneId, head: lane.head, saveIndex: 1 }]);
  assert.deepEqual(view.dependencies, []);
  assert.equal(view.dependencyCount, 0);
  assert.equal(run.checkName, 'verify');
  assert.equal(run.exitCode, 1);
  assert.equal(run.startedAt, f.data.runs[0].startedAt);
  assert.equal(run.endedAt, f.data.runs[0].endedAt);
  assert.equal(run.failureSummary, f.data.runs[0].failureSummary);
  assert.equal(run.check, undefined);
  for (const [collection, original] of [
    ['lanes', f.data.lanes[0]],
    ['views', f.data.views[0]],
    ['runs', f.data.runs[0]],
  ]) {
    const header = f.records[collection][0];
    const payload = f.projection.entries.filter(
      row => row.collection === `${collection}:payload` && row.parent === header.payloadKey,
    );
    assert.deepEqual(JSON.parse(payload.map(row => row.value).join('')), original);
    assert.ok(Buffer.byteLength(JSON.stringify(header)) < 8000);
  }
});

test('eight-Lane summaries and durable failures stay inside existing row and batch limits', () => {
  const f = hostedCockpitFixture();
  f.data.views[0].inputs = Array.from({ length: 8 }, () => f.data.views[0].inputs[0]);
  f.data.views[0].dependencies = [{ kind: 'view', viewId: f.viewId, head: f.data.views[0].head }];
  f.data.runs[0].failureSummary = 'f'.repeat(4096);
  f.data.runs[0].check.name = 'c'.repeat(40000);
  const projection = materializeWork(f.data, f.manifest, []);
  const view = JSON.parse(projection.entries.find(row => row.collection === 'views').value);
  assert.equal(view.inputs.length, 8);
  assert.equal(view.dependencyCount, 1);
  assert.equal(
    JSON.parse(projection.entries.find(row => row.collection === 'runs').value).checkName.length,
    200,
  );
  f.data.runs[0].checkSelection = {
    scope: 'scoped',
    reason: 'Synthetic impact fixture',
    tests: ['tests/files.test.mjs'],
  };
  const scoped = materializeWork(f.data, f.manifest, []);
  const scopedRun = JSON.parse(scoped.entries.find(row => row.collection === 'runs').value);
  assert.equal(scopedRun.checkName.length, 200);
  assert.match(scopedRun.checkName, / · scoped$/);
  assert.ok(projection.entries.every(row => Buffer.byteLength(JSON.stringify(row)) < 200000));
  assert.ok(
    indexBatches(projection.entries).every(
      batch => batch.length <= 100 && Buffer.byteLength(JSON.stringify(batch)) < 510000,
    ),
  );
});
