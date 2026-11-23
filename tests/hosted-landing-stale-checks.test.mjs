// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { auditWindow } from '../dist/landing-mode.js';
import { synthetic, states } from './hosted-landing-batches-fixture.mjs';
import {
  fixture,
  current,
  requestRow,
  finishRow,
  pendingTasks,
  drain,
  settle,
  assertProgressOwners,
} from './hosted-stale-check-fixture.mjs';
import { CHECK_WALL_MS, assertQueueProgress } from './queue-sim/invariants.mjs';
import { moduleUrl } from './convex-module.mjs';
const stale = await import(moduleUrl('../convex/projectHostedLandingStaleChecks.ts'));
const observe = await import(moduleUrl('../convex/projectHostedFinishObserve.ts'));
const completion = await import(moduleUrl('../convex/projectHostedAcceptanceCompletion.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// The O4 cancel-honours-fast switch is deleted (lead decision on 026ce0cf): a main move
// retires an overlapping or global-risk running check in every landing mode, and the Lane gets
// the ordinary exact recheck that holds queue order (incident replays 10d253c6, C1).
for (const { name, paths, mode = 'fast', breaker = false, person = false } of [
  { name: 'effective fast mode', paths: ['package.json', 'src/b.ts'] },
  { name: 'person in fast mode', paths: ['package.json', 'src/b.ts'], person: true },
  { name: 'strict mode', paths: ['package.json', 'src/b.ts'], mode: 'strict' },
  { name: 'open fast breaker', paths: ['package.json', 'src/b.ts'], breaker: true },
  { name: 'order-sensitive mover', paths: ['convex/schema.ts', 'src/b.ts'] },
  { name: 'overlapping code', paths: ['src/shared.ts', 'src/shared.ts'] },
])
  test(`main move: ${name} cancels the running check`, async t => {
    const f = await fixture(t, {
      memberPaths: paths,
      landingMode: mode,
      concurrency: 1,
      conflict: false,
      count: 0,
    });
    await f.add(0);
    await f.add(1, { request: person ? { agent: false } : {} });
    await drain(f);
    if (person) {
      const { attempt } = await f.status(current(f, 1).id);
      assert.equal(attempt.actor.kind, 'person');
    }
    const [a, b] = f.runs();
    await f.rawChecks.activate(b.id);
    await f.rawChecks.pass(await f.rawChecks.activate(a.id));
    await drain(f, task => task.name === 'projectHostedAcceptance:complete');
    if (breaker) {
      const red = { verdict: 'red', landings: 1 };
      const window = [red, red, red].reduce((slots, verdict) => auditWindow(slots, verdict), undefined);
      const audit = [...f.tables.projectHostedMainAudits.values()][0];
      if (audit) f.patch('projectHostedMainAudits', audit._id, { window });
      else f.insert('projectHostedMainAudits', { projectId: f.projectId, window });
    }
    await drain(f);
    assert.equal(current(f, 0).phase, 'landed');
    assert.equal(f.runs().find(run => run.id === b.id).status, 'cancelled');
    await settle(f);
    assert.equal(current(f, 1).phase, 'landed');
    assert.equal(f.runs().length, 3, 'one cancelled run plus the ordinary exact recheck');
    t.diagnostic(
      JSON.stringify({
        calls: f.counts.length,
        readBytes: f.counts.reduce((sum, cost) => sum + cost.readBytes, 0),
        writeBytes: f.counts.reduce((sum, cost) => sum + cost.writeBytes, 0),
      }),
    );
  });

for (const conflict of [true, false])
  test(`83e6d0d3: accepted overlap cancels its running admission and ${conflict ? 'delivers conflict without old CI' : 'starts a fresh exact check in the same queue position'}`, async t => {
    const f = await fixture(t, { conflict });
    const [a, b] = f.runs();
    const old = await f.rawChecks.activate(b.id);
    const original = current(f, 1);
    await f.rawChecks.pass(await f.rawChecks.activate(a.id));
    await drain(f, () => f.runs().find(r => r.id === b.id).status === 'cancelled');
    assert.equal(f.runs().find(r => r.id === b.id).status, 'cancelled');
    assert.equal(current(f, 0).phase, 'landed');
    assert.equal(current(f, 1).phase, 'queued');
    assert.equal(current(f, 1).sequence, original.sequence);
    assert.equal(current(f, 1).operationId, original.operationId);
    assert(finishRow(f, 1).wake, 'cancel transaction retains the replacement scheduler receipt');
    assert(JSON.parse(finishRow(f, 1).value).pending, 'replacement composition is reserved atomically');
    await assertProgressOwners(f);
    await assert.rejects(f.rawChecks.pass(old), e =>
      ['CHECK_CANCELLED', 'EVIDENCE_CHANGED'].includes(e.data?.code ?? e.code),
    );
    await drain(f);
    if (conflict) {
      assert.equal(current(f, 1).phase, 'terminal-failed');
      assert.equal(current(f, 1).error.code, 'COMPOSITION_CONFLICT');
      const page = JSON.parse(
        await f.transaction('stale-conflict-observe', observe.page, {
          projectId: f.projectId,
          operationId: original.operationId,
          nextVersion: 0,
        }),
      );
      assert.equal(page.submission.error.code, 'COMPOSITION_CONFLICT');
      assert.equal(f.runs().length, 2, 'no replacement check for a real conflict');
    } else {
      assert.equal(current(f, 1).phase, 'checking', 'fresh exact check starts without a further agent turn');
      const fresh = f.runs().find(r => r.status === 'queued');
      assert(fresh && fresh.id !== old.id);
      assert.equal(fresh.candidate.base.head, f.currentMain().head);
      assert.equal(fresh.candidate.base.receiptId, f.currentMain().receipt.id);
      await settle(f);
      assert.equal(current(f, 1).phase, 'landed');
      assert.equal(f.runs().length, 3, 'one cancelled admission plus the ordinary exact recheck');
    }
    assert.equal(pendingTasks(f).length, 0, 'settled work is idle');
  });

for (const [name, paths] of [
  ['unrelated', ['src/a.ts', 'src/b.ts']],
  ['global-risk', ['build.rs', 'src/b.ts']],
])
  test(`${name} accepted paths ${name === 'unrelated' ? 'preserve' : 'cancel'} the other running check without changing acceptance proofs`, async t => {
    const f = await fixture(t, { memberPaths: paths, count: 0 });
    if (name === 'global-risk') {
      const project = f.tables.hostedProjects.get(f.projectId);
      f.patch('hostedProjects', f.projectId, {
        autonomyPolicy: {
          ...project.autonomyPolicy,
          acceptance: { ...project.autonomyPolicy.acceptance, hostedCrossHeadReuse: false },
        },
      });
    }
    await f.add(0);
    await f.add(1);
    await drain(f);
    const [a, b] = f.runs();
    await f.rawChecks.activate(b.id);
    await f.rawChecks.pass(await f.rawChecks.activate(a.id));
    await drain(f);
    assert.equal(f.runs().find(r => r.id === b.id).status === 'cancelled', name === 'global-risk');
    if (name === 'unrelated') assert.equal(current(f, 1).phase, 'checking');
    await settle(f);
    assert(states(f).every(s => s.phase === 'landed'));
    assert.equal(f.runs().length, name === 'unrelated' ? 2 : 3);
  });

test('post-acceptance cancellation without a running entry reads zero new DB bytes and schedules nothing', async t => {
  const f = await fixture(t, { count: 1 });
  await settle(f);
  const before = f.counts.length;
  assert.equal(
    await f.transaction(
      'empty-stale-pass',
      {
        _handler: ctx =>
          stale.cancelStaleLandingChecks(ctx, {
            projectId: f.projectId,
            sequence: 0,
            receiptIds: [],
            head: 'a'.repeat(64),
            candidate: { id: randomUUID(), actor: 'owner', digest: 'a'.repeat(64) },
          }),
      },
      {},
    ),
    0,
  );
  const [cost] = f.counts.slice(before);
  assert.equal(cost.readBytes, 0);
  assert.equal(cost.writes, 0);
  assert.equal(pendingTasks(f).length, 0);
  t.diagnostic(JSON.stringify({ documents: cost.documents, readBytes: cost.readBytes, writes: cost.writes }));
});

test('restart after cancellation resumes the committed composition wake without a client repair', async t => {
  const f = await fixture(t, { conflict: false });
  const [a, b] = f.runs();
  await f.rawChecks.activate(b.id);
  await f.rawChecks.pass(await f.rawChecks.activate(a.id));
  await drain(f, () => f.runs().find(r => r.id === b.id).status === 'cancelled');
  const request = current(f, 1),
    pending = structuredClone(JSON.parse(finishRow(f, 1).value).pending);
  // Only durable tables/scheduler entries survive; no session invokes resume.
  for (const table of Object.values(f.tables))
    for (const [id, row] of table) table.set(id, structuredClone(row));
  await assertProgressOwners(f);
  await drain(f);
  assert.equal(current(f, 1).phase, 'checking');
  assert.notEqual(requestRow(f, 1).runId, b.id);
  assert.equal(current(f, 1).operationId, request.operationId);
  assert(f.runs().some(r => r.request.operationId === pending.operations.check));
  await settle(f);
  assert.equal(current(f, 1).phase, 'landed');
});

test('a scheduling failure rolls back cancellation and replay schedules fresh work atomically', async t => {
  const f = await fixture(t);
  const [a, b] = f.runs();
  await f.rawChecks.activate(b.id);
  await f.rawChecks.pass(await f.rawChecks.activate(a.id));
  await drain(f, task => task.name === 'projectHostedAcceptance:complete');
  const task = pendingTasks(f).find(t => t.name === 'projectHostedAcceptance:complete');
  assert(task);
  await assert.rejects(
    f.transaction(
      'cancel-schedule-crash',
      {
        _handler: async (ctx, args) =>
          completion.completeAcceptedHeads(
            {
              ...ctx,
              scheduler: {
                ...ctx.scheduler,
                runAfter: async () => {
                  throw new Error('synthetic scheduler interruption');
                },
              },
            },
            args,
          ),
      },
      task.args[0],
    ),
    /synthetic scheduler interruption/,
  );
  assert.equal(
    f.runs().find(r => r.id === b.id).status,
    'running',
    'uncommitted cancel cannot strand the run',
  );
  assert.equal(JSON.parse(finishRow(f, 1).value).pending, null);
  await f.execute(task);
  await drain(f);
  assert.equal(f.runs().find(r => r.id === b.id).status, 'cancelled');
  assert.equal(current(f, 1).error.code, 'COMPOSITION_CONFLICT');
});

test('a failed or late CI adapter stop cannot strand the replacement or revive the old run', async t => {
  const f = await fixture(t, { conflict: false });
  const [a, b] = f.runs();
  const old = await f.rawChecks.activate(b.id);
  const checks = await import(moduleUrl('../convex/projectHostedCheckStore.ts'));
  await f.transaction(
    'bind-direct-cancel-adapter',
    {
      _handler: async ctx => {
        const selected = await checks.loadHostedCheck(ctx, { projectId: f.projectId, runId: b.id }, false);
        selected.run.actions = {
          reservedAt: Date.now(),
          fence: selected.run.fence,
          watchdog: null,
          outcome: 'accepted',
        };
        await checks.writeHostedCheck(ctx, selected.row._id, selected.run);
      },
    },
    {},
  );
  await f.rawChecks.pass(await f.rawChecks.activate(a.id));
  await drain(f, () => f.runs().find(r => r.id === b.id).status === 'cancelled');
  const stop = f
    .pending()
    .find(t => t.name === 'projectHostedActionsWebhook:cancel' && t.args[0].runId === b.id);
  assert(stop, 'the existing adapter receives cancellation of the exact provider run');
  await assertProgressOwners(f);
  // The external stop action has not returned. Its failure is independent of
  // the atomic landing/source reservation already committed by cancellation.
  f.patch('_scheduled_functions', stop._id, { state: { kind: 'failed' } });
  await drain(f);
  assert.equal(current(f, 1).phase, 'checking');
  await assert.rejects(f.rawChecks.pass(old), e => (e.data?.code ?? e.code) === 'CHECK_CANCELLED');
  await settle(f);
  assert.equal(current(f, 1).phase, 'landed');
  assert(
    ![...f.tables.projectHostedAcceptances.values()]
      .map(r => JSON.parse(r.value))
      .some(r => r.submissionId === current(f, 1).id && r.check.runId === old.id),
  );
});

test('a failed replacement compose settles visibly instead of leaving a cancelled landing pending', async t => {
  const f = await fixture(t, { conflict: false });
  const [a, b] = f.runs();
  await f.rawChecks.activate(b.id);
  await f.rawChecks.pass(await f.rawChecks.activate(a.id));
  await drain(f, () => f.runs().find(r => r.id === b.id).status === 'cancelled');
  const source = JSON.parse(finishRow(f, 1).value).pending.operations.compose;
  const exhaustion = await import(moduleUrl('../convex/projectHostedComposeExhaustion.ts'));
  // The source owner's existing exhaustion terminal is also the failure exit of
  // an interrupted replacement, including a restart before any source step.
  await f.transaction(
    'cancelled-replacement-fails',
    { _handler: ctx => exhaustion.exhaustFinishCompose(ctx, finishRow(f, 1), source) },
    {},
  );
  assert.equal(current(f, 1).phase, 'terminal-failed');
  assert.equal(current(f, 1).error.code, 'SOURCE_RETRY_EXHAUSTED');
  await assertProgressOwners(f);
  const page = JSON.parse(
    await f.transaction('observe-source-failure', observe.page, {
      projectId: f.projectId,
      operationId: current(f, 1).operationId,
      nextVersion: 0,
    }),
  );
  assert.equal(page.submission.error.code, 'SOURCE_RETRY_EXHAUSTED');
  await drain(f);
});

test('back-to-back acceptances coalesce into actual main before the cancelled landing checks', async t => {
  const f = await fixture(t, { conflict: false, count: 3 });
  const [a, b, c] = f.runs();
  await f.rawChecks.activate(b.id);
  await f.rawChecks.pass(await f.rawChecks.activate(a.id));
  await f.rawChecks.pass(await f.rawChecks.activate(c.id));
  // Both publications happen before their post-acceptance ticks. The checking
  // entry holds no order yet, so the unrelated entry can land in the same wave.
  for (let n = 0; current(f, 2).phase !== 'landed'; n++) {
    assert(n < 200);
    const task = pendingTasks(f).find(t => t.name !== 'projectHostedAcceptance:complete');
    assert(task);
    await f.execute(task);
  }
  assert.equal(current(f, 0).phase, 'landed');
  const actual = f.currentMain();
  const ticks = pendingTasks(f).filter(t => t.name === 'projectHostedAcceptance:complete');
  assert(ticks.length >= 2);
  for (const tick of ticks.toReversed()) await f.execute(tick);
  await drain(f);
  assert.equal(f.runs().find(r => r.id === b.id).status, 'cancelled');
  const replacement = f.runs().find(r => r.status === 'queued');
  assert(replacement);
  assert.equal(replacement.candidate.base.head, actual.head);
  assert.equal(replacement.candidate.base.receiptId, actual.receipt.id);
  await assertProgressOwners(f);
  await settle(f);
  assert(states(f).every(s => s.phase === 'landed'));
});

test('a main move during replacement composition never starts CI on that obsolete generation', async t => {
  const f = await fixture(t, { conflict: false });
  const [a, b] = f.runs();
  await f.rawChecks.activate(b.id);
  await f.rawChecks.pass(await f.rawChecks.activate(a.id));
  await drain(f, () => f.runs().find(r => r.id === b.id).status === 'cancelled');
  const obsolete = JSON.parse(finishRow(f, 1).value).pending;
  const next = f.moveMain();
  await drain(f);
  const checks = f.runs().filter(r => r.status === 'queued');
  assert.equal(checks.length, 1);
  assert.equal(checks[0].candidate.base.head, next.head);
  assert.equal(checks[0].candidate.base.receiptId, next.receipt.id);
  assert(!f.runs().some(r => r.request.operationId === obsolete.operations.check));
  await assertProgressOwners(f);
  await settle(f);
  assert.equal(current(f, 1).phase, 'landed');
});

test('the acceptance cancellation pass stops at eight running entries', async t => {
  const f = await fixture(t, { count: 10, memberPaths: Array(10).fill('src/shared.ts') });
  const initial = f.runs();
  await f.rawChecks.pass(await f.rawChecks.activate(initial[0].id));
  await drain(f, () => f.runs().filter(r => r.status === 'cancelled').length > 0);
  assert.equal(f.runs().filter(r => r.status === 'cancelled').length, 8);
  assert.equal(current(f, 9).phase, 'checking', 'the ninth entry remains outside this finite look-ahead');
  await assertProgressOwners(f);
});

/** Item 9a04d916 (bench cell cohort-fail 143142, t27456): three Lanes add the same
 * file under a full pre-queue check. The first lands on its own run; the other two
 * runs are cancelled and each recomposes on the new main (83e6d0d3). Both composes
 * find the conflict at once. The entry is queued and not runnable, so the drive
 * actions on that path (submit the recompose, then consume its result) are its only
 * owners, and Convex runs a scheduled action at most once. When one was lost, only
 * the 15-minute stall alarm was left: 921 s of silence. Compose settle runs both steps
 * (submit, consume) in a scheduled mutation (exactly once); only their IO stays in an
 * action, owned by the step's retained 30 s retry. Each replay drops the drive action the
 * platform may lose and checks strict L5b (an owner due within one check wall) at every
 * step, so on a build without the fix it fails because the entry is stranded. */
async function threeWayOverlap(t) {
  const f = await fixture(t, {
    count: 3,
    landingMode: 'fast',
    memberPaths: ['src/shared.ts', 'src/shared.ts', 'src/shared.ts'],
    memberContents: ['A\nb\nc\n', 'B\nb\nc\n', 'C\nb\nc\n'],
  });
  const [a, b, c] = f.runs();
  await f.rawChecks.activate(b.id);
  await f.rawChecks.activate(c.id);
  await f.rawChecks.pass(await f.rawChecks.activate(a.id));
  return f;
}
const recompose = f => {
  const pending = JSON.parse(finishRow(f, 2).value).pending;
  const row =
    pending &&
    [...f.tables.projectHostedComposes.values()].find(r => r.operationId === pending.operations.compose);
  return { pending, status: row && JSON.parse(row.value).status };
};
const wakeTask = f => f.tables._scheduled_functions.get(finishRow(f, 2).wake?.taskId);
/** Run every task (stall alarms included) until the third entry ends. `drop` picks the
 * one pending task the platform loses; only an action can be lost (`failAny` also
 * fails a mutation, as one that throws every time). Returns the drop time, the
 * dropped task's name and the time the entry ended. */
async function lossyRun(f, drop, { strict = true, failAny = false, onStep = () => {} } = {}) {
  let lost = null;
  for (let step = 0; !['landed', 'terminal-failed'].includes(current(f, 2).phase); step++) {
    assert(step < 2000, JSON.stringify(states(f)));
    const target = !lost && drop(f);
    if (target) {
      assert.equal(target.state.kind, 'pending');
      if (failAny || target.name === 'projectHostedFinishDriver:drive')
        f.patch('_scheduled_functions', target._id, { state: { kind: 'failed' } });
      lost = { at: Date.now(), name: target.name };
    }
    const task = f.pending()[0];
    if (!task) break;
    await f.execute(task);
    if (strict && lost) await assertProgressOwners(f);
    onStep();
  }
  assert(lost, 'the dropped hop was reached');
  return { ...lost, endedAt: Date.now() };
}
const terminalStatus = f => current(f, 2).phase === 'terminal-failed';
async function assertConflictAtOnce(f, lost) {
  assert.equal(current(f, 0).phase, 'landed');
  assert.equal(current(f, 1).error?.code, 'COMPOSITION_CONFLICT');
  assert(terminalStatus(f), JSON.stringify(current(f, 2)));
  assert.equal(current(f, 2).error.code, 'COMPOSITION_CONFLICT');
  assert(
    lost.endedAt - lost.at < CHECK_WALL_MS,
    `conflict delivered within one check wall, not by the stall alarm: ${lost.endedAt - lost.at} ms`,
  );
  assert.equal(current(f, 2).observation.stall, undefined, 'no stall raised');
  assert.equal(f.runs().length, 3, 'no replacement check for a real conflict');
}
// The hop after the compose completed: the one wake owed to its result.
const composeResultHop = f =>
  recompose(f).status && ['completed', 'failed'].includes(recompose(f).status) && wakeTask(f);
// The hop before it: the backoff drive that submits the recompose (F2).
const recomposeSubmitHop = f => {
  const { pending, status } = recompose(f);
  return pending && !status && wakeTask(f)?.state.kind === 'pending' && wakeTask(f);
};

test("incident 9a04d916: a lost drive after a cancelled admission's recompose still delivers the conflict at once", async t => {
  const f = await threeWayOverlap(t);
  await assertConflictAtOnce(f, await lossyRun(f, composeResultHop));
});
test('incident 9a04d916 F2: the step that submits the recompose cannot be lost', async t => {
  const f = await threeWayOverlap(t);
  await assertConflictAtOnce(f, await lossyRun(f, recomposeSubmitHop));
});
test('incident 9a04d916 F2: a lost plan upload after a settled submit is owned by its 30 s retry', async t => {
  const f = await threeWayOverlap(t);
  const id = current(f, 2).id;
  const lost = await lossyRun(f, f =>
    f
      .pending()
      .find(
        task =>
          task.name === 'projectHostedFinishDriver:drive' &&
          task.args[0].submissionId === id &&
          task.args[0].command,
      ),
  );
  assert.equal(lost.name, 'projectHostedFinishDriver:drive');
  // Task args never carry the plan bytes (they hold the landing message) or a URL.
  for (const task of f.tables._scheduled_functions.values())
    if (task.args?.[0]?.command)
      assert.deepEqual(Object.keys(JSON.parse(task.args[0].command)).sort(), ['kind', 'pin', 'source']);
  await assertConflictAtOnce(f, lost);
  assert(lost.endedAt - lost.at >= 30_000, 'the retained retry, not a second consumer, ran the upload');
});
test('incident 9a04d916 F1: a solo stall that recovered leaves no stall in the terminal state', async t => {
  const f = await threeWayOverlap(t);
  // A settle that fails every time (a mutation is never lost, but it can throw).
  let owner = null;
  const lost = await lossyRun(f, composeResultHop, {
    strict: false,
    failAny: true,
    onStep: () => (owner ??= current(f, 2).observation.stall?.owner ?? null),
  });
  assert.equal(lost.name, 'projectHostedFinishDriver:settle');
  // The alarm's diagnosis is visible while the stall is current ...
  assert.deepEqual(owner, { finishWake: 'failed', compose: 'terminal' });
  // ... and goes with it once progress resumes.
  assert.equal(current(f, 2).error?.code, 'COMPOSITION_CONFLICT');
  assert.equal(current(f, 2).observation.stall, undefined);
  assert.equal(requestRow(f, 2).phase, 'terminal-failed');
});
test('F3: strict L5b rejects a finish wake due later than one check wall', async t => {
  const f = await threeWayOverlap(t);
  // A settle that fails every time leaves the entry to the stall alarm alone.
  await assert.rejects(lossyRun(f, composeResultHop, { failAny: true }), /L5b: stranded/);
  const task = wakeTask(f);
  // The lost wake comes back as a pending wake, first far in the future, then due soon.
  f.patch('_scheduled_functions', task._id, {
    state: { kind: 'pending' },
    scheduledTime: Date.now() + 14 * 60_000,
  });
  await assert.rejects(assertProgressOwners(f), /L5b: stranded/);
  await assertQueueProgress(f, { alarmOwns: true });
  f.patch('_scheduled_functions', task._id, { scheduledTime: Date.now() + CHECK_WALL_MS - 1 });
  await assertProgressOwners(f);
});

/** Review ba9ce962 L2 (owner 2026-11-18): the double loss. The action uploading the
 * recompose's plan dies after its step committed (a deploy mid-action), and the finish
 * drive due next for this entry is lost too. Both hops were actions, so the entry was
 * left to the 15-minute alarm. The step's retained retry is a mutation (`retry`, never
 * lost), so only its IO action can be lost again, and the next retry still delivers the
 * conflict within one check wall. */
async function doubleLossRun(f) {
  const id = current(f, 2).id,
    losses = [];
  const finishDrive = task =>
    task.name === 'projectHostedFinishDriver:drive' && task.args[0].submissionId === id;
  for (let step = 0; !['landed', 'terminal-failed'].includes(current(f, 2).phase); step++) {
    assert(step < 2000, JSON.stringify(states(f)));
    const task = f.pending()[0];
    if (!task) break;
    // First loss: the upload, i.e. the drive handed the plan by a settle. Second loss: the
    // next finish drive this entry gets, whatever owns it.
    const upload = Boolean(task.args[0]?.command);
    if (losses.length < 2 && finishDrive(task) && (losses.length || upload)) {
      f.advanceClock(Math.max(0, task.scheduledTime - Date.now()));
      f.patch('_scheduled_functions', task._id, { state: { kind: 'failed' } });
      losses.push({ at: Date.now(), command: Boolean(task.args[0].command) });
      // Owned right after the loss, not only once a later task (maybe the alarm) ran.
      await assertProgressOwners(f);
      continue;
    }
    await f.execute(task);
    if (losses.length) await assertProgressOwners(f);
  }
  assert.equal(losses.length, 2, 'both the upload and its retry were lost');
  return { at: losses[0].at, losses, endedAt: Date.now() };
}
test('incident 9a04d916 L2: a lost plan upload and a lost retry still deliver the conflict within one check wall', async t => {
  const f = await threeWayOverlap(t);
  const lost = await doubleLossRun(f);
  // Both losses were IO actions handed out by mutations; no owner was an action.
  assert.deepEqual(
    lost.losses.map(loss => loss.command),
    [true, true],
  );
  await assertConflictAtOnce(f, lost);
});
test('incident 9a04d916 L2: IO lost every time spends the retry mutation budget, then ends typed, not a 30 s loop', async t => {
  const { FINISH_SETTLE_RETRIES } = await import(moduleUrl('../convex/projectHostedFinishWake.ts'));
  const f = await threeWayOverlap(t);
  const id = current(f, 2).id,
    retries = [];
  let lost = 0;
  for (let step = 0; !['landed', 'terminal-failed'].includes(current(f, 2).phase); step++) {
    assert(step < 400, `bounded: ${JSON.stringify(states(f))}`);
    const task = f.pending()[0];
    if (!task) break;
    const own = task.args[0]?.submissionId === id && task.name.startsWith('projectHostedFinishDriver:');
    if (own && task.name === 'projectHostedFinishDriver:retry') retries.push(task.args[0].attempt ?? 1);
    // The platform loses every finish action of this entry once its recompose is reserved.
    if (own && task.name === 'projectHostedFinishDriver:drive' && recompose(f).pending) {
      f.advanceClock(Math.max(0, task.scheduledTime - Date.now()));
      f.patch('_scheduled_functions', task._id, { state: { kind: 'failed' } });
      lost++;
      continue;
    }
    await f.execute(task);
  }
  assert.deepEqual(
    retries,
    Array.from({ length: FINISH_SETTLE_RETRIES }, (_, i) => i + 1),
    'one mutation per budgeted retry, then the retry is a drive again',
  );
  assert(lost > FINISH_SETTLE_RETRIES, 'the drive retry after the budget was lost too');
  assert.equal(current(f, 2).phase, 'terminal-failed');
  assert.equal(current(f, 2).error.code, 'LANDING_DRIVER_EXHAUSTED');
  assert.equal(f.pending().length, 0, 'no timer left');
});
