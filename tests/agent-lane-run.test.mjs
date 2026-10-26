// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './landing-batch-fixture.mjs';
import { ForgeError } from '../dist/errors.js';

test('Lane run composes without a prior Candidate and survives a concurrent writer WORK_STALE', async t => {
  const f = await fixture(t, { delay: 0 });
  const lane = (await f.agent.dispatch({ action: 'start', outcome: 'Run saved Lane' })).result;
  writeFileSync(join(lane.path, 'saved.txt'), 'saved\n');
  const saved = (await f.agent.dispatch({ action: 'checkpoint', laneId: lane.laneId, message: 'Save' }))
    .result;
  const dispatch = f.work.dispatch.bind(f.work);
  let compositions = 0;
  f.work.dispatch = async (command, revision, options) => {
    if (command.action === 'compose' && ++compositions === 1) {
      await f.agent.dispatch({ action: 'start', outcome: 'Concurrent unrelated writer' });
      // Exercise the actual revision guard after the concurrent metadata write.
      return dispatch(command, revision, { ...options, reconcileComposition: false });
    }
    return dispatch(command, revision, options);
  };
  const operationId = randomUUID();
  const result = (await f.agent.dispatch({ action: 'run', operationId, laneId: lane.laneId })).result;
  assert.equal(result.status, 'passed');
  assert.equal(compositions, 2);
  const run = f.store.select('runs', operationId);
  assert.deepEqual(run.inputs, [{ laneId: lane.laneId, head: saved.head }]);
  assert.equal(run.comparisonBase, lane.base);
  writeFileSync(join(lane.path, 'saved.txt'), 'later save\n');
  await f.agent.dispatch({ action: 'checkpoint', laneId: lane.laneId, message: 'Later' });
  assert.deepEqual(
    (await f.agent.dispatch({ action: 'run', operationId, laneId: lane.laneId })).result,
    result,
  );
  assert.equal(f.store.load().runs.length, 1);
});

test('Lane run composes the saved Lane with pinned accepted main', async t => {
  const f = await fixture(t, { delay: 0 });
  const pending = await f.candidate('lane.txt', undefined, false);
  const accepted = await f.candidate('main.txt', undefined, false);
  await f.agent.dispatch({ action: 'run', viewId: accepted.view.id });
  const move = (await f.agent.dispatch({ action: 'accept', channel: 'main', viewId: accepted.view.id }))
    .result;
  const operationId = randomUUID();
  assert.equal(
    (await f.agent.dispatch({ action: 'run', laneId: pending.lane.laneId, operationId })).result.status,
    'passed',
  );
  const run = f.store.select('runs', operationId);
  assert.equal(run.comparisonBase, move.head);
  assert.ok(run.dependencies.some(pin => pin.kind === 'view' && pin.head === move.head));
});

test('Lane run bounds stale retries and preserves other errors', async t => {
  const f = await fixture(t, { delay: 0 });
  const pending = await f.candidate('lane.txt', undefined, false);
  for (const [code, expected] of [
    ['WORK_STALE', 4],
    ['LANE_STALE', 1],
  ]) {
    let attempts = 0;
    f.work.dispatch = async () => {
      attempts++;
      throw new ForgeError(code, 'Synthetic writer');
    };
    await assert.rejects(
      f.agent.dispatch({ action: 'run', laneId: pending.lane.laneId }),
      error => error.code === code,
    );
    assert.equal(attempts, expected);
  }
  assert.equal(f.store.load().runs.length, 0);
});
