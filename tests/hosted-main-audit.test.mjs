// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { auditFixture, audit, state } from './hosted-main-audit-fixture.mjs';
import { auditDebt, defaultMainAuditSettings, mainAuditKey } from '../dist/main-audit.js';
import { checkArgs } from './convex-args.mjs';
const readGate = f => f.run('mainGate', ctx => state.mainGate(ctx, f.projectId));
const readStatus = f => f.call('auditStatus', audit.status, { projectId: f.projectId }).then(JSON.parse);

for (const effective of ['docs', 'contract'])
  test(`a passed ${effective} audit cannot re-green main or erase its unaudited clock`, async () => {
    const f = await auditFixture();
    await f.land('full');
    const green = f.row().lastGreen;
    const at = new Date(Date.now() - 2 * 3600000).toISOString();
    await f.land('contract', { at });
    await f.start();
    const selected = f.currentRun();
    const finished = await f.terminal('passed', { ...selected, gate: { ...selected.gate, effective } });
    assert.deepEqual(f.row().lastGreen, green);
    assert.deepEqual(f.row().unaudited, { count: 1, firstAt: at });
    assert.equal(f.row().audit.status, 'passed', 'retain the actual check result');
    assert.equal((await readStatus(f)).alarm.step, 'not-full');
    assert.equal(f.pending().length, 0, 'no immediate retry of an inconclusive scope');
    const events = f.tables.projectHostedMainAuditEvents.size;
    await f.run('duplicateNotFull', ctx => state.onGateRunTerminal(ctx, finished));
    await f.start();
    assert.equal(f.tables.projectHostedMainAuditEvents.size, events);
    assert.equal(f.tables.projectHostedCheckRuns.size, 2, 'same-head replay does not dispatch again');
    assert.equal(f.pending().length, 0);
    await f.land();
    assert.equal(f.pending().length, 1, 'next landing resumes normal cadence');
    assert.equal(f.row().wake.at, Date.parse(at) + 24 * 3600000);
    await f.tick(f.pending()[0]);
    assert.equal(f.currentRun().gate.mode, 'audit');
    assert.notEqual(f.currentRun().id, selected.id);
    await f.terminal('passed', {
      ...f.currentRun(),
      gate: { ...f.currentRun().gate, effective: 'full' },
    });
    assert.equal(f.row().lastGreen.sequence, 3);
    assert.equal(f.row().unaudited.count, 0);
    assert.equal((await readStatus(f)).alarm, null);
    assert.equal(f.pending().length, 0);
  });

test('a passed not-full audit preserves red main, debt and all outstanding landings', async () => {
  const f = await auditFixture();
  await f.land('full');
  const green = f.row().lastGreen;
  const at = new Date(Date.now() - 49 * 3600000).toISOString();
  await f.land('contract', { at });
  await f.start();
  await f.terminal('failed');
  const red = f.row().red;
  await f.land('contract', { actorKind: 'person' });
  await f.start();
  for (let i = 0; i < 18; i++) await f.land('contract', { actorKind: 'person' });
  assert.equal(f.row().debt, true);
  const selected = f.currentRun();
  await f.terminal('passed', { ...selected, gate: { ...selected.gate, effective: 'docs' } });
  assert.deepEqual(f.row().lastGreen, green);
  assert.deepEqual(f.row().red, red);
  assert.equal(f.row().debt, true);
  assert.deepEqual(f.row().unaudited, { count: 20, firstAt: at });
  assert.equal((await readGate(f)).hold, 'main-red');
  assert.equal((await readStatus(f)).alarm.step, 'not-full');
  assert.equal(f.pending().length, 0);
  assert.equal(f.pending('projectHostedMainAudit:releaseHeld').length, 0);
});

test('legacy audit runs without an effective field retain full-suite evidence semantics', async () => {
  const f = await auditFixture();
  await f.land('full');
  await f.land();
  await f.start();
  assert.equal(f.currentRun().gate.effective, undefined);
  await f.terminal();
  assert.equal(f.row().lastGreen.sequence, 2);
  assert.equal(f.row().unaudited.count, 0);
  assert.equal(f.pending().length, 0);
});

test('owner-approved cadence, deadline and debt are explicit', () => {
  assert.deepEqual(defaultMainAuditSettings, { landings: 10, minutes: 1440 });
  assert.equal(auditDebt(19, new Date().toISOString()), false);
  assert.equal(auditDebt(20, new Date().toISOString()), true);
  assert.equal(auditDebt(1, new Date(Date.now() - 48 * 3600000).toISOString()), true);
  assert.throws(
    () => checkArgs(audit.start, { projectId: 'project', invented: true }, 'audit'),
    /ArgumentValidationError/,
  );
});

test('12 counted landings coalesce, audit newest main, and full-gated fix leaves no audit wake', async () => {
  const f = await auditFixture();
  await f.land('full');
  for (let i = 0; i < 12; i++) await f.land();
  assert.equal(f.pending().length, 1);
  assert.equal(f.row().unaudited.count, 12);
  assert(f.row().wake.at <= Date.now());
  await f.tick(f.pending()[0]);
  assert.equal(f.currentRun().gate.mode, 'audit');
  assert.equal(f.pending('projectHostedActionsDirect:dispatch').length, 1);
  await f.terminal();
  assert.equal(f.row().unaudited.count, 0);
  assert.equal(f.pending().length, 0);
  const runs = f.tables.projectHostedCheckRuns.size;
  await f.start();
  assert.equal(f.tables.projectHostedCheckRuns.size, runs);
  assert.equal((await readGate(f)).status, 'green');
});

test('24h wake audits one landing; full and green-parent docs adopt evidence for free', async () => {
  const f = await auditFixture();
  await f.land('full');
  await f.land('docs');
  assert.equal(f.row().unaudited.count, 0);
  assert.equal(f.pending().length, 0);
  await f.land();
  assert(Math.abs(f.row().wake.at - Date.now() - 24 * 3600000) < 1000);
  await f.tick(f.pending()[0]);
  await f.terminal();
  assert.equal(f.pending().length, 0);
});

test('red audit exposes hold and red minutes; passing full fix releases held rows and ignores stale verdicts', async () => {
  const f = await auditFixture();
  await f.land('full');
  await f.land();
  await f.start();
  await f.terminal('failed');
  assert.equal(await f.run('mainRed', ctx => state.mainRed(ctx, f.projectId)), true);
  assert.equal((await readGate(f)).hold, 'main-red');
  const red = f.row().red;
  f.patch('projectHostedMainAudits', f.row()._id, {
    red: { ...red, since: new Date(Date.now() - 7 * 60000).toISOString() },
  });
  assert((await readStatus(f)).redMinutes >= 7);
  await f.land('full');
  assert.equal((await readGate(f)).hold, null);
  assert.equal(f.row().red, undefined);
  assert.equal(f.pending().length, 0);
});

test('new landings during an audit are retained and do not cancel the pinned run', async () => {
  const f = await auditFixture();
  for (let i = 0; i < 10; i++) await f.land();
  await f.start();
  const original = f.currentRun();
  for (let i = 0; i < 2; i++) await f.land();
  assert.equal(f.currentRun().id, original.id);
  await f.terminal();
  assert.equal(f.row().unaudited.count, 2);
  assert.equal(f.pending().length, 1);
  assert.equal(f.pending()[0].args[0].runId, undefined);
});

test('full-gate failure requests early audit; a failed contract does not', async () => {
  const f = await auditFixture();
  const { run } = await f.land();
  await f.run('contractFailure', ctx => state.onGateRunTerminal(ctx, { ...run, status: 'failed' }));
  assert(f.row().wake.at > Date.now());
  await f.run('fullFailure', ctx =>
    state.onGateRunTerminal(ctx, { ...run, gate: { mode: 'full' }, status: 'failed' }),
  );
  assert(f.row().wake.at <= Date.now());
  assert.equal(f.pending().length, 1);
});

test('audit history earns fast landing: green verdicts count, a stalled audit is unclear, a recovered red is the drill and costs the count (81d12a32)', async () => {
  const f = await auditFixture();
  await f.land('full');
  assert.deepEqual(f.row().earned, { audited: 1, unclear: 0 }, 'an exact full landing audits itself');
  for (let i = 0; i < 12; i++) await f.land();
  await f.tick(f.pending()[0]);
  await f.terminal();
  assert.deepEqual(f.row().earned, { audited: 13, unclear: 0 }, 'one green audit covers all twelve');
  await f.land();
  await f.start();
  await f.terminal('runner-unavailable');
  assert.deepEqual(f.row().earned, { audited: 13, unclear: 1 });
  // Its one retry fails: main is red. The stalled landing is not counted a second time.
  await f.tick(f.pending()[0]);
  await f.terminal('failed');
  assert.deepEqual(f.row().earned, { audited: 13, unclear: 1 });
  assert.equal((await readStatus(f)).landing.effective, 'strict');
  // A full-gated fix ends the red episode: the drill is on record, and earning restarts from zero.
  const fix = await f.land('full');
  const earned = f.row().earned;
  assert.deepEqual([earned.audited, earned.unclear, earned.lost.reason], [0, 0, 'red']);
  assert.deepEqual(earned.drill, {
    at: fix.receipt.at,
    sequence: fix.receipt.snapshot.revision,
    reverted: false,
  });
  const landing = (await readStatus(f)).landing;
  assert.deepEqual([landing.mode, landing.state, landing.advice], ['strict', 'strict', null]);
  assert.deepEqual(landing.progress, { audited: 0, needed: 200, unclearShare: 0, drill: true });
});

test('identical content is never dispatched twice and an unavailable audit retries only once', async () => {
  const f = await auditFixture();
  await f.land();
  await f.start();
  const first = f.currentRun();
  await f.start();
  assert.equal(f.currentRun().id, first.id);
  await f.terminal('runner-unavailable');
  assert.equal(f.pending()[0].args[0].retry, true);
  await f.tick(f.pending()[0]);
  assert.notEqual(f.currentRun().id, first.id);
  await f.terminal('interrupted');
  assert.equal(f.pending().length, 0);
  assert.equal((await readStatus(f)).alarm.code, 'MAIN_AUDIT_STALLED');
  assert.equal(f.pending('projectHostedActionsDirect:dispatch').length, 2);
});

test('15-minute stall status is read-only; provider completion clears it without an audit timer', async t => {
  const f = await auditFixture();
  await f.land();
  await f.start();
  assert.equal(f.pending().length, 0);
  const now = Date.now();
  t.mock.method(Date, 'now', () => now + 15 * 60000);
  const beforeWrites = f.counts.reduce((n, row) => n + row.writes, 0);
  const status = await readStatus(f);
  assert.equal(status.alarm.code, 'MAIN_AUDIT_STALLED');
  assert.equal(status.alarm.step, 'queued');
  assert.equal(
    f.counts.reduce((n, row) => n + row.writes, 0),
    beforeWrites,
  );
  assert.equal(f.pending().length, 0);
  t.mock.restoreAll();
  await f.terminal();
  assert.equal((await readStatus(f)).alarm, null);
});

// Lead decision on Issue fe7d67a8: the owner person starts a red-audit drill; its red, if it recovers in
// time, is the recovered red on record and keeps the audited count. A real red or a late drill resets it.
const device = { subject: 'owner', forgeCredential: 'synthetic-device' };
const earn = (f, body, actor = 'owner') =>
  f
    .call(
      'earn',
      audit.configure,
      {
        projectId: f.projectId,
        request: JSON.stringify({ operationId: randomUUID(), authorityEpoch: 1, earn: body }),
      },
      actor,
    )
    .then(JSON.parse);
const auditEvents = f => [...f.tables.projectHostedMainAuditEvents.values()];
async function counted(f) {
  f.insert('cliCredentials', {
    credentialId: device.forgeCredential,
    owner: 'owner',
    name: 'Synthetic device',
    tokenHash: 'synthetic-hash',
    issuedAt: Date.now(),
    scope: 'cli',
    expiresAt: Date.now() + 60 * 60_000,
    revoked: false,
  });
  await f.land('full');
  for (let i = 0; i < 12; i++) await f.land();
  await f.tick(f.pending()[0]);
  await f.terminal();
  assert.deepEqual(f.row().earned, { audited: 13, unclear: 0 });
}
async function red(f) {
  await f.land();
  await f.start();
  await f.terminal('failed');
}

test('an owner drill that recovers in time is the recovered red and keeps the count; a real red resets it (fe7d67a8)', async () => {
  const { moduleUrl } = await import('./convex-module.mjs');
  const approvals = await import(moduleUrl('../convex/projectHostedApprovals.ts'));
  const f = await auditFixture();
  await counted(f);
  // An agent sign-in (the owner's own CLI included) only asks; nothing starts until the owner person grants.
  const held = await earn(f, { drill: 'start' }, device);
  assert.equal(held.rule, 'held');
  assert.equal(f.row().drill, undefined);
  const request = [...f.tables.projectHostedApprovals.values()].find(
    r => r.laneId === 'setting:main-audit:drill',
  );
  await assert.rejects(
    f.call(
      'grantAsAgent',
      approvals.decide,
      {
        projectId: f.projectId,
        operationId: randomUUID(),
        laneId: request.laneId,
        decision: 'grant',
        head: request.head,
      },
      device,
    ),
    error => error.data?.code === 'PROJECT_UNAVAILABLE',
  );
  await f.call('grant', approvals.decide, {
    projectId: f.projectId,
    operationId: randomUUID(),
    laneId: request.laneId,
    decision: 'grant',
    head: request.head,
  });
  const startedAt = f.row().drill.startedAt;
  assert.ok(startedAt);
  await red(f);
  assert.equal(f.row().drill.red.runId, f.row().red.runId, 'the armed drill claims the next red');
  assert.equal((await readStatus(f)).landing.effective, 'strict', 'a drill red holds landings like any red');
  // 2026-11-10 dogfood drill: a second failed audit in the same red episode keeps the drill's claim.
  await red(f);
  assert.notEqual(f.row().drill.red.runId, f.row().red.runId);
  const fix = await f.land('full');
  const earned = f.row().earned;
  assert.deepEqual([earned.audited, earned.unclear, earned.lost], [13, 0, undefined]);
  assert.deepEqual(earned.drill, {
    at: fix.receipt.at,
    sequence: fix.receipt.snapshot.revision,
    reverted: false,
    started: startedAt,
    red: auditEvents(f).find(e => e.kind === 'red').at,
  });
  assert.equal(f.row().drill, undefined);
  // The audit history records it as a drill: start, red, recovery and end, on the red and on its recovery.
  const [redEvent, greenEvent] = auditEvents(f).filter(e => e.drill);
  assert.deepEqual([redEvent.kind, greenEvent.kind], ['red', 'green']);
  assert.deepEqual(redEvent.drill, greenEvent.drill);
  assert.deepEqual(Object.keys(redEvent.drill).sort(), [
    'endedAt',
    'outcome',
    'recoveredAt',
    'redAt',
    'startedAt',
  ]);
  assert.equal(redEvent.drill.outcome, 'recovered');
  assert.deepEqual((await readStatus(f)).landing.progress, {
    audited: 13,
    needed: 200,
    unclearShare: 0,
    drill: true,
  });
  // A real red, with no drill armed, still resets the count.
  await red(f);
  await f.land('full');
  assert.deepEqual([f.row().earned.audited, f.row().earned.lost.reason], [0, 'red']);
});

test('a drill that recovers late is a real red; an agent cannot start a drill or mark a red as one (fe7d67a8)', async () => {
  const f = await auditFixture();
  await counted(f);
  assert.equal(
    (await earn(f, { drill: 'start' })).drill.started,
    true,
    'the owner person starts it directly',
  );
  await red(f);
  const row = f.row();
  const lateRed = new Date(Date.now() - 3 * 3600000).toISOString();
  f.patch('projectHostedMainAudits', row._id, {
    drill: { ...row.drill, red: { ...row.drill.red, at: lateRed } },
  });
  await f.land('full');
  assert.deepEqual(
    [f.row().earned.audited, f.row().earned.lost.reason],
    [0, 'red'],
    'late: the count restarts',
  );
  assert.equal(auditEvents(f).find(e => e.kind === 'red').drill.outcome, 'late');
  // While main is red no drill can start, so a red can never be claimed after the fact.
  await red(f);
  await assert.rejects(earn(f, { drill: 'start' }), error => error.data?.code === 'MAIN_RED');
  assert.equal((await earn(f, { drill: 'start' }, device)).rule, 'held');
  assert.equal(f.row().drill, undefined);
  await f.land('full');
  // A drill whose window closed before the red does not claim it.
  await earn(f, { drill: 'start' });
  f.patch('projectHostedMainAudits', f.row()._id, {
    drill: { startedAt: new Date(Date.now() - 3 * 3600000).toISOString() },
  });
  await red(f);
  assert.equal(f.row().drill, undefined);
  assert.equal(
    auditEvents(f)
      .filter(e => e.kind === 'red')
      .at(-1).drill,
    undefined,
  );
});

test('the owner recount replaces the counters with the live rules and is held for an agent (fe7d67a8)', async () => {
  const { moduleUrl } = await import('./convex-module.mjs');
  const { getFunctionName } = await import('convex/server');
  const earnModule = await import(moduleUrl('../convex/projectHostedMainAuditEarn.ts'));
  const f = await auditFixture();
  // The fixture's creation times count from zero; a deployment's are epoch milliseconds.
  const since = new Date(0).toISOString();
  await counted(f);
  await earn(f, { drill: 'start' });
  await red(f);
  await f.land('full');
  const live = f.row().earned;
  assert.equal((await earn(f, { backfill: { since } }, device)).rule, 'held');
  f.patch('projectHostedMainAudits', f.row()._id, { earned: { audited: 0, unclear: 0 } });
  const scheduled = await earn(f, { backfill: { since } });
  assert.deepEqual(scheduled.backfill, { since, scheduled: true });
  const ctx = {
    runQuery: (ref, args) => f.call('recount', earnModule[getFunctionName(ref).split(':')[1]], args),
  };
  ctx.runMutation = ctx.runQuery;
  for (let run = 0; run < 2; run++) {
    await earnModule.backfill._handler(ctx, { projectId: f.projectId, since });
    assert.deepEqual(f.row().earned, live, 'the recount equals the live counter, and again on a rerun');
  }
  // A recount that main moved past is not written.
  const written = await f.call('stale', earnModule.write, {
    projectId: f.projectId,
    through: f.row().lastGreen.sequence - 1,
    earned: JSON.stringify({ audited: 1, unclear: 0 }),
  });
  assert.equal(written, false);
  assert.deepEqual(f.row().earned, live);
});

test('project cadence settings are owner-only, validated, operation-idempotent and CAS protected', async () => {
  const f = await auditFixture();
  const request = {
    operationId: randomUUID(),
    authorityEpoch: 1,
    expected: null,
    settings: { landings: 3, minutes: 60 },
  };
  const args = { projectId: f.projectId, request: JSON.stringify(request) };
  const saved = await f.call('configureAudit', audit.configure, args);
  assert.equal(await f.call('configureAudit', audit.configure, args), saved);
  await assert.rejects(
    f.call('configureAudit', audit.configure, args, 'outside'),
    error => error.data?.code === 'PROJECT_UNAVAILABLE',
  );
  await assert.rejects(
    f.call('configureAudit', audit.configure, {
      ...args,
      request: JSON.stringify({ ...request, operationId: randomUUID() }),
    }),
    error => error.data?.code === 'EVIDENCE_CHANGED',
  );
  await f.land();
  await f.land();
  await f.land();
  assert(f.row().wake.at <= Date.now());
  assert.equal((await readStatus(f)).settings.landings, 3);
  assert.notEqual(
    mainAuditKey({
      projectId: 'p',
      head: 'h',
      definition: 'd',
      configuration: 'c',
      environment: 'e',
      authorityEpoch: 1,
    }),
    mainAuditKey({
      projectId: 'p',
      head: 'h',
      definition: 'd',
      configuration: 'c',
      environment: 'changed',
      authorityEpoch: 1,
    }),
  );
});

test('same head with a different Candidate adopts its original passed audit', async () => {
  const f = await auditFixture();
  const { receipt } = await f.land();
  await f.start();
  await f.terminal();
  await f.land('full');
  await f.land('contract', { head: receipt.candidate.head });
  const before = f.tables.projectHostedCheckRuns.size;
  await f.start();
  assert.equal(f.tables.projectHostedCheckRuns.size, before);
  assert.equal(f.row().lastGreen.sequence, 3);
  assert.equal(f.row().unaudited.count, 0);
  assert.equal(f.pending().length, 0);
});

test('a newer full-gated fix supersedes an in-flight failed audit', async () => {
  const f = await auditFixture();
  await f.land();
  await f.start();
  await f.land('full');
  const green = f.row().lastGreen;
  await f.terminal('failed');
  assert.equal(f.row().red, undefined);
  assert.deepEqual(f.row().lastGreen, green);
  assert.equal((await readStatus(f)).result, 'passed');
  assert.equal(f.pending().length, 0);
});

test('hosted audit events measure R, preserve open episodes and pin culprit landing time', async () => {
  const { calculateHostedRedMainMetrics } = await import('../dist/self-metrics-red-main.js');
  const at = minute => new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();
  const events = [
    { projectId: 'p', kind: 'red', at: at(5), head: 'h', runId: 'r', sequence: 2 },
    { projectId: 'p', kind: 'culprit', at: at(6), head: 'h', runId: 'r', sequence: 2, culprit: 'landing' },
    { projectId: 'p', kind: 'green', at: at(12), head: 'fix', runId: 'g', sequence: 3 },
  ];
  const moves = [{ id: 'landing', at: at(2), head: 'h', inputs: [], kind: 'landing' }];
  assert.deepEqual(calculateHostedRedMainMetrics(events, { from: at(0), to: at(20) }, moves), {
    minutes: 10,
    open: [],
    partial: true,
  });
  assert.deepEqual(calculateHostedRedMainMetrics(events.slice(0, 1), { from: at(0), to: at(10) }), {
    minutes: 5,
    open: ['p'],
    partial: true,
  });
});

test('green resumes 205 held requests in bounded pages and clears their retained MAIN_RED error', async () => {
  const f = await auditFixture();
  await f.land();
  await f.start();
  await f.terminal('failed');
  const { hostedLandingStateSchema, landingObservation } = await import('../dist/hosted-landing.js');
  for (let i = 0; i < 205; i++) {
    const id = randomUUID(),
      operationId = randomUUID(),
      attemptId = randomUUID();
    const request = {
      operationId,
      authorityEpoch: 1,
      channel: 'main',
      expectedMain: { head: f.state.sha256, receiptId: 'main-0' },
      candidateId: f.candidate.id,
      expectedHead: f.state.sha256,
      agent: true,
      check: null,
    };
    const retained = hostedLandingStateSchema.parse({
      schema: 1,
      projectId: f.projectId,
      id,
      operationId,
      actor: 'owner',
      at: new Date().toISOString(),
      request,
      sequence: i,
      version: 0,
      firstAttemptId: attemptId,
      attemptId,
      phase: 'ready',
      observation: landingObservation('queued'),
      error: { code: 'MAIN_RED', message: 'Main audit failed.' },
    });
    f.insert('projectHostedLandingRequests', {
      projectId: f.projectId,
      channel: 'main',
      submissionId: id,
      operationId,
      actor: 'owner',
      sequence: i,
      hold: 'main-red',
      runnable: false,
      phase: 'ready',
      runId: null,
      attemptId,
      value: JSON.stringify(retained),
    });
  }
  // A person may still accept while main is red; the next audit can lose its runner.
  await f.land('contract', { actorKind: 'person' });
  await f.start();
  await f.terminal('runner-unavailable');
  let stalledPages = 0;
  while (f.pending('projectHostedMainAudit:stallHeld').length) {
    const task = f.pending('projectHostedMainAudit:stallHeld')[0];
    f.patch('_scheduled_functions', task._id, { state: { kind: 'inProgress' } });
    await f.call('stallHeld', audit.stallHeld, task.args[0]);
    f.patch('_scheduled_functions', task._id, { state: { kind: 'success' } });
    assert(++stalledPages <= 3);
  }
  assert.equal(stalledPages, 3);
  assert(
    [...f.tables.projectHostedLandingRequests.values()].every(
      row => JSON.parse(row.value).error.code === 'MAIN_AUDIT_STALLED',
    ),
  );
  await f.land('full');
  let pages = 1;
  while (f.pending('projectHostedMainAudit:releaseHeld').length) {
    const task = f.pending('projectHostedMainAudit:releaseHeld')[0];
    f.patch('_scheduled_functions', task._id, { state: { kind: 'inProgress' } });
    await f.call('releaseHeld', audit.releaseHeld, task.args[0]);
    f.patch('_scheduled_functions', task._id, { state: { kind: 'success' } });
    pages++;
    assert(pages <= 3);
  }
  assert.equal(pages, 3);
  assert(
    [...f.tables.projectHostedLandingRequests.values()].every(
      row => row.hold === undefined && row.runnable && JSON.parse(row.value).error === null,
    ),
  );
  assert.equal(f.pending().length, 0);
});

test('rollout seed adopts only the last retained exact full-passed check', async () => {
  const f = await auditFixture();
  const { run } = await f.land('full');
  const saved = {
    projectId: f.projectId,
    runId: run.id,
    candidateId: run.request.candidateId,
    gate: run.gate,
    status: run.status,
    value: JSON.stringify(run),
  };
  const runRow = f.insert('projectHostedCheckRuns', saved);
  await f.run('clearAuditForSeed', ctx => ctx.db.delete(f.row()._id));
  await f.call('seedAudit', audit.seed, { projectId: f.projectId });
  assert.equal(f.row().lastGreen.runId, run.id);
  assert.equal(f.pending().length, 0);
  f.patch('projectHostedCheckRuns', runRow, { value: JSON.stringify({ ...run, terminalDigest: null }) });
  await assert.rejects(
    f.call('seedAudit', audit.seed, { projectId: f.projectId }),
    error => error.code === 'EVIDENCE_CHANGED',
  );
});

test('a stale wake and duplicate start cannot schedule or replace an active audit', async () => {
  const f = await auditFixture();
  await f.land();
  const stale = f.pending()[0];
  await f.start();
  const active = f.row().audit;
  await f.start();
  assert.deepEqual(f.row().audit, active);
  await f.start(stale.args[0]);
  assert.deepEqual(f.row().audit, active);
  await f.terminal();
  assert.equal(f.pending().length, 0);
});

test('a full-gate failure during an active audit requests an early audit of newer landings', async () => {
  const f = await auditFixture();
  await f.land();
  await f.start();
  const { run } = await f.land();
  await f.run('inFlightFullFailure', ctx =>
    state.onGateRunTerminal(ctx, { ...run, gate: { mode: 'full' }, status: 'failed' }),
  );
  await f.tick(f.pending()[0]);
  assert.equal(f.tables.projectHostedCheckRuns.size, 2, 'one fixture run plus the pinned audit');
  await f.terminal();
  assert(f.row().wake.at <= Date.now());
  await f.tick(f.pending()[0]);
  assert.equal(f.currentRun().request.expectedHead, run.request.expectedHead);
  await f.terminal();
  assert.equal(f.pending().length, 0);
});

test('retained machine lease failure is surfaced and reconciled without a new watchdog', async t => {
  const f = await auditFixture();
  await f.land();
  const current = [...f.tables.projectHostedCheckSettings.values()].find(row => row.key === 'runner');
  await f.configure(
    {
      kind: 'runner',
      configuration: {
        provider: 'mac',
        machineId: randomUUID(),
        runtime: 'c'.repeat(64),
        environmentFingerprint: 'd'.repeat(64),
      },
    },
    current.digest,
  );
  await f.start();
  const { moduleUrl } = await import('./convex-module.mjs');
  const lease = await import(moduleUrl('../convex/projectHostedCheckLease.ts'));
  for (let i = 0; i < 2; i++) {
    const selected = f.currentRun();
    t.mock.method(Date, 'now', () => selected.ownerDeadline + 1);
    await f.call('expireAuditLease', lease.expire, {
      projectId: f.projectId,
      runId: selected.id,
      fence: selected.fence,
      until: selected.ownerDeadline,
    });
    t.mock.restoreAll();
  }
  assert.equal(f.currentRun().status, 'runner-unavailable');
  assert.equal((await readStatus(f)).alarm.code, 'MAIN_AUDIT_STALLED');
  await f.start();
  assert.equal(f.row().audit.status, 'runner-unavailable');
  assert.equal(f.pending().length, 1);
  assert.equal(f.pending()[0].args[0].retry, true);
});

test('docs during an audit do not start the clock for later counted landings', async () => {
  const f = await auditFixture();
  const now = Date.now();
  const first = new Date(now - 2 * 3600000).toISOString();
  const docs = new Date(now - 3600000).toISOString();
  const counted = new Date(now).toISOString();
  await f.land('contract', { at: first });
  await f.start();
  await f.land('docs', { at: docs });
  assert.equal(f.row().unaudited.firstAt, null);
  await f.land('contract', { at: counted });
  assert.equal((await readGate(f)).unaudited.firstAt, first, 'old debt remains visible while its audit runs');
  await f.terminal();
  assert.equal(f.row().unaudited.count, 1);
  assert.equal(f.row().unaudited.firstAt, counted);
  assert.equal(f.row().wake.at, Date.parse(counted) + 24 * 3600000);
});

test('an obsolete audit completing after a full fix still schedules newer counted work', async () => {
  const f = await auditFixture();
  await f.land();
  await f.start();
  await f.land('full');
  await f.land();
  await f.terminal('failed');
  assert.equal(f.row().red, undefined);
  assert.equal(f.row().unaudited.count, 1);
  assert.equal(f.pending().length, 1);
});

test('hosted audit status and check-settings expose the same audit payload', async () => {
  const f = await auditFixture();
  await f.land();
  await f.start();
  await f.terminal('failed');
  const { definitions } = await import('./hosted-checks-fixture.mjs');
  const { moduleUrl } = await import('./convex-module.mjs');
  const audit = await import(moduleUrl('../convex/projectHostedMainAudit.ts'));
  const settings = JSON.parse(
    await f.call('auditCheckSettings', definitions.current, { projectId: f.projectId, checkId: f.checkId }),
  );
  const status = JSON.parse(await f.call('auditStatus', audit.status, { projectId: f.projectId }));
  assert.equal(settings.mainAudit.redSince, f.row().red.since);
  assert.equal(status.head, settings.mainAudit.head);
  await assert.rejects(
    f.call('auditStatus', audit.status, { projectId: f.projectId }, 'outside'),
    error => error.data?.code === 'PROJECT_UNAVAILABLE',
  );
});

const removeRunner = f => {
  const row = [...f.tables.projectHostedCheckSettings.values()].find(
    item => item.kind === 'runner' && item.key === 'runner',
  );
  f.tables.projectHostedCheckSettings.delete(row._id);
  return () => f.tables.projectHostedCheckSettings.set(row._id, row);
};
const dueAudit = async () => {
  const f = await auditFixture();
  await f.land('full');
  for (let i = 0; i < 12; i++) await f.land();
  return f;
};

test('a start that throws RUNNER_UNAVAILABLE retries with back-off, names the cause and runs once the runner is set (53b07031)', async () => {
  const f = await dueAudit();
  const setRunner = removeRunner(f);
  let task = f.pending()[0];
  for (const [attempt, minutes] of [
    [1, 5],
    [2, 15],
    [3, 60],
  ]) {
    await f.tick(task); // resolves: the failed start commits instead of rolling its wake back
    assert.equal(f.row().startFailure.attempts, attempt);
    assert.equal(f.row().startFailure.code, 'RUNNER_UNAVAILABLE');
    assert.equal(f.pending().length, 1, 'exactly one retry is pending');
    assert.equal(f.row().wake.taskId, f.pending()[0]._id, 'the wake never points at a finished task');
    assert.equal(Math.round((f.pending()[0].scheduledTime - task.scheduledTime) / 60_000), minutes);
    const alarm = (await readStatus(f)).alarm;
    if (attempt === 1) assert.equal(alarm, null, 'one failure is not yet a notice');
    else {
      assert.equal(alarm.code, 'MAIN_AUDIT_STALLED');
      assert.equal(alarm.step, 'RUNNER_UNAVAILABLE');
      assert.match(alarm.message, /No runner is set/);
    }
    task = f.pending()[0];
  }
  setRunner(); // the owner configures the runner; nothing else is done by hand
  await f.tick(task);
  assert.equal(f.currentRun().gate.mode, 'audit', 'the scheduled retry runs the audit');
  assert.equal(f.row().startFailure, undefined);
  assert.equal((await readStatus(f)).alarm, null);
  assert.equal(f.pending().length, 0);
  await f.terminal();
  assert.equal(f.row().unaudited.count, 0);
  assert.equal(f.row().lastGreen.sequence, 13);
  assert.equal(f.pending().length, 0);
});

test('a missing check on the newest receipt is named; retries stop at the cap and a full-gated landing clears the notice (53b07031)', async () => {
  const f = await dueAudit();
  const accepted = [...f.tables.projectHostedAcceptances.values()].find(row => row.sequence === 13);
  const receipt = JSON.parse(accepted.value);
  receipt.check = null;
  f.patch('projectHostedAcceptances', accepted._id, { value: JSON.stringify(receipt) });
  let task = f.pending()[0];
  const waits = [];
  for (let attempt = 1; attempt <= 7; attempt++) {
    await f.tick(task);
    assert.equal(f.row().startFailure.attempts, attempt);
    const next = f.pending();
    if (attempt === 7) assert.equal(next.length, 0, 'no retry beyond the cap of six');
    else {
      assert.equal(next.length, 1);
      waits.push(Math.round((next[0].scheduledTime - task.scheduledTime) / 60_000));
      task = next[0];
    }
  }
  assert.deepEqual(waits, [5, 15, 60, 60, 60, 60]);
  assert.equal(f.row().wake, undefined);
  const alarm = (await readStatus(f)).alarm;
  assert.equal(alarm.step, 'RUNNER_UNAVAILABLE');
  assert.match(alarm.message, /no check/);
  await f.land('full'); // a full-gated landing makes the debt moot and clears the notice
  assert.equal(f.row().startFailure, undefined);
  assert.equal((await readStatus(f)).alarm, null);
  assert.equal(f.pending().length, 0);
});

test('a start that fails for any other reason cannot leave a finished wake that blocks re-arming (53b07031)', async () => {
  const f = await auditFixture();
  await f.land('full');
  await f.land();
  const task = f.pending()[0];
  const past = Date.now() - 10 * 60_000;
  f.patch('_scheduled_functions', task._id, { state: { kind: 'failed' }, scheduledTime: past });
  f.patch('projectHostedMainAudits', f.row()._id, { wake: { taskId: task._id, at: past } });
  await f.land();
  const pending = f.pending();
  assert.equal(pending.length, 1, 'the next landing re-arms past a finished wake');
  assert.notEqual(pending[0]._id, task._id);
  assert.equal(f.row().wake.taskId, pending[0]._id);
});
