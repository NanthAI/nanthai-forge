// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from './landing-batch-fixture.mjs';
import { AgentWorkflow } from '../dist/agent-workflow.js';
import { batchEdit, selectBatch, composeBatch } from '../dist/landing-batch-store.js';
import { drainLandingBatches, passingPrefix } from '../dist/landing-batch.js';
import { advanceLandingBatch } from '../dist/landing-batch-step.js';
import { claimLandingDriver } from '../dist/landing-driver.js';
import { landingDiagnosis } from '../dist/landing-diagnosis.js';
import { queuedOutcome } from '../dist/landing-submission.js';
import { readLaneSubmissions } from '../dist/landing-submission-read.js';
import { waitForAgentRun } from '../dist/agent-run-observer.js';
import { landingBatchSchema } from '../dist/landing-batch-types.js';
import { preserveFields } from '../dist/work-normalization.js';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readPendingStatus } from '../dist/pending-status-read.js';

const select = f => batchEdit(f.work, 'select', data => selectBatch(f.work, data, 'main'));
const runs = f => f.store.load().runs.filter(run => !run.mainCheck);
function assertCheckedMoves(f) {
  const data = f.store.load();
  assert.ok(data.channelMoves.some(move => move.status === 'accepted'));
  for (const move of data.channelMoves.filter(move => move.status === 'accepted')) {
    const run = runs(f).find(
      run => run.viewId === move.viewId && run.head === move.head && run.status === 'passed',
    );
    assert.ok(run, 'every accepted subset has its own applicable exact-Candidate evidence');
    assert.equal(run.base, data.views.find(view => view.id === move.viewId).base);
    assert.equal(run.check.definition, data.checks.find(check => check.id === run.check.id).definition);
    assert.equal(run.exitCode, 0);
    assert.deepEqual(run.inputs, data.views.find(view => view.id === move.viewId).inputs);
  }
}

for (const remote of [false, true])
  test(`A/B interaction retains the failing set and lands only checked A (${remote ? 'parallel' : 'halving'})`, async t => {
    const f = await fixture(t, {
      remote,
      failWhen: "exists('A.txt') && exists('B.txt')",
    });
    const a = await f.candidate('A.txt'),
      b = await f.candidate('B.txt');
    const bControlId = randomUUID();
    await f.work.dispatch(
      {
        action: 'run-check',
        operationId: bControlId,
        viewId: b.view.id,
        expectedHead: b.view.head,
        checkId: f.check.checkId,
        expectedDefinition: f.check.definition,
        expectedEnvironment: b.command.expectedEnvironment,
      },
      f.store.revision(),
    );
    await waitForAgentRun(f.store, bControlId);
    assert.equal(f.store.select('runs', bControlId).status, 'passed');
    await drainLandingBatches(f.work, 'main');
    const data = f.store.load(),
      first = data.landingBatches[0];
    assert.equal(first.diagnosis.minimization, 'incomplete');
    assert.equal(first.settlement.failingViewId, first.settlement.culpritViewId);
    const full = first.diagnosis.nodes.find(node => node.entryIds.length === 2);
    assert.equal(full.status, 'failed');
    assert.deepEqual(full.entryIds, [a.command.operationId, b.command.operationId]);
    assert.deepEqual(full.inputs, [a.view.inputs[0], b.view.inputs[0]]);
    assert.equal(full.base, first.base);
    assert.equal(full.definition, f.check.definition);
    assert.equal(full.environment, first.environment.fingerprint);
    assert.equal(full.selection.runId, full.runId);
    assert.equal(full.selection.known, false, 'synthetic command declares no test selection');
    const aNode = first.diagnosis.nodes.find(node => node.entryIds.length === 1);
    assert.equal(aNode.parentId, full.id);
    assert.equal(aNode.status, 'passed');
    assert.deepEqual(
      data.landingEntries.map(entry => entry.status),
      ['accepted', 'failed'],
    );
    assert.match(data.landingEntries[1].reason, /Observed failing prefix of 2/);
    const submission = readLaneSubmissions(f.store, b.lane.laneId)[0];
    assert.equal(submission.cause, 'check-failed');
    assert.equal(submission.diagnosis.smallestObservedFailingSet.nodeId, full.id);
    assert.deepEqual(
      readPendingStatus(f.store, undefined, undefined, { detail: true }).lanes.find(
        lane => lane.laneId === b.lane.laneId,
      ).submission,
      submission,
    );
    const observation = queuedOutcome(f.store, data.landingEntries[1]);
    assert.deepEqual(observation.diagnosis.observedFailingSets[0].entryIds, full.entryIds);
    assert.equal(observation.diagnosis.smallestObservedFailingSet.nodeId, full.id);
    assertCheckedMoves(f);
  });

for (const remote of [false, true])
  test(`non-monotone prefixes retain observed failures without claiming minimality (${remote ? 'parallel' : 'halving'})`, async t => {
    const f = await fixture(t, {
      remote,
      failWhen: "(exists('B.txt') && !exists('C.txt')) || exists('D.txt')",
    });
    for (const name of ['A', 'B', 'C', 'D']) await f.candidate(`${name}.txt`);
    await drainLandingBatches(f.work, 'main');
    const first = f.store.load().landingBatches[0];
    const observed = new Map(first.diagnosis.nodes.map(node => [node.entryIds.length, node.status]));
    assert.equal(observed.get(4), 'failed');
    assert.equal(observed.get(2), 'failed');
    assert.equal(observed.get(remote ? 3 : 1), 'passed');
    if (!remote) assert.equal(observed.has(3), false, 'halving does not promise exhaustive prefixes');
    assert.equal(first.diagnosis.minimization, 'incomplete');
    assert.equal(
      landingDiagnosis(f.store, f.store.load().landingEntries[0]).diagnosis.smallestObservedFailingSet.nodeId,
      first.diagnosis.nodes.find(node => node.entryIds.length === 2).id,
    );
    assertCheckedMoves(f);
  });

test('all-passing halves do not license their failed union; second half is recomposed on actual main', async t => {
  const f = await fixture(t, {
    failWhen: "exists('A.txt') && exists('C.txt')",
  });
  let intentId;
  for (const name of ['A', 'B', 'C', 'D']) {
    const input = await f.candidate(`${name}.txt`, `${name}\n`, true, intentId);
    intentId ??= input.lane.intentId;
  }
  // Check both independent halves on the original base through the same runner.
  const initial = f.store.load().landingEntries;
  const halves = [];
  for (const entries of [initial.slice(0, 2), initial.slice(2)]) {
    const composed = (
      await f.agent.dispatch({
        action: 'compose',
        operationId: randomUUID(),
        intentId: f.store.select('views', entries[0].viewId).intentId,
        inputs: entries.flatMap(entry => f.store.select('views', entry.viewId).inputs),
        dependencies: [],
      })
    ).result;
    const runId = randomUUID();
    await f.work.dispatch(
      {
        action: 'run-check',
        operationId: runId,
        viewId: composed.viewId,
        expectedHead: composed.head,
        checkId: f.check.checkId,
        expectedDefinition: f.check.definition,
        expectedEnvironment: initial[0].environment,
      },
      f.store.revision(),
    );
    await waitForAgentRun(f.store, runId);
    assert.equal(f.store.select('runs', runId).status, 'passed');
    halves.push(f.store.select('runs', runId));
  }
  await drainLandingBatches(f.work, 'main');
  const data = f.store.load();
  assert.deepEqual(
    data.landingEntries.map(entry => entry.status),
    ['accepted', 'accepted', 'failed', 'accepted'],
  );
  const first = data.landingBatches[0];
  assert.equal(first.diagnosis.nodes.find(node => node.entryIds.length === 4).status, 'failed');
  assert.equal(first.diagnosis.nodes.find(node => node.entryIds.length === 3).status, 'failed');
  assert.equal(f.content('C.txt'), undefined);
  const dRun = f.store.select('runs', data.landingEntries[3].runId);
  assert.equal(dRun.base, data.channelMoves[0].head);
  assert.ok(halves.every(run => run.id !== dRun.id));
  assertCheckedMoves(f);
});

test('three-way-only failure retains the observed triple even when all pairs pass', async t => {
  const f = await fixture(t, {
    failWhen: "exists('A.txt') && exists('B.txt') && exists('C.txt')",
  });
  const candidates = [];
  for (const name of ['A', 'B', 'C'])
    candidates.push(await f.candidate(`${name}.txt`, `${name}\n`, true, candidates[0]?.lane.intentId));
  for (const pair of [
    [0, 1],
    [0, 2],
    [1, 2],
  ]) {
    const view = (
      await f.agent.dispatch({
        action: 'compose',
        operationId: randomUUID(),
        intentId: candidates[0].lane.intentId,
        inputs: pair.flatMap(i => candidates[i].view.inputs),
        dependencies: [],
      })
    ).result;
    const runId = randomUUID();
    await f.work.dispatch(
      {
        action: 'run-check',
        operationId: runId,
        viewId: view.viewId,
        expectedHead: view.head,
        checkId: f.check.checkId,
        expectedDefinition: f.check.definition,
        expectedEnvironment: candidates[0].command.expectedEnvironment,
      },
      f.store.revision(),
    );
    await waitForAgentRun(f.store, runId);
    assert.equal(f.store.select('runs', runId).status, 'passed');
  }
  await drainLandingBatches(f.work, 'main');
  const first = f.store.load().landingBatches[0];
  const observation = landingDiagnosis(f.store, f.store.load().landingEntries[2]).diagnosis;
  assert.deepEqual(
    observation.observedFailingSets.map(node => node.entryIds.length),
    [3],
  );
  assert.equal(observation.minimization, 'incomplete');
  assert.equal(first.diagnosis.nodes.find(node => node.entryIds.length === 2).status, 'passed');
  assert.equal(f.content('C.txt'), undefined);
  assertCheckedMoves(f);
});

test('restart mid-split retains reserved child and adopts completed evidence without another dispatch', async t => {
  const f = await fixture(t, { remote: false });
  for (const name of ['A.txt', 'bad.txt', 'C.txt', 'D.txt']) await f.candidate(name);
  const batch = await select(f),
    driver = await claimLandingDriver(f.work, 'main');
  await composeBatch(f.work, batch, driver.beforePublish);
  const script = `import { AgentWorkflow } from ${JSON.stringify(new URL('../dist/agent-workflow.js', import.meta.url).href)};
import { drainLandingBatches } from ${JSON.stringify(new URL('../dist/landing-batch.js', import.meta.url).href)};
import { waitForAgentRun } from ${JSON.stringify(new URL('../dist/agent-run-observer.js', import.meta.url).href)};
const work = new AgentWorkflow(process.argv[1]).work;
const dispatch = work.dispatch.bind(work);
let count = 0;
work.dispatch = async (...args) => {
  const result = await dispatch(...args);
  if (args[0].action === 'run-check' && ++count === 2) {
    await waitForAgentRun(work.store, args[0].operationId);
    process.exit(79);
  }
  return result;
};
await drainLandingBatches(work, 'main');`;
  await assert.rejects(
    promisify(execFile)(process.execPath, [
      '--import',
      './tests/check-runtime.mjs',
      '--input-type=module',
      '-e',
      script,
      f.root,
    ]),
    { code: 79 },
  );
  const interrupted = f.store.select('landingBatches', batch.id);
  const childId = interrupted.diagnosis.nodes.find(node => node.status === 'reserved').runId;
  assert.equal(interrupted.diagnosis.nodes.length, 2);
  assert.equal(interrupted.diagnosis.nodes.find(node => node.id === childId).status, 'reserved');
  const prefixRuns = runs(f).map(run => run.id);
  const replacement = new AgentWorkflow(f.root).work,
    replay = replacement.dispatch.bind(replacement);
  replacement.dispatch = (...args) => {
    if (args[0].action === 'run-check') assert.ok(!prefixRuns.includes(args[0].operationId));
    return replay(...args);
  };
  await drainLandingBatches(replacement, 'main');
  const recovered = f.store.select('landingBatches', batch.id);
  assert.equal(recovered.diagnosis.nodes.find(node => node.id === childId).status, 'failed');
  assert.equal(
    new Set(recovered.diagnosis.nodes.map(node => node.id)).size,
    recovered.diagnosis.nodes.length,
  );
  const legacy = landingBatchSchema.omit({ diagnosis: true, settlement: true });
  assert.deepEqual(preserveFields(legacy.parse(recovered), recovered), recovered);
  assert.equal(f.store.load().schema, 17);
  assert.deepEqual(
    f.store.load().landingEntries.map(entry => entry.status),
    ['accepted', 'failed', 'accepted', 'accepted'],
  );
  assertCheckedMoves(f);
});

test('blocked dependency stays pending and is never diagnosed as a failed Lane', async t => {
  const f = await fixture(t);
  const parent = await f.candidate('bad.txt', 'bad\n', false);
  const child = (
    await f.agent.dispatch({
      action: 'start',
      outcome: 'Blocked child',
      after: { intentId: parent.lane.intentId },
    })
  ).result;
  writeFileSync(join(child.path, 'child.txt'), 'child\n');
  const result = (
    await f.agent.dispatch({
      action: 'finish',
      operationId: randomUUID(),
      laneId: child.laneId,
      message: 'Wait for parent',
      accept: true,
    })
  ).result;
  assert.equal(result.status, 'waiting-for-dependency');
  assert.equal(result.terminal, false);
  assert.equal(f.store.load().landingBatches?.length ?? 0, 0);
  assert.equal(runs(f).length, 0);
  const observation = readLaneSubmissions(f.store, child.laneId)[0];
  assert.equal(observation.pendingReason, 'waiting-for-dependency');
  assert.equal(observation.cause, null);
});

test('a full passing composition needs no intermediate prefix gate', async () => {
  const prefixes = [1, 2, 3].map(n => ({
    entryIds: Array(n).fill('entry'),
    viewId: String(n),
    head: String(n),
    runId: String(n),
  }));
  const checked = [];
  const outcome = await passingPrefix(prefixes, 'halving', async prefix => {
    checked.push(prefix);
    return prefix === prefixes[2] ? 'passed' : 'failed';
  });
  assert.deepEqual(checked, [prefixes[2]]);
  assert.equal(outcome.passing, prefixes[2]);
  assert.equal(outcome.failing, undefined);
});

test('an evaluated cursor cannot accept stale or incomplete passing evidence', async t => {
  const f = await fixture(t);
  await f.candidate('pins.txt');
  const batch = await select(f),
    driver = await claimLandingDriver(f.work, 'main');
  await advanceLandingBatch(f.work, batch.id, driver);
  await advanceLandingBatch(f.work, batch.id, driver);
  const saved = f.store.select('landingBatches', batch.id),
    prefix = saved.prefixes[0];
  const { validatePassingPrefix } = await import('../dist/landing-diagnosis.js');
  const original = f.store.select.bind(f.store);
  for (const mutation of [
    run => ({ ...run, head: 'f'.repeat(64) }),
    run => ({
      ...run,
      environment: { ...run.environment, fingerprint: 'f'.repeat(64) },
    }),
    run => ({ ...run, inputs: [] }),
    run => ({
      ...run,
      dependencies: [{ kind: 'view', viewId: randomUUID(), head: 'f'.repeat(64) }],
    }),
    run => ({ ...run, exitCode: null }),
  ]) {
    f.store.select = (collection, id) => {
      const record = original(collection, id);
      return collection === 'runs' && id === prefix.runId ? mutation(record) : record;
    };
    assert.throws(() => validatePassingPrefix(f.work, saved, prefix), {
      code: 'EVIDENCE_CHANGED',
    });
  }
  f.store.select = original;
  await f.agent.dispatch({
    action: 'define-check',
    checkId: f.check.checkId,
    name: 'verify',
    executable: process.execPath,
    args: ['-e', 'console.log("changed definition")'],
  });
  await assert.rejects(advanceLandingBatch(f.work, batch.id, driver), {
    code: 'EVIDENCE_CHANGED',
  });
  assert.equal(f.store.load().channelMoves.length, 0);
  assert.equal(runs(f).length, 1);
});

for (const error of [undefined, { code: 'WORK_BUSY', message: 'Synthetic runner preparation contention' }])
  test(`runner ${error ? 'preparation error' : 'unknown non-execution'} is inconclusive, without splitting or blaming source`, async t => {
    const f = await fixture(t, { remote: false });
    await f.candidate('A.txt');
    await f.candidate('B.txt');
    const batch = await select(f),
      driver = await claimLandingDriver(f.work, 'main');
    await composeBatch(f.work, batch, driver.beforePublish);
    const saved = f.store.select('landingBatches', batch.id),
      prefix = saved.prefixes.at(-1);
    const view = f.store.select('views', prefix.viewId);
    await batchEdit(f.work, 'synthetic-failed-preparation', data => {
      data.runs.push({
        id: prefix.runId,
        viewId: view.id,
        head: view.head,
        base: view.base,
        inputs: view.inputs,
        dependencies: view.dependencies ?? [],
        check: data.checks[0],
        environment: saved.environment,
        status: 'failed',
        exitCode: null,
        signal: null,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        runner: { pid: process.pid, host: 'synthetic' },
        details: 'Synthetic command never started',
        backend: { requested: 'local', actual: 'local' },
        ...(error ? { error } : {}),
      });
    });
    await drainLandingBatches(new AgentWorkflow(f.root).work, 'main');
    const data = f.store.load(),
      retained = data.landingBatches[0];
    assert.deepEqual(
      data.landingEntries.map(entry => entry.status),
      ['interrupted', 'interrupted'],
    );
    assert.ok(data.landingEntries.every(entry => entry.runId === prefix.runId));
    assert.equal(readLaneSubmissions(f.store, view.inputs[0].laneId)[0].cause, 'infra');
    assert.equal(
      readPendingStatus(f.store, undefined, undefined, { detail: true }).lanes[0].submission.cause,
      'infra',
    );
    assert.equal(retained.diagnosis.nodes.length, 1);
    assert.equal(retained.diagnosis.nodes[0].cause, error ? 'infra' : 'unknown-outcome');
    assert.deepEqual(landingDiagnosis(f.store, data.landingEntries[0]).diagnosis.observedFailingSets, []);
    assert.equal(runs(f).length, 1);
    assert.equal(data.channelMoves.length, 0);
  });

test('signal and likely-OOM check failures do not become confirmed transient infrastructure', async () => {
  const { diagnosticStatus, diagnosticCause } = await import('../dist/landing-diagnosis.js');
  for (const run of [
    { status: 'failed', exitCode: 137 },
    { status: 'failed', exitCode: null, signal: 'SIGKILL' },
    {
      status: 'failed',
      exitCode: 1,
      backend: { actual: 'github-actions' },
      error: { code: 'GITHUB_ACTIONS_PENDING_INFRA' },
    },
  ]) {
    assert.equal(diagnosticStatus(run), 'failed');
    assert.equal(diagnosticCause(run), 'check-failed');
  }
});
