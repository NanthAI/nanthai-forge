// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './landing-batch-fixture.mjs';
import { batchEdit, selectBatch, composeBatch, enqueueLanding } from '../dist/landing-batch-store.js';
import { evaluateBatch } from '../dist/landing-batch-check.js';
import { drainLandingBatches } from '../dist/landing-batch.js';
import { readLaneSubmissions } from '../dist/landing-submission-read.js';

const driver = { beforePublish() {} };
const select = f => batchEdit(f.work, randomUUID(), data => selectBatch(f.work, data, 'main'));
const physical = f => f.store.load().runs.filter(run => !run.mainCheck && !run.reusedFrom);
async function checkOnly(f, input) {
  const result = (
    await f.agent.dispatch({
      action: 'finish',
      laneId: input.lane.laneId,
      message: 'Check before review',
    })
  ).result;
  assert.equal(result.run.status, 'passed');
  assert.equal(f.main(), undefined);
  return result;
}

test('unchecked entries run alone before the green wave receives one combined check', async t => {
  const f = await fixture(t, { delay: 0 });
  await f.candidate('a.txt');
  await f.candidate('b.txt');
  for (let i = 0; i < 2; i++) {
    const solo = await select(f);
    assert.equal(solo.admission, true);
    assert.equal(solo.entryIds.length, 1);
    assert.equal(solo.environment.env.FORGE_CHECK_FULL, '1');
    await composeBatch(f.work, solo);
    await evaluateBatch(f.work, f.store.select('landingBatches', solo.id), driver);
    assert.equal(f.store.select('landingBatches', solo.id).diagnosis, undefined);
    const queued = f.store.select('landingEntries', solo.entryIds[0]);
    assert.equal(queued.status, 'queued');
    assert.equal(queued.waitingFor.rule, 'batch-order');
    assert.equal(f.main(), undefined);
  }
  const combined = await select(f);
  assert.equal(combined.admission, undefined);
  assert.equal(combined.entryIds.length, 2);
  await drainLandingBatches(f.work, 'main');
  assert.deepEqual(
    physical(f).map(run => run.inputs.length),
    [1, 1, 2],
  );
  assert.ok(f.store.load().landingEntries.every(entry => entry.status === 'accepted'));
});

test('land after passed check-only finishes batches without another solo execution', async t => {
  const f = await fixture(t, { delay: 0 });
  const a = await f.candidate('a.txt', undefined, false);
  const b = await f.candidate('b.txt', undefined, false);
  await checkOnly(f, a);
  await checkOnly(f, b);
  const before = physical(f).map(run => run.id);
  const result = (
    await f.agent.dispatch({
      action: 'land',
      operationId: randomUUID(),
      laneIds: [a.lane.laneId, b.lane.laneId],
      wait: true,
    })
  ).result;
  assert.equal(result.complete, true);
  const fresh = physical(f).filter(run => !before.includes(run.id));
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].inputs.length, 2);
  assert.ok(f.store.load().landingBatches.every(batch => !batch.admission));
});

test('a full solo run on the same Q3 key admits a changed saved head without a solo rerun', async t => {
  const f = await fixture(t, { delay: 0 });
  const a = await f.candidate('a.txt', 'original\n', false);
  const b = await f.candidate('b.txt', undefined, false);
  await checkOnly(f, a);
  await checkOnly(f, b);
  writeFileSync(join(a.lane.path, 'a.txt'), 'temporary\n');
  await f.agent.dispatch({ action: 'checkpoint', laneId: a.lane.laneId, message: 'Different content' });
  writeFileSync(join(a.lane.path, 'a.txt'), 'original\n');
  const saved = (
    await f.agent.dispatch({ action: 'checkpoint', laneId: a.lane.laneId, message: 'Same tree, new State' })
  ).result;
  assert.notEqual(saved.head, a.checkpoint.head);
  const before = physical(f).map(run => run.id);
  await f.agent.dispatch({
    action: 'land',
    operationId: randomUUID(),
    laneIds: [a.lane.laneId, b.lane.laneId],
    wait: true,
  });
  const fresh = physical(f).filter(run => !before.includes(run.id));
  assert.equal(fresh.length, 1);
  assert.equal(fresh[0].inputs.length, 2);
  assert.ok(f.store.load().landingBatches.every(batch => !batch.admission));
});

test('a solo failure names its test file and settles without prefix diagnosis', async t => {
  const f = await fixture(t, { remote: false, delay: 0 });
  const check = f.store.load().checks[0];
  await f.agent.dispatch({
    action: 'define-check',
    checkId: check.id,
    name: 'verify',
    executable: process.execPath,
    args: [
      '-e',
      "if(require('fs').existsSync('bad.txt')){console.log('# Failed test file: tests/broken.test.mjs');process.exit(1)}",
    ],
  });
  const bad = await f.candidate('bad.txt');
  await f.candidate('good.txt');
  await drainLandingBatches(f.work, 'main');
  const entry = f.store.select('landingEntries', bad.command.operationId);
  assert.equal(entry.status, 'failed');
  assert.equal(entry.waitingFor, undefined);
  const submission = readLaneSubmissions(f.store, bad.lane.laneId)[0];
  assert.equal(submission.state, 'terminal-failed');
  assert.equal(submission.cause, 'check-failed');
  assert.match(entry.reason, /tests\/broken.test.mjs/);
  const batch = f.store.select('landingBatches', entry.batchId);
  assert.equal(batch.diagnosis, undefined);
  assert.equal(batch.settlement, undefined);
  assert.equal(batch.prefixes.length, 1);
  assert.equal(physical(f).filter(run => run.status === 'failed').length, 1);
  assert.equal(f.content('bad.txt'), undefined);
  assert.equal(f.content('good.txt'), 'good.txt\n');
});

test('an explicit partial run never supplies solo admission evidence', async t => {
  const f = await fixture(t, { delay: 0 });
  const a = await f.candidate('a.txt', undefined, false);
  await checkOnly(f, a);
  const run = physical(f)[0];
  // Model the explicit-list marker on an otherwise passed source receipt. It
  // must be rejected before it can be considered admission evidence.
  f.store.locked(() => {
    const tx = f.store.records(),
      item = tx.find('runs', run.id);
    item.record.checkSelection = {
      scope: 'full',
      reason: 'Explicit test files',
      tests: ['tests/a.test.mjs'],
      partial: true,
    };
    tx.replace('runs', item.position, item.record);
    f.store.commitRecords(tx);
  });
  const receiptPath = join(f.store.directory, `check-${run.id}`, 'result.json');
  const receipt = JSON.parse(readFileSync(receiptPath));
  receipt.checkSelection = f.store.select('runs', run.id).checkSelection;
  writeFileSync(receiptPath, JSON.stringify(receipt));
  await enqueueLanding(f.work, a.command, a.view);
  const solo = await select(f);
  assert.equal(solo.admission, true);
});

test('a passed solo run against an older main does not admit the rebased tree', async t => {
  const f = await fixture(t, { delay: 0 });
  const a = await f.candidate('a.txt', undefined, false);
  const rival = await f.candidate('rival.txt', undefined, false);
  await checkOnly(f, a);
  await f.agent.dispatch({ action: 'run', viewId: rival.view.id });
  await f.agent.dispatch({ action: 'accept', channel: 'main', viewId: rival.view.id });
  await enqueueLanding(f.work, a.command, a.view);
  const solo = await select(f);
  assert.equal(solo.admission, true);
  assert.equal(solo.base, f.main().head);
});

test('an identical tree checked with another Lane is not solo admission evidence', async t => {
  const f = await fixture(t, { delay: 0 });
  const a = await f.candidate('a.txt', undefined, false);
  const sibling = (
    await f.agent.dispatch({ action: 'start', intentId: a.lane.intentId, outcome: 'Unchanged sibling' })
  ).result;
  const combined = (
    await f.agent.dispatch({
      action: 'compose',
      operationId: randomUUID(),
      intentId: a.lane.intentId,
      inputs: [...a.view.inputs, { laneId: sibling.laneId, head: sibling.head }],
      dependencies: [],
    })
  ).result;
  const run = (await f.agent.dispatch({ action: 'run', viewId: combined.viewId })).result;
  assert.equal(run.status, 'passed');
  assert.equal(f.store.select('runs', run.runId).inputs.length, 2);
  await enqueueLanding(f.work, a.command, a.view);
  const solo = await select(f);
  assert.equal(solo.admission, true);
});
