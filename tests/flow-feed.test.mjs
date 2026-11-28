// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// The Flow view's feed fields (Item 85f456c1) ride writes the line feed already makes: a landing's step goes in
// the summary write its exit already makes, a check key and a main-red hold ride the mark's stage/held patch.
import test from 'node:test';
import { storageClock } from './storage-clock.mjs';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { batchesFixture, synthetic } from './hosted-landing-batches-fixture.mjs';
import { finishFixture } from './hosted-finish-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const line = await import(moduleUrl('../convex/projectLiveLine.ts'));
const landing = await import(moduleUrl('../convex/projectHostedLandingStore.ts'));
const store = await import(moduleUrl('../convex/projectLiveLineStore.ts'));
const { policyPreset } = await import(moduleUrl('../src/autonomy-policy.ts'));
const day = await import(moduleUrl('../src/flow-day.ts'));
const sub = await import(moduleUrl('../convex/projectLiveLineSubmission.ts'));
const fyi = await import(moduleUrl('../convex/projectNeedsFyi.ts'));
const previousEnvironment = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
test.beforeEach(t => storageClock(t));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(previousEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const read = f => f.tx('observerBudgetPage', line.read, { projectId: f.projectId }, 'owner');
const marks = f => [...f.tables.projectLiveLineLanes.values()];
/** Committed writes of the per-project summary row, by any transaction. */
function countSummaryWrites(f) {
  const rows = f.tables.projectFinishReadRows;
  const counter = { n: 0 };
  const set = rows.set.bind(rows);
  rows.set = (id, doc) => {
    if (doc?.kind === 'projectLiveLineSummary') counter.n++;
    return set(id, doc);
  };
  return counter;
}
const rewrite = (f, submissionId, change) =>
  f.tx(
    'flowTransition',
    {
      _handler: async ctx => {
        const { row, state } = await landing.loadLanding(ctx, { projectId: f.projectId, submissionId });
        await landing.writeLanding(ctx, row, { ...change(state), version: state.version + 1 }, false);
      },
    },
    {},
  );

test('a landing steps the Flow day inside the summary write its exit already makes (85f456c1)', async t => {
  const f = await finishFixture(t);
  const summary = countSummaryWrites(f);
  const state = await f.enqueue(f.request());
  const keys = new Set();
  while (f.pending().length) {
    await f.execute();
    for (const mark of marks(f)) if (mark.stage === 'checking') keys.add(mark.check);
  }
  await f.passChecks();
  while (f.pending().length) await f.execute();
  assert.equal((await f.current(state.id)).submission.phase, 'landed');
  assert.deepEqual([...keys], [state.id.slice(0, 8)], 'a checked Lane carries its check key');
  const feed = await read(f);
  const today = day.flowToday(feed.flow, Date.now(), Date.now() - 3_600_000);
  assert.equal(today.landed, 1);
  assert.equal(today.samples, 1, 'one land-to-main sample');
  assert.equal(today.fix, 0);
  // Writes per landing of the summary row (2026-11-20, before this Item): writeLineMain's main snapshot and the
  // exit's. The Flow day adds none.
  assert.equal(summary.n, 2, 'summary writes per landing unchanged');
  t.diagnostic(
    JSON.stringify({
      summaryWritesPerLanding: summary.n,
      summaryBytes: feed.flow ? JSON.stringify(feed.flow).length : 0,
    }),
  );
});

test('Recent landings keeps a reference-backed title after Clear all in FYI', async t => {
  const f = await finishFixture(t);
  const title = 'Keep the recent landing title when FYI is cleared';
  await f.enqueue(f.request({ message: `${title}\n\nThe full message stays with the receipt.` }));
  while (f.pending().length) await f.execute();
  await f.passChecks();
  while (f.pending().length) await f.execute();
  const [stored] = f.tables.projectHostedAcceptances.values();
  assert.ok(JSON.parse(stored.value).messageRef, 'the receipt stores a message reference');
  const args = { projectId: f.projectId };
  await f.tx('clearFyi', fyi.dismiss, { ...args, clearAll: true }, 'owner');
  const cleared = JSON.parse(await f.tx('readClearedFyi', fyi.read, args, 'owner'));
  assert.deepEqual(cleared.landings, []);
  const latest = (await read(f)).recentLandings[0];
  assert.equal(latest.receiptId, stored.receiptId);
  assert.equal(latest.title, title);
});

test('the live line reports running checks, grouped Lane counts and configured queue room in one reply', async t => {
  const f = await finishFixture(t);
  const state = await f.enqueue(f.request());
  const [source] = f.tables.projectHostedLandingRequests.values();
  const { _id, _creationTime, requestBodyId: _body, selectionBodyId: _selection, ...landing } = source;
  const { _id: _markId, _creationTime: _markAt, ...mark } = marks(f)[0];
  const at = Date.parse('2026-11-01T10:02:00.000Z');
  const reservedAt = '2026-11-01T10:00:00.000Z';
  const policy = { ...policyPreset('trusted'), checks: { runner: 'github-actions', concurrency: 5 } };
  f.insert('projectPolicyChanges', {
    projectId: f.projectId,
    operationId: randomUUID(),
    actor: 'owner',
    request: '',
    at: reservedAt,
    previous: policyPreset('trusted'),
    policy,
  });
  const batchId = randomUUID();
  const group = (phase, id = randomUUID(), fields = {}) => ({
    id,
    phase,
    sequence: 10,
    priority: 'normal',
    ...fields,
  });
  const check = (status, shardStartedAt, batchId, hasLane = true) => {
    const runId = randomUUID();
    const checkId = f.insert('projectHostedCheckRuns', {
      projectId: f.projectId,
      runId,
      candidateId: randomUUID(),
      status,
      ...(shardStartedAt === undefined ? {} : { shardStartedAt }),
      value: JSON.stringify({
        at: reservedAt,
        status,
        configuration: { description: 'recorded settings '.repeat(200) },
      }),
    });
    if (!hasLane) return { checkId };
    const submissionId = randomUUID();
    const requestBodyId = batchId
      ? f.insert('projectHostedLandingBodies', {
          value: JSON.stringify({ projectId: f.projectId, submissionId, request: state.request }),
        })
      : undefined;
    const rowId = f.insert('projectHostedLandingRequests', {
      ...landing,
      ...(requestBodyId ? { requestBodyId } : {}),
      submissionId,
      phase: 'checking',
      operationId: randomUUID(),
      runId,
      value: JSON.stringify({ ...state, id: submissionId, batchId }),
    });
    return { runId, checkId, rowId, requestBodyId, submissionId, key: (batchId ?? submissionId).slice(0, 8) };
  };
  const shared = check('running', at, batchId);
  const single = check('running');
  const queued = check('queued');
  const passed = check('passed');
  // A landing in the checking phase whose CI run is not even named yet (9e748e41, owner 16:36Z).
  const bareId = randomUUID();
  const bareRow = f.insert('projectHostedLandingRequests', {
    ...landing,
    submissionId: bareId,
    phase: 'checking',
    operationId: randomUUID(),
    value: JSON.stringify({ ...state, id: bareId }),
  });
  const bare = { key: bareId.slice(0, 8), rowId: bareRow };
  const unrelated = check('running', at + 10_000, undefined, false); // A run whose work has no Lanes on Flow.
  const [queue] = f.tables.projectHostedLandingQueues.values();
  f.tables.projectHostedLandingQueues.set(queue._id, { ...queue, train: [shared.submissionId] });
  const [attempt] = f.tables.projectHostedLandingAttempts.values();
  f.tables.projectHostedLandingAttempts.set(attempt._id, {
    ...attempt,
    value: JSON.stringify({
      ...JSON.parse(attempt.value),
      policy: { ...policy, checks: { ...policy.checks, concurrency: 2 } },
    }),
  });
  f.insert('projectHostedLandingQueueStatus', {
    projectId: f.projectId,
    page: 999,
    value: JSON.stringify([
      group('checking', shared.submissionId, { batchId }),
      group('checking', single.submissionId), // Separate admission check, outside the train.
      group('ready'),
      group('queued'),
    ]),
  });
  const lane = (check, stage = 'checking', held = false) =>
    f.insert('projectLiveLineLanes', { ...mark, laneId: randomUUID(), stage, held, check });

  lane(shared.key);
  lane(shared.key);
  lane(single.key);
  lane(queued.key);
  lane(bare.key);
  lane(passed.key, 'ready');
  lane(shared.key, 'checking', true);
  for (let i = 8; i < 56; i++) lane(undefined, 'editing');

  const started = performance.now();
  const { checks, ...baseline } = await read(f);
  const wallMs = performance.now() - started;
  assert.equal(baseline.lanes.length, 56);
  assert.deepEqual(
    checks.runs.sort((a, b) => a.at - b.at),
    [
      { groups: [single.key], lanes: 1, at: Date.parse(reservedAt), reserved: true },
      { groups: [shared.key], lanes: 2, at },
      // Checks that hold a slot with no CI run started are drawn and counted, never dropped: one whose run is queued at
      // the provider, and one with no run named yet. `at` is when each was requested.
      ...[queued, bare]
        .map(entry => ({
          groups: [entry.key],
          lanes: 1,
          at: f.tables.projectHostedLandingRequests.get(entry.rowId)._creationTime,
          starting: true,
        }))
        .sort((a, b) => a.at - b.at),
    ].sort((a, b) => a.at - b.at),
  );
  assert.equal(
    checks.pickupMs,
    at - Date.parse(reservedAt),
    'the middle request-to-start time of the runs in view',
  );
  assert.equal(checks.free, 1, 'use the train and its pinned width, excluding independent admission checks');
  assert.equal(checks.partial, undefined);
  assert.ok(
    baseline.lanes.some(lane => lane.check === shared.key),
    'the picture keeps compact check keys',
  );
  const before = Buffer.byteLength(JSON.stringify(baseline));
  const after = Buffer.byteLength(JSON.stringify({ ...baseline, checks }));
  // Four run summaries now (two of them starting, 9e748e41) and the pickup time: about 100 bytes each.
  assert.ok(after - before < 420, 'only the check summaries cross the feed');
  t.diagnostic(
    JSON.stringify({
      before,
      after,
      wallMs,
      fixturePeakRssKiB: process.resourceUsage().maxRSS,
      queryReadBytes: f.counts.at(-1).readBytes,
      queryDocuments: f.counts.at(-1).documents,
    }),
  );

  const skipsColdBodies = f.readSet();
  const cold = f.tables.projectHostedLandingBodies.get(shared.requestBodyId);
  await f.tx(
    'coldVerificationClaim',
    {
      _handler: ctx =>
        ctx.db.patch(cold._id, {
          value: JSON.stringify({ ...JSON.parse(cold.value), request: { notVerified: ['Synthetic claim'] } }),
        }),
    },
    {},
  );
  assert(skipsColdBodies(), 'reading run identities does not hydrate the archived landing request');
  const replacement = check('running', at + 20_000);
  const original = f.tables.projectHostedCheckRuns.values();
  for (const run of original)
    if (run.runId === single.runId)
      f.tables.projectHostedCheckRuns.set(run._id, { ...run, status: 'interrupted' });
  const originalLanding = f.tables.projectHostedLandingRequests.get(single.rowId);
  f.tables.projectHostedLandingRequests.set(single.rowId, { ...originalLanding, runId: replacement.runId });
  assert.deepEqual(
    (await read(f)).checks.runs.filter(run => !run.starting).sort((a, b) => a.at - b.at),
    [
      { groups: [shared.key], lanes: 2, at },
      { groups: [single.key], lanes: 1, at: at + 20_000 },
    ],
    'a retry in the same check stage uses the current run without patching its marks',
  );

  const beforeProgress = (await read(f)).checks;
  const readSet = f.readSet();
  const unrelatedRun = f.tables.projectHostedCheckRuns.get(unrelated.checkId);
  await f.tx(
    'unrelatedCheckProgress',
    {
      _handler: ctx =>
        ctx.db.patch(unrelatedRun._id, {
          value: JSON.stringify({ ...JSON.parse(unrelatedRun.value), counts: { completed: 1 } }),
        }),
    },
    {},
  );
  assert.equal(readSet(), false, 'a canonical run update can wake this bounded read while work is active');
  assert.deepEqual((await read(f)).checks, beforeProgress, 'unrelated progress publishes no new strip data');

  for (let i = 0; i < 9; i++) check('running', at + 60_000, undefined, false);
  const capped = (await read(f)).checks;
  assert.equal(capped.partial, true, 'an overfull page states that some runs could not be read');
  assert.equal(capped.free, 1, 'a capped check list does not change train occupancy');
  const { documents, readBytes } = f.counts.at(-1);
  t.diagnostic(JSON.stringify({ cappedRunCase: { documents, readBytes } }));
  assert.ok(readBytes < 75_000, 'the canonical run page stays bounded with other active checks');
});

test('a failed check counts once for needs fix, a main-red hold rides the held patch and clears with it', async t => {
  const f = await finishFixture(t);
  const state = await f.enqueue(f.request());
  const summary = countSummaryWrites(f);
  await rewrite(f, state.id, s => ({
    ...s,
    observation: { ...s.observation, state: 'pending', pendingReason: 'queued' },
  }));
  // The gate parks it while main is red: held, mainRed, and no person is asked.
  const park = async hold =>
    f.tx(
      'flowPark',
      {
        _handler: async ctx => {
          const { row, state: before } = await landing.loadLanding(ctx, {
            projectId: f.projectId,
            submissionId: state.id,
          });
          await ctx.db.patch(row._id, { hold });
          await landing.writeLanding(
            ctx,
            { ...row, hold },
            { ...before, version: before.version + 1 },
            false,
          );
        },
      },
      {},
    );
  await park('main-red');
  let lane = (await read(f)).lanes[0];
  assert.equal(lane.held, true);
  assert.equal(lane.mainRed, true);
  await park(undefined);
  lane = (await read(f)).lanes[0];
  assert.equal(lane.held, false);
  assert.equal(lane.mainRed, undefined, 'the release clears main-red with the hold');
  assert.equal(summary.n, 0, 'holds write no summary');
  const fail = s => ({
    ...s,
    phase: 'terminal-failed',
    observation: { state: 'terminal-failed', pendingReason: null, cause: 'check-failed' },
    error: { code: 'CHECK_FAILED', message: 'synthetic failure' },
    counts: { ...s.counts, runnerSeconds: 120 },
  });
  await rewrite(f, state.id, fail);
  await rewrite(f, state.id, s => ({ ...s }));
  const today = day.flowToday((await read(f)).flow, Date.now(), Date.now() - 3_600_000);
  assert.equal(today.fix, 1, 'a replayed failed write counts once');
  assert.equal(today.ciMinutes, 2);
  assert.equal(today.lostMinutes, 2, 'a failed check’s minutes did not land');
  assert.equal(summary.n, 1, 'one summary write for the failed check');
});

test('CI seconds count each check once: a discarded shared check, then the members’ solo checks (85f456c1)', async t => {
  const f = await finishFixture(t);
  const summary = countSummaryWrites(f);
  const base = (id, phase, counts, extra = {}) => ({
    id,
    projectId: f.projectId,
    phase,
    held: false,
    hold: null,
    observation: { state: phase, pendingReason: null, cause: null },
    error: null,
    counts,
    ...extra,
  });
  const move = (before, after) =>
    f.tx(
      'flowMove',
      {
        _handler: async ctx => {
          if (after.phase === 'landed')
            await store.writeLineMain(ctx, f.projectId, { head: after.id, at: new Date().toISOString() }, 1);
          await sub.transitionLineSubmission(ctx, before, after);
        },
      },
      {},
    );
  const [a, b] = ['a', 'b'].map(c => c.repeat(8) + '-0000-4000-8000-000000000000');
  // A shared batch check of 300 s fails; the failure loop moves each member's 150 s share to its own discarded
  // seconds on a write that keeps the phase.
  for (const id of [a, b])
    await move(
      base(id, 'checking', { runnerSeconds: 150 }, { batchId: 'c'.repeat(8) }),
      base(id, 'checking', { discardedRunnerSeconds: 150 }, { batchId: 'c'.repeat(8) }),
    );
  // Each member lands on its own 60 s solo check; the shared share it still carries is not counted again.
  for (const id of [a, b])
    await move(
      base(id, 'checking', { discardedRunnerSeconds: 150 }),
      base(id, 'landed', { runnerSeconds: 60, discardedRunnerSeconds: 150 }),
    );
  // A resubmission's carried seconds arrive with its insert (no transition), so its landing counts its own check.
  await move(
    base('d'.repeat(8) + '-0000-4000-8000-000000000000', 'queued', { discardedRunnerSeconds: 120 }),
    base('d'.repeat(8) + '-0000-4000-8000-000000000000', 'landed', {
      runnerSeconds: 180,
      discardedRunnerSeconds: 120,
    }),
  );
  // An end whose check did not fail (superseded, cancelled after a pass, stalled) counts no seconds: its
  // resubmission may bind that same check and count it when it lands.
  for (const [c, code] of [
    ['e', 'LANDING_SUPERSEDED'],
    ['f', 'LANDING_CANCELLED'],
  ])
    await move(
      base(c.repeat(8) + '-0000-4000-8000-000000000000', 'ready', { runnerSeconds: 90 }),
      base(
        c.repeat(8) + '-0000-4000-8000-000000000000',
        'terminal-failed',
        { runnerSeconds: 90 },
        {
          error: { code, message: code },
        },
      ),
    );
  // f's resubmission binds the passed 90 s check: its carried 90 s leave discarded (ignored) and land once.
  await move(
    base('9'.repeat(8) + '-0000-4000-8000-000000000000', 'queued', { discardedRunnerSeconds: 90 }),
    base('9'.repeat(8) + '-0000-4000-8000-000000000000', 'landed', {
      runnerSeconds: 90,
      discardedRunnerSeconds: 0,
    }),
  );
  const today = day.flowToday((await read(f)).flow, Date.now(), Date.now() - 3_600_000);
  assert.equal(
    today.ciMinutes,
    Math.round((300 + 2 * 60 + 180 + 90) / 60),
    'shared 300 + solo 2 × 60 + 180 + the reused 90 once',
  );
  assert.equal(today.lostMinutes, 5, 'the failed shared check did not land');
  assert.equal(today.landed, 4);
  assert.equal(today.fix, 0);
  assert.equal(
    summary.n,
    10,
    'two discarded shares and two writes per publication and exit; no writes for a cancelled pass',
  );
});

test('main’s verdict reaches the summary only when it flips; a red ended without a revert is fixed on top', async t => {
  const f = await finishFixture(t);
  const at = new Date().toISOString();
  const flip = verdict =>
    f.tx('flowMain', { _handler: ctx => store.lineMainState(ctx.db, f.projectId, verdict) }, {});
  await flip({ red: true, at });
  await flip({ red: true, at: new Date(Date.now() + 60_000).toISOString() });
  let feed = await read(f);
  assert.deepEqual(
    feed.flow.main,
    { red: true, since: Date.parse(at) },
    'a repeated red keeps its first time',
  );
  await flip({ red: false, at, ended: 'fixed-on-top' });
  feed = await read(f);
  assert.equal(feed.flow.main.red, false);
  assert.equal(day.flowToday(feed.flow, Date.now(), Date.now() - 3_600_000).fixedOnTop, 1);
});

test('a batch landing moves the line’s main snapshot and counts every member, as a single landing does (85f456c1)', async t => {
  const titles = ['Change the parser', 'Speed up loading', 'Repair the toolbar', '界'.repeat(33)];
  const f = await batchesFixture(t, {
    memberMessages: titles.map((title, index) => `${title}${index === 3 ? '🌍' : ''}\n\nDetails`),
  });
  const summary = countSummaryWrites(f);
  const before = (await read(f)).main?.head;
  await f.drain();
  await f.passChecks();
  await f.drain();
  const head = f.currentMain().head;
  assert.notEqual(head, before);
  const feed = await read(f);
  assert.equal(
    feed.main.head,
    head,
    'the top bar and Flow view show the batch’s main, not the one before it',
  );
  assert.equal(feed.main.check, 'passed');
  for (const [index, entry] of f.entries.entries()) {
    const { submission } = await f.current(entry.state.id);
    const row = feed.recentLandings.find(row => row.receiptId === submission.acceptance.receiptId);
    assert.equal(row.title, titles[index], 'each batch member keeps its own title within the byte cap');
  }
  const row = [...f.tables.projectFinishReadRows.values()].find(r => r.kind === 'projectLiveLineSummary');
  const week = JSON.parse(row.value).publicWeek;
  assert.equal(
    week.days.reduce((n, d) => n + d.count, 0),
    4,
    'four receipts under one head count four landings',
  );
  assert.equal(
    week.days.reduce((n, d) => n + (d.hist ?? []).reduce((a, c) => a + c, 0), 0),
    4,
    'each member records its save-to-main time for the public week’s median (8947a779)',
  );
  assert.equal(day.flowToday(feed.flow, Date.now(), Date.now() - 3_600_000).landed, 4);
  t.diagnostic(JSON.stringify({ batchOfFour: { summaryWrites: summary.n } }));
});

test('the Flow day keeps one rolling day: old hours and samples drop, today follows the reader’s midnight', () => {
  const hour = day.HOUR_MS;
  const start = 1_000 * hour;
  let value = day.stepFlow(undefined, start, { landed: 1, took: 300 });
  value = day.stepFlow(value, start + 2 * hour, { landed: 2, fix: 1, took: 600 });
  value = day.stepFlow(value, start + 30 * hour, { landed: 1, took: 60 });
  assert.deepEqual(
    value.hours.map(row => row[0]),
    [1030],
    'hours older than a day are gone',
  );
  assert.equal(value.took.length, 1);
  const midnight = start + 29 * hour;
  const today = day.flowToday(value, start + 30 * hour + 10, midnight);
  assert.deepEqual(today.byHour, [0, 1]);
  assert.equal(today.landed, 1);
  for (let i = 0; i < 100; i++) value = day.stepFlow(value, start + 30 * hour, { took: i });
  assert.equal(value.took.length, day.FLOW_TOOK, 'samples are capped');
  assert.deepEqual(
    day.flowDay({ hours: 'x' }),
    { hours: [], took: [] },
    'another shape reads as an empty day',
  );
});
