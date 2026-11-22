// SPDX-License-Identifier: Apache-2.0
// Issue ced8e98f follow-ups (receipt a58539d0, lead live check 8866a6ed): the attempt-ledger writers.
// Each test fails when its writer is removed.
// 1. A protected-review park records the holder it waits for (`orderWaits`), typed `approved-check`.
// 2. A cohort platform retry that recomposes on a moved main installs `provider-retry` with the retired run.
// 3. Every writer that retires or censors an attempt records its cause (table), and a new retiring
//    call site fails the build until it has a row here.
// 4. Hold edges name a type for every hold kind; receipts from before the stamp read `unrecorded`.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { finishFixture } from './hosted-finish-fixture.mjs';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';

const api = await import(moduleUrl('../convex/projectHostedLandingAttemptHistory.ts'));
const { advanceLandingQueue } = await import(moduleUrl('../convex/projectHostedLandingControl.ts'));
const store = await import(moduleUrl('../convex/projectHostedLandingStore.ts'));
const finishStore = await import(moduleUrl('../convex/projectHostedFinishStore.ts'));
const admission = await import(moduleUrl('../convex/projectHostedLandingAdmission.ts'));
const staleChecks = await import(moduleUrl('../convex/projectHostedLandingStaleChecks.ts'));
const laneFinish = await import(moduleUrl('../convex/projectHostedLaneFinish.ts'));
const landingApi = await import(moduleUrl('../convex/projectHostedLanding.ts'));
const park = await import(moduleUrl('../convex/projectHostedLandingParkExact.ts'));
const { exhaustLanding } = await import(moduleUrl('../convex/projectHostedLandingExhaust.ts'));
const { reserveFinishRetry } = await import(moduleUrl('../convex/projectHostedFinishCompose.ts'));
const { replayHoldEdges } = await import(moduleUrl('../convex/projectHostedLandingReplay.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const read = (f, submissionId) =>
  f.tx('attempt-history', api.read, { projectId: f.projectId, submissionId }).then(JSON.parse);
const rowOf = (f, submissionId) =>
  [...f.tables.projectHostedLandingRequests.values()].find(row => row.submissionId === submissionId);

test('a protected-review park records the approved check it waits for, so the history names the holder', async t => {
  const f = await finishFixture(t);
  const holder = await f.enqueue(f.request({ check: null, message: 'Holds the approved-check turn' }));
  const waiter = await f.enqueue(f.request({ check: null, message: 'Protected review parked behind it' }));
  const waiterRow = rowOf(f, waiter.id);
  const attemptRow = [...f.tables.projectHostedLandingAttempts.values()].find(
    row => row.submissionId === waiter.id,
  );
  // The approved holder owns the publication turn; the waiter is an owner-approved entry whose
  // check is deferred. Its queue lease is real, so the park runs through the controller's advance.
  const queueRow = [...f.tables.projectHostedLandingQueues.values()][0];
  f.patch('projectHostedLandingRequests', rowOf(f, holder.id)._id, { exactReview: true });
  f.patch('projectHostedLandingRequests', waiterRow._id, { earlyReview: true });
  f.patch('projectHostedLandingAttempts', attemptRow._id, {
    value: JSON.stringify({ ...JSON.parse(attemptRow.value), deferredCheck: true }),
  });
  f.patch('projectHostedLandingQueues', queueRow._id, {
    exactReview: holder.id,
    lease: {
      owner: 'synthetic-owner',
      token: 1,
      until: f.now() + 60_000,
      submissionId: waiter.id,
      attemptId: waiterRow.attemptId,
    },
  });
  const claim = {
    projectId: f.projectId,
    channel: waiterRow.channel,
    owner: 'synthetic-owner',
    token: 1,
    submissionId: waiter.id,
    attemptId: waiterRow.attemptId,
  };
  const parked = await f.transaction(
    'park-protected-review',
    { _handler: ctx => advanceLandingQueue(ctx, claim, f.now()) },
    {},
  );
  assert.equal(parked.id, waiter.id, 'the controller advance parked the waiter');
  const waits = rowOf(f, waiter.id).orderWaits;
  assert.equal(waits?.length, 1, 'the park keeps one wait record, as the claim path does');
  assert.equal(waits[0].submissionId, holder.id);
  assert.equal(waits[0].held, 'approved-check');
  assert.equal(rowOf(f, waiter.id).orderWait, holder.id);
  assert.equal(rowOf(f, holder.id).orderWaited, true, 'the holder is marked as waited for');
  const history = await read(f, waiter.id);
  assert.equal(history.holdEdges.length, 1, 'the history lists the hold, not unrecorded');
  assert.equal(history.holdEdges[0].holderSubmissionId, holder.id);
  assert.equal(history.holdEdges[0].edgeType, 'approved-check', 'the hold kind types an unread footprint');
});

test('a cohort platform retry on a moved main installs provider-retry linked to the retired run', async t => {
  const f = await batchesFixture(t, { count: 3, batching: 'default', batchMaxSize: null });
  for (let steps = 0; f.pending().length; steps++) {
    assert(steps < 400, 'bounded queue progress');
    await f.execute(f.pending()[0]);
  }
  const [head] = f.runs();
  assert.equal(f.runs().length, 1, 'one shared cohort check');
  const members = states(f).map(state => ({ id: state.id, attemptId: state.attemptId }));
  assert.equal(members.length, 3, 'every fixture member shares the check');
  const attemptValue = id =>
    [...f.tables.projectHostedLandingAttempts.values()]
      .map(row => JSON.parse(row.value))
      .find(attempt => attempt.id === id);
  for (const member of members)
    assert.equal(
      attemptValue(member.attemptId)?.check?.runId,
      head.id,
      'each member attempt is bound to the shared run before the retry',
    );
  const live = await f.rawChecks.activate(head.id);
  const moved = f.moveMain();
  await f.rawChecks.callback(f.rawChecks.complete(live, 'runner-unavailable'));
  for (let steps = 0; f.pending().length; steps++) {
    assert(steps < 400, 'bounded queue progress');
    await f.execute(f.pending()[0]);
  }
  const retry = f.runs().find(run => run.id !== head.id);
  assert.ok(retry, 'the cohort rechecks on the moved main');
  assert.equal(retry.candidate.base.head, moved.head, 'the retry is composed on the moved main');
  for (const member of members) {
    const attempts = (await read(f, member.id)).attempts;
    const retired = attempts.find(attempt => attempt.id === member.attemptId);
    assert.ok(retired, 'the retired attempt stays in the history');
    assert.equal(retired.replay.outcome, 'censored');
    assert.deepEqual(
      retired.replay.replacementCause,
      { kind: 'provider-retry', link: head.id },
      'a platform retry links the retired run, not check-binding',
    );
  }
});

const tx = (f, name, handler) => f.transaction(name, { _handler: handler }, {});
const keyOf = (f, submissionId) => ({ projectId: f.projectId, submissionId });
const pinOf = (ctx, f, attemptId) => store.loadLandingAttempt(ctx, { projectId: f.projectId, attemptId });
const syntheticProof = () => ({
  runId: randomUUID(),
  checkId: randomUUID(),
  definition: 'd'.repeat(64),
  configuration: 'c'.repeat(64),
  environment: 'e'.repeat(64),
});
async function bindProof(ctx, f, key, proof) {
  const selected = await store.loadLanding(ctx, key);
  const attempt = await pinOf(ctx, f, selected.state.attemptId);
  await admission.bindAdmissionProof(ctx, { ...selected, attempt }, attempt, proof);
  return attempt.id;
}
async function retry(f, key, { main, cause, code } = {}) {
  let attemptId;
  await tx(f, 'finish-retry', async ctx => {
    attemptId = (await store.loadLanding(ctx, key)).state.attemptId;
    const finish = await finishStore.loadFinish(ctx, key);
    await reserveFinishRetry(ctx, finish.row, finish.value, code, undefined, main, cause);
  });
  return attemptId;
}
async function parkDrained(f, key, as) {
  const run = f.runs()[0];
  let attemptId;
  await tx(f, 'park-member', async ctx => {
    const entry = await store.loadLanding(ctx, key);
    attemptId = entry.state.attemptId;
    await park.parkEntry(ctx, entry, run, await pinOf(ctx, f, entry.state.firstAttemptId), as);
  });
  return { attemptId, run };
}
const finishEntry = async t => {
  const f = await finishFixture(t);
  return { f, key: keyOf(f, (await f.enqueue(f.request({ check: null }))).id) };
};
const drainedEntry = async t => {
  const f = await batchesFixture(t, { count: 2 });
  await f.drain();
  return { f, key: keyOf(f, f.entries[0].state.id) };
};

// Every convex writer that forks a replacement attempt or cancels an entry, with the cause it
// records. `drive` runs the real writer and returns the attempt it retired and the expected cause.
// A writer without `drive` passes a literal cause the type checker requires; `why` says where.
const WRITERS = [
  {
    file: 'projectHostedLandingAdmission.ts',
    case: 'a held admission proof binds without a recheck',
    setup: finishEntry,
    async drive({ f, key }) {
      const proof = syntheticProof();
      let attemptId;
      await tx(f, 'bind-proof', async ctx => (attemptId = await bindProof(ctx, f, key, proof)));
      return { attemptId, cause: { kind: 'check-binding', link: proof.runId } };
    },
  },
  {
    file: 'projectHostedLandingStaleChecks.ts',
    case: 'a solo check on an older main retires under the mover',
    setup: finishEntry,
    async drive({ f, key }) {
      const raced = { head: 'f'.repeat(64), receipt: { id: randomUUID() } };
      let attemptId;
      await tx(f, 'retire-solo-check', async ctx => {
        await bindProof(ctx, f, key, syntheticProof());
        const current = await store.loadLanding(ctx, key);
        attemptId = current.state.attemptId;
        await staleChecks.retireSoloCheck(ctx, {
          ...current,
          attempt: await pinOf(ctx, f, attemptId),
          finish: await finishStore.loadFinish(ctx, key),
          main: raced,
        });
      });
      return { attemptId, cause: { kind: 'main-race', link: raced.receipt.id } };
    },
  },
  {
    file: 'projectHostedFinishCompose.ts',
    case: 'a finish retry on a moved main names the mover',
    setup: finishEntry,
    async drive({ f, key }) {
      const main = { head: 'b'.repeat(64), receipt: { id: randomUUID() } };
      return {
        attemptId: await retry(f, key, { main }),
        cause: { kind: 'main-race', link: main.receipt.id },
      };
    },
  },
  {
    file: 'projectHostedFinishCompose.ts',
    case: "a finish retry keeps its caller's named cause (a policy change)",
    setup: finishEntry,
    async drive({ f, key }) {
      const cause = { kind: 'policy', link: 'p'.repeat(64) };
      return { attemptId: await retry(f, key, { cause }), cause };
    },
  },
  {
    file: 'projectHostedFinishCompose.ts',
    case: 'a same-main finish retry with no named cause records unknown with the writer and code',
    setup: finishEntry,
    async drive({ f, key }) {
      return {
        attemptId: await retry(f, key, { code: 'BATCH_FALLBACK' }),
        cause: { kind: 'unknown', link: 'finish-retry:BATCH_FALLBACK' },
      };
    },
  },
  {
    file: 'projectHostedLandingParkExact.ts',
    case: 'a main-red park names its audit',
    setup: drainedEntry,
    async drive({ f, key }) {
      const as = { hold: 'main-red', error: { code: 'MAIN_RED', message: 'red' }, auditRunId: randomUUID() };
      return { ...(await parkDrained(f, key, as)), cause: { kind: 'audit', link: as.auditRunId } };
    },
  },
  {
    file: 'projectHostedLandingParkExact.ts',
    case: 'a CI-down park names the run the provider could not serve',
    setup: drainedEntry,
    async drive({ f, key }) {
      const parked = await parkDrained(f, key, {
        hold: 'ci-down',
        error: { code: 'CI_DOWN', message: 'down' },
      });
      return { attemptId: parked.attemptId, cause: { kind: 'provider-retry', link: parked.run.id } };
    },
  },
  {
    file: 'projectHostedLaneFinish.ts',
    case: "a new save of the author's Lane supersedes the entry",
    setup: finishEntry,
    async drive({ f, key }) {
      const head = '7'.repeat(64);
      let attemptId;
      await tx(f, 'supersede-by-save', async ctx => {
        attemptId = (await store.loadLanding(ctx, key)).state.attemptId;
        await laneFinish.supersedeLaneFinishes(ctx, {
          projectId: f.projectId,
          laneId: randomUUID(),
          head,
          submissionIds: [key.submissionId],
          scope: 'live',
        });
      });
      return { attemptId, cause: { kind: 'new-save', link: head } };
    },
  },
  {
    file: 'projectHostedLanding.ts',
    case: 'an operator cancel ends the entry with nothing replacing it',
    setup: finishEntry,
    async drive({ f, key }) {
      const { attemptId } = [...f.tables.projectHostedLandingRequests.values()].find(
        row => row.submissionId === key.submissionId,
      );
      await f.tx('operator-cancel', landingApi.cancel, {
        projectId: f.projectId,
        request: JSON.stringify({
          operationId: randomUUID(),
          authorityEpoch: 1,
          submissionId: key.submissionId,
        }),
      });
      return { attemptId, cause: { kind: 'cancelled', link: 'operator-cancel' } };
    },
  },
  {
    file: 'projectHostedLandingExhaust.ts',
    case: 'the landing supervisor gives up on the entry',
    setup: finishEntry,
    async drive({ f, key }) {
      let attemptId;
      await tx(f, 'exhaust', async ctx => {
        const { state } = await store.loadLanding(ctx, key);
        attemptId = state.attemptId;
        await exhaustLanding(ctx, state, 'The landing supervisor gave up.');
      });
      // A driver budget ending is a Forge failure, not a censored attempt; it still names its path.
      return { attemptId, cause: { kind: 'cancelled', link: 'driver-exhausted' }, outcome: 'failed' };
    },
  },
  // Reached by their own replays; their causes are literals the required parameter enforces.
  { file: 'projectHostedLandingBatchStore.ts', why: 'cohort pin: the platform-retry test above' },
  { file: 'projectHostedLandingBatchConflict.ts', why: 'conflict: hosted-speculative-conflict' },
  {
    file: 'projectHostedLandingPipelineInvalidation.ts',
    why: "pair-interaction: the pinned predecessor's id",
  },
  { file: 'projectHostedLandingStall.ts', why: "cancelled 'stall-drop'" },
  { file: 'projectHostedLandingWithdraw.ts', why: "cancelled 'withdraw'" },
  { file: 'projectHostedLifecycleCancel.ts', why: "cancelled 'lifecycle-abandon'" },
  { file: 'projectHostedBatchAbandon.ts', why: "cancelled 'lifecycle-abandon'" },
  { file: 'projectHostedOwnerReview.ts', why: "cancelled 'review-declined'" },
  { file: 'projectHostedCulprit.ts', why: "audit: the red episode's failed re-check run" },
];

for (const writer of WRITERS.filter(writer => writer.drive))
  test(`ced8e98f writer ${writer.file}: ${writer.case}`, async t => {
    const context = await writer.setup(t);
    const { attemptId, cause, outcome = 'censored' } = await writer.drive(context);
    const history = await read(context.f, context.key.submissionId);
    const retired = history.attempts.find(attempt => attempt.id === attemptId);
    assert.ok(retired, 'the retired attempt stays in the history');
    assert.equal(retired.replay.outcome, outcome);
    assert.deepEqual(retired.replay.replacementCause, cause);
  });

test('a replacement no writer forked in the same invocation still records a countable unknown cause', async t => {
  const { f, key } = await finishEntry(t);
  let attemptId;
  await tx(f, 'unforked-retire', async ctx => {
    const { state } = await store.loadLanding(ctx, key);
    attemptId = state.attemptId;
    await store.retainLandingProgress(ctx, state, true);
  });
  const retired = (await read(f, key.submissionId)).attempts.find(attempt => attempt.id === attemptId);
  assert.deepEqual(retired.replay.replacementCause, { kind: 'unknown', link: 'retain:ATTEMPT_REPLACED' });
});

test('every convex call site that forks a replacement or cancels an entry has a writer row', () => {
  const callers = readdirSync(new URL('../convex/', import.meta.url))
    .filter(name => name.endsWith('.ts'))
    .filter(name => {
      const source = readFileSync(new URL(`../convex/${name}`, import.meta.url), 'utf8');
      const forks = /\bforkLandingAttempt\(/.test(
        source.replace(/export async function forkLandingAttempt\(/, ''),
      );
      const cancels = /\bcancelHostedLanding\(/.test(
        source.replace(/export async function cancelHostedLanding\(/, ''),
      );
      return forks || cancels;
    })
    .sort();
  const listed = [...new Set(WRITERS.map(writer => writer.file))].sort();
  assert.deepEqual(
    listed,
    callers,
    'add a row (a driven case, or the literal cause) for each new retiring writer',
  );
});

test('hold edges type every hold kind once stamped; an unstamped receipt invents none', () => {
  const wait = (held, footprints) => [{ submissionId: 'holder', held, footprints, seconds: 3 }];
  const stamped = [{ holdEdges: 'recorded' }];
  for (const held of ['approved-check', 'combined', 'handed', 'reserved', 'composing', 'accepting']) {
    assert.equal(replayHoldEdges(wait(held, 'unknown'), stamped)[0].edgeType, held);
    assert.equal(replayHoldEdges(wait(held, 'unknown'), [])[0].edgeType, 'unrecorded');
    for (const footprints of ['overlap', 'disjoint'])
      assert.equal(replayHoldEdges(wait(held, footprints), [])[0].edgeType, footprints);
  }
  assert.equal(replayHoldEdges(wait('dependent', 'unknown'), [])[0].edgeType, 'dependent');
  assert.equal(replayHoldEdges(undefined, stamped), 'none');
  assert.equal(replayHoldEdges(undefined, [{ holdEdges: 'none' }]), 'none');
  assert.equal(replayHoldEdges(undefined, [undefined]), 'unrecorded');
});

test('a cohort member that was handed a hold lands stamped recorded, so history and receipt type the handoff', async t => {
  const f = await batchesFixture(t, { count: 2 });
  const [first, second] = f.entries.map(entry => entry.state.id);
  f.patch('projectHostedLandingRequests', rowOf(f, second)._id, {
    orderHandoffs: [
      {
        submissionId: first,
        handedFrom: randomUUID(),
        startedAt: f.now(),
        holderPhase: 'checking',
        generation: 'g1',
      },
    ],
  });
  await f.drain();
  await f.passChecks();
  await f.drain();
  const landed = states(f).find(state => state.id === second);
  assert.equal(landed.phase, 'landed', 'the cohort published the member');
  const attempt = [...f.tables.projectHostedLandingAttempts.values()].find(
    row => row.attemptId === landed.attemptId,
  );
  assert.equal(attempt.replay?.holdEdges, 'recorded', 'the cohort publish stamps a handed member');
  const history = await read(f, second);
  assert.deepEqual(
    history.holdEdges.map(edge => [edge.holderSubmissionId, edge.edgeType]),
    [[first, 'handed']],
  );
});

test('a cancelled entry keeps its typed hold, and a recompose cancelled before install names its cause', async t => {
  const f = await finishFixture(t);
  const holder = await f.enqueue(f.request({ check: null, message: 'Holder' }));
  const waiter = await f.enqueue(f.request({ check: null, message: 'Waiter' }));
  const key = keyOf(f, waiter.id);
  f.patch('projectHostedLandingRequests', rowOf(f, waiter.id)._id, {
    orderWaits: [{ submissionId: holder.id, held: 'approved-check', footprints: 'unknown', at: f.now() }],
  });
  await retry(f, key, { main: { head: 'c'.repeat(64), receipt: { id: randomUUID() } } });
  await f.tx('operator-cancel', landingApi.cancel, {
    projectId: f.projectId,
    request: JSON.stringify({ operationId: randomUUID(), authorityEpoch: 1, submissionId: waiter.id }),
  });
  const history = await read(f, waiter.id);
  assert.equal(history.holdEdges[0].edgeType, 'approved-check', 'the terminal write stamps the ended entry');
  const reserved = history.attempts.find(attempt => attempt.reserved);
  assert.ok(reserved, 'the reserved recompose is the current attempt');
  assert.equal(reserved.replay.outcome, 'censored');
  assert.deepEqual(reserved.replay.replacementCause, { kind: 'cancelled', link: 'operator-cancel' });
});

test('a check cancelled with nothing replacing it records a cancelled cause', async t => {
  const { f, key } = await finishEntry(t);
  let attemptId;
  await tx(f, 'cancelled-check-ends-entry', async ctx => {
    const { row, state } = await store.loadLanding(ctx, key);
    attemptId = state.attemptId;
    await store.writeLanding(
      ctx,
      row,
      {
        ...state,
        version: state.version + 1,
        phase: 'terminal-failed',
        error: { code: 'CHECK_FAILED', message: 'The check was cancelled.' },
      },
      false,
      true,
      undefined,
      { replay: { check: { runId: randomUUID(), stop: 'CHECK_CANCELLED' } } },
    );
  });
  const retired = (await read(f, key.submissionId)).attempts.find(attempt => attempt.id === attemptId);
  assert.equal(retired.replay.censorReason, 'CHECK_CANCELLED');
  assert.deepEqual(retired.replay.replacementCause, { kind: 'cancelled', link: 'check-cancelled' });
});
