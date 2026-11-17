// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readLandingTransition } from '../dist/hosted-landing.js';
import { statsDay } from '../dist/stats-estimate.js';
import { batchesFixture, states, synthetic } from './hosted-landing-batches-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const { cancelledJobUsage, adjustClosedRunnerDay, pendingRunnerState } = await import(
  moduleUrl('../convex/cancelledRunUsage.ts')
);
const usageApi = await import(moduleUrl('../convex/projectCancelledRunUsage.ts'));
const { hostedVerdictKey } = await import('../dist/hosted-check-evidence.js');
const statsApi = await import(moduleUrl('../convex/projectStats.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.beforeEach(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const jobs = (extra = {}) => ({
  total_count: 3,
  jobs: [
    {
      id: 1,
      run_id: 123,
      run_attempt: 1,
      status: 'completed',
      conclusion: 'cancelled',
      started_at: '2026-11-17T23:59:00Z',
      completed_at: '2026-11-18T00:01:00Z',
    },
    {
      id: 2,
      run_id: 123,
      run_attempt: 1,
      status: 'completed',
      conclusion: 'success',
      started_at: '2026-11-17T23:59:30Z',
      completed_at: '2026-11-18T00:01:00Z',
    },
    {
      id: 3,
      run_id: 123,
      run_attempt: 1,
      status: 'completed',
      conclusion: 'skipped',
      started_at: null,
      completed_at: null,
    },
  ],
  ...extra,
});

test('cancelled provider jobs count their actual elapsed runner minutes across UTC midnight', () => {
  const measured = cancelledJobUsage(jobs(), '123');
  assert.equal(measured.seconds, 210);
  assert.equal(measured.receipt.sha256.length, 64);
  for (const changed of [
    { total_count: 4 },
    { jobs: jobs().jobs.map((j, i) => (i === 0 ? { ...j, run_id: 999 } : j)) },
    { jobs: jobs().jobs.map((j, i) => (i === 0 ? { ...j, completed_at: null } : j)) },
    { jobs: jobs().jobs.map((j, i) => (i === 0 ? { ...j, status: 'in_progress' } : j)) },
  ])
    assert.equal(cancelledJobUsage(jobs(changed), '123'), null, 'unproven usage stays unknown');
});

const landing = (patch = {}) => ({
  id: 'r',
  who: 'builder',
  submittedAt: 0,
  landedAt: 600_000,
  checkStartedAt: 60_000,
  checkEndedAt: 300_000,
  runnerSeconds: 300,
  discardedRunnerSeconds: null,
  attempts: null,
  ranInFull: true,
  ...patch,
});
test('a late correction adjusts a closed UTC day without rebuilding its queue replay or distributions', () => {
  const before = landing(),
    after = landing({ discardedRunnerSeconds: 210, attempts: 2 });
  const closed = statsDay('2026-11-17', [before]);
  const corrected = adjustClosedRunnerDay(closed, before, after, 2);
  assert.equal(corrected.day, '2026-11-17');
  assert.equal(
    corrected.runner.acceptedSeconds,
    300,
    'accepted usage joins the priced cohort once cancellation is known',
  );
  assert.equal(corrected.runner.discardedSeconds, 210);
  assert.equal(corrected.runner.priced, 1);
  assert.equal(corrected.runner.unknown, 0);
  assert.equal(corrected.replay.runs, 2);
  assert.equal(corrected.replay.reruns, 2);
  assert.deepEqual(corrected.toMain, closed.toMain);
  assert.deepEqual(corrected.stops, closed.stops);
  assert.deepEqual(corrected.replay.toMain, closed.replay.toMain);
  assert.equal(corrected.replay.freeAt, closed.replay.freeAt);
  assert.equal(closed.runner.acceptedSeconds, 0, 'unpriced landing contributes no accepted-only numerator');
  const unknownAccepted = landing({ runnerSeconds: null });
  const stillUnknown = landing({
    runnerSeconds: null,
    discardedRunnerSeconds: 210,
  });
  const unknownDay = statsDay('2026-11-17', [unknownAccepted]);
  assert.deepEqual(
    adjustClosedRunnerDay(unknownDay, unknownAccepted, stillUnknown).runner,
    unknownDay.runner,
    'a known discarded amount is not priced while accepted usage remains unknown',
  );

  const known = landing({ discardedRunnerSeconds: 0, attempts: 1 });
  const pricedDay = statsDay('2026-11-17', [known]);
  const pendingAfterClose = adjustClosedRunnerDay(pricedDay, known, before, 2);
  assert.equal(pendingAfterClose.runner.unknown, 1);
  assert.equal(pendingAfterClose.runner.acceptedSeconds, 0);
  assert.equal(pendingAfterClose.firstTry.counted, 0);
  const completedAfterClose = adjustClosedRunnerDay(pendingAfterClose, before, after, 2);
  assert.equal(completedAfterClose.runner.unknown, 0);
  assert.equal(completedAfterClose.runner.discardedSeconds, 210);
  assert.equal(completedAfterClose.firstTry.first, 0);
  assert.deepEqual(completedAfterClose.replay.toMain, pricedDay.replay.toMain);
});

async function cancelledFixture(t, accounting = true) {
  const f = await batchesFixture(t, { count: 2 });
  await f.drain();
  const row = [...f.tables.projectHostedCheckRuns.values()].find(
    r => JSON.parse(r.value).status === 'queued',
  );
  assert(
    row?.cancelledUsage?.submissions.length === 2,
    'dispatch retains both original submission identities',
  );
  if (!accounting) f.patch('projectHostedCheckRuns', row._id, { cancelledUsage: undefined });
  const run = JSON.parse(row.value);
  f.patch('projectHostedCheckRuns', row._id, { value: JSON.stringify({ ...run, executionId: '123' }) });
  const cancelAt = f.counts.length;
  await f.rawChecks.cancel(row.runId);
  f.cancelMeters = f.counts.slice(cancelAt);
  const passChecks = f.passChecks;
  f.passChecks = async () => {
    await passChecks();
    for (const r of f.tables.projectHostedCheckRuns.values()) {
      const passed = JSON.parse(r.value);
      if (passed.status !== 'passed' || passed.execution) continue;
      const stamped = { ...passed, execution: { seconds: 300, shards: passed.plan.shardCount } };
      f.patch('projectHostedCheckRuns', r._id, {
        value: JSON.stringify(stamped),
        verdictKey: hostedVerdictKey(stamped),
      });
    }
  };
  return { f, row, runId: row.runId, fence: run.fence };
}
const finish = async f => {
  for (let i = 0; i < 5 && states(f).some(s => s.phase !== 'landed'); i++) {
    await f.drain();
    await f.passChecks();
    await f.drain();
  }
  assert(states(f).every(s => s.phase === 'landed'));
};

test('cancelled usage stays pending until completion, is shared once, and corrects its closed landing day idempotently', async t => {
  const { f, row, runId, fence } = await cancelledFixture(t);
  for (const r of f.tables.projectHostedLandingRequests.values()) assert.equal(r.runnerAccounting.pending, 1);
  assert.equal(JSON.parse(row.value).cost.status, 'unknown');
  const { landingCosts } = await import('../dist/hosted-landings-view.js');
  for (const r of f.tables.projectHostedLandingRequests.values())
    assert.equal(
      landingCosts(pendingRunnerState(JSON.parse(r.value), r.runnerAccounting.pending), 0).runnerDiscarded,
      null,
    );
  await finish(f);
  const { repairLandingSpeedPage } = await import(moduleUrl('../convex/projectLandingSpeedRepair.ts'));
  await f.tx(
    'repairCannotPricePending',
    { _handler: ctx => repairLandingSpeedPage(ctx, f.projectId, '', Date.now()) },
    {},
  );
  assert(
    [...f.tables.projectLandingSpeed.values()].every(r =>
      JSON.parse(r.value).samples.every(s => s[7][4] === null),
    ),
    'existing maintenance cannot turn pending cancellation into a known zero',
  );
  const pending = [...f.tables.projectHostedLandingRequests.values()];
  const receipts = [...f.tables.projectHostedAcceptances.values()];
  const day = new Date(receipts[0]._creationTime).toISOString().slice(0, 10);
  for (const receiptRow of receipts) {
    const owner = pending.find(r => r.submissionId === receiptRow.submissionId);
    const state = JSON.parse(owner.value);
    // Construct the synthetic receipt birth time; production system fields are immutable.
    f.tables.projectHostedAcceptances.set(receiptRow._id, {
      ...receiptRow,
      _creationTime: Date.parse(day) + 100,
    });
    f.patch('projectHostedLandingRequests', owner._id, {
      value: JSON.stringify({
        ...state,
        timing: { ...state.timing, committedAt: new Date(Date.parse(day) - 100).toISOString() },
      }),
    });
  }
  const priorDay = new Date(Date.parse(day) - 86400000).toISOString().slice(0, 10);
  await f.tx('closePreviousUtcDay', statsApi.closeDay, { projectId: f.projectId, day: priorDay });
  const previous = [...f.tables.projectStatsDays.values()].find(r => r.day === priorDay);
  const previousValue = previous.value;
  await f.tx('closeBeforeUsage', statsApi.closeDay, { projectId: f.projectId, day });
  const closed = [...f.tables.projectStatsDays.values()].find(r => r.day === day);
  // Price the correction at the real day-close cap, without rebuilding that day
  // in product code. Unrelated original contributions must remain untouched.
  const actual = receipts.map(receiptRow => {
    const receipt = JSON.parse(receiptRow.value);
    const owner = [...f.tables.projectHostedLandingRequests.values()].find(
      r => r.submissionId === receipt.submissionId,
    );
    return statsApi.statsLanding(receipt, JSON.parse(owner.value), owner.runnerAccounting.pending);
  });
  const synthetic = Array.from({ length: 998 }, (_, i) =>
    landing({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      who: `synthetic-${i}`,
      discardedRunnerSeconds: 0,
      attempts: 1,
    }),
  );
  f.patch('projectStatsDays', closed._id, {
    value: JSON.stringify(statsDay(day, [...actual, ...synthetic])),
    runnerContributions: [
      ...closed.runnerContributions,
      ...synthetic.map(l => ({ submissionId: l.id, reruns: 0 })),
    ],
  });
  const original = JSON.parse(f.tables.projectStatsDays.get(closed._id).value);
  f.advanceClock(86_400_000); // The provider completion arrives after the landing day closed.
  assert.equal(original.runner.unknown, 2, 'both included landings are pending at close');
  const countsAt = f.counts.length;
  const input = {
    projectId: f.projectId,
    runId,
    fence,
    executionId: '123',
    usage: cancelledJobUsage(jobs(), '123'),
  };
  await f.tx('lateUsage', usageApi.complete, input);
  const after = [...f.tables.projectHostedLandingRequests.values()];
  assert.equal(
    after.reduce((n, r) => n + JSON.parse(r.value).counts.discardedRunnerSeconds, 0),
    210,
  );
  assert(after.every(r => r.runnerAccounting.pending === 0));
  assert.equal(JSON.parse(f.tables.projectHostedCheckRuns.get(row._id).value).cost.seconds, 210);
  assert.equal(JSON.parse(f.tables.projectStatsDays.get(closed._id).value).runner.unknown, 0);
  assert.equal(
    JSON.parse(f.tables.projectStatsDays.get(closed._id).value).runner.discardedSeconds -
      original.runner.discardedSeconds,
    210,
  );
  assert.deepEqual(JSON.parse(f.tables.projectStatsDays.get(closed._id).value).toMain, original.toMain);
  assert.equal(
    f.tables.projectStatsDays.get(previous._id).value,
    previousValue,
    'commit day is not the receipt creation day',
  );
  const snapshot = JSON.stringify(after.map(r => [r.value, r.runnerAccounting]));
  await f.tx('lateUsageReplay', usageApi.complete, input);
  assert.equal(JSON.stringify(after.map(r => [r.value, r.runnerAccounting])), snapshot);
  assert.equal(f.counts.at(-1).writes, 0, 'run id fences duplicate correction writes');
  await assert.rejects(
    f.tx('changedUsageReplay', usageApi.complete, { ...input, usage: { ...input.usage, seconds: 999 } }),
    e => (e.code ?? e.data?.code) === 'EVIDENCE_CHANGED',
  );
  console.log(
    'cancelled-usage-cost',
    JSON.stringify(
      f.counts.slice(countsAt).map(c => ({
        name: c.name,
        documents: c.documents,
        writes: c.writes,
        readBytes: c.readBytes,
        writeBytes: c.writeBytes,
      })),
    ),
  );
});

test('late accounting preserves accepted main cancelled-cohort decisions and all 22 transitions', async t => {
  const scenarios = [],
    cancellationCosts = [];
  for (const accounting of [false, true]) {
    const { f, runId, fence } = await cancelledFixture(t, accounting);
    cancellationCosts.push(
      f.cancelMeters.reduce(
        (a, c) => ({
          documents: a.documents + c.documents,
          writes: a.writes + c.writes,
          readBytes: a.readBytes + c.readBytes,
          writeBytes: a.writeBytes + c.writeBytes,
        }),
        { documents: 0, writes: 0, readBytes: 0, writeBytes: 0 },
      ),
    );
    if (accounting)
      await f.tx('completeBeforeQueueContinues', usageApi.complete, {
        projectId: f.projectId,
        runId,
        fence,
        executionId: '123',
        usage: cancelledJobUsage(jobs(), '123'),
      });
    await finish(f);
    if (!accounting)
      assert.deepEqual(
        states(f).map(s => s.counts),
        Array.from({ length: 2 }, () => ({
          runnerSeconds: 150,
          discardedRunnerSeconds: 0,
          discardedRunnerUnknown: 'superseded-check-execution-unreported',
        })),
        'without a durable usage target, final minute counts match main and remain unknown',
      );
    const members = [...f.tables.projectHostedLandingRequests.values()].map(r => r.submissionId);
    const trace = [...f.tables.projectHostedLandingObservations.values()].map(r => {
      const current = states(f).find(s => s.id === r.submissionId);
      const event = readLandingTransition(r.value, current),
        state = event.submission;
      return {
        member: members.indexOf(r.submissionId),
        version: r.version,
        phase: state.phase,
        sequence: state.sequence,
        observation: {
          ...state.observation,
          ...(state.observation.stall
            ? {
                stall: (() => {
                  const { alarmAt, lastProgressAt, ...decision } = state.observation.stall;
                  return { ...decision, alarmDelayMs: Date.parse(alarmAt) - Date.parse(lastProgressAt) };
                })(),
              }
            : {}),
        },
        pendingPhase: event.pendingAttempt?.phase ?? null,
      };
    });
    scenarios.push({
      trace,
      phases: states(f).map(s => s.phase),
      attempts: states(f).map(
        s => [...f.tables.projectHostedLandingAttempts.values()].filter(r => r.submissionId === s.id).length,
      ),
      checks: [...f.tables.projectHostedCheckRuns.values()].map(r => JSON.parse(r.value).status),
      accepts: f.publications.map(p => ({ receipts: p.receipts, mainMoves: p.mainMoves, landed: p.landed })),
      waits: states(f).map(s => s.observation.pendingReason ?? null),
    });
  }
  const baseline = JSON.parse(
    readFileSync(new URL('./fixtures/cancelled-cohort-main-trace.json', import.meta.url)),
  ).scenario;
  for (const scenario of scenarios) {
    assert.deepEqual(
      scenario,
      baseline,
      'compare with the trace captured by executing accepted main batch-check code',
    );
    assert.equal(scenario.trace.length, 22);
    assert.deepEqual(
      [0, 1].map(member => Math.max(...scenario.trace.filter(s => s.member === member).map(s => s.version))),
      [11, 9],
    );
  }
  console.log(
    'cancelled-pending-cost',
    JSON.stringify({
      without: cancellationCosts[0],
      with: cancellationCosts[1],
      added: Object.fromEntries(
        Object.keys(cancellationCosts[0]).map(k => [k, cancellationCosts[1][k] - cancellationCosts[0][k]]),
      ),
    }),
  );
});

test('the existing completion collector reads bounded job pages once and publishes one usage correction', async t => {
  const { generateKeyPairSync } = await import('node:crypto');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const priorId = process.env.GITHUB_APP_ID,
    priorKey = process.env.GITHUB_APP_PRIVATE_KEY;
  process.env.GITHUB_APP_ID = '123';
  process.env.GITHUB_APP_PRIVATE_KEY = privateKey.export({ type: 'pkcs8', format: 'pem' });
  t.after(() => {
    if (priorId === undefined) delete process.env.GITHUB_APP_ID;
    else process.env.GITHUB_APP_ID = priorId;
    if (priorKey === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY;
    else process.env.GITHUB_APP_PRIVATE_KEY = priorKey;
  });
  const target = {
    projectId: 'p',
    runId: 'r',
    fence: 1,
    executionId: '123',
    repository: 'synthetic/checks',
    runnerScope: { repoId: 7, installationId: 42 },
  };
  const corrections = [],
    pages = [];
  const all = Array.from({ length: 101 }, (_, i) => ({ ...jobs().jobs[0], id: i + 1 }));
  const ctx = { runMutation: async (_ref, args) => corrections.push(args) };
  const request = async url => {
    if (url.endsWith('/installation')) return Response.json({ id: 42 });
    if (url.endsWith('/access_tokens')) return Response.json({ token: 'synthetic-only-token' });
    const page = Number(new URL(url).searchParams.get('page'));
    pages.push(page);
    return Response.json({ total_count: all.length, jobs: all.slice((page - 1) * 100, page * 100) });
  };
  await usageApi.collectCancelledUsage(ctx, target, request);
  assert.deepEqual(pages, [1, 2]);
  assert.equal(corrections.length, 1);
  assert.equal(corrections[0].usage.seconds, 101 * 120);
  corrections.length = 0;
  await assert.rejects(
    usageApi.collectCancelledUsage(ctx, target, async url =>
      url.endsWith('/installation') ? Response.json({ id: 99 }) : request(url),
    ),
    e => e.code === 'GITHUB_REPOSITORY_UNBOUND',
  );
  assert.equal(corrections.length, 0, 'changed installation cannot record usage');
  await usageApi.collectCancelledUsage(ctx, target, async url => {
    if (url.includes('/jobs?')) return Response.json({ total_count: 101, jobs: [] });
    return request(url);
  });
  assert.equal(corrections.length, 0, 'missing provider timing remains unknown, never zero');
});

test('provider timings arriving before Forge cancellation survive the existing report-collector ordering', async t => {
  const f = await batchesFixture(t, { count: 2 });
  await f.drain();
  const row = [...f.tables.projectHostedCheckRuns.values()].find(
    r => JSON.parse(r.value).status === 'queued',
  );
  const run = JSON.parse(row.value);
  f.patch('projectHostedCheckRuns', row._id, { value: JSON.stringify({ ...run, executionId: '123' }) });
  const input = {
    projectId: f.projectId,
    runId: row.runId,
    fence: run.fence,
    executionId: '123',
    usage: cancelledJobUsage(jobs(), '123'),
  };
  await f.tx('earlyProviderUsage', usageApi.complete, input);
  assert.equal(JSON.parse(f.tables.projectHostedCheckRuns.get(row._id).value).status, 'queued');
  assert.equal(f.tables.projectHostedCheckRuns.get(row._id).cancelledUsage.final.seconds, 210);
  await f.tx('earlyProviderReplay', usageApi.complete, input);
  assert.equal(f.counts.at(-1).writes, 0);
  assert([...f.tables.projectHostedLandingRequests.values()].every(r => r.runnerAccounting.pending === 0));
  await assert.rejects(
    f.tx('wrongProvider', usageApi.complete, { ...input, executionId: '999' }),
    e => (e.code ?? e.data?.code) === 'EVIDENCE_CHANGED',
  );
  const { internalMutation } = await import(moduleUrl('../convex/server.ts'));
  const { cancelHostedCheck } = await import(moduleUrl('../convex/projectHostedCheckCancel.ts'));
  const { v } = await import('convex/values');
  const snapshots = [...f.tables.projectHostedLandingRequests.values()].map(r => ({
    id: r._id,
    value: r.value,
  }));
  const cancelThenWriteEarlierSnapshot = internalMutation({
    args: {},
    returns: v.null(),
    handler: async ctx => {
      await cancelHostedCheck(ctx, { projectId: f.projectId, runId: row.runId });
      // A queue caller may still publish the snapshot it held before cancelling.
      for (const snapshot of snapshots) await ctx.db.patch(snapshot.id, { value: snapshot.value });
      return null;
    },
  });
  await f.tx('cancelThenWriteEarlierSnapshot', cancelThenWriteEarlierSnapshot, {});
  const owners = [...f.tables.projectHostedLandingRequests.values()];
  assert(owners.every(r => r.runnerAccounting.pending === 0));
  assert.equal(
    owners.reduce((n, r) => n + JSON.parse(r.value).counts.discardedRunnerSeconds, 0),
    210,
  );
  await f.tx('afterEarlyUsageReplay', usageApi.complete, input);
  assert.equal(f.counts.at(-1).writes, 0);
});

test('an eight-member cancelled cohort accounts by original submission in bounded metadata work', async t => {
  const f = await batchesFixture(t, { count: 8 });
  await f.drain();
  const row = [...f.tables.projectHostedCheckRuns.values()].find(
    r => JSON.parse(r.value).status === 'queued',
  );
  const run = JSON.parse(row.value);
  f.patch('projectHostedCheckRuns', row._id, { value: JSON.stringify({ ...run, executionId: '123' }) });
  const checks = await import(moduleUrl('../convex/projectHostedChecks.ts'));
  await f.tx('cohortCancel', checks.cancel, {
    projectId: f.projectId,
    request: JSON.stringify({ runId: row.runId, authorityEpoch: 1, operationId: crypto.randomUUID() }),
  });
  const pending = f.counts.at(-1);
  await f.tx('cohortUsage', usageApi.complete, {
    projectId: f.projectId,
    runId: row.runId,
    fence: run.fence,
    executionId: '123',
    usage: cancelledJobUsage(jobs(), '123'),
  });
  const complete = f.counts.at(-1);
  for (const meter of [pending, complete]) {
    assert(meter.documents < 100 && meter.writes < 40);
    assert(meter.readBytes < 256 * 1024 && meter.writeBytes < 128 * 1024);
  }
  const owners = [...f.tables.projectHostedLandingRequests.values()];
  assert.equal(
    owners.reduce((n, r) => n + JSON.parse(r.value).counts.discardedRunnerSeconds, 0),
    210,
  );
  assert(owners.every(r => r.runnerAccounting.pending === 0));
  console.log(
    'cancelled-eight-cost',
    JSON.stringify(
      [pending, complete].map(c => ({
        name: c.name,
        documents: c.documents,
        writes: c.writes,
        readBytes: c.readBytes,
        writeBytes: c.writeBytes,
      })),
    ),
  );
});

test('unavailable accounting authority cannot change the completion decision, and a pass adds no reads', async () => {
  const ctx = {
    db: {
      get: async () => {
        throw Error('binding unavailable');
      },
      query: () => {
        throw Error('binding unavailable');
      },
    },
  };
  const selected = {
    row: { projectId: 'p' },
    run: {
      status: 'cancelled',
      id: 'r',
      fence: 1,
      executionId: '123',
      configuration: { provider: 'github-actions', repository: 'synthetic/runner' },
    },
  };
  assert.equal(await usageApi.cancelledUsageTarget(ctx, selected), null);
  // Any DB use throws above, so this also guards the zero-added-read pass path.
  assert.equal(
    await usageApi.cancelledUsageTarget(ctx, { ...selected, run: { ...selected.run, status: 'passed' } }),
    null,
  );
});
