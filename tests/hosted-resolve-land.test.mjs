// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeFunctionReference } from 'convex/server';
import { resolutionFixture } from './hosted-agent-resolution-fixture.mjs';
import { readHostedLaneCheckout } from '../dist/hosted-lane-checkout-marker.js';
import { submitHostedLand } from '../dist/hosted-land-cli.js';
import { hostedAgentDirectory } from '../dist/hosted-agent-journal.js';
import { drainReady } from './early-resolution-replay.mjs';

function useLegacyFinishIndex(root) {
  const directory = hostedAgentDirectory(root);
  const [index] = readdirSync(directory).filter(name => name.startsWith('finish-'));
  const path = join(directory, index);
  const { checkoutLaneId: _checkoutLaneId, ...legacy } = JSON.parse(readFileSync(path, 'utf8'));
  writeFileSync(path, JSON.stringify(legacy));
}

for (const mode of ['implicit', 'implicit with a legacy journal', 'explicit'])
  test(`36fd3295: ${mode} land follows the current Lane after successive in-place resolutions`, async t => {
    const s = await resolutionFixture(t, { overlap: true }),
      f = s.f;
    const root = s.root;
    const command = { message: 'Land current resolution', accept: true };
    await s.transport().dispatch('open', { laneId: f.lane.laneId });
    // Keep the original shorthand operation and its clean pins, with no admitted landing to observe.
    const transport = s.transport();
    let originalOperation;
    transport.onOperation = (_action, id) => {
      originalOperation = id;
    };
    s.lose('projectHostedComposeSelection:page');
    await assert.rejects(submitHostedLand(root, command, s.address, transport), {
      code: 'HOSTED_ACTION_FAILED',
    });
    if (mode === 'implicit with a legacy journal') useLegacyFinishIndex(root);
    writeFileSync(join(root, 'notes.txt'), 'A later save moves the original pins\n');
    await s.transport().dispatch('save', { message: 'Save notes' });

    const lanes = [f.lane.laneId];
    for (const edit of ['first', 'second']) {
      f.move([f.c.file('a.txt', `main ${edit}\nb\nc\n`)]);
      const { conflict } = (await s.transport().dispatch('sync', { laneId: lanes.at(-1) })).result;
      assert.equal(conflict.laneId, readHostedLaneCheckout(root).selection.laneId);
      assert(!lanes.includes(conflict.laneId));
      lanes.push(conflict.laneId);
      writeFileSync(join(root, 'a.txt'), `chosen ${edit}\nb\nc\n`);
      const { action, ...resolve } = conflict.next;
      await s.transport().dispatch(action, resolve);
    }
    f.move([f.c.file('accepted.txt', 'later accepted\n')]);
    assert.equal(
      (await s.transport().dispatch('sync', { laneId: lanes.at(-1) })).result.source.outcome.result.status,
      'merged',
    );
    const current = readHostedLaneCheckout(root).selection;
    const parameters = mode === 'explicit' ? { ...command, laneId: current.laneId } : command;
    const before = s.calls.length;
    const submitted = await submitHostedLand(root, parameters, s.address, s.transport());
    assert.equal(submitted.result.phase, 'finish');
    assert.notEqual(submitted.operationId, originalOperation);
    const calls = s.calls.slice(before);
    assert(!calls.some(call => call.name === 'projectHostedFinishObserve:page'));
    assert.deepEqual(
      calls.filter(call => call.name === 'projectHostedComposeSelection:page').map(call => call.args.inputs),
      [
        [
          {
            laneId: current.laneId,
            expected: {
              head: current.head,
              version: current.version,
              sourceVersion: current.sourceVersion,
              lifecycleVersion: current.lifecycleVersion,
            },
          },
        ],
      ],
    );
    const replay = await submitHostedLand(
      root,
      { ...parameters, operationId: submitted.operationId },
      s.address,
      s.transport(),
    );
    assert.equal(replay.result.submission.id, submitted.result.submission.id);
    await assert.rejects(
      submitHostedLand(root, { ...command, operationId: originalOperation }, s.address, s.transport()),
      { code: 'WORK_STALE' },
      'an explicit operation replay still uses the original Lane pins',
    );
    await drainReady(f);
    await f.passChecks();
    await drainReady(f);
    assert.equal((await f.current(submitted.result.submission.id)).submission.phase, 'landed');
    assert.equal(f.text(f.currentMain().head, 'a.txt'), 'chosen second\nb\nc\n');
  });

test('a legacy finish paused after saving still replays on the same resolution Lane', async t => {
  const s = await resolutionFixture(t, { overlap: true });
  const { f, root } = s;
  await s.transport().dispatch('open', { laneId: f.lane.laneId });
  f.moveMain({ overlap: true });
  const { conflict } = (await s.transport().dispatch('sync', { laneId: f.lane.laneId })).result;
  writeFileSync(join(root, 'a.txt'), 'chosen\nb\nc\n');
  const { action, ...resolve } = conflict.next;
  await s.transport().dispatch(action, resolve);

  const command = { message: 'Land the saved resolution', accept: true };
  writeFileSync(join(root, 'notes.txt'), 'Captured by the first land\n');
  s.lose('projectHostedComposeSelection:page');
  await assert.rejects(submitHostedLand(root, command, s.address, s.transport()), {
    code: 'HOSTED_ACTION_FAILED',
  });
  useLegacyFinishIndex(root);
  writeFileSync(join(root, 'notes.txt'), 'Added while the reply was lost\n');
  await assert.rejects(submitHostedLand(root, command, s.address, s.transport()), {
    code: 'UNSAVED_LANE_EDITS',
  });
  const saved = await f.readLane(conflict.laneId);
  assert.equal(f.text(saved.head, 'notes.txt'), 'Captured by the first land\n');
  assert.equal(readFileSync(join(root, 'notes.txt'), 'utf8'), 'Added while the reply was lost\n');
});

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
