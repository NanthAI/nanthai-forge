// SPDX-License-Identifier: Apache-2.0
// The Flow view's feed fields (Item 85f456c1) ride writes the line feed already makes: a landing's step goes in
// the summary write its exit already makes, a check key and a main-red hold ride the mark's stage/held patch.
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchesFixture, synthetic } from './hosted-landing-batches-fixture.mjs';
import { finishFixture } from './hosted-finish-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const line = await import(moduleUrl('../convex/projectLiveLine.ts'));
const landing = await import(moduleUrl('../convex/projectHostedLandingStore.ts'));
const store = await import(moduleUrl('../convex/projectLiveLineStore.ts'));
const day = await import(moduleUrl('../src/flow-day.ts'));
const sub = await import(moduleUrl('../convex/projectLiveLineSubmission.ts'));
const previousEnvironment = Object.fromEntries(Object.keys(synthetic).map(key => [key, process.env[key]]));
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
  const f = await batchesFixture(t);
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
  const row = [...f.tables.projectFinishReadRows.values()].find(r => r.kind === 'projectLiveLineSummary');
  const week = JSON.parse(row.value).publicWeek;
  assert.equal(
    week.days.reduce((n, d) => n + d.count, 0),
    4,
    'four receipts under one head count four landings',
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
