// SPDX-License-Identifier: Apache-2.0
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

for (const { name, paths, enabled, mode = 'fast', breaker = false, keep = false, person = false } of [
  { name: 'switch off', paths: ['package.json', 'src/b.ts'], enabled: false },
  { name: 'effective fast mode', paths: ['package.json', 'src/b.ts'], enabled: true, keep: true },
  { name: 'person in fast mode', paths: ['package.json', 'src/b.ts'], enabled: true, person: true },
  { name: 'strict mode', paths: ['package.json', 'src/b.ts'], enabled: true, mode: 'strict' },
  { name: 'open fast breaker', paths: ['package.json', 'src/b.ts'], enabled: true, breaker: true },
  { name: 'order-sensitive mover', paths: ['convex/schema.ts', 'src/b.ts'], enabled: true },
  { name: 'overlapping code', paths: ['src/shared.ts', 'src/shared.ts'], enabled: true },
])
  test(`O4: ${name} ${keep ? 'preserves' : 'cancels'} the running check`, async t => {
    const previous = process.env.FORGE_QUEUE_CANCEL_HONOURS_FAST;
    process.env.FORGE_QUEUE_CANCEL_HONOURS_FAST = enabled ? '1' : '0';
    t.after(() => {
      if (previous === undefined) delete process.env.FORGE_QUEUE_CANCEL_HONOURS_FAST;
      else process.env.FORGE_QUEUE_CANCEL_HONOURS_FAST = previous;
    });
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
    const running = await f.rawChecks.activate(b.id);
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
    assert.equal(f.runs().find(run => run.id === b.id).status, keep ? 'running' : 'cancelled');
    if (keep) {
      assert.equal(requestRow(f, 1).runId, b.id);
      await f.rawChecks.pass(running);
      await drain(f);
      assert.equal(current(f, 1).phase, 'landed');
      assert.equal(f.runs().length, 2);
      const receipt = [...f.tables.projectHostedAcceptances.values()].find(
        row => row.receiptId === current(f, 1).acceptance.receiptId,
      );
      assert.equal(JSON.parse(receipt.value).crossHeadProof.algorithm, 'fast-first-check-v1');
    } else if (name === 'switch off') {
      await settle(f);
      assert.equal(current(f, 1).phase, 'landed');
      assert.equal(f.runs().length, 3);
    }
    if (keep || name === 'switch off')
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
 * the 15-minute stall alarm was left: 921 s of silence. FORGE_QUEUE_COMPOSE_SETTLE
 * runs both steps (submit, consume) in a scheduled mutation (exactly once); only
 * their IO stays in an action, owned by the step's retained 30 s retry. Each replay drops the drive action the platform may lose and
 * checks strict L5b (an owner due within one check wall) at every step, so on a
 * build without the fix it fails because the entry is stranded. */
function composeSettleSwitch(t, on) {
  const previous = process.env.FORGE_QUEUE_COMPOSE_SETTLE;
  process.env.FORGE_QUEUE_COMPOSE_SETTLE = on ? '1' : '0';
  t.after(() => {
    if (previous === undefined) delete process.env.FORGE_QUEUE_COMPOSE_SETTLE;
    else process.env.FORGE_QUEUE_COMPOSE_SETTLE = previous;
  });
}
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
  composeSettleSwitch(t, true);
  const f = await threeWayOverlap(t);
  await assertConflictAtOnce(f, await lossyRun(f, composeResultHop));
});
test("incident 9a04d916: a lost drive after a cancelled admission's recompose leaves only the stall alarm (switch off)", async t => {
  composeSettleSwitch(t, false);
  const f = await threeWayOverlap(t);
  await assert.rejects(lossyRun(f, composeResultHop), /L5b: stranded/);
  assert.equal(current(f, 2).phase, 'queued');
  assert.equal(requestRow(f, 2).runnable, false);
  await assertProgressOwners(f, { alarmOwns: true });
});
test('incident 9a04d916 F2: the step that submits the recompose cannot be lost', async t => {
  composeSettleSwitch(t, true);
  const f = await threeWayOverlap(t);
  await assertConflictAtOnce(f, await lossyRun(f, recomposeSubmitHop));
});
test('incident 9a04d916 F2: a lost plan upload after a settled submit is owned by its 30 s retry', async t => {
  composeSettleSwitch(t, true);
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
test('incident 9a04d916 F2: a lost recompose submit leaves only the stall alarm (switch off)', async t => {
  composeSettleSwitch(t, false);
  const f = await threeWayOverlap(t);
  await assert.rejects(lossyRun(f, recomposeSubmitHop), /L5b: stranded/);
});
test('incident 9a04d916 F1: a solo stall that recovered leaves no stall in the terminal state (switch on)', async t => {
  composeSettleSwitch(t, true);
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
  // ... and goes with it once progress resumes, exactly as with the switch off.
  assert.equal(current(f, 2).error?.code, 'COMPOSITION_CONFLICT');
  assert.equal(current(f, 2).observation.stall, undefined);
  assert.equal(requestRow(f, 2).phase, 'terminal-failed');
});
test('F3: strict L5b rejects a finish wake due later than one check wall', async t => {
  composeSettleSwitch(t, false);
  const f = await threeWayOverlap(t);
  await assert.rejects(lossyRun(f, composeResultHop), /L5b: stranded/);
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
