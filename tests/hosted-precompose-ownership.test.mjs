// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { observerProjectionBudget } from './observer-projection-budget.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { batchesFixture, synthetic, states } from './hosted-landing-batches-fixture.mjs';
import { isFinishWake, runFinishWake } from './hosted-finish-fixture.mjs';
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
  await runFinishWake(
    f,
    f.pending().find(task => isFinishWake(task.name)),
  );
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
    // Reads 1341 -> 1343 (0b12fcfe): one overlap-row read per open sibling at the landing, to see whether
    // it already landed at its head (landed siblings no longer hold the Intent open). Calls and writes unchanged.
    // Reads 1343 -> 1345 (8dfede85): one main path-history row read per landed receipt, to add the landing
    // to its 50-entry log for the drift nudge. Calls are unchanged.
    // Reads 1345 -> 1347, writes 412 -> 414 (45f49fb7): each of the 2 landings reads and rewrites the
    // project's landing-speed row (regression ladder rung 1) in its own accept mutation. Calls are unchanged.
    // Reads 1347 -> 1349 (ee9d5738): each of the 2 landing completion ticks reads one (empty) indexed range of
    // open overlap rows that predate lastActivityAt, to stamp them from their Lane record. Calls and writes unchanged.
    // Reads 1349 -> 1351 (435c7c2f): each of the 2 new operation receipts first looks, through one indexed range,
    // for receipts older than 90 days to delete; nothing is expired here, so no document is read. Calls and writes unchanged.
    // Reads 1351 -> 1352 (10d253c6): a submission reads its Intent's previous landing (one indexed row, take 1) to
    // grant a landing reservation after a supersession; here the second landing finds the first. Calls and writes unchanged.
    // Reads 1352 -> 1354 (750c5929): each of the 2 completion ticks first point-reads the landing's main path log row
    // to name it. On a real deployment that row exists and replaces the 140 KB main-row read. This fixture has
    // neither row, so the main-row lookup stays as well. Calls and writes unchanged.
    // Reads 1354 -> 1364, writes 414 -> 446 (Item 9a04d916, compose settle; owner-approved
    // +$0.02/1k): each finish wake with no IO in flight is the settle mutation, and a step that needs IO hands it to one drive action (an acceptance page or cohort plan steps once more there). Calls stay under their ceiling.
    // Writes 446 -> 448: the always-on S1 writer (b149b16b, merged from main) arms one capsule wake per landed member; no call or read.
    // Reads 1364 -> 1370, writes 448 -> 454: source repair wakes (e62d834b, review 308f217c): each scheduled source step arms a wake at its lease end that its commit cancels (a scheduler insert, a status read and a cancel), and a job that fails or is cancelled outside a commit reads its step row to cancel any wake left; no call.
    // Calls 69 -> 70 (under the ceiling), reads 1370 -> 1371, writes 454 -> 455 (Item 85f456c1, batch truth gap): the
    // batch's first landing of the hour schedules the person-order touch single landings already schedule (scheduler
    // write, run and its read). Summary and mark I/O are projection I/O, outside these source counts.
    // Reads 1371 -> 1369 (Item c0af6cfa): the per-completion range read of overlap rows with no lastActivityAt is gone
    // (2 completion ticks). Calls and writes unchanged.
    assert(
      budget.calls <= 71 &&
        source.reduce((n, c) => n + c.documents, 0) <= 1369 &&
        source.reduce((n, c) => n + c.writes, 0) <= 455,
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
  await runFinishWake(
    f,
    f.pending().find(task => isFinishWake(task.name) && task.args[0].submissionId === id),
  );
  assert.equal(JSON.parse(f.row(id).value).pending, null, 'the shared source owns useful preparation');
  assert.equal(f.metrics.sourceJobs, 0, 'no advisory source job is needed to prepare the train');
  const batch = [...f.tables.projectHostedLandingBatches.values()].map(row => JSON.parse(row.value))[0];
  assert.equal(batch.uploadIndex, batch.uploads.length, 'the shared finish wake makes all metadata ready');
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
    const task = f.pending().find(task => isFinishWake(task.name));
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
      task.name.startsWith('projectConvexSource') ||
      /^projectHostedComposeJobs:(complete|publish)$/.test(task.name);
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

test('1dd4e095: a client operation using the Candidate UUID cannot collide with its derived source job', async t => {
  const { hostedPayloadHash } = await import('../dist/hosted-source-operation.js');
  const f = await batchesFixture(t, { count: 1, batching: false });
  await probe(f);
  const identity = { projectId: f.projectId, submissionId: f.entries[0].state.id };
  await f.transaction(
    'candidate-operation-namespace',
    {
      _handler: async ctx => {
        const { value } = await finishStore.loadFinish(ctx, identity);
        const source = await finishCompose.prepareFinishCompose(ctx, identity, value);
        assert.notEqual(source.state.jobOperationId, source.state.candidateId);
        const replay = await finishCompose.prepareFinishCompose(ctx, identity, value);
        assert.equal(
          replay.state.jobOperationId,
          source.state.jobOperationId,
          'retry keeps the original source identity',
        );
        const payload = { synthetic: 'client operation' };
        const expected = source.operation.expected;
        await operations.beginHostedOperation(ctx, {
          projectId: f.projectId,
          actor: source.row.actor,
          payload,
          request: {
            schema: 1,
            projectId: f.projectId,
            actor: source.row.actor,
            operationId: source.state.candidateId,
            expected,
            payloadHash: hostedPayloadHash(payload, expected),
          },
          firstAttempt: { ...source.operation.firstAttempt, operationId: source.state.candidateId },
        });
      },
    },
    {},
  );
  await drain(f);
  await f.passChecks();
  await drain(f);
  assert.equal(states(f)[0].phase, 'landed');
});
