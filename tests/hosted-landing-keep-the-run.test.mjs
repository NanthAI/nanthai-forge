// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
/** Keep the run (Item fa2c1383) wired into the main-move sweep, switch FORGE_QUEUE_KEEP_THE_RUN on.
 * Guards from plan 82bf7c75 (A2-A5, B1, C1), review 563c595b (F2, F3a-c) and review 0c7f9440
 * (finding 4). The switch-off rows prove today's retire is unchanged. A1 is the starvation and C1
 * suites run with the switch on (docs/pre-queue-checks.md). */
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
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
import { moduleUrl } from './convex-module.mjs';
import { WIRED, wiredProblems } from './keep-the-run-scenarios.mjs';
import { metricAliasProjectionCounts } from './observer-projection-budget.mjs';
import { storageClock } from './storage-clock.mjs';
import { armed, assertQueueProgress } from './queue-sim/invariants.mjs';
const stale = await import(moduleUrl('../convex/projectHostedLandingStaleChecks.ts'));
const mainAudit = await import(moduleUrl('../convex/projectHostedMainAudit.ts'));
const { summary: checkSummary } = await import(moduleUrl('../convex/projectHostedCheckRead.ts'));
const { reserveFinishRetry } = await import(moduleUrl('../convex/projectHostedFinishCompose.ts'));
const { loadFinish } = await import(moduleUrl('../convex/projectHostedFinishStore.ts'));
const { writableHostedCheck } = await import(moduleUrl('../convex/projectHostedCheckStore.ts'));
const { settleDirectActions } = await import(moduleUrl('../convex/projectHostedActionsDirect.ts'));
const SWITCH = 'FORGE_QUEUE_KEEP_THE_RUN';
const prior = Object.fromEntries([...Object.keys(synthetic), SWITCH].map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic, { [SWITCH]: '1' }));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});
const switchOff = t => {
  process.env[SWITCH] = '0';
  t.after(() => {
    process.env[SWITCH] = '1';
  });
};

/** The project's measured check costs: a scoped recheck is 2/3 of a whole check's runner jobs and
 * 10/13 of its wall (src/stale-check-economics.ts reads the landing-speed samples). The landings
 * commit after the recheck selector's basis (RECHECK_BASIS_SINCE), an hour apart. */
const seedCosts = f => {
  const sample = (i, wall, jobs, kind) => [
    Date.parse('2026-11-24T00:00:00.000Z') + i * 3_600_000,
    30,
    wall,
    `l${i}`,
    1,
    1,
    1,
    [0, 0, 0, jobs, 0, 0],
    null,
    null,
    1,
    kind,
  ];
  const samples = [1, 2, 3].flatMap(i => [sample(i, 13, 1200, 'full'), sample(10 + i, 10, 800, 'scoped')]);
  f.insert('projectLandingSpeed', {
    projectId: f.projectId,
    value: JSON.stringify({ schema: 2, samples, broken: {} }),
  });
};
/** A direct Actions runner (no credential) on a green main: what a scoped recheck needs. */
async function directOnGreen(f) {
  const { credential: _credential, ...runner } = f.rawChecks.runner;
  void _credential;
  f.rawChecks.configuration = await f.rawChecks.configure(
    { kind: 'runner', configuration: runner },
    f.rawChecks.configuration.digest,
  );
  const main = f.currentMain();
  f.insert('projectHostedMainAudits', {
    projectId: f.projectId,
    lastGreen: { sequence: main.sourceRevision, head: main.head, runId: randomUUID() },
  });
}
const checkRow = (f, id) => [...f.tables.projectHostedCheckRuns.values()].find(r => r.runId === id);
const runOf = (f, id) => f.runs().find(r => r.id === id);
/** The run's first shard started `minutes` ago (null: not yet). The project's whole check takes 13. */
const startShards = (f, id, minutes) => {
  if (minutes !== null)
    f.patch('projectHostedCheckRuns', checkRow(f, id)._id, { shardStartedAt: Date.now() - minutes * 60_000 });
};
/** The fake provider echoes no effective gate; a real whole run does, and scopedRecheckBasis reads it. */
const echoFullGate = (f, id) => {
  const row = checkRow(f, id);
  const run = JSON.parse(row.value);
  f.patch('projectHostedCheckRuns', row._id, {
    value: JSON.stringify({ ...run, gate: { ...run.gate, effective: 'full' } }),
  });
};
const attempts = (f, index) =>
  [...f.tables.projectHostedLandingAttempts.values()]
    .map(r => JSON.parse(r.value))
    .filter(a => a.submissionId === current(f, index).id);
const attemptOf = (f, index) => attempts(f, index).find(a => a.id === current(f, index).attemptId);
const finishPending = (f, index) => JSON.parse(finishRow(f, index).value).pending;
const queueRow = f =>
  [...f.tables.projectHostedLandingQueues.values()].find(q => q.projectId === f.projectId);
/** Hold one task (the platform has not run it yet) while everything else runs. */
async function drainExcept(f, held, stop = () => false) {
  for (let step = 0; ; step++) {
    const task = pendingTasks(f).find(t => !held.has(t._id));
    if (!task || stop(task)) return;
    assert(step < 1000, JSON.stringify(states(f)));
    await f.execute(task);
  }
}

/** Entry 0 lands while every later entry's admission run is running. Returns before the sweep's
 * effects are drained when `stop` says so. */
async function mainMoves(
  t,
  { paths, contents, mode = 'strict', count = 2, minutes = 12, concurrency = 1, held = new Set(), stop } = {},
) {
  const f = await fixture(t, {
    memberPaths: paths,
    ...(contents ? { memberContents: contents } : {}),
    landingMode: mode,
    concurrency,
    conflict: false,
    count: 0,
  });
  seedCosts(f);
  await directOnGreen(f);
  for (let i = 0; i < count; i++) await f.add(i);
  await drain(f);
  const runs = f.runs();
  assert.equal(runs.length, count, 'one admission run per entry');
  for (const run of runs.slice(1)) {
    await f.rawChecks.activate(run.id);
    startShards(f, run.id, minutes);
    echoFullGate(f, run.id);
  }
  const before = {
    main: f.currentMain(),
    attemptId: current(f, 1).attemptId,
    accept: attemptOf(f, 1).operations.accept,
    firstChecks: queueRow(f)?.checkHistory?.first,
    calls: f.counts.length,
  };
  await f.rawChecks.pass(await f.rawChecks.activate(runs[0].id));
  await drain(f, task => task.name === 'projectHostedAcceptance:complete');
  await drainExcept(f, held, stop ? task => stop(f, task) : undefined);
  assert.equal(current(f, 0).phase, 'landed');
  return { f, runs, before };
}
/** A red run: a test fails on the run already running (the fixture's `fail` would re-activate it). */
const failRun = async (f, id) => {
  const run = runOf(f, id);
  await f.rawChecks.callback(f.rawChecks.shard(run, 0, 'failed'));
  await f.rawChecks.callback(
    f.rawChecks.complete(run, 'failed', {
      contractReports: {
        'tests/member-1.test.mjs': { failed: true, durationMs: 1, firstError: 'synthetic failure' },
      },
    }),
  );
};
const passRun = async (f, id) => {
  const run = runOf(f, id);
  await f.rawChecks.pass(run.status === 'queued' ? await f.rawChecks.activate(id) : run);
};
// An order-sensitive global mover (schema) that shares no path with the run: today it retires it.
const ORDER_SENSITIVE = ['convex/schema.ts', 'src/b.ts'];

test('incident fa2c1383: check summaries retain why main kept or retired each run', async t => {
  const paths = ['convex/schema.ts', 'src/b.ts'];
  for (const [minutes, action, reason] of [
    [12, 'keep', 'scoped-recheck'],
    [null, 'cancel', 'scoped-costs-more'],
  ]) {
    const { f, runs } = await mainMoves(t, { paths, minutes });
    const [mover, affected] = runs;
    const summary = (runId, diagnostics = true) =>
      f.rawChecks.call('checkSummary', checkSummary, {
        projectId: f.projectId,
        runId,
        ...(diagnostics ? { mainMoveDecision: 1 } : {}),
      });
    const decision = {
      action,
      reason,
      moverReceiptId: current(f, 0).acceptance.receiptId,
    };
    assert.equal(JSON.parse(await summary(mover.id)).mainMoveDecision, null);
    assert.equal(JSON.parse(await summary(affected.id, false)).mainMoveDecision, undefined);
    assert.deepEqual(JSON.parse(await summary(affected.id)).mainMoveDecision, decision);
    await settle(f);
    assert.deepEqual(JSON.parse(await summary(affected.id)).mainMoveDecision, decision);
  }
});

test('A3/F3: a strict kept run holds order, keeps its attempt, and lands only after a scoped recheck', async t => {
  const { f, runs, before } = await mainMoves(t, { paths: ORDER_SENSITIVE });
  const b = runs[1];
  assert.equal(runOf(f, b.id).status, 'running', 'the run the rule keeps goes on');
  assert.equal(f.runs().length, 2, 'no replacement run');
  const row = requestRow(f, 1);
  assert.equal(row.admission.status, 'checking');
  assert.equal(row.admission.kept, true);
  assert.equal(row.orderLive, true, 'A2: the kept admission holds queue order, as the retire would have');
  assert.equal(row.checkKind, 'full');
  // F3a/F3b: no attempt fork, no new accept id, no finish retry; the attempt's main is the checked base.
  assert.equal(current(f, 1).attemptId, before.attemptId);
  assert.equal(attemptOf(f, 1).operations.accept, before.accept);
  assert.equal(attemptOf(f, 1).main.head, before.main.head);
  // The kept run stays bound as the admission run (the kept marker), not through attempt.check.
  assert.equal(attemptOf(f, 1).check, null);
  assert.equal(row.runId, b.id);
  assert.equal(row.admission.runId, b.id);
  assert.equal(finishPending(f, 1), null, 'no probe: the run shares no path with the mover');
  await passRun(f, b.id);
  await drain(f);
  const recheck = f.runs().find(r => r.id !== b.id && r.id !== runs[0].id);
  assert(recheck, 'strict: the kept pass is not acceptance by itself');
  // The main-race attempt the finish composed on current main names why it rechecked (7c2e69e1).
  const raced = attempts(f, 1).filter(a => a.main.head !== before.main.head);
  assert(raced.length, 'the finish recomposed the kept pass on current main');
  assert(
    raced.every(a => a.recheck?.runId === b.id),
    'A4: the kept pass is the scoped recheck basis',
  );
  assert(
    raced.every(a => a.scopedFallback === undefined),
    'A4: no scoped-no-evidence fallback',
  );
  assert.equal(raced.find(a => a.recheckReason)?.recheckReason, 'order-sensitive');
  // F3c: the kept admission settles like any admission: first check recorded, recheck reason named.
  const settled = requestRow(f, 1).admission;
  assert.equal(settled.status, 'passed');
  assert.equal(settled.kept, true);
  assert.equal(settled.recheck, 'order-sensitive');
  assert.notDeepEqual(queueRow(f).checkHistory?.first, before.firstChecks, 'first check recorded');
  await settle(f);
  assert.equal(current(f, 1).phase, 'landed');
  assert.equal(f.runs().length, 3, 'kept run plus its scoped recheck; no full replacement');
  assert.equal(requestRow(f, 1).checkKind, 'scoped');
  assert.equal(pendingTasks(f).length, 0, 'A5: settled work is idle');
});

test('A4: a red kept run ends the landing with no replacement run', async t => {
  const { f, runs } = await mainMoves(t, { paths: ORDER_SENSITIVE });
  assert.equal(requestRow(f, 1).admission.kept, true);
  await failRun(f, runs[1].id);
  await drain(f);
  assert.equal(current(f, 1).phase, 'terminal-failed');
  assert.equal(requestRow(f, 1).admission.status, 'failed');
  assert.equal(f.runs().length, 2, 'no replacement and no recheck for a red run');
  await assertProgressOwners(f);
});

test('A2: a kept run holds order: an overlapping follower composes behind it before spending a check', async t => {
  const { f, runs } = await mainMoves(t, {
    paths: [...ORDER_SENSITIVE, 'src/b.ts'],
    mode: 'fast',
    concurrency: 2,
  });
  assert.equal(requestRow(f, 1).admission.kept, true);
  assert.equal(requestRow(f, 1).orderLive, true);
  await f.add(2);
  await drain(f);
  assert.equal(f.runs().length, 2, 'the follower spends no independent admission check');
  const follower = await f.current(f.entries[2].state.id);
  assert.equal(follower.submission.phase, 'queued');
  assert.equal(follower.wouldConflict?.code, 'COMPOSITION_CONFLICT');
  assert.equal(follower.wouldConflict.predecessor.submissionId, f.entries[1].state.id);
  assert.equal(runOf(f, runs[1].id).status, 'running');
});

/** Review a09af93a finding 1 and 379d19f5 nit 3: every order of the two passes. The kept entry keeps
 * its place (no cohort hold parks it), so it lands and the follower conflicts, as today. */
const A2_FULL = 'A2: with the pipeline full, an overlapping follower checks on its own as today';
for (const timing of ['follower passes first', 'both pass together', 'kept run passes first'])
  test(`${A2_FULL} (${timing})`, async t => {
    const { f, runs } = await mainMoves(t, { paths: [...ORDER_SENSITIVE, 'src/b.ts'] });
    assert.equal(requestRow(f, 1).admission.kept, true);
    await f.add(2);
    await drain(f);
    assert.equal(f.runs().length, 3, 'one admission run of its own, never a strand behind the kept run');
    assert.equal(requestRow(f, 2).admission?.status, 'checking');
    assert.equal(runOf(f, runs[1].id).status, 'running');
    const follower = f.runs()[2].id;
    const order = {
      'follower passes first': [[follower], [runs[1].id]],
      'both pass together': [[follower, runs[1].id]],
      'kept run passes first': [[runs[1].id], [follower]],
    }[timing];
    for (const wave of order) {
      for (const id of wave) await passRun(f, id);
      await drain(f);
    }
    await settle(f);
    assert.equal(current(f, 1).phase, 'landed', 'the kept entry lands in its queue place');
    assert.equal(current(f, 2).phase, 'terminal-failed');
    assert.equal(current(f, 2).error.code, 'COMPOSITION_CONFLICT');
    assert.equal(requestRow(f, 1).admission.hold, undefined, 'a kept run is never parked for peers');
  });

/** Review a09af93a nit 6: fast seeds from its train, which holds the kept row, so with the pipeline full
 * an overlapping follower stacks behind the kept run exactly as it stacks behind today's retired entry
 * (switch off: the same rows, the same outcome). It has no run of its own: the kept run's settle is
 * its owner. L5b must recognize that capacity wait using the retained train. Every entry also reaches
 * its end with the stall alarm never run, whether the kept run passes, goes red, or parks on main's
 * own red tests (review 018569e9 finding 1: that park released the place but woke no queue). */
const MAIN_RED_TEST = 'tests/main-red.test.mjs';
for (const end of ['passes', 'red', 'parks on main red'])
  test(`A2 fast: with the pipeline full, a follower stacked on a kept run is driven by its settle (kept run ${end})`, async t => {
    if (end === 'parks on main red') {
      process.env.FORGE_QUEUE_PARK_ON_MAIN_RED = '1';
      t.after(() => delete process.env.FORGE_QUEUE_PARK_ON_MAIN_RED);
    }
    const { f, runs } = await mainMoves(t, { paths: [...ORDER_SENSITIVE, 'src/b.ts'], mode: 'fast' });
    assert.equal(requestRow(f, 1).admission.kept, true);
    assert.equal(requestRow(f, 1).orderLive, true);
    // Every scheduled task but the stall alarm, release pages included, as the scheduler would run them.
    const owned = async () => {
      for (let step = 0; ; step++) {
        const task = pendingTasks(f)[0];
        if (!task) return;
        assert(step < 1000, JSON.stringify(states(f)));
        if (task.name === 'projectHostedMainAudit:releaseHeld') {
          f.patch('_scheduled_functions', task._id, { state: { kind: 'success' } });
          await f.transaction('release', mainAudit.releaseHeld, task.args[0]);
        } else await f.execute(task);
      }
    };
    await f.add(2);
    await owned();
    assert.equal(f.runs().length, 2, 'the follower stacks: no run of its own');
    assert.equal(current(f, 2).phase, 'queued');
    await assertProgressOwners(f);
    if (end === 'passes') {
      const queue = queueRow(f);
      assert(queue.train.includes(current(f, 1).id), 'the live kept run occupies the train');
      const tasks = [...f.tables._scheduled_functions.values()].filter(task => armed(f, task._id));
      for (const task of tasks) f.patch('_scheduled_functions', task._id, { state: { kind: 'canceled' } });
      const until = Date.parse(current(f, 1).at) + 20 * 60_000;
      const staleLease = f.insert('_scheduled_functions', {
        name: 'projectHostedCheckLease:expire',
        args: [{ projectId: f.projectId, runId: runs[1].id, fence: -1, until }],
        scheduledTime: until,
        state: { kind: 'pending' },
      });
      try {
        await assert.rejects(
          assertQueueProgress(f, { alarmOwns: false }),
          new RegExp(`L5b: stranded ${current(f, 2).id}`),
        );
      } finally {
        f.tables._scheduled_functions.delete(staleLease);
        for (const task of tasks) f.patch('_scheduled_functions', task._id, { state: task.state });
      }
    }
    const audit = [...f.tables.projectHostedMainAudits.values()].find(r => r.projectId === f.projectId);
    if (end === 'passes') await passRun(f, runs[1].id);
    else if (end === 'red') await failRun(f, runs[1].id);
    else {
      // Main is red on one test; the kept run fails on that test alone.
      f.patch('projectHostedMainAudits', audit._id, {
        red: {
          since: current(f, 1).at,
          head: f.currentMain().head,
          runId: 'red-audit',
          tests: [MAIN_RED_TEST],
        },
      });
      const run = runOf(f, runs[1].id);
      await f.rawChecks.callback(f.rawChecks.shard(run, 0, 'failed'));
      await f.rawChecks.callback(f.rawChecks.shard(run, 1, 'passed'));
      await f.rawChecks.callback(
        f.rawChecks.complete(run, 'failed', {
          contractReports: { [MAIN_RED_TEST]: { failed: true, durationMs: 1, firstError: 'synthetic' } },
        }),
      );
    }
    await owned();
    if (end === 'parks on main red') {
      assert.equal(current(f, 1).error?.code, 'MAIN_RED', 'the kept entry parks under the main-red hold');
      assert.equal(f.runs().length, 3, 'the follower is not left behind the parked place: it checks');
    }
    for (let wave = 0; f.runs().some(r => ['queued', 'running'].includes(r.status)); wave++) {
      assert(wave < 10, JSON.stringify(states(f)));
      for (const run of f.runs().filter(r => ['queued', 'running'].includes(r.status)))
        await passRun(f, run.id);
      await owned();
    }
    assert(
      states(f).every(s => s.observation.state !== 'pending'),
      `stranded without the stall alarm: ${JSON.stringify(states(f))}`,
    );
    if (end === 'passes') {
      assert.equal(current(f, 1).phase, 'landed', 'the kept entry lands in its queue place');
      assert.equal(current(f, 2).error.code, 'COMPOSITION_CONFLICT');
    } else {
      assert.equal(current(f, 2).phase, 'landed', 'the follower lands once the kept entry leaves its place');
      // Red: the kept entry fails. Parked: main's green release recomposes it on the follower's change.
      assert.equal(current(f, 1).error.code, end === 'red' ? 'CHECK_FAILED' : 'COMPOSITION_CONFLICT');
    }
    assert.equal(f.runs().length, 3);
    assert.equal(pendingTasks(f).length, 0);
  });

/** Review a09af93a nit 4 / 379d19f5 nit 5: a kept run that ends without a failing test (the platform)
 * has lost the elapsed share the keep was for. Restarting it would pay a whole fresh run on its old
 * base plus the scoped recheck; it retires as the main move would have, onto current main, so the
 * entry pays what today's retire pays and no more. */
for (const [name, options] of [
  ['strict', { paths: ORDER_SENSITIVE }],
  ['fast', { paths: ['package.json', 'src/b.ts'], mode: 'fast' }],
  [
    'probe running',
    {
      paths: ['src/shared.ts', 'src/shared.ts'],
      contents: ['A\nb\nc\n', 'a\nb\nC\n'],
      stop: f => Boolean(finishPending(f, 1)?.precompose),
    },
  ],
])
  test(`platform restart (${name}): a kept run without a test result retires onto current main, never a fresh run on its old base`, async t => {
    const { f, runs, before } = await mainMoves(t, options);
    const b = runs[1];
    assert.equal(requestRow(f, 1).admission.kept, true);
    if (options.stop)
      assert(finishPending(f, 1)?.precompose, 'the platform ends the run while its probe runs');
    const outage = 'Provider outage: synthetic Actions runner lost its execution without a verdict.';
    if (name === 'strict')
      await f.runAcceptance(
        'settle provider outage',
        async (ctx, input) => {
          const selected = await writableHostedCheck(ctx, input);
          await settleDirectActions(ctx, selected, 'runner-unavailable', outage);
        },
        { projectId: f.projectId, runId: b.id },
      );
    else
      // Actions completed (failure) without complete job evidence: no test failed.
      await f.rawChecks.callback(f.rawChecks.complete(runOf(f, b.id), 'runner-unavailable'));
    await drain(f);
    const fresh = f.runs().filter(r => r.id !== runs[0].id && r.id !== b.id);
    assert.equal(fresh.length, 1, 'one replacement run');
    if (name === 'strict') assert.equal(fresh[0].failureReason, `provider-delayed: retrying after ${outage}`);
    else assert.match(fresh[0].failureReason, /^provider-delayed: waiting for check infrastructure since /);
    assert.equal(current(f, 1).observation.pendingReason, 'pending-infra');
    const bound = attempts(f, 1).find(a => a.candidate.id === fresh[0].request.candidateId);
    assert(bound, 'the replacement checks an attempt of this entry');
    assert.notEqual(bound.main.head, before.main.head, 'never a fresh run on the old base');
    assert.equal(bound.main.head, f.currentMain().head, 'the replacement checks current main');
    assert.notEqual(requestRow(f, 1).admission.kept, true, 'a retired run is no longer kept');
    assert.equal(requestRow(f, 1).admission.recheck, 'main-moved');
    await settle(f);
    assert.equal(current(f, 1).phase, 'landed');
    assert.equal(f.runs().length, 3, "the platform-ended run plus one exact replacement, as today's retire");
    assert.equal(pendingTasks(f).length, 0);
    const costs = f.counts.slice(before.calls).filter(cost => cost.name !== 'queueInvariantRead');
    t.diagnostic(
      JSON.stringify({
        calls: costs.length,
        readBytes: costs.reduce((n, c) => n + c.readBytes, 0),
        writeBytes: costs.reduce((n, c) => n + c.writeBytes, 0),
      }),
    );
  });

test('platform end with an ordinary finish pending clears kept and preserves the reserved replacement', async t => {
  const { f, runs } = await mainMoves(t, { paths: ORDER_SENSITIVE });
  const b = runs[1];
  const submissionId = current(f, 1).id;
  await f.runAcceptance(
    'reserve ordinary finish',
    async (ctx, input) => {
      const { row, value } = await loadFinish(ctx, input);
      await reserveFinishRetry(ctx, row, value);
    },
    { projectId: f.projectId, submissionId },
  );
  const pending = finishPending(f, 1);
  assert(pending && !pending.precompose);
  const held = new Set([finishRow(f, 1).wake.taskId]);
  await f.rawChecks.callback(f.rawChecks.complete(runOf(f, b.id), 'runner-unavailable'));
  await drainExcept(f, held);
  assert.equal(requestRow(f, 1).admission.status, 'unavailable');
  assert.equal(requestRow(f, 1).admission.kept, undefined);
  assert.deepEqual(finishPending(f, 1), pending, 'the ordinary finish still owns its original claim');
  await settle(f);
  assert.equal(current(f, 1).phase, 'landed');
  assert.equal(f.runs().length, 3, 'one replacement check on the reserved Candidate');
  assert.equal(attemptOf(f, 1).main.head, pending.main.head);
});

test('A3: a fast kept run carries only through the cross-head proof', async t => {
  const { f, runs } = await mainMoves(t, { paths: ['package.json', 'src/b.ts'], mode: 'fast' });
  const b = runs[1];
  assert.equal(runOf(f, b.id).status, 'running');
  assert.equal(requestRow(f, 1).admission.kept, true);
  await passRun(f, b.id);
  await settle(f);
  assert.equal(current(f, 1).phase, 'landed');
  const landedOn = attemptOf(f, 1);
  assert.equal(landedOn.check?.runId, b.id);
  assert(landedOn.crossHeadProof, 'the pass carries with a proof, or not at all');
  assert.equal(f.runs().length, 2, 'the carried pass saves the replacement outright');
});

for (const [name, contents, conflict] of [
  ['conflicting', ['A\nb\nc\n', 'B\nb\nc\n'], true],
  ['clean', ['A\nb\nc\n', 'a\nb\nC\n'], false],
])
  test(`B1: a shared-path run keeps only until its probe answers (${name})`, async t => {
    const probing = f => Boolean(finishPending(f, 1)?.precompose);
    const { f, runs } = await mainMoves(t, {
      paths: ['src/shared.ts', 'src/shared.ts'],
      contents,
      stop: probing,
    });
    const b = runs[1];
    assert(probing(f), 'the sweep reserved the probe in its own transaction');
    assert.equal(runOf(f, b.id).status, 'running');
    assert.equal(requestRow(f, 1).admission.kept, true);
    await drain(f);
    if (conflict) {
      assert.equal(current(f, 1).phase, 'terminal-failed');
      assert.equal(current(f, 1).error.code, 'COMPOSITION_CONFLICT');
      assert.equal(runOf(f, b.id).status, 'cancelled', 'the conflict releases the kept run');
      assert.equal(f.runs().length, 2, 'no replacement run for a real conflict');
      assert.equal(current(f, 1).observation.stall, undefined);
    } else {
      assert.equal(runOf(f, b.id).status, 'running', 'a clean probe leaves the kept run going');
      assert.equal(finishPending(f, 1), null);
      await passRun(f, b.id);
      await settle(f);
      assert.equal(current(f, 1).phase, 'landed');
      assert.equal(f.runs().length, 3, 'kept run plus its scoped recheck');
    }
    assert.equal(pendingTasks(f).length, 0);
  });

for (const [name, options] of [
  ['C1: a coverage mover', ['scripts/browser-test-policy.mjs', 'src/b.ts']],
  ['F2: runner wait (no shard started)', ORDER_SENSITIVE, null],
  ['F2: a run whose shards just started', ORDER_SENSITIVE, 0],
  ['switch off', ORDER_SENSITIVE],
].map(([name, paths, minutes = 12]) => [name, { paths, minutes }]))
  test(`${name} retires the run as today`, async t => {
    if (name === 'switch off') switchOff(t);
    const { f, runs } = await mainMoves(t, options);
    assert.equal(runOf(f, runs[1].id).status, 'cancelled');
    assert.notEqual(requestRow(f, 1).admission?.kept, true);
    await settle(f);
    assert.equal(current(f, 1).phase, 'landed');
    assert.equal(f.runs().length, 3, 'one cancelled run plus the ordinary exact recheck');
  });

/** Review 0c7f9440 finding 4: entry 2 shares src/shared.ts with mover 1 and is kept with a probe.
 * The probe is held (the platform has not run it yet) while mover 2 (entry 1) lands. */
for (const [name, mover2, conflict = false] of [
  ['a second mover that keeps the run retargets the running probe to the new main', 'convex/schema.ts'],
  ['an unrelated second mover leaves the probe and reads nothing more, as today', 'src/other.ts'],
  [
    'a cancelling second mover claims the running probe and retires the run',
    'scripts/browser-test-policy.mjs',
  ],
  // Review a09af93a finding 2: the sweep skips the row for mover 2, so the probe answers on main 1.
  [
    'an unrelated second mover: a conflicting probe still ends the run before it passes',
    'src/other.ts',
    true,
  ],
])
  test(`finding 4: ${name}`, async t => {
    const f = await fixture(t, {
      memberPaths: ['src/shared.ts', mover2, 'src/shared.ts'],
      memberContents: ['A\nb\nc\n', 'other\n', conflict ? 'B\nb\nc\n' : 'a\nb\nC\n'],
      landingMode: 'strict',
      concurrency: 1,
      conflict: false,
      count: 0,
    });
    seedCosts(f);
    await directOnGreen(f);
    for (let i = 0; i < 3; i++) await f.add(i);
    await drain(f);
    const [a, b, c] = f.runs();
    await f.rawChecks.activate(b.id);
    await f.rawChecks.activate(c.id);
    startShards(f, c.id, 12);
    echoFullGate(f, c.id);
    const probing = () => Boolean(finishPending(f, 2)?.precompose);
    await f.rawChecks.pass(await f.rawChecks.activate(a.id));
    await drain(f, () => probing());
    assert(probing(), 'mover 1 kept entry 2 with a probe');
    assert.equal(runOf(f, b.id).status, 'running', 'entry 1 is unrelated to mover 1: kept as today');
    // The platform has not run the probe yet; mover 2 lands meanwhile.
    const held = new Set([finishRow(f, 2).wake.taskId]);
    const main1 = f.currentMain();
    assert.equal(finishPending(f, 2).main.head, main1.head);
    await drainExcept(f, held);
    await f.rawChecks.pass(runOf(f, b.id));
    await drainExcept(f, held);
    // A global mover 2 rechecks before it lands (strict); entry 2's kept run and probe stay as they are.
    for (let wave = 0; current(f, 1).phase !== 'landed'; wave++) {
      assert(wave < 5, JSON.stringify(current(f, 1)));
      for (const run of f.runs().filter(r => r.id !== c.id && ['queued', 'running'].includes(r.status)))
        await passRun(f, run.id);
      await drainExcept(f, held);
    }
    const main2 = f.currentMain();
    assert.notEqual(main2.head, main1.head);
    if (conflict) {
      assert.equal(runOf(f, c.id).status, 'running');
      await drain(f);
      assert.equal(current(f, 2).phase, 'terminal-failed', 'the conflict ends the landing early');
      assert.equal(current(f, 2).error.code, 'COMPOSITION_CONFLICT');
      assert.equal(runOf(f, c.id).status, 'cancelled', 'the conflict releases the kept run');
      assert.equal(f.runs().length, 3, 'no replacement or recheck run');
    } else if (mover2 === 'convex/schema.ts') {
      assert.equal(runOf(f, c.id).status, 'running');
      assert.equal(
        finishPending(f, 2).precompose.next.main.head,
        main2.head,
        'the probe answers on main 2 too',
      );
      await drain(f);
      assert.equal(finishPending(f, 2), null, 'clean on current main');
      assert.equal(JSON.parse(finishRow(f, 2).value).precomposed?.main.head, main2.head);
      await passRun(f, c.id);
      await settle(f);
      assert.equal(current(f, 2).phase, 'landed');
    } else if (mover2 === 'src/other.ts') {
      // A path-disjoint mover cannot change the probe's answer; the finish composes on current main.
      assert.equal(runOf(f, c.id).status, 'running');
      assert.equal(finishPending(f, 2).precompose.next, undefined);
      await drain(f);
      assert.equal(finishPending(f, 2), null);
      await passRun(f, c.id);
      await settle(f);
      assert.equal(current(f, 2).phase, 'landed');
      assert.equal(f.runs().length, 4, 'entry 2: kept run plus its scoped recheck');
    } else {
      assert.equal(runOf(f, c.id).status, 'cancelled', 'a cancel during the probe retires the run');
      assert.equal(requestRow(f, 2).admission.status, 'unavailable');
      assert.equal(requestRow(f, 2).admission.kept, undefined, 'a retired run is no longer kept');
      assert.equal(finishPending(f, 2)?.precompose, undefined, 'the probe was claimed, not left running');
      await settle(f);
      assert.equal(current(f, 2).phase, 'landed');
    }
    assert.equal(pendingTasks(f).length, 0);
  });

test('finding 4: up to eight kept rows are probed in the sweep itself, outside the precompose budget', async t => {
  const f = await fixture(t, {
    memberPaths: Array(10).fill('src/shared.ts'),
    memberContents: Array.from({ length: 10 }, (_, i) => `member ${i}\n`),
    landingMode: 'strict',
    concurrency: 1,
    conflict: false,
    count: 0,
  });
  seedCosts(f);
  await directOnGreen(f);
  for (let i = 0; i < 10; i++) await f.add(i);
  await drain(f);
  const runs = f.runs();
  for (const run of runs.slice(1)) {
    await f.rawChecks.activate(run.id);
    startShards(f, run.id, 12);
    echoFullGate(f, run.id);
  }
  await f.rawChecks.pass(await f.rawChecks.activate(runs[0].id));
  await drain(f, task => task.name === 'projectHostedAcceptance:complete');
  const [complete] = pendingTasks(f);
  assert.equal(complete.name, 'projectHostedAcceptance:complete');
  await f.execute(complete);
  // The sweep's transaction reserved every probe itself: no precompose pass (PRECOMPOSE_ENTRIES) ran.
  for (let i = 1; i <= 8; i++) {
    assert(finishPending(f, i)?.precompose, `entry ${i} probed`);
    assert.equal(runOf(f, runs[i].id).status, 'running');
  }
  assert.equal(finishPending(f, 9), null, 'the ninth entry remains outside the sweep look-ahead');
  await drain(f);
  for (let i = 1; i <= 8; i++) {
    assert.equal(current(f, i).error?.code, 'COMPOSITION_CONFLICT', `entry ${i}`);
    assert.equal(runOf(f, runs[i].id).status, 'cancelled');
  }
  assert.equal(f.runs().length, 10, 'eight conflicts end with no replacement run');
});

test('A5: an empty sweep with the switch on reads zero DB bytes and schedules nothing', async t => {
  const f = await fixture(t, { count: 1 });
  await settle(f);
  const before = f.counts.length;
  const retired = await f.transaction(
    'empty-keep-pass',
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
  );
  assert.equal(retired, 0);
  const [cost] = f.counts.slice(before);
  assert.equal(cost.readBytes, 0);
  assert.equal(cost.writes, 0);
  assert.equal(pendingTasks(f).length, 0);
});

/** Done-when line 3 (lead reading 2026-11-19 17:50Z): carry and red keeps cost no more Convex calls
 * than the retire they replace; a scoped-recheck keep may add calls within the owner's cap. Measured
 * from the mover's pass until every landing settles, on the same scenario with the switch off and on,
 * and held exactly to the measured `WIRED` deltas the scenario table prices (calls and bytes). The
 * fixture's runner reports in few calls: the carry's saved replacement run would also have paid the real
 * runner's ingest and source resolve (17.4 calls), which the table credits. */
async function lifecycle(t, { paths, mode, red, on }) {
  if (!on) switchOff(t);
  const { f, runs, before } = await mainMoves(t, { paths, mode });
  const kept = runOf(f, runs[1].id).status === 'running';
  for (let wave = 0; states(f).some(s => s.observation.state === 'pending'); wave++) {
    assert(wave < 20, JSON.stringify(states(f)));
    for (const run of f.runs().filter(r => ['queued', 'running'].includes(r.status))) {
      if (run.status === 'queued') await f.rawChecks.activate(run.id);
      if (red) await failRun(f, run.id);
      else await passRun(f, run.id);
    }
    await drain(f);
  }
  if (!on) process.env[SWITCH] = '1';
  const costs = f.counts.slice(before.calls).filter(cost => cost.name !== 'queueInvariantRead');
  return {
    kept,
    phase: current(f, 1).phase,
    runs: f.runs().length,
    calls: costs.length,
    readBytes: costs.reduce((sum, cost) => sum + cost.readBytes, 0),
    writeBytes: costs.reduce((sum, cost) => sum + cost.writeBytes, 0),
    aliasWriteBytes: costs.reduce((sum, cost) => sum + metricAliasProjectionCounts(cost).writeBytes, 0),
  };
}
for (const [name, options, kind] of [
  ['carry (fast)', { paths: ['package.json', 'src/b.ts'], mode: 'fast' }, 'carry'],
  ['red kept run', { paths: ORDER_SENSITIVE, mode: 'strict', red: true }, 'red'],
  ['scoped recheck', { paths: ORDER_SENSITIVE, mode: 'strict' }, 'scoped-recheck'],
])
  test(`line 3: a ${name} keep against the retire it replaces`, async t => {
    // One clock for ISO stamps, scheduler time and measured step durations, as the storage ratchets
    // use: the deltas are exact bytes, not a wall-clock-dependent spread (review a09af93a finding 3).
    storageClock(t, { elapsed: true });
    const retire = await lifecycle(t, { ...options, on: false });
    const keep = await lifecycle(t, { ...options, on: true });
    t.diagnostic(JSON.stringify({ name, retire, keep }));
    assert.equal(retire.kept, false);
    assert.equal(keep.kept, true);
    assert.equal(keep.phase, retire.phase, 'the same outcome');
    // A cancelled run counts as a run: carry and red save the replacement; a scoped keep swaps it for a
    // scoped recheck.
    assert(kind === 'scoped-recheck' ? keep.runs === retire.runs : keep.runs < retire.runs);
    const delta = {
      calls: keep.calls - retire.calls,
      readBytes: keep.readBytes - retire.readBytes,
      // The alias ledger separately prices the leaf writes that vary with check outcome.
      writeBytes: keep.writeBytes - keep.aliasWriteBytes - (retire.writeBytes - retire.aliasWriteBytes),
    };
    t.diagnostic(JSON.stringify({ kind, delta }));
    // Calls exact; bytes within the band of the pin, both ways (review 379d19f5 nit 4): a drop past the
    // band fails too, so WIRED and the prices built on it (keep-the-run-scenarios.mjs) ratchet down with
    // the change that earned it. Item 168e4ed8: small stored-byte growth no longer re-pins the row.
    const problems = wiredProblems(kind, WIRED[kind], delta);
    assert.deepEqual(problems, [], problems.join('\n'));
  });

/** Incident fa2c1383 replay (regression ladder rung 3): the guards above catch the wiring's own
 * regressions. A child runs this file on mutant source: once with the sweep's keep switched off (the
 * 11-17 incident: the kept run is thrown away), once with a follower stacked on a kept run when the
 * pipeline is full (it then strands, L5b), and once per review finding below. Each named guard must
 * fail there, by name. */
const MUTANTS = [
  {
    name: 'A3/F3: a strict kept run holds order, keeps its attempt, and lands only after a scoped recheck',
    patches: [
      {
        file: 'convex/projectHostedLandingStaleChecks.ts',
        find: '  const keep = keepTheRunOn() && !!project;',
        replace: '  const keep = false && keepTheRunOn() && !!project;',
      },
    ],
  },
  {
    name: `${A2_FULL} (follower passes first)`,
    patches: [
      {
        file: 'convex/projectHostedLandingAdmissionPipeline.ts',
        find: '!(keptSeed && full)',
        replace: '!(keptSeed && full && false)',
      },
    ],
  },
  // Review a09af93a finding 1: the cohort hold parks the kept entry and the follower lands first, in
  // both timings the review named (379d19f5 nit 3).
  ...['follower passes first', 'both pass together'].map(timing => ({
    name: `${A2_FULL} (${timing})`,
    patches: [
      {
        file: 'convex/projectHostedLandingCohortHold.ts',
        find: '    admission.kept ||\n',
        replace: '',
      },
    ],
  })),
  // Review a09af93a nit 4: a kept run's platform end restarts a whole run on its old base.
  {
    name: 'platform restart (strict): a kept run without a test result retires onto current main, never a fresh run on its old base',
    patches: [
      {
        file: 'convex/projectHostedLandingAdmission.ts',
        find: "if (row.admission.kept && kind === 'platform') {",
        replace: 'if (false) {',
      },
      {
        file: 'convex/projectHostedLandingAdmission.ts',
        find: 'row.admission.full && !row.admission.kept && kind',
        replace: 'row.admission.full && kind',
      },
    ],
  },
  // Review a09af93a nit 6: a kept run's settle wakes no queue tick, so the fast follower stacked on it
  // strands.
  {
    name: 'A2 fast: with the pipeline full, a follower stacked on a kept run is driven by its settle (kept run passes)',
    patches: [
      {
        file: 'convex/projectHostedLandingAdmission.ts',
        find: "  if (settled === 'tests') await settleLandingOperation(ctx, next);\n  return true;\n}",
        replace:
          "  if (settled === 'tests') await settleLandingOperation(ctx, next);\n  return !admission.kept;\n}",
      },
    ],
  },
  // Review 018569e9 finding 1: a kept run's main-red park releases its place but wakes no queue.
  {
    name: 'A2 fast: with the pipeline full, a follower stacked on a kept run is driven by its settle (kept run parks on main red)',
    patches: [
      {
        file: 'convex/projectHostedLandingAdmission.ts',
        find: 'return Boolean(row.admission.kept);',
        replace: 'return false;',
      },
    ],
  },
  // Review a09af93a finding 2: the obsolete conflict is dropped and the kept run goes on.
  {
    name: 'finding 4: an unrelated second mover: a conflicting probe still ends the run before it passes',
    patches: [
      {
        file: 'convex/projectHostedFinishCompose.ts',
        find: "state.phase === 'checking' && keepTheRunOn()",
        replace: "state.phase === 'checking' && false",
      },
    ],
  },
];
if (!process.env.FORGE_TEST_SOURCE_PATCHES)
  test('incident fa2c1383 wiring: the guards fail on the incident, stranded followers, a parked kept run, a stale-base restart and a dropped conflict', async () => {
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    for (const mutant of MUTANTS) {
      const environment = {
        ...process.env,
        FORGE_TEST_SOURCE_PATCHES: JSON.stringify(mutant.patches),
        FORGE_TEST_PRECOMPILED: '0',
      };
      delete environment.NODE_TEST_CONTEXT;
      const pattern = `^${mutant.name.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`;
      const output = await promisify(execFile)(
        process.execPath,
        [
          '--import',
          './tests/check-runtime.mjs',
          '--test',
          '--test-reporter=tap',
          `--test-name-pattern=${pattern}`,
          'tests/hosted-landing-keep-the-run.test.mjs',
        ],
        { env: environment, maxBuffer: 8 * 1024 * 1024 },
      ).then(
        ({ stdout }) => stdout,
        error => error.stdout ?? '',
      );
      assert.match(output, new RegExp(`^not ok \\d+ - ${pattern.slice(1, -1)}$`, 'm'), mutant.name);
    }
  });
