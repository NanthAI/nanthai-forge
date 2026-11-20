// SPDX-License-Identifier: Apache-2.0
// Stats day close (Items 2cf30e0a, a61d3c91): a project's day closes once, when a landing on a later UTC
// day is recorded; the close reads each receipt and its landing row (own columns, no body pages) once and writes one row; the read
// returns that day as measured figures only, with no clock argument.
import test from 'node:test';
import assert from 'node:assert/strict';
import { batchesFixture, synthetic } from './hosted-landing-batches-fixture.mjs';
import { fixtureLayers, readLimits } from './hosted-lanes-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';

const statsApi = await import(moduleUrl('../convex/projectStats.ts'));
const { landingRequestBodies } = await import(moduleUrl('../convex/projectLandingRequestBody.ts'));
const { scheduleStatsClose, utcDay } = await import(moduleUrl('../convex/projectStatsClose.ts'));
const { statsDay } = await import(moduleUrl('../src/stats-estimate.ts'));
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [k, v] of Object.entries(prior)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

test('only the first landing of a later UTC day schedules a close, for the previous day', async () => {
  const calls = [];
  const ctx = { scheduler: { runAfter: async (delay, ref, args) => calls.push({ delay, args }) } };
  const at = Date.parse('2026-11-04T23:59:00.000Z');
  await scheduleStatsClose(ctx, 'p', undefined, at);
  await scheduleStatsClose(ctx, 'p', at - 60_000, at);
  assert.equal(calls.length, 0, 'no previous landing, or the same day: nothing scheduled');
  await scheduleStatsClose(ctx, 'p', at, at + 120_000);
  assert.deepEqual(calls, [{ delay: 0, args: { projectId: 'p', day: '2026-11-04' } }]);
});

test('a closed day holds measured figures from receipts and landing rows, once', async t => {
  const f = await batchesFixture(t);
  await f.drain();
  await f.passChecks();
  await f.drain();
  const receipts = [...f.tables.projectHostedAcceptances.values()];
  assert.equal(receipts.length, 4);
  const day = utcDay(receipts[0]._creationTime);
  const before = f.counts.length;
  await f.tx('statsClose', statsApi.closeDay, { projectId: f.projectId, day });
  const close = f.counts.slice(before).find(c => c.name === 'statsClose');
  // Per landing: its receipt and its request row (this fixture's second body layer, absent in production, adds the row's
  // two body pages; the close's own read touches none, tested below); plus the day's own two lookups. A person's
  // day (Item 6a251b23) adds that day's Lanes once each, one row read and one write per active person, and one range of
  // the Work change rows since the previous closed day (planning closes and comments; empty here, billed as one read).
  // A first close looks back past the 14 days of change rows Convex keeps, so it reads the project once to know
  // whether it is old enough to have archived some (convex/personWork.ts). This fixture's project is that old (its clock
  // starts at 1970), so the close is partial and reads the project's writers once to mark them (an empty range here).
  const lanes = [...f.tables.projectHostedOverlapLanes.values()].filter(
    lane => utcDay(lane._creationTime) === day,
  );
  const people = [...f.tables.personDays.values()];
  assert(people.length >= 1, 'the submitter has a day row');
  // Every check run (Item a61d3c91, all-runs method; review 1240fe03 finding 5): the day's compact run rows and its run
  // rows not projected yet (one range each), the project's compact attempt index and the attempt rows around the day,
  // the newest earlier submission of each landing's Intent (one row; up to STATS_RESUBMIT_LOOKBACK only behind a
  // submission still running), and one landing row for each passed run that neither landed nor was rechecked. An empty
  // range bills as one document.
  const inDay = row => utcDay(row._creationTime) === day;
  const runs = [...f.tables.projectHostedCheckRuns.values()].filter(inDay).length;
  const attemptRows = [...(f.tables.projectFinishReadRows?.values() ?? [])].filter(
    row => row.kind === 'projectHostedLandingAttempts',
  ).length;
  const requests = [...f.tables.projectHostedLandingRequests.values()];
  const earlierOf = r =>
    requests.filter(o => o.intentId && o.intentId === r.intentId && o._creationTime < r._creationTime);
  const landed = requests.filter(r => r.phase === 'landed');
  const docs = close.readDocumentsByTable;
  assert.equal(
    docs.projectHostedLandingRequests,
    2 * receipts.length,
    'each ticket and one earlier submission',
  );
  assert(docs.projectHostedLandingAttempts + (docs.projectFinishReadRows ?? 0) <= attemptRows + runs + 3);
  assert(
    close.documents <=
      4 * receipts.length +
        2 +
        (lanes.length + 2) +
        people.length +
        3 +
        (runs + 2) +
        (attemptRows + 2) +
        receipts.length,
    `four reads per landing and one earlier submission, plus the day's runs: ${close.documents} (runs ${runs}, attempts ${attemptRows}) ${JSON.stringify(docs)}`,
  );
  const closedRow = [...f.tables.projectStatsDays.values()].find(r => r.day === day);
  const closedDay = JSON.parse(closedRow.value);
  assert.equal(closedDay.schema, 2);
  assert.equal(closedDay.ci.all.runs, runs, 'every run started that day is counted');
  // The run, attempt and earlier-submission rows add their own bytes; per landing stays as before.
  const size = row => JSON.stringify(row).length;
  const runBytes =
    [...f.tables.projectHostedCheckRuns.values()].filter(inDay).reduce((n, row) => n + 2 * size(row), 0) +
    [...(f.tables.projectFinishReadRows?.values() ?? [])]
      .filter(row => row.kind === 'projectHostedLandingAttempts')
      .reduce((n, row) => n + size(row), 0) +
    // The attempt rows themselves while the compact attempt index is not built (this fixture builds none).
    [...f.tables.projectHostedLandingAttempts.values()].reduce((n, row) => n + size(row), 0) +
    landed.flatMap(r => earlierOf(r).slice(-1)).reduce((n, row) => n + size(row), 0);
  assert(
    close.readBytes < 16_000 * receipts.length + runBytes,
    `bytes per landing: ${(close.readBytes - runBytes) / receipts.length} (runs and attempts ${runBytes})`,
  );
  assert.equal(close.writes, 1 + people.length);
  const counted = people.map(row => JSON.parse(row.value).p[f.projectId]);
  assert.equal(
    counted.reduce((n, entry) => n + entry.l, 0),
    4,
    'every landing counts once, for its submitter',
  );
  assert.equal(
    counted.reduce((n, entry) => n + entry.n, 0),
    lanes.length,
    'every Lane started that day counts once',
  );
  assert(
    people.every(row => row.value.length < 2_000),
    'a person-day row stays small',
  );
  await f.tx('statsClose', statsApi.closeDay, { projectId: f.projectId, day });
  assert.equal(
    [...f.tables.personDays.values()].length,
    people.length,
    'a repeated close writes no new person rows',
  );
  const rows = [...f.tables.projectStatsDays.values()];
  assert.equal(rows.length, 1, 'a day closes once');
  const closed = JSON.parse(rows[0].value);
  assert.equal(closed.day, day);
  assert.equal(closed.landings, 4);
  assert.equal(closed.firstTry.counted + closed.runner.unknown >= 4, true);
  // The screen reads one chosen range of closed days: its own month, never the whole table.
  const [y, m] = day.split('-').map(Number);
  const month = { from: `${day.slice(0, 7)}-01`, to: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10) };
  const read = JSON.parse(await f.tx('statsRead', statsApi.read, { projectId: f.projectId, ...month }));
  assert.equal(read.through, day);
  assert.deepEqual(read.perDay, [[day, 4]]);
  assert.equal(read.window.landings, 4);
  assert.equal(read.window.comparison, null, 'under 50 landings: measured only');
  const later = JSON.parse(
    await f.tx('statsRead', statsApi.read, { projectId: f.projectId, from: '2099-01-01', to: '2099-01-31' }),
  );
  assert.deepEqual([later.through, later.perDay], [null, []], 'a period with no closed day reads none');
  await assert.rejects(
    f.tx('statsRead', statsApi.read, { projectId: f.projectId, from: '2026-01-01', to: '2026-12-31' }),
    error => error.data?.code === 'BAD_ARGUMENT',
    'a range past 92 days is refused',
  );
});

// Review 1240fe03 findings 4, 5, 7 and 10 (Item a61d3c91).
const DAY = 86_400_000;
const dayOf = ms => new Date(ms).toISOString().slice(0, 10);
const scheduledIds = f => new Set(f.tables._scheduled_functions.keys());
const scheduledCloses = (f, before) =>
  [...f.tables._scheduled_functions.values()]
    .filter(task => !before.has(task._id) && task.name === 'projectStats:closeDay')
    .map(task => task.args[0]);

test('a day with check runs and no landing closes before the next landing day, and is counted', async t => {
  const f = await batchesFixture(t);
  await f.drain();
  await f.passChecks();
  await f.drain();
  const day = utcDay([...f.tables.projectHostedAcceptances.values()][0]._creationTime);
  await f.tx('statsClose', statsApi.closeDay, { projectId: f.projectId, day });
  const start = Date.parse(`${day}T00:00:00.000Z`);
  const gap = dayOf(start + DAY),
    next = dayOf(start + 2 * DAY);
  // One check run on the next day, not projected yet (a hand run that stopped), and no landing that day.
  const template = [...f.tables.projectHostedCheckRuns.values()][0];
  const run = { ...JSON.parse(template.value), id: 'gap-run', status: 'cancelled' };
  f.tables.projectHostedCheckRuns.set('gap-run-row', {
    ...template,
    _id: 'gap-run-row',
    _creationTime: start + DAY + 3_600_000,
    runId: 'gap-run',
    value: JSON.stringify(run),
    metricsProjected: undefined,
  });
  // A main audit still running that day (finding 2): marked by its gate, before it has any execution seconds.
  const audit = {
    ...JSON.parse(template.value),
    id: 'gap-audit',
    status: 'running',
    gate: { ...(JSON.parse(template.value).gate ?? {}), mode: 'audit' },
  };
  f.tables.projectHostedCheckRuns.set('gap-audit-row', {
    ...template,
    _id: 'gap-audit-row',
    _creationTime: start + DAY + 7_200_000,
    runId: 'gap-audit',
    value: JSON.stringify(audit),
    metricsProjected: undefined,
  });
  const at = scheduledIds(f),
    counted = f.counts.length;
  await f.tx('statsClose', statsApi.closeDay, { projectId: f.projectId, day: next });
  assert.deepEqual(
    scheduledCloses(f, at),
    [{ projectId: f.projectId, day: gap, then: next }],
    'the gap day first',
  );
  assert(
    ![...f.tables.projectStatsDays.values()].some(r => r.day === next),
    'the later day waits for the gap day',
  );
  const probe = f.counts.slice(counted).find(c => c.name === 'statsClose');
  assert(
    probe.documents <= 3 + 2,
    `the existing row, the previous day and two run probes: ${probe.documents}`,
  );
  const thenAt = scheduledIds(f);
  await f.tx('statsClose', statsApi.closeDay, { projectId: f.projectId, day: gap, then: next });
  const gapRow = [...f.tables.projectStatsDays.values()].find(r => r.day === gap);
  const gapDay = JSON.parse(gapRow.value);
  assert.deepEqual([gapDay.landings, gapDay.ci.all.runs, gapDay.ci.unlinked.runs], [0, 1, 1]);
  assert.equal(gapDay.ci.audits.runs, 1, 'the running audit is kept apart, not counted as a change’s check');
  assert.deepEqual(
    gapRow.lateRuns,
    [{ runId: 'gap-run', bucket: 'unlinked' }],
    'its minutes may still arrive',
  );
  assert.deepEqual(scheduledCloses(f, thenAt), [{ projectId: f.projectId, day: next }], 'then the later day');
  const lastAt = scheduledIds(f),
    lastCounted = f.counts.length;
  await f.tx('statsClose', statsApi.closeDay, { projectId: f.projectId, day: next });
  assert.deepEqual(scheduledCloses(f, lastAt), [], 'no gap left: nothing more scheduled');
  // The day after the previous closed day has no gap to probe (review b4dd69b4 finding 5): its one read of run rows not
  // projected yet is the close's own.
  const consecutive = f.counts.slice(lastCounted).find(c => c.name === 'statsClose');
  assert.equal(consecutive.readRangesByTable.projectHostedCheckRuns, 1, 'no gap probe');
  assert(
    [...f.tables.projectStatsDays.values()].some(r => r.day === next),
    'the later day closes once the gap day is closed',
  );
  const read = JSON.parse(
    await f.tx('statsRead', statsApi.read, { projectId: f.projectId, from: day, to: next }),
  );
  assert.equal(read.window.daysWithoutRuns, 0, 'every day recorded every run');
  assert(read.window.measured.unlinked.runs >= 1, 'the gap day run is counted on Forge’s side');
  // An existing day schedules its successor and writes nothing.
  const dupAt = scheduledIds(f);
  const rowsBefore = JSON.stringify([...f.tables.projectStatsDays.values()]);
  await f.tx('statsClose', statsApi.closeDay, { projectId: f.projectId, day: gap, then: next });
  assert.deepEqual(scheduledCloses(f, dupAt), [{ projectId: f.projectId, day: next }]);
  assert.equal(JSON.stringify([...f.tables.projectStatsDays.values()]), rowsBefore, 'no day row is written');
  assert.equal(f.counts.at(-1).writes, 1, 'only the scheduled close');
});

/** A close, then every close it schedules, as the scheduler would run them: a close that throws schedules nothing.
 * Returns the days whose close threw. */
async function closeChain(f, day) {
  const failed = [],
    queue = [{ projectId: f.projectId, day }];
  while (queue.length) {
    const args = queue.shift(),
      at = scheduledIds(f);
    try {
      await f.tx('statsClose', statsApi.closeDay, args);
    } catch {
      failed.push(args.day);
      continue;
    }
    queue.push(...scheduledCloses(f, at));
  }
  return failed;
}

// Review d6b0f1aa finding 5: a close that always throws must not stop the days after it.
test('a day whose close always throws is left not measured after its tries, and later days still close', async t => {
  const f = await batchesFixture(t);
  await f.drain();
  await f.passChecks();
  await f.drain();
  const receipt = [...f.tables.projectHostedAcceptances.values()][0];
  const day0 = utcDay(receipt._creationTime);
  await f.tx('statsClose', statsApi.closeDay, { projectId: f.projectId, day: day0 });
  const start = Date.parse(`${day0}T00:00:00.000Z`);
  const days = [1, 2, 3, 4, 5].map(n => dayOf(start + n * DAY));
  // A check run each day, none of them landed; day 1 also holds a receipt its close cannot read, so it throws every time.
  const template = [...f.tables.projectHostedCheckRuns.values()][0];
  days.forEach((d, i) => {
    const id = `fail-run-${i}`;
    f.tables.projectHostedCheckRuns.set(id, {
      ...template,
      _id: id,
      _creationTime: Date.parse(`${d}T01:00:00.000Z`),
      runId: id,
      value: JSON.stringify({ ...JSON.parse(template.value), id, status: 'cancelled' }),
      metricsProjected: undefined,
    });
  });
  f.tables.projectHostedAcceptances.set('broken-receipt', {
    ...receipt,
    _id: 'broken-receipt',
    _creationTime: Date.parse(`${days[0]}T02:00:00.000Z`),
    value: '{',
  });
  // A Lane started on the failing day (Done-when 22:05Z): its close never finishes, so a later close must count it.
  const laneRow = [...f.tables.projectHostedOverlapLanes.values()][0];
  f.tables.projectHostedOverlapLanes.set('fail-day-lane', {
    ...laneRow,
    _id: 'fail-day-lane',
    _creationTime: Date.parse(`${days[0]}T03:00:00.000Z`),
    laneId: 'fail-day-lane',
  });
  const run = day => closeChain(f, day);
  const row = d => [...f.tables.projectStatsDays.values()].find(r => r.day === d);
  const failedOf = d => JSON.parse(row(d).value).failed;
  // Landing days 2, 3 and 4 close in turn: each tries day 1 first, which throws, so day 1 holds its mark and its tries.
  for (const [i, trigger] of [days[1], days[2], days[3]].entries()) {
    assert.deepEqual(await run(trigger), [days[0]], `${trigger}: day 1 is tried and throws`);
    assert.equal(failedOf(days[0]).tries, i + 1);
    assert.equal(row(trigger), undefined, `${trigger} waits behind day 1`);
  }
  // Out of tries: the next close goes past day 1, and closes every day after it, oldest first.
  assert.deepEqual(await run(days[4]), [], 'nothing more throws');
  assert.deepEqual(failedOf(days[0]), {
    tries: 3,
    reason: 'The day close did not finish, so this day is not measured.',
    since: days[0],
  });
  // The day keeps its person-day work: the next close past it counts from where its close would have, and marks the
  // day partial (its landings were never read).
  const person = [...f.tables.personDays.values()].find(r => r.day === days[0] && r.person === laneRow.actor);
  assert(person, 'the not-measured day’s Lane is on its person’s day');
  const entry = JSON.parse(person.value).p[f.projectId];
  assert.equal(entry.n, 1, 'its Lane is counted');
  assert.equal(entry.pp, 1, 'marked partial: that day’s landings were never counted');
  for (const d of days.slice(1)) {
    assert(row(d), `${d} closed`);
    assert.equal(failedOf(d), undefined, `${d} is measured`);
    assert.equal(JSON.parse(row(d).value).ci.all.runs, 1, `${d}: its run is counted`);
  }
  // The page: day 1 is missing, never zero, and in no figure.
  const read = JSON.parse(
    await f.tx('statsRead', statsApi.read, { projectId: f.projectId, from: day0, to: days[4] }),
  );
  assert.deepEqual(read.perDay[1], [days[0], null], 'not measured, not zero');
  assert.equal(read.perDay.filter(([, n]) => n === null).length, 1);
  assert.equal(read.window.days, 5, 'the measured days only');
  assert.equal(read.window.daysWithoutRuns, 0, 'never “closed before every run was recorded”');
  assert.equal(
    read.window.measured.runs,
    4 + JSON.parse(row(day0).value).ci.all.runs,
    'day 1’s run is in no figure',
  );
  const months = JSON.parse(
    await f.tx('statsRead', statsApi.read, {
      projectId: f.projectId,
      from: day0,
      to: days[4],
      part: 'months',
    }),
  );
  assert.equal(
    months.months.reduce((n, m) => n + m.notMeasured, 0),
    1,
  );
});

test('re-close refuses today and later days: only closed days are rebuilt', async t => {
  const f = await batchesFixture(t);
  const today = utcDay(Date.now());
  for (const through of [today, dayOf(Date.now() + DAY)])
    await assert.rejects(
      f.tx('statsReclose', statsApi.recloseDays, { projectId: f.projectId, from: today, through }),
      error => (error.code ?? error.data?.code) === 'BAD_ARGUMENT',
      `through ${through} is refused`,
    );
  const yesterday = dayOf(Date.now() - DAY);
  const at = scheduledIds(f);
  await f.tx('statsReclose', statsApi.recloseDays, {
    projectId: f.projectId,
    from: yesterday,
    through: yesterday,
  });
  assert.deepEqual(scheduledCloses(f, at), [
    { projectId: f.projectId, day: yesterday, reclose: { through: yesterday } },
  ]);
});

test('resubmission reads at most three earlier submissions of the Intent and stops at its previous landing', async () => {
  const run = async rows => {
    const taken = [];
    let below = Infinity;
    // Rows newest first; each read's range ends below the `_creationTime` its `lt` names.
    rows = rows.map((r, i) => ({ ...r, _creationTime: 9 - i }));
    const range = {
      eq: () => range,
      lt: (_field, at) => ((below = at), range),
    };
    const chain = {
      withIndex: (_name, build) => (build(range), chain),
      order: () => chain,
      take: async n => {
        taken.push(n);
        const page = rows.filter(r => r._creationTime < below).slice(0, n);
        return page;
      },
      [Symbol.asyncIterator]: () => assert.fail('never iterated: the read is one bounded take'),
    };
    const ctx = { db: { query: () => chain } };
    const result = await statsApi.resubmittedBefore(ctx, 'p', { intentId: 'i', _creationTime: 10 });
    return { result, taken };
  };
  const row = phase => ({ phase, value: '{}' });
  assert.deepEqual(await run([]), { result: false, taken: [1] }, 'a first submission: one empty read');
  assert.deepEqual(
    await run([row('terminal-failed')]),
    { result: true, taken: [1] },
    'a failure since the last landing',
  );
  assert.deepEqual(
    await run([row('landed'), row('terminal-failed')]),
    { result: false, taken: [1] },
    'stops at the previous landing, one row read',
  );
  assert.deepEqual(
    await run([row('checking'), row('terminal-failed')]),
    { result: true, taken: [1, 2] },
    'a parallel submission still running is passed over: the look further starts below it',
  );
  assert.deepEqual(
    await run([row('checking'), row('checking'), row('terminal-failed')]),
    { result: true, taken: [1, 2] },
    'two more rows below the newest reach the third',
  );
  assert.equal(
    (await run([row('checking'), row('checking'), row('checking'), row('terminal-failed')])).result,
    false,
    'past three rows nothing is read',
  );
  assert.deepEqual(statsApi.STATS_RESUBMIT_LOOKBACK, 3);
  assert.equal(
    await statsApi.resubmittedBefore({ db: {} }, 'p', { _creationTime: 1 }),
    false,
    'no Intent: no read',
  );
});

test('the close reads landing rows without their body pages', async () => {
  const rows = [
    { _id: 'r2', phase: 'checking', value: '{}', requestBodyId: 'b2', projectId: 'p', submissionId: 's2' },
    {
      _id: 'r1',
      phase: 'terminal-failed',
      value: '{}',
      requestBodyId: 'b1',
      projectId: 'p',
      submissionId: 's1',
    },
  ];
  const gets = [];
  const chain = {
    withIndex: () => chain,
    order: () => chain,
    take: async n => rows.slice(0, n).map(row => ({ ...row })),
  };
  const raw = {
    query: () => chain,
    get: async id => (gets.push(id), { _id: id, value: '{}' }),
    normalizeId: (table, id) => (table === 'projectHostedLandingBodies' && id.startsWith('b') ? id : null),
  };
  // One body layer, as every mutation has in production (convex/server.ts).
  const ctx = landingRequestBodies({ db: raw });
  assert.equal(await statsApi.resubmittedBefore(ctx, 'p', { intentId: 'i', _creationTime: 10 }), true);
  assert.deepEqual(gets, [], 'no body page read');
});

test('a close reads no body page: its landing rows, the Intent’s earlier rows and a later landing’s fate', async t => {
  // Review d6b0f1aa finding 7, end to end with production's wrapper stack alone (convex/server.ts): every landing row
  // here points at body pages, so any of the three reads made through the body layer reads them.
  const f = await batchesFixture(t);
  await f.drain();
  await f.passChecks();
  await f.drain();
  const requests = [...f.tables.projectHostedLandingRequests.values()];
  assert(requests.length > 1 && requests.every(r => r.requestBodyId && r.intentId === requests[0].intentId));
  const day = utcDay(requests[0]._creationTime);
  const last = Math.max(...requests.map(r => r._creationTime));
  // A passed check of a submission that has not landed, with no compact landing row: its fate is the landing row.
  const template = requests.find(r => r.phase === 'landed');
  f.tables.projectHostedLandingRequests.set('fate-row', {
    ...template,
    _id: 'fate-row',
    _creationTime: last + 10,
    submissionId: 'fate-s',
    phase: 'checking',
    sequence: 99,
  });
  const attemptRow = [...f.tables.projectHostedLandingAttempts.values()][0];
  const attempt = JSON.parse(attemptRow.value);
  f.tables.projectHostedLandingAttempts.set('fate-attempt', {
    ...attemptRow,
    _id: 'fate-attempt',
    _creationTime: last + 11,
    value: JSON.stringify({
      ...attempt,
      id: 'fate-a',
      submissionId: 'fate-s',
      parentAttemptId: null,
      check: { ...attempt.check, runId: 'fate-run' },
    }),
  });
  const runRow = [...f.tables.projectHostedCheckRuns.values()][0];
  f.tables.projectHostedCheckRuns.set('fate-run-row', {
    ...runRow,
    _id: 'fate-run-row',
    _creationTime: last + 12,
    runId: 'fate-run',
    metricsProjected: undefined,
    value: JSON.stringify({ ...JSON.parse(runRow.value), id: 'fate-run', status: 'passed' }),
  });
  const before = f.counts.length;
  fixtureLayers.outer = false;
  try {
    await f.tx('statsClose', statsApi.closeDay, { projectId: f.projectId, day });
  } finally {
    fixtureLayers.outer = true;
  }
  const close = f.counts.slice(before).find(c => c.name === 'statsClose');
  const docs = close.readDocumentsByTable;
  // Each landing's own row, each landing's previous row of the Intent, and the fate lookup: all landing rows.
  assert(docs.projectHostedLandingRequests >= 2 * requests.length + 1, JSON.stringify(docs));
  assert.equal(docs.projectHostedLandingBodies, undefined, `no body page read: ${JSON.stringify(docs)}`);
  const closed = JSON.parse([...f.tables.projectStatsDays.values()].find(r => r.day === day).value);
  assert.equal(closed.landings, requests.length);
});

test('a discarded check whose minutes are not known yet is not a first try', () => {
  const receipt = { id: 'receipt', at: '2026-11-18T10:00:00.000Z' };
  const state = (counts = {}) => ({
    at: '2026-11-18T09:50:00.000Z',
    counts: { runnerSeconds: 300, discardedRunnerSeconds: 0, ...counts },
  });
  assert.equal(statsApi.statsLanding(receipt, state()).attempts, 1, 'nothing discarded: first try');
  assert.equal(statsApi.statsLanding(receipt, state(), 1).attempts, 2, 'a stopped run still reporting');
  assert.equal(
    statsApi.statsLanding(receipt, state({ discardedRunnerUnknown: 1 })).attempts,
    2,
    'a discarded check that reported no minutes',
  );
  assert.equal(statsApi.statsLanding(receipt, state(), 0, true).attempts, 2, 'resubmitted');
});

test('a day with more run bytes than one close may read is partial, inside one transaction’s limits', async t => {
  const f = await batchesFixture(t);
  await f.drain();
  await f.passChecks();
  await f.drain();
  const day = utcDay([...f.tables.projectHostedAcceptances.values()][0]._creationTime);
  const start = Date.parse(`${day}T00:00:00.000Z`);
  // 1,700 compact run rows of about 9 KB each (15.3 MB): past what one transaction may read beside the rest.
  const pad = 'x'.repeat(9_000);
  for (let i = 0; i < 1_700; i++) {
    const id = `busy-${i}`;
    f.tables.projectFinishReadRows.set(id, {
      _id: id,
      _creationTime: start + 1_000 + i,
      kind: 'projectMetricCheckRuns',
      projectId: f.projectId,
      sourceId: id,
      sourceCreatedAt: start + 1_000 + i,
      value: JSON.stringify({
        id,
        at: new Date(start + 1_000 + i).toISOString(),
        endedAt: new Date(start + 301_000 + i).toISOString(),
        status: 'passed',
        runnerMinutes: 5,
        fullSuite: true,
        auditRunnerSeconds: null,
        pad,
      }),
    });
  }
  const before = f.counts.length;
  // Past the fixture's controller bounds (2 MiB) on purpose; they assert after the close has run. The transaction's read
  // meter is what keeps the close inside one Convex transaction (the fixture throws on any read past its limits).
  await f
    .transaction('statsClose', statsApi.closeDay, { projectId: f.projectId, day }, 'owner')
    .catch(error => {
      if (!/statsClose: (bounded|metadata)/.test(error.message)) throw error;
    });
  const close = f.counts.slice(before).find(c => c.name === 'statsClose');
  const closed = JSON.parse([...f.tables.projectStatsDays.values()].find(r => r.day === day).value);
  assert.equal(closed.ci.partial, true, 'the runs past the budget are not guessed');
  assert.equal(closed.landings, 4, 'every landing is still counted');
  assert(closed.ci.all.runs > 1_000 && closed.ci.all.runs < 1_700, `runs read: ${closed.ci.all.runs}`);
  assert(
    close.readBytes < 16 * 1024 * 1024 - 256 * 1024,
    `bytes read: ${close.readBytes}, under 16 MiB with room`,
  );
  // The stated ceiling (review d6b0f1aa): readers stop once 2 MiB is left, so a close reads at most 14 MiB and one more
  // page (200 of these rows). At $0.20 per GB of database I/O, 14 MiB is $0.0029.
  const page = 200 * JSON.stringify(f.tables.projectFinishReadRows.get('busy-0')).length;
  assert(
    close.readBytes <= 14 * 1024 * 1024 + page,
    `bytes read: ${close.readBytes}, at most 14 MiB and a page`,
  );
  const dollars = bytes => (bytes * 0.2) / 1e9;
  assert.equal(Math.round(dollars(14 * 1024 * 1024) * 1e4) / 1e4, 0.0029);
  assert(dollars(close.readBytes - page) < 0.00295, `${dollars(close.readBytes)} dollars for the day`);
  assert(close.ranges < 4_096, `index ranges: ${close.ranges}`);
});

// Review b4dd69b4 finding 2: every reader of one close at its cap. `parts` picks the landings, the person's day and the
// runs (with their attempts and lookups).
async function worstDay(t, parts) {
  const f = await batchesFixture(t);
  await f.drain();
  await f.passChecks();
  await f.drain();
  const receipt = [...f.tables.projectHostedAcceptances.values()][0];
  const day = utcDay(receipt._creationTime);
  const start = Date.parse(`${day}T00:00:00.000Z`);
  const request = [...f.tables.projectHostedLandingRequests.values()].find(r => r.phase === 'landed');
  const attempt = [...f.tables.projectHostedLandingAttempts.values()][0];
  const run = [...f.tables.projectHostedCheckRuns.values()][0];
  const lane = [...f.tables.projectHostedOverlapLanes.values()][0];
  assert(request && attempt && run && lane, 'template rows');
  const put = (table, id, row) => f.tables[table].set(id, { ...row, _id: id });
  if (parts.landings)
    // 1,000 landings (the day's cap), each with two earlier submissions of its Intent: a parallel one still running and a
    // failure, so each landing reads the Intent's rows twice (the three-row look). The close reads landing rows' own
    // columns only, so these carry no body pages (this fixture adds a second body layer production does not have; the
    // body-free read is tested on its own below).
    for (let i = 0; i < 1_000; i++) {
      const at = start + 60_000 + i * 50;
      const submissionId = `wc-s-${i}`,
        intentId = `wc-i-${i}`;
      put('projectHostedAcceptances', `wc-a-${i}`, {
        ...receipt,
        _creationTime: at,
        value: JSON.stringify({ ...JSON.parse(receipt.value), id: `wc-a-${i}`, submissionId }),
      });
      const landing = (id, phase, created, sub) =>
        put('projectHostedLandingRequests', id, {
          ...request,
          _creationTime: created,
          submissionId: sub,
          intentId,
          phase,
          requestBodyId: undefined,
          selectionBodyId: undefined,
          value: JSON.stringify({ ...JSON.parse(request.value), id: sub, pad: 'q'.repeat(1_500) }),
        });
      landing(`wc-r-${i}`, 'landed', at - 10, submissionId);
      landing(`wc-r-${i}-run`, 'checking', at - 20, `${submissionId}-run`);
      landing(`wc-r-${i}-fail`, 'terminal-failed', at - 30, `${submissionId}-fail`);
    }
  if (parts.person)
    // A person's day at its caps: change rows past PERSON_WORK_CHANGES; every one of the first 400 commands a close of an
    // Item, kept in a retained body (two reads) and checked against the Item's version before it (a third).
    for (let n = 0; n < 1_001; n++) {
      const at = start + 100_000 + n;
      put('projectCoordinationEvents', `wc-c-${n}`, {
        _creationTime: at,
        projectId: f.projectId,
        actor: 'owner',
        operationId: `work:wc-o-${n}`,
        at,
        kind: 'change',
        command: { kind: 'change', source: 'work', action: 'put-planning-item' },
      });
      put('projectHostedRecordBodies', `wc-rb-${n}`, {
        _creationTime: at,
        projectId: f.projectId,
        operationId: `wc-o-${n}`,
        command: JSON.stringify({
          action: 'put-planning-item',
          itemId: `item-${n}`,
          status: 'closed',
          expectedVersion: 2,
          text: 't'.repeat(9_000),
        }),
        value: '',
      });
    }
  // 2,000 Lanes (each range's cap), open and not.
  if (parts.person)
    for (let n = 0; n < 2_000; n++)
      put('projectHostedOverlapLanes', `wc-l-${n}`, {
        ...lane,
        _creationTime: start + 200_000 + n,
        open: n % 2 === 0,
        // One person, or `parts.people` of them: one person-day row each to write.
        actor: parts.people ? `person-${n % parts.people}` : 'owner',
        laneId: `wc-lane-${n}`,
      });
  if (!parts.runs) return { f, day };
  // 3,000 compact runs and 250 run rows not projected yet; 6,000 attempt rows by default (no compact attempt index), the first 300
  // naming a passed run whose landing must be looked up.
  for (let n = 0; n < 3_000; n++) {
    const at = start + 300_000 + n;
    put('projectFinishReadRows', `wc-run-${n}`, {
      _creationTime: at,
      kind: 'projectMetricCheckRuns',
      projectId: f.projectId,
      sourceId: `wc-run-${n}`,
      sourceCreatedAt: at,
      value: JSON.stringify({
        id: `wc-run-${n}`,
        at: new Date(at).toISOString(),
        endedAt: new Date(at + 300_000).toISOString(),
        status: 'passed',
        runnerMinutes: 5,
        fullSuite: true,
        auditRunnerSeconds: null,
        pad: 'r'.repeat(600),
      }),
    });
  }
  const rawRun = JSON.parse(run.value);
  for (let n = 0; n < 250; n++)
    put('projectHostedCheckRuns', `wc-raw-${n}`, {
      ...run,
      _creationTime: start + 400_000 + n,
      runId: `wc-raw-${n}`,
      metricsProjected: undefined,
      value: JSON.stringify({ ...rawRun, id: `wc-raw-${n}` }),
    });
  const rawAttempt = JSON.parse(attempt.value);
  for (let n = 0; n < (parts.attempts ?? 6_000); n++)
    put('projectHostedLandingAttempts', `wc-at-${n}`, {
      ...attempt,
      _creationTime: start - 3_600_000 + n,
      value: JSON.stringify({
        ...rawAttempt,
        id: `wc-at-${n}`,
        submissionId: `wc-look-${n}`,
        parentAttemptId: null,
        check: { ...rawAttempt.check, runId: n < 300 ? `wc-run-${n}` : `wc-none-${n}` },
      }),
    });
  return { f, day };
}

async function closeAtLimits(f, day) {
  const before = f.counts.length;
  // Convex's own limits for this one close (docs.convex.dev/production/state/limits): 4,096 queries, 16 MiB and 32,000
  // documents; the fixture throws on any read past them. Its controller bounds assert after the close, on purpose.
  readLimits.documents = 32_000;
  try {
    await f
      .transaction('statsClose', statsApi.closeDay, { projectId: f.projectId, day }, 'owner')
      .catch(error => {
        if (!/statsClose: (bounded|metadata)/.test(error.message)) throw error;
      });
  } finally {
    readLimits.documents = 4096;
  }
  const close = f.counts.slice(before).find(c => c.name === 'statsClose');
  assert(close.ranges < 4_096, `queries: ${close.ranges}`);
  assert(close.readBytes < 16 * 1024 * 1024, `bytes read: ${close.readBytes}`);
  assert(close.documents < 32_000, `documents: ${close.documents}`);
  return close;
}

test('a worst-case day through every reader of the close stays inside one transaction', async t => {
  const { f, day } = await worstDay(t, { landings: true, person: true, runs: true });
  const close = await closeAtLimits(f, day);
  const docs = close.readDocumentsByTable;
  // The landings stop with room kept for the runs, and the runs with room kept for the close's writes: the day is
  // partial on both counts. The attempts get no room on a day this full (their own test is below).
  for (const table of [
    'projectHostedAcceptances',
    'projectHostedLandingRequests',
    'projectCoordinationEvents',
    'projectHostedRecordBodies',
    'projectHostedRecords',
    'projectHostedOverlapLanes',
    'projectFinishReadRows',
    'projectHostedCheckRuns',
  ])
    assert(docs[table] > 0, `${table} was read: ${JSON.stringify(docs)}`);
  const closed = JSON.parse([...f.tables.projectStatsDays.values()].find(r => r.day === day).value);
  assert.equal(closed.partial, true, 'landings past the room left are not guessed');
  assert(closed.landings > 100 && closed.landings < 1_000, `landings read: ${closed.landings}`);
  assert.equal(closed.ci.partial, true, 'the runs past the room left are not guessed');
  assert(closed.ci.all.runs > 0, `runs read: ${closed.ci.all.runs}`);
  assert.equal(closed.planningPartial, true, 'planning past its caps is marked');
  assert([...f.tables.personDays.values()].length > 0, 'the person-day rows are written');
});

test('a worst-case day with many people closes, its person days metered and marked partial', async t => {
  // 2,000 Lanes by 2,000 people: one person-day read and write each after the landings stop (they keep 1,000 queries).
  // Unmetered, the close passed Convex's 4,096 queries and failed whole (review d6b0f1aa finding 5). The person-day
  // writes are under the transaction's meter (Done-when d5857b5c): the day closes, with the people it could not write
  // left out and the day marked, and its runs still read.
  const { f, day } = await worstDay(t, { landings: true, person: true, people: 2_000, runs: true });
  const close = await closeAtLimits(f, day);
  const row = [...f.tables.projectStatsDays.values()].find(r => r.day === day);
  assert(row, 'the day closes');
  const closed = JSON.parse(row.value);
  assert.equal(closed.failed, undefined, 'measured, not failed');
  assert.equal(closed.peoplePartial, true, 'people left unwritten are marked on the day');
  const written = [...f.tables.personDays.values()].filter(r => r.day === day).length;
  assert(written > 100 && written < 2_000, `person days written: ${written}`);
  assert(closed.ci.all.runs > 0, `the runs still get room: ${closed.ci.all.runs}`);
  assert(close.ranges < 4_096 - 64, `queries: ${close.ranges}`);
});

test('a day whose landings were read only in part marks each person’s day partial', async t => {
  // 1,001 receipts: one past the day's cap, so the close reads 1,000 at most (review d6b0f1aa finding 4). No planning
  // work, so the mark comes from the landings alone.
  const { f, day } = await worstDay(t, { landings: true });
  // Closed the next day, so the planning reads are within the change rows Convex keeps and see all of that work.
  const now = Date.now;
  Date.now = () => Date.parse(`${day}T00:00:00.000Z`) + DAY + 3_600_000;
  try {
    await closeAtLimits(f, day);
  } finally {
    Date.now = now;
  }
  const closed = JSON.parse([...f.tables.projectStatsDays.values()].find(r => r.day === day).value);
  assert.equal(closed.partial, true);
  assert.equal(closed.planningPartial, undefined, 'no planning work was cut');
  const people = [...f.tables.personDays.values()].filter(r => r.day === day);
  assert(people.length > 0, 'the landers have person days');
  for (const row of people)
    assert.equal(JSON.parse(row.value).p[f.projectId].pp, 1, `${row.person}: the landings are a floor`);
});

test('run rows not projected yet, each at a shard pool’s 4,096 paths, stay inside one transaction', async t => {
  // Review d6b0f1aa finding 6: a full run row can carry 4,096 pending pool paths. 50 of them (a page at the old size)
  // are about 20 MB, past 16 MiB in one read; the close reads them one at a time under the meter and stops partial.
  const { f, day } = await worstDay(t, {});
  const start = Date.parse(`${day}T00:00:00.000Z`);
  const run = [...f.tables.projectHostedCheckRuns.values()][0];
  const value = JSON.parse(run.value);
  for (let n = 0; n < 50; n++) {
    const poolPending = Array.from(
      { length: 4_096 },
      (_, i) =>
        `tests/contract/area-${n}/a-module-with-a-long-descriptive-name-for-its-behaviour-${i}.test.mjs`,
    );
    f.tables.projectHostedCheckRuns.set(`pool-${n}`, {
      ...run,
      _id: `pool-${n}`,
      _creationTime: start + 500_000 + n,
      runId: `pool-${n}`,
      metricsProjected: undefined,
      value: JSON.stringify({ ...value, id: `pool-${n}`, poolPending }),
    });
  }
  const bytes = JSON.stringify(f.tables.projectHostedCheckRuns.get('pool-0')).length;
  assert(bytes > 350_000 && bytes < 1024 * 1024, `one row: ${bytes} bytes, under Convex's 1 MiB document`);
  const close = await closeAtLimits(f, day);
  const closed = JSON.parse([...f.tables.projectStatsDays.values()].find(r => r.day === day).value);
  assert.equal(closed.ci.partial, true, 'the rows past the room kept are not guessed');
  assert(closed.ci.all.runs > 20 && closed.ci.all.runs < 50, `runs read: ${closed.ci.all.runs}`);
  assert(
    close.readBytes < 16 * 1024 * 1024 - 1024 * 1024,
    `bytes read: ${close.readBytes}, one row inside the room`,
  );
});

test('the runs, attempts and landing lookups at their caps stay inside one transaction', async t => {
  // 2,000 attempt rows (about 7 MB) leave room for the lookups; 6,000 on a full day stop at the room kept (above).
  const { f, day } = await worstDay(t, { runs: true, attempts: 2_000 });
  const close = await closeAtLimits(f, day);
  const docs = close.readDocumentsByTable;
  for (const table of ['projectFinishReadRows', 'projectHostedCheckRuns', 'projectHostedLandingAttempts'])
    assert(docs[table] > 0, `${table} was read: ${JSON.stringify(docs)}`);
  // Each passed run whose attempt neither landed nor was rechecked looks its landing up once (none exists here).
  assert(docs.projectHostedLandingRequests >= 300, `lookups: ${JSON.stringify(docs)}`);
  const closed = JSON.parse([...f.tables.projectStatsDays.values()].find(r => r.day === day).value);
  assert.equal(closed.ci.partial, true, 'attempts past the room left are not guessed');
  assert.equal(closed.landings, 4);
});

test('the day close judges the daily waste tripwire from the rows it read and carries its state to the next day', async t => {
  // Item a217b83e (lead 20b27f1d): day budgets are judged once per closed day here, never on the landing path.
  const f = await batchesFixture(t);
  await f.drain();
  await f.passChecks();
  await f.drain();
  const day = utcDay([...f.tables.projectHostedAcceptances.values()][0]._creationTime);
  // Every landing's usage is in: known runner seconds and no discarded check.
  for (const request of [...f.tables.projectHostedLandingRequests.values()]) {
    const state = JSON.parse(request.value);
    if (state.phase === 'landed')
      f.patch('projectHostedLandingRequests', request._id, {
        value: JSON.stringify({
          ...state,
          counts: { ...state.counts, runnerSeconds: 300, discardedRunnerSeconds: 0 },
        }),
      });
  }
  const priorDay = new Date(Date.parse(day) - 86_400_000).toISOString().slice(0, 10);
  // The previous closed day left the tripwire broken (landing 1117w000 discarded the most).
  const open = { since: `${priorDay}T23:59:59.999Z`, landing: '1117w000', value: 6613 };
  f.insert('projectStatsDays', {
    projectId: f.projectId,
    day: priorDay,
    value: JSON.stringify(statsDay(priorDay, [])),
    budgets: JSON.stringify({ broken: { 'runner-waste-daily': open } }),
  });
  const scheduled = () =>
    [...f.tables._scheduled_functions.values()].filter(s => s.name === 'projectLandingSpeedIssue:write');
  const before = scheduled().length;
  await f.tx('statsClose', statsApi.closeDay, { projectId: f.projectId, day });
  const row = [...f.tables.projectStatsDays.values()].find(r => r.day === day);
  const carried = JSON.parse(row.budgets);
  assert.equal(carried.broken, undefined, 'a day under the line ends the break');
  assert(carried.ratchet['runner-waste-daily'], 'the closed day joins the ratchet history');
  assert(row.budgets.length < 400, `day state stays small: ${row.budgets.length}`);
  const written = scheduled().slice(before);
  assert.equal(
    written.length,
    1,
    'the recovery updates the P0 Issue through the same path as a window budget',
  );
  assert.match(JSON.parse(written[0].args[0].issue).title, /recovered|P0 speed budget/i);
});

// Done-when 22:05Z (Item a61d3c91): All time from monthly rollups, and the self-trend's read.
test('All time reads one rollup a closed month and the open month’s days, never every day', async t => {
  const f = await batchesFixture(t);
  await f.drain();
  const put = (name, n) => {
    const start = Date.parse(`${name}T09:00:00.000Z`);
    const landings = Array.from({ length: n }, (_, i) => ({
      id: `${name}-${i}`,
      who: 'amber-fox',
      submittedAt: start + i * 60_000,
      landedAt: start + i * 60_000 + 300_000,
      checkStartedAt: null,
      checkEndedAt: null,
      runnerSeconds: 100,
      discardedRunnerSeconds: 0,
      attempts: 1,
      ranInFull: true,
    }));
    f.tables.projectStatsDays.set(`sd-${name}`, {
      _id: `sd-${name}`,
      _creationTime: start,
      projectId: f.projectId,
      day: name,
      value: JSON.stringify(statsDay(name, landings)),
    });
  };
  const sep = Array.from({ length: 30 }, (_, i) => `2026-09-${String(i + 1).padStart(2, '0')}`);
  const oct = Array.from({ length: 31 }, (_, i) => `2026-10-${String(i + 1).padStart(2, '0')}`);
  const nov = ['2026-11-01', '2026-11-02', '2026-11-03'];
  // A re-close that finishes a closed month rolls it up (here before the rows exist: it writes no empty day).
  const at = scheduledIds(f);
  await f.tx('statsClose', statsApi.closeDay, {
    projectId: f.projectId,
    day: '2026-10-31',
    reclose: { through: '2026-10-31' },
  });
  assert.deepEqual(
    [...f.tables._scheduled_functions.values()]
      .filter(task => !at.has(task._id) && task.name === 'projectStats:rollMonth')
      .map(task => task.args[0]),
    [{ projectId: f.projectId, month: '2026-10' }],
  );
  for (const d of [...sep, ...oct, ...nov]) put(d, 2);
  for (const month of ['2026-09', '2026-10'])
    await f.tx('statsRoll', statsApi.rollMonth, { projectId: f.projectId, month });
  assert.equal(f.tables.projectStatsMonths.size, 2);
  const before = f.counts.length;
  const all = JSON.parse(await f.tx('statsReadAll', statsApi.readAll, { projectId: f.projectId }));
  const read = f.counts.slice(before).find(c => c.name === 'statsReadAll');
  assert.equal(read.readDocumentsByTable.projectStatsMonths, 2, 'one row a closed month');
  assert.equal(read.readDocumentsByTable.projectStatsDays, 3, 'only the open month’s days');
  assert.equal(all.window.landings, 2 * 64, 'every day counted');
  assert.deepEqual(all.cover, { first: '2026-09-01', last: '2026-11-03', closed: 64, notMeasured: 0 });
  assert.deepEqual(all.perMonth, [
    ['2026-09', 60],
    ['2026-10', 62],
    ['2026-11', 6],
  ]);
  // The self-trend: the range, and the same number of days just before it (only when its fold asks).
  const trendAt = f.counts.length;
  const trend = JSON.parse(
    await f.tx('statsRead', statsApi.read, {
      projectId: f.projectId,
      from: '2026-11-01',
      to: '2026-11-03',
      part: 'trend',
    }),
  );
  const trendRead = f.counts.slice(trendAt).find(c => c.name === 'statsRead');
  assert.equal(trendRead.readDocumentsByTable.projectStatsDays, 6, 'this range and the one before');
  assert.deepEqual([trend.previous.from, trend.previous.to], ['2026-10-29', '2026-10-31']);
  assert.equal(trend.previous.cover.closed, 3);
  assert.equal(trend.current.landingsPerDay, 2);
  const headAt = f.counts.length;
  await f.tx('statsRead', statsApi.read, { projectId: f.projectId, from: '2026-11-01', to: '2026-11-03' });
  assert.equal(
    f.counts.slice(headAt).find(c => c.name === 'statsRead').readDocumentsByTable.projectStatsDays,
    3,
    'the head reads its own range only',
  );
});
