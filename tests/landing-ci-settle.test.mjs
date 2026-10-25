import { landingPreviewRecords } from '../dist/landing-preview-records.js';
import { previewTuple } from '../dist/integration-preview-inputs.js';
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fixture } from './landing-batch-fixture.mjs';
import { batchEdit, selectBatch, composeBatch, enqueueLanding } from '../dist/landing-batch-store.js';
import { drainLandingBatches } from '../dist/landing-batch.js';
import { landingRecords, landingCheckPrefix } from '../dist/landing-records.js';
import { composeLandingInputs } from '../dist/landing-compose-inputs.js';
import { land } from '../dist/land.js';
import { checkEnvironment } from '../dist/check-environment.js';
import { LandJournal } from '../dist/land-journal.js';

test('a failed singleton publishes terminal evidence and dispatches the next queued check within 10s', async t => {
  const f = await fixture(t, { remote: false, failWhen: "exists('bad.txt') || exists('bad2.txt')" });
  const first = await f.candidate('bad.txt');
  const selected = await batchEdit(f.work, 'select', data => selectBatch(f.work, data, 'main'));
  await composeBatch(f.work, selected);
  const second = await f.candidate('bad2.txt');
  const dispatched = [];
  const dispatch = f.work.dispatch.bind(f.work);
  f.work.dispatch = async (...args) => {
    assert.notEqual(args[0].action, 'accept-channel', 'failed singleton must not enter acceptance');
    if (args[0].action === 'run-check') dispatched.push({ id: args[0].operationId, at: Date.now() });
    return dispatch(...args);
  };
  const boundaries = [];
  await drainLandingBatches(f.work, 'main', undefined, undefined, undefined, () => {
    const entry = f.store.select('landingEntries', first.command.operationId);
    if (entry.status === 'failed') boundaries.push(Date.now());
  });
  const entries = [first, second].map(input => f.store.select('landingEntries', input.command.operationId));
  assert.deepEqual(
    entries.map(entry => entry.status),
    ['failed', 'failed'],
  );
  assert.equal(dispatched.length, 2, 'no bisection, replay or duplicate physical run');
  for (const entry of entries) {
    const path = join(f.store.directory, `check-${entry.runId}`, 'result.json');
    assert.equal(JSON.parse(readFileSync(path)).status, 'failed');
    const delay = Date.parse(entry.terminalAt) - statSync(path).mtimeMs;
    assert.ok(delay >= -1 && delay < 10000, `result to terminal: ${delay}ms`);
    const batch = f.store.select('landingBatches', entry.batchId);
    assert.equal(batch.status, 'completed');
    assert.equal(batch.diagnosis.nodes.length, 1);
    assert.equal(batch.diagnosis.nodes[0].status, 'failed');
    t.diagnostic(`result-to-terminal ${Math.round(delay)}ms`);
  }
  const nextRun = f.store.select('runs', entries[1].runId);
  const nextDelay = Date.parse(nextRun.startedAt) - Date.parse(entries[0].terminalAt);
  assert.ok(nextDelay >= 0 && nextDelay < 10000, `terminal to next dispatch: ${nextDelay}ms`);
  assert.ok(boundaries.length);
  t.diagnostic(`terminal-to-next-dispatch ${nextDelay}ms`);
  const revision = f.store.revision();
  await drainLandingBatches(f.work, 'main');
  assert.equal(dispatched.length, 2);
  assert.equal(f.store.revision(), revision, 'terminal replay publishes nothing');
  const replay = await enqueueLanding(f.work, first.command, first.view);
  assert.equal(replay.status, 'failed');
  assert.equal(f.store.revision(), revision, 'terminal enqueue replays the original result');
});

test('indexed queue reads and native composition preserve unrelated history without loading whole Work', async t => {
  const f = await fixture(t, { remote: false });
  const input = await f.candidate('selected.txt');
  const unrelated = await f.candidate('history.txt', 'retained\n', false);
  const before = f.store.select('lanes', unrelated.lane.laneId);
  const full = f.store.load();
  const expectedPreview = previewTuple(
    f.store,
    full,
    full.lanes.filter(lane => lane.id === input.lane.laneId),
    full.nativeHead,
  );
  const retry = { at: new Date().toISOString(), code: 'SYNTHETIC_RETRY', runId: randomUUID() };
  f.store.locked(() => {
    const records = f.store.records(),
      entry = records.find('landingEntries', input.command.operationId);
    entry.record.infrastructureRetries = [retry];
    records.replace('landingEntries', entry.position, entry.record);
    f.store.commitRecords(records);
  });
  const tx = f.store.readRecords();
  const restore = t.mock.method(f.store, 'load', () => {
    throw new Error('whole Work hydration');
  });
  try {
    const preview = landingPreviewRecords(f.store, [input.lane.laneId]);
    assert.equal(
      previewTuple(
        f.store,
        preview,
        preview.lanes.filter(lane => lane.id === input.lane.laneId),
        preview.nativeHead,
      ).key,
      expectedPreview.key,
    );
    const projected = landingRecords(f.store, 'main');
    assert.deepEqual(
      projected.lanes.map(lane => lane.id),
      [input.lane.laneId],
    );
    const command = {
      action: 'compose',
      operationId: randomUUID(),
      intentId: input.lane.intentId,
      inputs: input.view.inputs,
      dependencies: [],
    };
    const composed = await composeLandingInputs(f.store, command);
    const replay = await composeLandingInputs(f.store, command);
    assert.equal(replay.result.id, composed.result.id);
    assert.equal(replay.revision, composed.revision);
    await assert.rejects(
      composeLandingInputs(f.store, {
        ...command,
        dependencies: [{ kind: 'view', viewId: input.view.id, head: input.view.head }],
      }),
      { code: 'WORK_OPERATION_CHANGED' },
    );
    const selected = await batchEdit(
      f.work,
      'selected',
      data => selectBatch(f.work, data, 'main'),
      undefined,
      'main',
    );
    await composeBatch(f.work, selected);
    const saved = f.store.select('landingBatches', selected.id);
    assert.deepEqual(landingCheckPrefix(f.store, saved.prefixes[0].viewId), saved.prefixes[0]);
    assert.deepEqual(f.store.select('lanes', unrelated.lane.laneId), before);
    assert.deepEqual(f.store.select('landingEntries', input.command.operationId).infrastructureRetries, [
      retry,
    ]);
    assert.equal(
      tx.find('lanes', unrelated.lane.laneId).record.head,
      before.head,
      'old pinned reader stays valid',
    );
  } finally {
    restore.mock.restore();
  }
});

test('an idle land dispatches within 10s and its failed journal settles before unrelated acceptance', async t => {
  const f = await fixture(t, { remote: false });
  const bad = await f.candidate('bad.txt', 'bad\n', false);
  const later = await f.candidate('later.txt', 'later\n', false);
  const command = { action: 'land', operationId: randomUUID(), laneIds: [bad.lane.laneId], channel: 'main' };
  const journal = new LandJournal(f.store, command);
  const dispatch = f.work.dispatch.bind(f.work);
  let startedAt,
    dispatchedAt,
    firstRunId,
    observed = false;
  const load = f.store.load.bind(f.store);
  t.mock.method(f.store, 'load', (...args) => {
    assert.ok(dispatchedAt, 'idle dispatch must not hydrate whole Work');
    return load(...args);
  });
  f.work.dispatch = async (...args) => {
    if (args[0].action === 'run-check' && !dispatchedAt) {
      dispatchedAt = Date.now();
      firstRunId = args[0].operationId;
      // Admit another request only after this singleton has its own batch.
      await enqueueLanding(f.work, later.command, later.view);
    }
    if (args[0].action === 'accept-channel') {
      const saved = JSON.parse(readFileSync(journal.path));
      assert.equal(saved.entries[0].result.status, 'failed');
      observed = true;
    }
    return dispatch(...args);
  };
  startedAt = Date.now();
  const result = await land(f.work, command);
  assert.ok(dispatchedAt - startedAt < 10000, `idle dispatch: ${dispatchedAt - startedAt}ms`);
  const checkStarted = Date.parse(f.store.select('runs', firstRunId).startedAt) - startedAt;
  assert.ok(checkStarted < 10000, `idle check start: ${checkStarted}ms`);
  assert.equal(result.result.entries[0].status, 'failed');
  assert.equal(observed, true, 'failed parent journal is published before unrelated acceptance');
  t.diagnostic(`idle-land-to-dispatch ${dispatchedAt - startedAt}ms; check-start ${checkStarted}ms`);
});

test('native landing composition keeps configured clean-View automations and their replay identity', async t => {
  const f = await fixture(t, { remote: false, stopChecks: true });
  const input = await f.candidate('automated.txt', 'automation\n', false);
  const check = f.store.select('checks', input.command.checkId);
  const playbook = {
    id: randomUUID(),
    name: 'Synthetic compose check',
    checkIds: [check.id],
    definition: 'a'.repeat(64),
    at: 'now',
  };
  const automation = {
    id: randomUUID(),
    name: 'Synthetic clean-View automation',
    intentId: input.lane.intentId,
    enabled: true,
    version: 1,
    event: 'clean-view',
    playbook,
    checks: [check],
    environment: checkEnvironment(),
    onFailure: 'stop',
    definition: 'b'.repeat(64),
    at: 'now',
  };
  f.store.locked(() => {
    const records = f.store.records();
    records.append('playbooks', playbook);
    records.append('automations', automation);
    f.store.commitRecords(records);
  });
  const command = {
    action: 'compose',
    operationId: randomUUID(),
    intentId: input.lane.intentId,
    inputs: input.view.inputs,
    dependencies: [],
  };
  const response = await f.work.dispatch(command, f.store.revision(), { reconcileComposition: true });
  const replay = await f.work.dispatch(command, f.store.revision(), { reconcileComposition: true });
  assert.equal(replay.result.id, response.result.id);
  const runs = f.store.load().playbookRuns.filter(run => run.viewId === response.result.id);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].automation.id, automation.id);
});
