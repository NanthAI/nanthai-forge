// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fixture } from './landing-batch-fixture.mjs';
import { batchEdit, selectBatch, composeBatch } from '../dist/landing-batch-store.js';
import { advanceLandingBatch } from '../dist/landing-batch-step.js';
import { claimLandingDriver } from '../dist/landing-driver.js';
import { drainLandingBatches } from '../dist/landing-batch.js';
import { readLaneSubmissions } from '../dist/landing-submission-read.js';
import { readPendingStatus } from '../dist/pending-status-read.js';
import { waitForAgentRun } from '../dist/agent-run-observer.js';
import { planLandingTrain } from '../dist/landing-train-plan.js';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { ForgeError } from '../dist/errors.js';

const select = f => batchEdit(f.work, 'main', data => selectBatch(f.work, data, 'main'), undefined, 'main');
const entry = (f, candidate) => f.store.select('landingEntries', candidate.command.operationId);
const base = '# Shared\n\nParagraph.\n\nEnd.\n';

test('every unselected overlapping head retains its blocker pins, then lands at its original age', async t => {
  const f = await fixture(t, { files: { 'shared.md': base } });
  const a = await f.candidate('shared.md', base.replace('Paragraph.', 'First.\nParagraph.'));
  const b = await f.candidate('shared.md', base.replace('Paragraph.', 'Second.\nSecond.\nParagraph.'));
  const age = entry(f, b).arrivedAt;
  const batch = await select(f);
  assert.deepEqual(batch.entryIds, [a.command.operationId]);
  const waiting = entry(f, b).waitingFor;
  assert.equal(waiting.rule, 'overlap');
  assert.deepEqual(waiting.entries, [{ entryId: a.command.operationId, inputs: a.view.inputs }]);
  assert.deepEqual(readLaneSubmissions(f.store, b.lane.laneId)[0].waitingFor, waiting);
  assert.deepEqual(
    readPendingStatus(f.store).lanes.find(lane => lane.laneId === b.lane.laneId).submission.waitingFor,
    waiting,
  );
  await drainLandingBatches(f.work, 'main');
  assert.equal(entry(f, b).status, 'accepted');
  assert.equal(entry(f, b).arrivedAt, age);
  assert.equal(readLaneSubmissions(f.store, b.lane.laneId)[0].state, 'landed');
});

test('capacity and batch-size omissions have recorded selection rules', async t => {
  const f = await fixture(t, { remote: false });
  const candidates = [];
  for (let i = 0; i < 5; i++) candidates.push(await f.candidate(`${i}.txt`));
  await f.checkCandidates();
  const batch = await select(f);
  assert.equal(batch.entryIds.length, 4);
  assert.equal(entry(f, candidates[4]).waitingFor.rule, 'batch-size');
  await composeBatch(f.work, batch);
  await batchEdit(
    f.work,
    'main',
    data => selectBatch(f.work, data, 'main', new Set([batch.id])),
    undefined,
    'main',
  );
  assert.equal(entry(f, candidates[4]).waitingFor.rule, 'capacity');
  assert.equal(entry(f, candidates[4]).waitingFor.batchId, batch.id);
  await drainLandingBatches(f.work, 'main');
  assert.ok(f.store.load().landingEntries.every(entry => entry.status === 'accepted'));
});

test('a passed batch with no live run names settlement before publication and resumes without another check', async t => {
  const f = await fixture(t);
  const candidate = await f.candidate('orphan.txt');
  const batch = await select(f),
    driver = await claimLandingDriver(f.work, 'main');
  await advanceLandingBatch(f.work, batch.id, driver);
  await advanceLandingBatch(f.work, batch.id, driver);
  assert.equal(entry(f, candidate).status, 'checking');
  const revision = f.store.revision();
  const observation = readLaneSubmissions(f.store, candidate.lane.laneId)[0];
  assert.equal(observation.waitingFor.rule, 'settlement');
  assert.equal(observation.waitingFor.batchId, batch.id);
  assert.ok(observation.waitingFor.runIds.length);
  assert.deepEqual(readPendingStatus(f.store).lanes[0].submission.waitingFor, observation.waitingFor);
  assert.equal(f.store.revision(), revision, 'visibility reads never publish progress');
  await drainLandingBatches(new AgentWorkflow(f.root).work, 'main');
  assert.equal(entry(f, candidate).status, 'accepted');
  assert.equal(f.store.load().runs.filter(run => !run.mainCheck && !f.soloRuns.has(run.id)).length, 1);
});

test('canonical acceptance cannot remain a stale overlapping blocker while entry settlement waits', async t => {
  const f = await fixture(t, { files: { 'shared.md': base } });
  const a = await f.candidate('shared.md', base.replace('Paragraph.', 'First.\nParagraph.'));
  const b = await f.candidate('shared.md', base.replace('Paragraph.', 'Second.\nSecond.\nParagraph.'));
  const dispatch = f.work.dispatch.bind(f.work);
  f.work.dispatch = async (...args) => {
    const result = await dispatch(...args);
    if (args[0].action === 'accept-channel')
      throw new ForgeError('SOURCE_CHANGED', 'Synthetic lost settlement');
    return result;
  };
  await assert.rejects(drainLandingBatches(f.work, 'main'), { code: 'SOURCE_CHANGED' });
  assert.equal(entry(f, a).status, 'checking');
  const train = planLandingTrain(f.store, f.store.load(), 'main');
  assert.ok(!train.waits.some(wait => wait.entryId === b.command.operationId));
  f.work.dispatch = dispatch;
  await drainLandingBatches(f.work, 'main');
  assert.equal(entry(f, a).status, 'accepted');
  assert.equal(entry(f, b).status, 'accepted');
});

for (const flaky of [true, false])
  test(`last remote boundary is confirmed once (${flaky ? 'flake lands' : 'repeated failure terminates'})`, async t => {
    const scratch = mkdtempSync(join(tmpdir(), 'forge-confirm-'));
    const marker = join(scratch, 'failed-once');
    const failWhen = flaky
      ? `exists('A.txt') && exists('C.txt') && (()=>{const marker=${JSON.stringify(marker)};if(fs.existsSync(marker))return false;fs.writeFileSync(marker,'once');return true})()`
      : "exists('A.txt') && exists('C.txt')";
    const f = await fixture(t, { failWhen });
    // Keep the one-shot marker until the fixture has drained its detached audit.
    t.after(() => rmSync(scratch, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }));
    const candidates = [];
    for (const name of ['A', 'B', 'C']) candidates.push(await f.candidate(`${name}.txt`));
    await f.checkCandidates();
    const dispatch = f.work.dispatch.bind(f.work);
    f.work.dispatch = async (...args) => {
      const result = await dispatch(...args);
      if (args[0].action === 'run-check') {
        await waitForAgentRun(f.store, args[0].operationId);
        await batchEdit(f.work, 'test-verdict', data => {
          const run = data.runs.find(run => run.id === args[0].operationId);
          if (run?.status === 'failed')
            run.backend.testVerdicts = [{ test: 'tests/synthetic-boundary.test.mjs', verdict: 'failed' }];
        });
      }
      return result;
    };
    await drainLandingBatches(f.work, 'main');
    const batch = f.store.load().landingBatches[0];
    assert.deepEqual(batch.confirmation.tests, ['tests/synthetic-boundary.test.mjs']);
    assert.equal(batch.confirmation.verdict, flaky ? 'flake' : 'confirmed');
    assert.notEqual(batch.confirmation.runId, batch.confirmation.failedRunId);
    assert.equal(f.store.select('runs', batch.confirmation.failedRunId).status, 'failed');
    assert.equal(f.store.select('runs', batch.confirmation.runId).status, flaky ? 'passed' : 'failed');
    assert.equal(batch.diagnosis.nodes.length, 4);
    assert.equal(
      batch.diagnosis.nodes.find(node => node.id === batch.confirmation.failedRunId).status,
      'failed',
    );
    const final = readLaneSubmissions(f.store, candidates[2].lane.laneId)[0];
    assert.equal(final.state, flaky ? 'landed' : 'terminal-failed');
    assert.equal(final.diagnosis.confirmation.verdict, flaky ? 'flake' : 'confirmed');
    if (!flaky) assert.match(entry(f, candidates[2]).reason, /Confirmation run .* failed again/);
    const runs = f.store.load().runs.filter(run => !run.mainCheck && !f.soloRuns.has(run.id)).length;
    assert.equal(runs, 4);
    await drainLandingBatches(new AgentWorkflow(f.root).work, 'main');
    assert.equal(f.store.load().runs.filter(run => !run.mainCheck && !f.soloRuns.has(run.id)).length, runs);
  });

for (const lostAfterDispatch of [false, true])
  test(`confirmation restart adopts its one operation after loss ${lostAfterDispatch ? 'after' : 'before'} dispatch`, async t => {
    const f = await fixture(t, { failWhen: "exists('A.txt') && exists('B.txt')" });
    await f.candidate('A.txt');
    const b = await f.candidate('B.txt');
    await f.checkCandidates();
    const dispatch = f.work.dispatch.bind(f.work);
    let lost = false;
    f.work.dispatch = async (...args) => {
      const batch = f.store.load().landingBatches?.[0];
      if (!lost && args[0].action === 'run-check' && args[0].operationId === batch?.confirmation?.runId) {
        lost = true;
        if (lostAfterDispatch) {
          await dispatch(...args);
          await waitForAgentRun(f.store, args[0].operationId);
        }
        throw new ForgeError('SOURCE_CHANGED', 'Synthetic lost confirmation dispatch');
      }
      return dispatch(...args);
    };
    await assert.rejects(drainLandingBatches(f.work, 'main'), { code: 'SOURCE_CHANGED' });
    assert.ok(lost);
    const confirmation = f.store.load().landingBatches[0].confirmation;
    await drainLandingBatches(new AgentWorkflow(f.root).work, 'main');
    const batch = f.store.load().landingBatches[0];
    assert.equal(batch.confirmation.runId, confirmation.runId);
    assert.equal(batch.confirmation.verdict, 'confirmed');
    assert.equal(entry(f, b).status, 'failed');
    assert.equal(f.store.load().runs.filter(run => !run.mainCheck && !f.soloRuns.has(run.id)).length, 3);
    assert.equal(batch.diagnosis.nodes.filter(node => node.id === confirmation.runId).length, 1);
  });

test('metric 3 counts a stalled queued fixture before driving and zero after its actual landing', async t => {
  const { nativeSelfMetricsReader } = await import('../dist/self-metrics-native.js');
  const { calculateSelfMetrics } = await import('../dist/self-metrics.js');
  const f = await fixture(t);
  const candidate = await f.candidate('metric.txt');
  const reader = nativeSelfMetricsReader(f.root);
  const beforeRecords = reader.read();
  assert.ok(beforeRecords.coverage.deliveries);
  // Move the observation clock, not arrival before the recorded coverage window.
  const asOf = new Date(Date.now() + 2 * 60 * 60_000).toISOString();
  const period = { from: beforeRecords.coverage.deliveries, to: asOf, asOf };
  const before = calculateSelfMetrics(beforeRecords, period).metric3;
  assert.equal(before.partial, false);
  assert.equal(before.dropped, 1);
  await drainLandingBatches(f.work, 'main');
  const after = calculateSelfMetrics(reader.read(), period).metric3;
  assert.equal(after.partial, false);
  assert.equal(entry(f, candidate).status, 'accepted');
  assert.equal(after.dropped, 0);
});
