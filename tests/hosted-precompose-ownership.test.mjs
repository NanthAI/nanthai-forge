// SPDX-License-Identifier: Apache-2.0
import { observerProjectionBudget } from './observer-projection-budget.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { batchesFixture, synthetic, states } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const precompose = await import(moduleUrl('../convex/projectHostedLandingPrecompose.ts'));
const finishDriver = await import(moduleUrl('../convex/projectHostedFinishDriver.ts'));
const finishCompose = await import(moduleUrl('../convex/projectHostedFinishCompose.ts'));
const finishStore = await import(moduleUrl('../convex/projectHostedFinishStore.ts'));
const operations = await import(moduleUrl('../convex/projectHostedOperations.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const ready = f => f.pending().find(task => task.scheduledTime <= Date.now() + 30000);
async function drain(f) {
  let ticks = 0;
  while (ready(f)) {
    assert(++ticks < 500, 'finite event-driven work');
    await f.execute(ready(f));
  }
}
async function probe(f) {
  const main = f.moveMain();
  await f.transaction(
    'ownership-probe',
    { _handler: precompose.precomposeWaiting },
    {
      projectId: f.projectId,
      receiptIds: [main.receipt.id],
    },
  );
  await f.execute(f.pending().find(task => task.name === 'projectHostedFinishDriver:drive'));
  assert(JSON.parse(f.row(f.entries[0].state.id).value).pending.precompose);
}

for (const history of [575, 1150])
  test(`useful train claim supersedes pending probe with ${history} retained landings`, async t => {
    const f = await batchesFixture(t, { count: 2 });
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
    await probe(f);
    f.moveMain({ sameHead: true }); // Matching bytes with a different receipt cannot authorize reuse.
    await f.execute(f.pending().find(task => task.name === 'projectHostedLandingDriver:drive'));
    const preparedAtClaim = states(f)[0].batchId;
    await drain(f);
    for (let i = 0; states(f).some(s => s.phase !== 'landed'); i++) {
      assert(i < 5);
      await f.passChecks();
      await drain(f);
    }
    const calls = f.counts.slice(before);
    const budget = {
      history,
      calls: calls.length,
      reads: calls.reduce((n, c) => n + c.documents, 0),
      writes: calls.reduce((n, c) => n + c.writes, 0),
      sourceJobs: f.metrics.sourceJobs,
      checks: f.runs().length,
      wallMs: performance.now() - started,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
    };
    t.diagnostic(JSON.stringify(budget));
    // Measured on the pre-fix controller with the identical replay, including
    // the blocked claim, advisory completions, exact shared check and publication.
    const source = calls.map(observerProjectionBudget);
    // Reads 1329 -> 1334 (0b12fcfe): the completion tick reads the landed Lane's Intent head to complete
    // the Intent with its last Lane. Calls and writes are unchanged.
    // Reads 1334 -> 1336, writes 410 -> 412 (13c63abe): the completion tick's stall guard, retained
    // on the plan and cancelled by the tick. Calls are unchanged: a healthy guard never runs.
    // Reads 1336 -> 1341 (55024d40): a landed Lane's Intent with other open unpinned Lanes costs the
    // completion tick one overlap-row read for the landed Lane and one per candidate, to supersede the
    // quiet ones. Calls and writes are unchanged.
    // Reads 1341 -> 1345, writes 412 -> 416 (5471e31c): each overlap-row write also reads and rewrites the
    // Lane's ~1 KB slim peer row. Calls are unchanged.
    assert(
      budget.calls <= 71 &&
        source.reduce((n, c) => n + c.documents, 0) <= 1345 &&
        source.reduce((n, c) => n + c.writes, 0) <= 416,
      JSON.stringify({
        ...budget,
        sourceReads: source.reduce((n, c) => n + c.documents, 0),
        sourceWrites: source.reduce((n, c) => n + c.writes, 0),
      }),
    );
    assert(preparedAtClaim, 'train preparation must not wait for advisory source completion');
    assert.equal(f.runs().length, 1, 'the shared exact check remains mandatory');
    const idle = f.counts.length;
    await drain(f);
    assert.equal(f.counts.length, idle, 'zero idle calls');
  });

test('an exact-main individual claim adopts pending source and checks its result once', async t => {
  const f = await batchesFixture(t, { count: 1, batching: false });
  await probe(f);
  const id = f.entries[0].state.id;
  const old = JSON.parse(f.row(id).value).pending;
  await f.execute(f.pending().find(task => task.name === 'projectHostedLandingDriver:drive'));
  const claimed = JSON.parse(f.row(id).value).pending;
  assert(claimed && !claimed.precompose, 'the claim owns useful composition');
  assert.notEqual(claimed.id, old.id, 'advisory completion generation is fenced');
  assert.equal(claimed.operations.compose, old.operations.compose, 'same source operation on exact main');
  await drain(f);
  assert.equal(states(f)[0].phase, 'checking');
  assert.equal(f.metrics.sourceJobs, 1);
  assert.equal(f.runs().length, 1);
  await f.passChecks();
  await drain(f);
  assert.equal(states(f)[0].phase, 'landed');
  assert.equal(f.metrics.sourceJobs, 1);
});

test('a delayed clean warmup cannot retake ownership from an already formed train', async t => {
  const f = await batchesFixture(t, { count: 2 });
  await f.execute(f.pending().find(task => task.name === 'projectHostedLandingDriver:drive'));
  assert(states(f)[0].batchId);
  const main = f.moveMain({ sameHead: true });
  await f.transaction(
    'delayed-main-probes',
    { _handler: precompose.precomposeWaiting },
    {
      projectId: f.projectId,
      receiptIds: [main.receipt.id],
      paths: ['unrelated'],
      cleanPass: true,
    },
  );
  const id = f.entries[0].state.id;
  assert.equal(JSON.parse(f.row(id).value).pending, null, 'formed groups retain their useful preparation');
  await f.execute(
    f
      .pending()
      .find(task => task.name === 'projectHostedFinishDriver:drive' && task.args[0].submissionId === id),
  );
  assert.equal(JSON.parse(f.row(id).value).pending, null, 'the shared source owns useful preparation');
  assert.equal(f.metrics.sourceJobs, 0, 'no advisory source job is needed to prepare the train');
  assert(
    [...f.tables.projectHostedLandingBatches.values()].some(row => JSON.parse(row.value).uploadIndex > 0),
    'useful shared source metadata advances on this tick',
  );
  await drain(f);
  await f.passChecks();
  await drain(f);
  assert(states(f).every(state => state.phase === 'landed'));
});

test('an individual claim fences a probe on identical main bytes with a different receipt', async t => {
  const f = await batchesFixture(t, { count: 1, batching: false });
  await probe(f);
  const id = f.entries[0].state.id;
  const old = JSON.parse(f.row(id).value).pending;
  const main = f.moveMain({ sameHead: true });
  await f.execute(f.pending().find(task => task.name === 'projectHostedLandingDriver:drive'));
  const claimed = JSON.parse(f.row(id).value).pending;
  assert(claimed && !claimed.precompose);
  assert.notEqual(claimed.operations.compose, old.operations.compose);
  assert.deepEqual(claimed.main, { head: main.head, receiptId: main.receipt.id });
  await drain(f);
  assert.equal(states(f)[0].phase, 'checking');
  assert.equal(f.metrics.sourceJobs, 2);
  assert.equal(f.runs().length, 1);
  await f.passChecks();
  await drain(f);
  assert.equal(states(f)[0].phase, 'landed');
});

for (const outcome of ['clean', 'conflict'])
  test(`late ${outcome} probe completion and old IO cannot change claimed train ownership`, async t => {
    const f = await batchesFixture(t, { count: 2 });
    const main = f.moveMain();
    if (outcome === 'conflict') {
      const conflict = f.c.state(
        [...JSON.parse(f.c.objects.get(main.head)).files, f.c.file('member-0', 'competing main content')],
        [main.head],
      );
      f.c.register(conflict);
      f.patch('projectHostedChannels', f.mainId, {
        selection: JSON.stringify({ ...main, head: conflict.sha256 }),
      });
    }
    await f.transaction(
      'late-probe',
      { _handler: precompose.precomposeWaiting },
      {
        projectId: f.projectId,
        receiptIds: [main.receipt.id],
      },
    );
    const task = f.pending().find(task => task.name === 'projectHostedFinishDriver:drive');
    const command = JSON.parse(await f.transaction('old-plan-step', finishDriver.step, task.args[0]));
    assert.equal(command.kind, 'plan');
    const old = JSON.parse(f.row(f.entries[0].state.id).value).pending;
    // Submit the pinned old plan, then retain its exact IO callback for replay.
    f.c.objects.set(command.pin.sha256, Buffer.from(command.value));
    const object = [...f.tables.projectObjects.values()].find(row => row.digest === command.pin.sha256);
    const oldIO = { ...task.args[0], command: JSON.stringify(command), key: object.r2Key };
    await f.transaction('submit-old-plan', finishDriver.resume, oldIO);
    // Restore main before the useful train is composed; the old conflicting
    // generation must still publish its artifact without settling this member.
    f.moveMain();
    await f.execute(f.pending().find(task => task.name === 'projectHostedLandingDriver:drive'));
    const held = f.row(f.entries[0].state.id);
    assert.equal(JSON.parse(held.value).pending, null);
    const state = states(f)[0];
    assert(state.batchId);
    await f.transaction('late-old-plan', finishDriver.resume, oldIO);
    const isSource = task =>
      task.name.startsWith('projectConvexSource') || task.name === 'projectHostedComposeJobs:complete';
    let ticks = 0;
    while (f.pending().some(isSource)) {
      assert(++ticks < 100);
      await f.execute(f.pending().find(isSource));
    }
    assert.equal(f.row(state.id).value, held.value, 'late result cannot reattach the old finish');
    assert.equal(states(f)[0].attemptId, state.attemptId);
    assert.equal(states(f)[0].error, null);
    assert.equal(f.tables.projectHostedAcceptances.size, 0, 'advisory completion never publishes main');
    assert.equal(f.runs().length, 0, 'the useful exact check has not started yet');
    const source = [...f.tables.projectHostedComposes.values()].find(
      row => row.operationId === old.operations.compose,
    );
    assert.equal(JSON.parse(source.value).status, 'completed');
    if (outcome === 'conflict') assert(JSON.parse(source.value).conflictSummary.paths.includes('member-0'));
    await drain(f);
    await f.passChecks();
    await drain(f);
    assert(states(f).every(s => s.phase === 'landed'));
  });

test('failure of an adopted exact probe yields to ordinary source without failing the claim', async t => {
  const f = await batchesFixture(t, { count: 1, batching: false });
  const main = f.moveMain();
  await f.transaction(
    'reserve-failing-probe',
    { _handler: precompose.precomposeWaiting },
    {
      projectId: f.projectId,
      receiptIds: [main.receipt.id],
    },
  );
  await f.execute(f.pending().find(task => task.name === 'projectHostedLandingDriver:drive'));
  const identity = { projectId: f.projectId, submissionId: f.entries[0].state.id };
  const adopted = JSON.parse(f.row(identity.submissionId).value).pending;
  assert(adopted && !adopted.precompose);
  await f.transaction(
    'fail-adopted-probe',
    {
      _handler: async ctx => {
        const { value } = await finishStore.loadFinish(ctx, identity);
        const source = await finishCompose.prepareFinishCompose(ctx, identity, value);
        await operations.finishHostedOperation(ctx, {
          projectId: f.projectId,
          actor: source.row.actor,
          operationId: adopted.operations.compose,
          receipt: {
            attemptId: source.operation.firstAttempt.id,
            at: source.operation.firstAttempt.at,
            outcome: {
              status: 'failed',
              error: { code: 'SOURCE_WORKER_UNAVAILABLE', message: 'synthetic failed advisory probe' },
            },
          },
        });
      },
    },
    {},
  );
  await drain(f);
  assert.equal(states(f)[0].phase, 'checking');
  assert.equal(states(f)[0].error, null);
  assert.equal(f.metrics.sourceJobs, 1, 'one fresh ordinary source job');
  await f.passChecks();
  await drain(f);
  assert.equal(states(f)[0].phase, 'landed');
});
