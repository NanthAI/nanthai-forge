import { observerProjectionBudget } from './observer-projection-budget.mjs';
// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { batchesFixture, states, synthetic, batchStore } from './hosted-landing-batches-fixture.mjs';
import { landingApi } from './hosted-finish-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { batchMemberDiagnostic, batchDiagnosticSchema } from '../dist/hosted-batch-diagnosis.js';
const finishCompose = await import(moduleUrl('../convex/projectHostedFinishCompose.ts'));
const finishStore = await import(moduleUrl('../convex/projectHostedFinishStore.ts'));
const pipeline = await import(moduleUrl('../convex/projectHostedLandingPipeline.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const current = (f, index) => states(f).find(state => state.id === f.entries[index].state.id);
const batches = f => [...f.tables.projectHostedLandingBatches.values()].map(row => JSON.parse(row.value));
async function drain(f, skip = () => false) {
  let steps = 0;
  for (;;) {
    const task = f.pending().find(task => !task.name.startsWith('projectHostedLandingStall:') && !skip(task));
    if (!task) return;
    assert(++steps < 2000, 'finite event-driven progress');
    await f.execute(task);
  }
}
async function finish(f) {
  for (let wave = 0; states(f).some(state => !['landed', 'terminal-failed'].includes(state.phase)); wave++) {
    assert(wave < 20);
    const runs = f.runs().filter(run => run.status === 'queued');
    assert(runs.length, JSON.stringify(states(f).map(({ phase, error }) => ({ phase, error }))));
    for (const run of runs) await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    await drain(f);
  }
  assert.equal(f.pending().length, 0);
}
const rowOf = (f, id) =>
  [...f.tables.projectHostedLandingRequests.values()].find(row => row.submissionId === id);

for (const history of [0, 575, 1150])
  test(`mixed cohort replay with ${history} retained entries: survivors check before settlement and reuse their exact generation`, async t => {
    const f = await batchesFixture(t, {
      count: 10,
      batching: 'default',
      batchMaxSize: 3,
      memberPaths: [
        'independent-0',
        'collision',
        'independent-2',
        'collision',
        'independent-4',
        'independent-5',
      ],
    });
    for (let index = 0; index < history; index++) {
      f.insert('projectHostedLandingRequests', {
        projectId: f.projectId,
        channel: 'main',
        submissionId: randomUUID(),
        operationId: randomUUID(),
        actor: 'owner',
        sequence: -index - 1,
        runnable: false,
        phase: 'landed',
        batchable: false,
        runId: null,
        attemptId: randomUUID(),
        value: JSON.stringify({ phase: 'landed', id: randomUUID() }),
      });
      f.insert('projectHostedAcceptances', {
        projectId: f.projectId,
        receiptId: randomUUID(),
        submissionId: randomUUID(),
        attemptId: randomUUID(),
        sequence: index + 100,
        value: 'unrelated receipt history must not be read',
      });
    }
    const before = f.counts.length,
      started = performance.now();
    await drain(f);
    assert.equal(current(f, 3).phase, 'queued');
    assert.equal(current(f, 4).phase, 'checking');
    assert.equal(current(f, 5).phase, 'checking');
    assert.equal(f.runs().length, 4, 'clean survivors open later pipeline slots');
    const cohort = batches(f).find(batch => batch.id === current(f, 4).batchId);
    const generation = cohort.composeOperationId,
      runId = cohort.runId;
    const attempt = current(f, 4).attemptId;
    assert.equal(f.currentMain().head, f.entries[0].request.expectedMain.head);
    // A clean successor can finish first but cannot publish before its predecessor.
    await f.rawChecks.pass(await f.rawChecks.activate(runId));
    await drain(f);
    assert.equal(current(f, 4).phase, 'ready');
    assert.equal(current(f, 3).phase, 'queued', 'speculative conflict remains advisory');
    await f.rawChecks.pass(await f.rawChecks.activate(f.runs()[0].id));
    await drain(f);
    assert.equal(current(f, 3).error?.code, 'COMPOSITION_CONFLICT');
    assert.equal(current(f, 4).phase, 'landed');
    assert.equal(current(f, 4).attemptId, attempt);
    assert.equal(batches(f).find(batch => batch.id === cohort.id).composeOperationId, generation);
    await finish(f);
    assert.equal(f.runs().length, 4, 'no additional exact checks');
    assert.equal(f.metrics.sourceJobs, 4, 'one source job per original cohort, no survivor recompose');
    for (const state of states(f).filter(state => state.phase === 'landed'))
      assert.equal(
        state.batchDiagnostic,
        undefined,
        'successful cohorts never receive individual fallback prose',
      );
    const files = JSON.parse(f.c.objects.get(f.currentMain().head)).files;
    for (const [index, entry] of f.entries.entries()) {
      if (index === 3) continue;
      const own = JSON.parse(f.c.objects.get(entry.candidate.result.head)).files;
      for (const file of own)
        assert(files.some(accepted => accepted.path === file.path && accepted.blob === file.blob));
    }
    const calls = f.counts.slice(before);
    const budget = {
      history,
      calls: calls.length,
      reads: calls.reduce((n, c) => n + c.documents, 0),
      writes: calls.reduce((n, c) => n + c.writes, 0),
      maxReads: Math.max(...calls.map(c => c.documents)),
      maxWrites: Math.max(...calls.map(c => c.writes)),
      sourceJobs: f.metrics.sourceJobs,
      checks: f.runs().length,
      wallMs: performance.now() - started,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
    };
    const source = calls.map(observerProjectionBudget);
    // Reads 3997 -> 3999 (incident c329d191): each of the two order-woken heads
    // cancels the stall alarm armed with its wake when it lands.
    // Reads 3999 -> 4107 (0b12fcfe): the completion tick reads each landed Lane's Intent head (and its
    // sibling Lane heads) to complete the Intent with its last Lane. Calls and writes are unchanged.
    assert(
      budget.calls <= 199 &&
        source.reduce((n, c) => n + c.documents, 0) <= 4107 &&
        source.reduce((n, c) => n + c.writes, 0) <= 1200,
      JSON.stringify({
        ...budget,
        sourceReads: source.reduce((n, c) => n + c.documents, 0),
        sourceWrites: source.reduce((n, c) => n + c.writes, 0),
      }),
    );
    assert(
      Math.max(...source.map(c => c.documents)) <= 170 && Math.max(...source.map(c => c.writes)) <= 55,
      JSON.stringify(budget),
    );
    const idle = f.counts.length;
    await drain(f);
    assert.equal(f.counts.length, idle, 'zero idle calls');
    t.diagnostic(JSON.stringify(budget));
  });

test('member precompose terminal before shared compose consumption keeps clean survivors grouped', async t => {
  const f = await batchesFixture(t, {
    count: 6,
    batching: 'default',
    batchMaxSize: 3,
    memberPaths: [
      'independent-0',
      'collision',
      'independent-2',
      'collision',
      'independent-4',
      'independent-5',
    ],
  });
  let cohort,
    steps = 0;
  // Stop exactly when the shared source result is durable, before its finish consumes it.
  for (;;) {
    assert(++steps < 500);
    const task = f.pending().find(task => !task.name.startsWith('projectHostedLandingStall:'));
    assert(task);
    await f.execute(task);
    cohort = batches(f).find(batch => batch.predecessor);
    if (!cohort) continue;
    const op = [...f.tables.projectHostedOperations.values()]
      .map(row => JSON.parse(row.value))
      .find(op => op.operationId === cohort.composeOperationId);
    if (op?.terminal) break;
  }
  const leader = cohort.leaderId;
  const sharedFinish = task =>
    task.name === 'projectHostedFinishDriver:drive' && task.args[0].submissionId === leader;
  await f.rawChecks.pass(await f.rawChecks.activate(f.runs()[0].id));
  await drain(f, sharedFinish);
  assert.equal(current(f, 1).phase, 'landed');
  await f.transaction(
    'member-probe-before-shared-result',
    {
      _handler: async ctx => {
        const finish = await finishStore.loadFinish(ctx, { projectId: f.projectId, submissionId: leader });
        if (!finish.value.pending)
          await finishCompose.reserveFinishRetry(ctx, finish.row, finish.value, 'CHECK_EVIDENCE_REFRESH', {
            peerLanes: [f.entries[1].lane.laneId],
            paths: ['collision'],
            runnable: false,
          });
      },
    },
    {},
  );
  await drain(f);
  assert.equal(current(f, 3).phase, 'terminal-failed');
  assert.equal(current(f, 4).phase, 'checking');
  assert.equal(current(f, 5).phase, 'checking');
  const retained = batches(f).find(batch => batch.id === cohort.id);
  assert.equal(retained.phase, 'checking');
  assert.equal(retained.composeOperationId, cohort.composeOperationId);
  assert.equal(current(f, 4).batchSolo, undefined);
  assert.equal(f.runs().length, 2);
  assert.equal(
    f.metrics.sourceJobs,
    5,
    'two shared jobs and three already-running legacy member probes, without fallback source',
  );
  await finish(f);
  assert.equal(f.runs().length, 2);
});

for (const outcome of ['passed', 'failed', 'cancelled'])
  test(`ready entries pipeline behind a fallback solo tail; ${outcome} preserves or invalidates exact successor evidence`, async t => {
    const f = await batchesFixture(t, { count: 1, batching: 'default', batchMaxSize: 3 });
    await drain(f);
    const solo = current(f, 0),
      row = rowOf(f, solo.id);
    f.patch('projectHostedLandingRequests', row._id, {
      batchable: false,
      batchSelection: undefined,
      value: JSON.stringify({ ...solo, batchSolo: true }),
    });
    // These entries become ready while the solo check remains live, as recovered
    // source selections did in the observed replay. Their paths are arbitrary.
    for (let index = 1; index < 5; index++) await f.add(index);
    await drain(f);
    assert(f.runs().length > 1, 'successors start before the solo check settles');
    const successors = batches(f).filter(batch => batch.predecessor);
    assert.equal(successors[0].predecessor.submissionId, solo.id);
    const child = successors[0],
      oldRun = f.runs().find(run => run.id === child.runId);
    const active = await f.rawChecks.activate(oldRun.id);
    if (outcome === 'passed') await f.rawChecks.pass(await f.rawChecks.activate(f.runs()[0].id));
    else if (outcome === 'failed') await f.fail(f.runs()[0].id);
    else
      await f.transaction('cancel-solo-predecessor', landingApi.cancel, {
        projectId: f.projectId,
        request: JSON.stringify({ operationId: randomUUID(), authorityEpoch: 1, submissionId: solo.id }),
      });
    await drain(f);
    if (outcome === 'passed') {
      assert.equal(
        batches(f).find(batch => batch.id === child.id).composeOperationId,
        child.composeOperationId,
      );
      await f.rawChecks.pass(active);
    } else {
      assert.equal(batches(f).find(batch => batch.id === child.id).phase, 'superseded');
      const pins = states(f).map(state => state.attemptId);
      await assert.rejects(f.rawChecks.pass(active), error => error.data?.code === 'CHECK_CANCELLED');
      assert.deepEqual(
        states(f).map(state => state.attemptId),
        pins,
        'late check cannot revive the old generation',
      );
    }
    await drain(f);
    await finish(f);
    assert.equal(states(f).filter(state => state.phase === 'landed').length, outcome === 'passed' ? 5 : 4);
  });

test('same-head new predecessor receipt invalidates a retained shared source generation', async t => {
  const f = await batchesFixture(t, { count: 4, batching: 'default', batchMaxSize: 3 });
  await drain(f);
  const cohort = batches(f).find(batch => batch.predecessor),
    original = cohort.composeOperationId;
  const predecessor = rowOf(f, cohort.predecessor.submissionId);
  const value = JSON.parse(predecessor.value);
  f.patch('projectHostedLandingRequests', predecessor._id, {
    phase: 'landed',
    runnable: false,
    value: JSON.stringify({
      ...value,
      phase: 'landed',
      acceptance: { head: cohort.predecessor.head, receiptId: randomUUID() },
    }),
  });
  const result = await f.transaction(
    'exact-receipt-status',
    {
      _handler: ctx =>
        pipeline.predecessorStatus(ctx, { projectId: f.projectId, batchId: cohort.id }, cohort),
    },
    {},
  );
  assert.equal(result, 'invalid');
  await f.transaction(
    'retire-stale-source',
    {
      _handler: ctx =>
        batchStore.retryLandingBatch(ctx, { projectId: f.projectId, batchId: cohort.id }, cohort),
    },
    {},
  );
  assert.notEqual(batches(f).find(batch => batch.id === cohort.id).composeOperationId, original);
});

test('late source upload callbacks cannot consume another cohort generation even with identical bytes', async t => {
  const f = await batchesFixture(t, { count: 2 });
  while (!f.tables.projectHostedLandingBatches.size) await f.execute(f.pending()[0]);
  const before = batches(f)[0];
  const batchCompose = await import(moduleUrl('../convex/projectHostedLandingBatchCompose.ts'));
  const batchFinish = await import(moduleUrl('../convex/projectHostedLandingBatchFinish.ts'));
  const key = { projectId: f.projectId, batchId: before.id };
  const source = await f.transaction(
    'original-shared-plan',
    { _handler: ctx => batchCompose.prepareBatchCompose(ctx, key) },
    {},
  );
  const command = {
    kind: 'plan',
    ...source.uploads[0],
    batchId: before.id,
    batchComposeOperationId: before.composeOperationId,
  };
  await f.transaction(
    'replace-shared-generation',
    { _handler: ctx => batchStore.retryLandingBatch(ctx, key, batches(f)[0]) },
    {},
  );
  const retained = batches(f)[0];
  assert.notEqual(retained.composeOperationId, before.composeOperationId);
  const call = f.counts.length;
  await f.transaction(
    'late-old-plan-callback',
    {
      _handler: ctx =>
        batchFinish.resumeBatchIO(ctx, {
          projectId: f.projectId,
          submissionId: before.leaderId,
          wakeId: randomUUID(),
          command,
        }),
    },
    {},
  );
  assert.deepEqual(batches(f)[0], retained);
  assert.equal(f.counts[call].writes, 0, 'a stale source callback does not write or wake anything');
  await drain(f);
  await finish(f);
});

test('structured internal transition causes retain the released strict diagnostic shape', () => {
  const cause = {
    code: 'EVIDENCE_CHANGED',
    message: 'The exact shared run no longer matches its Candidate.',
  };
  const diagnostic = batchMemberDiagnostic(
    [],
    undefined,
    { id: randomUUID(), phase: 'queued' },
    null,
    'fallback',
    cause,
  );
  // Released clients reject unknown keys. New attribution must use the existing
  // message surface while the cohort stores the structured cause internally.
  assert.deepEqual(Object.keys(diagnostic).sort(), [
    'coverage',
    'failedTests',
    'failsTogetherWith',
    'individualPassed',
    'likelyCulprit',
    'message',
    'overBudgetPairs',
    'waitingFor',
  ]);
  assert.deepEqual(batchDiagnosticSchema.parse(diagnostic), diagnostic);
  assert(diagnostic.message.includes(cause.code) && diagnostic.message.includes(cause.message));
});
