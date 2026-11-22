// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { hostedAgentCli } from '../dist/hosted-agent-cli.js';
import { cliReplyLines } from '../dist/cli-reply-lines.js';
import { slimReceipt } from '../dist/receipt-slim.js';
import { agentFixture } from './hosted-agent-fixture.mjs';
import { finishFixture, desired, code } from './hosted-finish-fixture.mjs';
import { batchStore, batchesFixture, synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';

const api = await import(moduleUrl('../convex/projectHostedLandingAttemptHistory.ts'));
const finishStore = await import(moduleUrl('../convex/projectHostedFinishStore.ts'));
const store = await import(moduleUrl('../convex/projectHostedLandingStore.ts'));
const park = await import(moduleUrl('../convex/projectHostedLandingParkExact.ts'));
const { reserveFinishRetry } = await import(moduleUrl('../convex/projectHostedFinishCompose.ts'));
const { checkReplay } = await import(moduleUrl('../convex/projectHostedLandingReplay.ts'));
const { markCheckDispatch, observeCheckStart, observeCheckEnd } = await import(
  moduleUrl('../convex/projectHostedCheckClock.ts')
);
const landingApi = await import(moduleUrl('../convex/projectHostedLanding.ts'));
const admission = await import(moduleUrl('../convex/projectHostedLandingAdmission.ts'));
const staleChecks = await import(moduleUrl('../convex/projectHostedLandingStaleChecks.ts'));
const laneFinish = await import(moduleUrl('../convex/projectHostedLaneFinish.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const iso = time => `2026-11-20T${time}:00.000Z`;
const attemptRow = (f, submissionId) =>
  [...f.tables.projectHostedLandingAttempts.values()].find(row => row.submissionId === submissionId);
const read = (f, submissionId, args = {}, actor) =>
  f.tx('attempt-history', api.read, { projectId: f.projectId, submissionId, ...args }, actor);

test('incident replay e62d834b (d52e034f): the CLI explains a main-race landing still composing after 313 minutes', async t => {
  const f = await finishFixture(t, { startAt: Date.parse(iso('09:18')) });
  const state = await f.enqueue(f.request({ check: null }));
  const prior = attemptRow(f, state.id);
  const earliest = JSON.parse(prior.value);
  const { id, number } = earliest;
  const move = {
    code: 'CHANNEL_CHANGED',
    message: 'Main changed. Diagnostic https://forge.invalid/check?token=synthetic-secret',
  };
  f.patch('projectHostedLandingAttempts', prior._id, {
    value: JSON.stringify({ ...earliest, at: iso('04:00') }),
    progress: JSON.stringify({
      phase: 'terminal-failed',
      observation: { state: 'terminal-failed', pendingReason: null, cause: 'stale-head' },
      timing: {
        submittedAt: iso('04:00'),
        composeStartedAt: iso('04:00'),
        composedAt: iso('04:01'),
        selectedAt: iso('04:03'),
        settledAt: iso('04:05'),
      },
      error: move,
      acceptance: null,
      version: 1,
      settled: true,
    }),
  });
  const finish = f.row(state.id);
  const pending = {
    id: randomUUID(),
    parentAttemptId: id,
    number: number + 1,
    at: iso('04:05'),
    main: { head: 'b'.repeat(64), receiptId: randomUUID() },
    operations: { compose: randomUUID(), check: randomUUID(), accept: randomUUID() },
  };
  f.patch('projectHostedFinishes', finish._id, {
    value: JSON.stringify({ ...JSON.parse(finish.value), pending }),
  });
  const jobId = randomUUID();
  f.insert('projectHostedComposes', {
    projectId: f.projectId,
    actor: state.actor,
    operationId: pending.operations.compose,
    jobId,
    value: '{}',
  });
  f.insert('projectSourceSteps', {
    projectId: f.projectId,
    jobId,
    dispatch: 'synthetic',
    executionId: 'synthetic',
    step: 1,
    cursor: null,
    failedAttempts: 2,
    lastFailureAt: Date.parse(iso('04:07')),
    lastFailure: {
      stage: 'step',
      exception: 'ForgeError',
      code: 'SOURCE_JOB_FENCED',
      elapsedMs: 60_200,
      httpStatus: null,
    },
  });
  const cli = agentFixture(t);
  const transport = cli.transport();
  const queries = [];
  let wire;
  transport.query = async (name, input) => {
    queries.push(name);
    wire = await read(f, input.submissionId);
    return JSON.parse(wire);
  };
  const result = slimReceipt(
    await hostedAgentCli(cli.root, 'queue', { submissionId: state.id }, cli.address, transport),
  );
  assert.deepEqual(queries, ['projectHostedLandingAttemptHistory:read']);
  const { attempts, currentAttemptId, nextBeforeAttempt } = result.result;
  assert.equal(currentAttemptId, pending.id);
  assert.equal(nextBeforeAttempt, null);
  assert.deepEqual(
    attempts.map(a => [a.id, a.current, a.phase]),
    [
      [pending.id, true, 'composing'],
      [id, false, 'terminal-failed'],
    ],
  );
  assert.deepEqual(attempts[0].periods, [
    { phase: 'composing', startedAt: iso('04:05'), elapsedMs: 313 * 60_000 },
  ]);
  assert.equal(attempts[0].sourceFailure.code, 'SOURCE_JOB_FENCED');
  assert.equal(attempts[0].sourceFailure.elapsedMs, 60_200);
  assert.equal(attempts[0].runId, undefined);
  assert.deepEqual(
    attempts[1].periods.map(({ phase, elapsedMs }) => [phase, elapsedMs]),
    [
      ['composing', 60_000],
      ['queued', 120_000],
    ],
  );
  assert.equal(attempts[1].cause.code, 'CHANNEL_CHANGED');
  assert.equal(attempts[1].replay.dispatchedAt, 'unrecorded');
  assert.equal(attempts[1].replay.outcome, 'unrecorded');
  assert.match(attempts[1].cause.message, /Main changed/);
  assert.doesNotMatch(wire, /synthetic-secret/);
  const [current, earlier] = cliReplyLines(['agent', cli.root, 'queue'], result);
  assert.match(current, /Attempt 1 \(current\).*composing 313 min so far.*source step 1: SOURCE_JOB_FENCED/);
  assert.match(earlier, /Attempt 0.*queued 2 min.*CHANNEL_CHANGED/);
  const cost = f.counts.findLast(row => row.name === 'attempt-history');
  assert.equal(cost.writes, 0);
  assert.equal(cost.readDocumentsByTable.projectHostedLandingAttempts, 1);
  assert.equal(cost.readDocumentsByTable.projectSourceSteps, 1);
  assert(Buffer.byteLength(wire) < 64 * 1024);
  t.diagnostic(
    `Two-attempt replay: ${cost.documents} documents, ${cost.readBytes} DB bytes, ${Buffer.byteLength(wire)} reply bytes`,
  );

  await f.transaction(
    'fail-reserved-compose',
    {
      _handler: ctx =>
        finishStore.failFinish(
          ctx,
          { projectId: f.projectId, submissionId: state.id },
          'SOURCE_JOB_FENCED',
          'Source lease expired.',
        ),
    },
    {},
  );
  const failed = JSON.parse(await read(f, state.id));
  assert.equal(failed.currentAttemptId, pending.id);
  assert.equal(failed.attempts[0].phase, 'terminal-failed');
  assert.equal(failed.attempts[0].cause.code, 'SOURCE_JOB_FENCED');
  assert(failed.attempts[0].periods[0].endedAt, 'the failed reservation is no longer running');
  assert.equal(failed.attempts[1].cause.code, 'CHANNEL_CHANGED');
});

test('attempt replay records the mover and checked prefix, links a conflict recheck and censors a withdrawn follower', async t => {
  const f = await finishFixture(t, { startAt: Date.parse(iso('09:18')) });
  const first = await f.enqueue(f.request({ check: null }));
  const prior = JSON.parse(attemptRow(f, first.id).value);
  const prefix = { head: 'a'.repeat(64), receiptId: randomUUID() };
  const mover = { head: 'b'.repeat(64), receipt: { id: randomUUID() } };
  const run = {
    id: randomUUID(),
    status: 'passed',
    candidate: { base: prefix },
    endedAt: iso('09:23'),
  };
  markCheckDispatch(run, Date.parse(iso('09:19')));
  observeCheckStart(run, iso('09:21'));
  observeCheckEnd(run, iso('09:22'));
  const tx = (name, handler) => f.transaction(name, { _handler: handler }, {});
  await tx('replace-checked-attempt', async ctx => {
    const key = { projectId: f.projectId, submissionId: first.id };
    const { state } = await store.loadLanding(ctx, key);
    await store.retainLandingProgress(ctx, state, false, undefined, checkReplay(run));
    const finish = await finishStore.loadFinish(ctx, key);
    await reserveFinishRetry(ctx, finish.row, finish.value, undefined, undefined, mover);
  });
  const {
    attempts: [replacement, replaced],
  } = JSON.parse(await read(f, first.id));
  assert.deepEqual(replaced.replay, {
    attempt: prior.number,
    composedBase: prior.main,
    runId: run.id,
    predictedBase: prefix,
    actualBase: { head: mover.head, receiptId: mover.receipt.id },
    dispatchedAt: iso('09:19'),
    startedAt: iso('09:21'),
    endedAt: iso('09:22'),
    recordedEndAt: iso('09:23'),
    waitedToStartMs: 120_000,
    outcome: 'censored',
    censorReason: 'CHANNEL_CHANGED',
    replacementCause: { kind: 'main-race', link: mover.receipt.id },
    replacedByAttemptId: replacement.id,
    recheckCause: 'unrecorded',
  });

  const follower = await f.enqueue(f.request({ check: null, message: 'Follower with a conflicting prefix' }));
  const key = { projectId: f.projectId, submissionId: follower.id };
  const conflictBatch = randomUUID();
  await tx('recheck-exposed-conflict', async ctx => {
    const { row, state } = await store.loadLanding(ctx, key);
    const original = await store.loadLandingAttempt(ctx, {
      projectId: f.projectId,
      attemptId: state.attemptId,
    });
    const child = { ...original, ...(await store.forkLandingAttempt(ctx, state)) };
    await store.insertLandingAttempt(ctx, child);
    await store.writeLanding(
      ctx,
      row,
      { ...state, attemptId: child.id, version: state.version + 1 },
      false,
      true,
      undefined,
      { replacementReplay: { replacementCause: { kind: 'conflict', link: conflictBatch } } },
    );
    await ctx.db.patch(row._id, {
      orderWaits: [{ submissionId: first.id, held: 'dependent', footprints: 'overlap', seconds: 37 }],
    });
  });
  await f.tx('withdraw-follower', landingApi.cancel, {
    projectId: f.projectId,
    request: JSON.stringify({
      operationId: randomUUID(),
      authorityEpoch: 1,
      submissionId: follower.id,
    }),
  });
  const history = JSON.parse(await read(f, follower.id));
  assert.deepEqual(history.holdEdges, [
    { holderSubmissionId: first.id, edgeType: 'dependent', heldSeconds: 37 },
  ]);
  assert.deepEqual(history.attempts[1].replay.replacementCause, { kind: 'conflict', link: conflictBatch });
  assert.equal(history.attempts[0].replay.outcome, 'censored');
  assert.equal(history.attempts[0].replay.censorReason, 'LANDING_CANCELLED');
  assert.equal(history.attempts[0].replay.waitedToStartMs, 'unrecorded');

  // Lead live check 8866a6ed: 57 ATTEMPT_REPLACED and 3 CHANNEL_CHANGED attempts had no cause.
  // The admission proof's binding, then a retired solo check under a main race, each name theirs.
  const bound = await f.enqueue(
    f.request({ check: null, message: 'Admission proof binds, then main moves' }),
  );
  const boundKey = { projectId: f.projectId, submissionId: bound.id };
  const proof = {
    runId: randomUUID(),
    checkId: randomUUID(),
    definition: 'd'.repeat(64),
    configuration: 'c'.repeat(64),
    environment: 'e'.repeat(64),
  };
  const raced = { head: 'f'.repeat(64), receipt: { id: randomUUID() } };
  await tx('bind-proof-then-retire-on-race', async ctx => {
    const selected = await store.loadLanding(ctx, boundKey);
    const attempt = await store.loadLandingAttempt(ctx, {
      projectId: f.projectId,
      attemptId: selected.state.attemptId,
    });
    await admission.bindAdmissionProof(ctx, { ...selected, attempt }, attempt, proof);
    const current = await store.loadLanding(ctx, boundKey);
    await staleChecks.retireSoloCheck(ctx, {
      ...current,
      attempt: await store.loadLandingAttempt(ctx, {
        projectId: f.projectId,
        attemptId: current.state.attemptId,
      }),
      finish: await finishStore.loadFinish(ctx, boundKey),
      main: raced,
    });
  });
  const boundHistory = JSON.parse(await read(f, bound.id)).attempts.map(attempt => attempt.replay);
  // Newest first: the reserved recompose, the deferred fork, the bound proof, the admission attempt.
  assert.equal(boundHistory.length, 4);
  const [, deferred, boundProof, admitted] = boundHistory;
  assert.equal(admitted.censorReason, 'ATTEMPT_REPLACED');
  assert.deepEqual(admitted.replacementCause, { kind: 'check-binding', link: proof.runId });
  assert.equal(boundProof.censorReason, 'ATTEMPT_REPLACED');
  assert.deepEqual(boundProof.replacementCause, { kind: 'main-race', link: raced.receipt.id });
  assert.equal(deferred.censorReason, 'CHANNEL_CHANGED');
  assert.deepEqual(deferred.replacementCause, { kind: 'main-race', link: raced.receipt.id });

  // A child installed on a moved main with no named cause still names the mover (the 3 CHANNEL_CHANGED).
  const moved = await f.enqueue(f.request({ check: null, message: 'Recomposed on a moved main' }));
  const movedKey = { projectId: f.projectId, submissionId: moved.id };
  const movedMain = { head: '9'.repeat(64), receiptId: randomUUID() };
  await tx('install-on-moved-main', async ctx => {
    const { row, state } = await store.loadLanding(ctx, movedKey);
    const original = await store.loadLandingAttempt(ctx, {
      projectId: f.projectId,
      attemptId: state.attemptId,
    });
    const child = { ...original, ...(await store.forkLandingAttempt(ctx, state)), main: movedMain };
    await store.insertLandingAttempt(ctx, child);
    await store.writeLanding(ctx, row, { ...state, attemptId: child.id, version: state.version + 1 }, false);
  });
  const movedReplay = JSON.parse(await read(f, moved.id)).attempts.at(-1).replay;
  assert.equal(movedReplay.censorReason, 'CHANNEL_CHANGED');
  assert.deepEqual(movedReplay.replacementCause, { kind: 'main-race', link: movedMain.receiptId });

  // A new save of the author's Lane supersedes the entry: the censored attempt links that save.
  const saved = await f.enqueue(f.request({ check: null, message: 'Superseded by a new save' }));
  const savedHead = '7'.repeat(64);
  await tx('supersede-by-save', async ctx => {
    // The real save path, so the cause comes from the caller that knows it is a save.
    await laneFinish.supersedeLaneFinishes(ctx, {
      projectId: f.projectId,
      laneId: randomUUID(),
      head: savedHead,
      submissionIds: [saved.id],
      scope: 'live',
    });
  });
  const savedReplay = JSON.parse(await read(f, saved.id)).attempts[0].replay;
  assert.equal(savedReplay.censorReason, 'LANDING_SUPERSEDED');
  assert.deepEqual(savedReplay.replacementCause, { kind: 'new-save', link: savedHead });
});

test('a parked no-check child owns only the new queue interval, even when its parent carried check timestamps', async t => {
  const f = await batchesFixture(t, { count: 2 });
  await f.drain();
  const { id: submissionId } = f.entries[0].state;
  const key = { projectId: f.projectId, submissionId };
  const run = f.runs()[0];
  await f.transaction(
    'park-checked-member',
    {
      _handler: async ctx => {
        const entry = await store.loadLanding(ctx, key);
        await store.writeLanding(
          ctx,
          entry.row,
          {
            ...entry.state,
            version: entry.state.version + 1,
            timing: { submittedAt: entry.state.at, ...entry.state.timing, checkReservedAt: run.at },
          },
          false,
        );
        const current = await store.loadLanding(ctx, key);
        const original = await store.loadLandingAttempt(ctx, {
          projectId: f.projectId,
          attemptId: entry.state.firstAttemptId,
        });
        await park.parkEntry(ctx, current, run, original, {
          hold: 'main-red',
          error: { code: 'MAIN_RED', message: 'Waiting for main to pass.' },
        });
      },
    },
    {},
  );
  f.advanceClock(60_000);
  const {
    attempts: [current, parent],
  } = JSON.parse(await read(f, submissionId));
  assert.equal(current.phase, 'queued');
  assert.equal(current.cause.code, 'MAIN_RED');
  assert.equal(current.runId, undefined);
  assert.equal(parent.runId, run.id);
  assert.deepEqual(
    current.periods.map(period => [period.phase, period.endedAt]),
    [['queued', undefined]],
  );
});

test('shared recomposition shows an open compose interval when its member is still queued', async t => {
  const f = await batchesFixture(t, { count: 2 });
  await f.drain();
  const { id: submissionId } = f.entries[0].state;
  const { submission } = await f.current(submissionId);
  const key = { projectId: f.projectId, batchId: submission.batchId };
  await f.transaction(
    'shared-recompose',
    {
      _handler: async ctx => {
        const { batch } = await batchStore.loadBatch(ctx, key);
        await batchStore.retryLandingBatch(ctx, key, batch);
      },
    },
    {},
  );
  f.advanceClock(31_000);
  const {
    attempts: [current],
  } = JSON.parse(await read(f, submissionId));
  assert.equal(current.phase, 'composing');
  assert.deepEqual(
    current.periods.map(({ phase, elapsedMs }) => [phase, elapsedMs]),
    [['composing', 31_000]],
  );
});

test('landing attempt history shows a desired submission before its first attempt is installed', async t => {
  const f = await finishFixture(t);
  const composeOperationId = f.selection.request.operationId;
  const op = [...f.tables.projectHostedOperations.values()].find(
    row => row.operationId === composeOperationId,
  );
  f.patch('projectHostedOperations', op._id, {
    value: JSON.stringify({ ...JSON.parse(op.value), terminal: null }),
  });
  const state = JSON.parse(
    await f.tx('submit-desired', desired.submit, {
      projectId: f.projectId,
      request: JSON.stringify({
        operationId: randomUUID(),
        authorityEpoch: 1,
        composeOperationId,
        after: null,
        check: null,
      }),
    }),
  );
  const snapshot = JSON.parse(await read(f, state.id));
  assert.equal(snapshot.currentAttemptId, state.firstAttemptId);
  assert.deepEqual(
    snapshot.attempts.map(({ number, phase, reserved }) => [number, phase, reserved]),
    [[0, 'composing', true]],
  );
  assert.equal(snapshot.attempts[0].composeOperationId, composeOperationId);
  assert.equal(snapshot.attempts[0].sourceFailure, undefined);
});

test('landing attempt pages have a bounded read and keep legacy evidence and project access distinct', async t => {
  const f = await finishFixture(t);
  f.patch('hostedProjects', f.projectId, { visibility: 'private' });
  const state = await f.enqueue(f.request());
  const { _id, _creationTime, progress, ...base } = attemptRow(f, state.id);
  const first = JSON.parse(base.value);
  const request = [...f.tables.projectHostedLandingRequests.values()].find(
    row => row.submissionId === state.id,
  );
  let parentAttemptId = first.id;
  for (let number = 1; number <= 100; number++) {
    const id = randomUUID();
    f.insert('projectHostedLandingAttempts', {
      ...base,
      number,
      attemptId: id,
      value: JSON.stringify({ ...first, id, number, parentAttemptId }),
    });
    parentAttemptId = id;
  }
  f.patch('projectHostedLandingRequests', request._id, {
    attemptId: parentAttemptId,
    value: JSON.stringify({ ...JSON.parse(request.value), attemptId: parentAttemptId }),
  });
  const started = performance.now();
  const wire = await read(f, state.id);
  const elapsed = performance.now() - started;
  const page = JSON.parse(wire);
  assert.deepEqual(
    page.attempts.map(a => a.number),
    [100, 99, 98, 97, 96, 95, 94, 93],
  );
  assert.equal(page.attempts[0].current, true);
  assert.equal(page.attempts[1].phase, null, 'a legacy attempt cannot borrow current progress');
  assert.deepEqual(page.attempts[1].periods, []);
  assert.equal(page.attempts[1].cause, undefined);
  const cost = f.counts.findLast(row => row.name === 'attempt-history');
  assert.equal(cost.readDocumentsByTable.projectHostedLandingAttempts, 9);
  assert.equal(cost.writes, 0);
  assert(Buffer.byteLength(wire) < 64 * 1024);
  t.diagnostic(
    `101-attempt fixture: ${cost.documents} documents, ${cost.readBytes} DB bytes, ${Buffer.byteLength(wire)} reply bytes, ${elapsed.toFixed(1)} ms locally`,
  );
  const earlier = JSON.parse(await read(f, state.id, { beforeAttempt: page.nextBeforeAttempt }));
  assert.deepEqual(
    earlier.attempts.map(a => a.number),
    [92, 91, 90, 89, 88, 87, 86, 85],
  );
  assert.equal(earlier.currentAttemptId, page.currentAttemptId);
  assert.equal(
    earlier.attempts.some(a => a.current),
    false,
  );
  await assert.rejects(read(f, state.id, {}, 'outsider'), code('PROJECT_UNAVAILABLE'));
  await assert.rejects(read(f, randomUUID()), code('NOT_FOUND'));
});
