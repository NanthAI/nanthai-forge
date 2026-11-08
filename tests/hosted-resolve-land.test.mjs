// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFunctionReference } from 'convex/server';
import { resolutionFixture } from './hosted-agent-resolution-fixture.mjs';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';

test('completed resolve hands exact pins to an ordinary land on the resolution root', async t => {
  const s = await resolutionFixture(t, { overlap: true }),
    f = s.f;
  f.moveMain({ overlap: true });
  const conflict = (await s.transport().dispatch('finish', { laneId: f.lane.laneId })).result.recovery
    .conflict;
  writeFileSync(join(conflict.root, 'a.txt'), 'chosen\nb\nc\n');
  const { action, ...resolve } = conflict.next;
  const fixed = await s.transport(conflict.root).dispatch(action, resolve);
  const selection = readHostedLaneCheckout(conflict.root).selection;
  assert.deepEqual(selection, fixed.result.source.outcome.result.lane);
  // The receipt splits its own wall time (save, submit, hosted wait, local apply, next landing).
  const { totalMs, stepsMs } = fixed.result.timing;
  assert.deepEqual(Object.keys(stepsMs), ['save', 'submit', 'hostedWait', 'apply', 'select']);
  const summed = Object.values(stepsMs).reduce((sum, ms) => sum + ms, 0);
  assert(Math.abs(totalMs - summed) <= 5, `steps cover the total within rounding: ${totalMs} vs ${summed}`);
  const remote = await f.readLane(conflict.laneId);
  for (const key of ['head', 'version', 'sourceVersion', 'lifecycleVersion'])
    assert.equal(selection[key], remote[key], key);
  const submitted = await s.transport(conflict.root).dispatch('finish', { message: 'Land resolved files' });
  await f.drain();
  await f.passChecks();
  await f.drain();
  assert.equal((await f.current(submitted.result.submission.id)).submission.phase, 'landed');
});

test('a source-completed resolve whose client wait ended still hands pins to ordinary land', async t => {
  const s = await resolutionFixture(t, { overlap: true }),
    f = s.f;
  f.moveMain({ overlap: true });
  const conflict = (await s.transport().dispatch('finish', { laneId: f.lane.laneId })).result.recovery
    .conflict;
  writeFileSync(join(conflict.root, 'a.txt'), 'chosen\nb\nc\n');
  await s.transport(conflict.root).dispatch('save', { message: 'Save chosen bytes' });
  s.eagerSource(false);
  const controller = new AbortController();
  controller.abort();
  const { action, ...resolve } = conflict.next;
  const pending = await s.transport(conflict.root).dispatch(action, resolve, controller.signal);
  assert.equal(pending.result.status, 'submitted');
  s.eagerSource(true);
  await s.exchange.client.mutation(makeFunctionReference('projectHostedSyncJobs:submit'), {
    projectId: f.projectId,
    operationId: resolve.operationId,
  });
  const remote = await f.readLane(conflict.laneId);
  assert.equal(remote.resolution.status, 'resolved');
  assert.equal(remote.sourceVersion, 2);
  assert.equal(readHostedLaneCheckout(conflict.root).selection.sourceVersion, 1);
  s.eagerSource(true);
  const submitted = await s.transport(conflict.root).dispatch('finish', { message: 'Land resolved files' });
  assert.equal(readHostedLaneCheckout(conflict.root).selection.sourceVersion, remote.sourceVersion);
  await f.drain();
  await f.passChecks();
  await f.drain();
  assert.equal((await f.current(submitted.result.submission.id)).submission.phase, 'landed');
});

test('lost completed resolve reply is reconciled by land without repeating source or replacing pins', async t => {
  const s = await resolutionFixture(t, { overlap: true }),
    f = s.f;
  f.moveMain({ overlap: true });
  const conflict = (await s.transport().dispatch('finish', { laneId: f.lane.laneId })).result.recovery
    .conflict;
  writeFileSync(join(conflict.root, 'a.txt'), 'chosen\nb\nc\n');
  await s.transport(conflict.root).dispatch('save', { message: 'Save chosen bytes' });
  s.lose('projectHostedSyncJobs:submit');
  const { action, ...resolve } = conflict.next;
  await assert.rejects(s.transport(conflict.root).dispatch(action, resolve), {
    code: 'HOSTED_ACTION_FAILED',
  });
  const remote = await f.readLane(conflict.laneId);
  assert.equal(remote.resolution.status, 'resolved');
  assert.equal(readHostedLaneCheckout(conflict.root).selection.sourceVersion, 1);
  const before = s.calls.length;
  const submitted = await s.transport(conflict.root).dispatch('finish', { message: 'Land resolved files' });
  const reconciles = s.calls.slice(before).filter(c => c.name === 'projectHostedSync:progress');
  assert.equal(reconciles.length, 1);
  assert.equal(reconciles[0].args.operationId, resolve.operationId);
  assert.equal(readHostedLaneCheckout(conflict.root).selection.head, remote.head);
  assert.equal(s.calls.slice(before).filter(c => c.name === 'projectHostedSyncJobs:submit').length, 0);
  await f.drain();
  await f.passChecks();
  await f.drain();
  assert.equal((await f.current(submitted.result.submission.id)).submission.phase, 'landed');
});
