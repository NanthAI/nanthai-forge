// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { buildComposePages } from '../dist/hosted-compose.js';
import { readHostedMetricPages } from '../dist/self-metrics-hosted-pages.js';
import { metricsSurface } from '../dist/self-metrics-surface.js';
import { calculateSelfMetrics } from '../dist/self-metrics.js';
import { runResourceWorker, assertMetricResources } from './resource-budget.mjs';
import { calculateWaste } from '../dist/self-metrics-waste.js';
import { fixture, period, at } from './self-metrics-hosted-fixture.mjs';
const head = char => char.repeat(64);
function evidence(f) {
  const objects = new Map();
  const input = (lane, intent, h, savedAt, version = 0) => {
    const built = buildComposePages([
      {
        laneId: lane,
        head: h,
        version,
        sourceVersion: version,
        lifecycleVersion: 0,
        state: { object: { sha256: h, size: 0 }, recipe: null },
      },
    ]);
    for (const page of built.pages) objects.set(page.pin.sha256, saveBytes(page.value));
    const body = f.put(
      'projectHostedRecordBodies',
      {
        projectId: 'project',
        value: JSON.stringify({
          kind: 'lane',
          id: lane,
          version,
          intentId: intent,
          head: h,
          at: savedAt,
        }),
      },
      savedAt,
    );
    f.put(
      'projectHostedRecords',
      {
        projectId: 'project',
        kind: 'lane',
        key: lane,
        parent: intent,
        status: 'active',
        version,
        bodyId: body._id,
        digest: h,
        bytes: 100,
      },
      savedAt,
    );
    const saveId = randomUUID();
    const saved = f.put(
      'projectHostedRecordBodies',
      {
        projectId: 'project',
        value: JSON.stringify({
          kind: 'save',
          id: saveId,
          laneId: lane,
          head: h,
          at: savedAt,
        }),
      },
      savedAt,
    );
    f.put(
      'projectHostedRecords',
      {
        projectId: 'project',
        kind: 'save',
        key: saveId,
        parent: lane,
        status: 'saved',
        version: 0,
        bodyId: saved._id,
        digest: h,
        bytes: 100,
      },
      savedAt,
    );
    return built.manifest.root;
  };
  const attempt = (id, start, pin, runId, main = head('1'), parent = null) => {
    const row = f.tables.projectHostedLandingAttempts.find(row => row.attemptId === id);
    const value = {
      id,
      at: start,
      parentAttemptId: parent,
      main: { head: main },
      candidate: { inputs: pin },
      check: runId ? { runId } : null,
      actor: { kind: 'agent' },
      policy: { acceptance: { mode: 'auto-on-pass' } },
    };
    if (row) row.value = JSON.stringify(value);
    else
      f.put(
        'projectHostedLandingAttempts',
        {
          projectId: 'project',
          submissionId: id.split('/')[0],
          attemptId: id,
          number: 1,
          value: JSON.stringify(value),
        },
        start,
      );
  };
  const landing = (id, start, end, pin, runId = id) => {
    f.landing(id, start, end);
    attempt(id, start, pin, runId);
    const move = f.tables.projectHostedAcceptances.at(-1);
    const value = JSON.parse(move.value);
    value.candidate.inputs = pin;
    move.value = JSON.stringify(value);
  };
  const fail = (id, start, end, pin, code = 'CHECK_FAILED') => {
    landing(id, start, end, pin);
    f.tables.projectHostedAcceptances.pop();
    const row = f.tables.projectHostedLandingRequests.at(-1);
    row.phase = 'terminal-failed';
    row.value = JSON.stringify({
      id,
      actor: 'builder',
      operationId: id,
      at: start,
      attemptId: id,
      phase: 'terminal-failed',
      error: { code },
      timing: { submittedAt: start, settledAt: end },
    });
    f.run(id, start, end, 120);
    const run = f.tables.projectHostedCheckRuns.at(-1);
    const value = JSON.parse(run.value);
    value.status = 'failed';
    run.value = JSON.stringify(value);
  };
  let objectCalls = 0;
  f.query.objects = async pins => {
    objectCalls++;
    assert(pins.length <= 8);
    assert(pins.reduce((sum, pin) => sum + pin.size, 0) <= 1024 * 1024);
    return pins.map(pin => objects.get(pin.sha256));
  };
  // A stacked batch Candidate is composed with empty inputs; its members ride on memberCandidate.
  const stack = () => {
    const built = buildComposePages([]);
    for (const page of built.pages) objects.set(page.pin.sha256, saveBytes(page.value));
    return built.manifest.root;
  };
  const batch = (id, start, end, member, runId = id) => {
    landing(id, start, end, stack(), runId);
    const row = f.tables.projectHostedLandingAttempts.find(row => row.attemptId === id);
    row.value = JSON.stringify({ ...JSON.parse(row.value), memberCandidate: { inputs: member } });
    const move = f.tables.projectHostedAcceptances.at(-1);
    move.value = JSON.stringify({ ...JSON.parse(move.value), memberCandidate: { inputs: member } });
  };
  return {
    input,
    attempt,
    landing,
    batch,
    stack,
    fail,
    get objectCalls() {
      return objectCalls;
    },
  };
}
import { saveBytes } from '../dist/hosted-save.js';

test('hosted immutable inputs classify first try, retry, fixer and main-race waste with actor attribution', async () => {
  const f = fixture(),
    e = evidence(f);
  const first = e.input(randomUUID(), randomUUID(), head('a'), at(-30));
  e.landing('first', at(1), at(5), first);
  f.run('first', at(1), at(5), 180);
  const retry = e.input(randomUUID(), randomUUID(), head('b'), at(-20));
  e.fail('retry-failed', at(2), at(4), retry);
  e.landing('retry-landed', at(6), at(10), retry);
  f.run('retry-landed', at(6), at(10), 180);
  const lane = randomUUID(),
    intent = randomUUID();
  e.fail('fix-failed', at(2), at(4), e.input(lane, intent, head('c'), at(-10)));
  e.landing('fix-landed', at(7), at(11), e.input(lane, intent, head('d'), at(5), 1));
  f.run('fix-landed', at(7), at(11), 180);
  const race = e.input(randomUUID(), randomUUID(), head('e'), at(-10));
  e.landing('race', at(1), at(12), race, 'race-recheck');
  e.attempt('race', at(1), race, 'race-discarded');
  e.attempt('race/child', at(6), race, 'race-recheck', head('2'), 'race');
  const request = f.tables.projectHostedLandingRequests.at(-1);
  request.value = JSON.stringify({
    id: 'race',
    at: at(1),
    attemptId: 'race/child',
    actor: 'builder',
    phase: 'landed',
    error: null,
  });
  const move = f.tables.projectHostedAcceptances.at(-1);
  const mv = JSON.parse(move.value);
  mv.attemptId = 'race/child';
  move.value = JSON.stringify(mv);
  f.run('race-discarded', at(1), at(5), 240);
  f.run('race-recheck', at(6), at(11), 300);
  const { records } = await readHostedMetricPages(f.query, period);
  const result = calculateSelfMetrics(records, period),
    waste = calculateWaste(records, period);
  assert.deepEqual(result.metric1.rows.map(row => row.path).sort(), [
    'after-fixer',
    'after-recompose', // the main race: Forge's own recompose, not a builder retry
    'after-retry',
    'first-try',
  ]);
  assert.equal(result.metric1.gaps.length, 1, 'one explicit bounded-context gap');
  assert.equal(result.metric5.interventions, 2);
  // The resubmit takes its kind from the signed-in identity on the attempt (an agent here), not a fixed person label.
  assert.equal(result.metric5.byActor[0].actor, 'agent:owner');
  assert.equal(result.metric6.runnerMinutes, 22);
  assert.equal(result.metric6.discardedMainRaceRuns, 1);
  assert.equal(waste.byCause.find(row => row.cause === 'main-race').runnerMinutes, 4);
  assert.equal(waste.byCause.find(row => row.cause === 'main-race').discardedPassedRunnerMinutes, 4);
  assert.equal(waste.mainRaceRecheckRunnerMinutes, 5);
  assert.equal(waste.byCause.find(row => row.cause === 'flake').attempts, 0);
  assert(e.objectCalls < 7, 'input pins deduplicate across moves/runs/attempts');
  assert.equal(f.meter.writes, 0);
  f.projectRuns();
  const projected = await readHostedMetricPages(f.query, period);
  assert.deepEqual(
    metricsSurface(projected.records, period),
    metricsSurface(records, period),
    'compact runs preserve retries, fixers, actors, main-race waste and all report fields',
  );
});

test('batch landings classify by their member Lanes, never unknown because the stack has empty inputs', async () => {
  const f = fixture(),
    e = evidence(f);
  e.batch('first', at(1), at(5), e.input(randomUUID(), randomUUID(), head('a'), at(-30)));
  f.run('first', at(1), at(5), 180);
  const retry = e.input(randomUUID(), randomUUID(), head('b'), at(-20));
  e.fail('retry-failed', at(2), at(4), retry);
  e.batch('retry-landed', at(6), at(16), retry);
  f.run('retry-landed', at(6), at(10), 180);
  // M5: the second landing rechecked after the admission check; the first landed on it.
  const firstCheck = [
    { landedOn: 'admission-run', mainMoved: false },
    { landedOn: 'recheck', reason: 'main-moved' },
  ];
  f.tables.projectHostedAcceptances.forEach((row, i) => {
    row.value = JSON.stringify({ ...JSON.parse(row.value), firstCheck: firstCheck[i] });
  });
  const { records } = await readHostedMetricPages(f.query, period);
  const result = calculateSelfMetrics(records, period);
  assert.deepEqual(result.metric1.rows.map(row => row.path).sort(), ['after-retry', 'first-try']);
  assert.equal(result.metric1.unresolved, 0);
  assert.equal(f.meter.writes, 0);
  const totals = metricsSurface(records, period).totals;
  // M5: p50 alone flips on a two-humped distribution; p90, mean and the admission share ride beside it.
  assert.deepEqual(
    [
      totals.finishToMain.p50Minutes,
      totals.finishToMain.p90Minutes,
      totals.finishToMain.meanMinutes,
      totals.finishToMain.admissionRunShare,
    ],
    [4, 10, 7, 0.5],
  );
  // M8: the documented first-attempt land rate is on the 5.1 totals (each member Lane's first entry).
  assert.equal(totals['5.1'].firstAttemptLandRate.lanes, 2);
  assert.equal(totals['5.1'].firstAttemptLandRate.accepted, 1, 'the retried Lane failed its first entry');
  assert.equal(totals['5.1'].firstAttemptLandRate.retriedLanes, 1);
});

test('5.6 is check-minutes per landing with runs per landing and runs a moved main discarded', async () => {
  const f = fixture(),
    e = evidence(f);
  const race = e.input(randomUUID(), randomUUID(), head('e'), at(-10));
  e.landing('race', at(1), at(12), race, 'race-recheck');
  e.attempt('race', at(1), race, 'race-discarded');
  e.attempt('race/child', at(6), race, 'race-recheck', head('2'), 'race');
  f.run('race-discarded', at(1), at(5), 240);
  f.run('race-recheck', at(6), at(11), 300);
  const { records } = await readHostedMetricPages(f.query, period);
  const m = calculateSelfMetrics(records, period).metric6;
  assert.equal(m.checkMinutes, 9);
  assert.equal(m.checkMinutesPerLanding, 9);
  assert.equal(m.wallMinutesPerLanding, 9, 'the old key stays one release');
  assert.equal(m.runsPerLanding, 2);
  assert.equal(m.discardedMainRaceRuns, 1);
});

test('a head made by sync (no save record) after a failed attempt is a retry, never a fixer or unknown', async () => {
  const f = fixture(),
    e = evidence(f);
  const lane = randomUUID(),
    intent = randomUUID();
  e.fail('sync-failed', at(2), at(4), e.input(lane, intent, head('c'), at(-10)));
  e.landing('sync-landed', at(7), at(11), e.input(lane, intent, head('d'), at(5), 1));
  // The sync's new head has no `save` record: only saves reach the metric's saves stream (M4).
  f.tables.projectHostedRecords.pop();
  f.tables.projectHostedRecordBodies.pop();
  const { records } = await readHostedMetricPages(f.query, period);
  assert.equal(calculateSelfMetrics(records, period).metric1.rows[0].path, 'after-retry');
});

test('an attempt replaced in the instant it was created is a handoff, not a retry, in either row order', async () => {
  const f = fixture(),
    e = evidence(f);
  const pin = e.input(randomUUID(), randomUUID(), head('a'), at(-10));
  e.landing('handoff', at(1), at(5), pin);
  // The child shares the parent's timestamp but was stored earlier, so the parent row sorts first.
  e.attempt('handoff/child', at(0.9), pin, 'handoff', head('1'), 'handoff');
  f.tables.projectHostedLandingAttempts.find(row => row.attemptId === 'handoff/child').value = JSON.stringify(
    {
      id: 'handoff/child',
      at: at(1),
      parentAttemptId: 'handoff',
      main: { head: head('1') },
      candidate: { inputs: pin },
      check: { runId: 'handoff' },
      actor: { kind: 'agent' },
      policy: { acceptance: { mode: 'auto-on-pass' } },
    },
  );
  f.run('handoff', at(1), at(5), 120);
  const { records } = await readHostedMetricPages(f.query, period);
  assert.deepEqual(
    calculateSelfMetrics(records, period).metric1.rows.map(row => row.path),
    ['first-try'],
  );
});

test('a Lane landing again on an Intent that already landed is a first try, not unknown', async () => {
  const f = fixture(),
    e = evidence(f);
  const lane = randomUUID(),
    intent = randomUUID();
  e.landing('earlier', at(1), at(5), e.input(lane, intent, head('a'), at(-10)));
  f.run('earlier', at(1), at(5), 120);
  e.landing('again', at(10), at(15), e.input(lane, intent, head('b'), at(8), 1));
  f.run('again', at(10), at(15), 120);
  const { records } = await readHostedMetricPages(f.query, period);
  assert.deepEqual(
    calculateSelfMetrics(records, period)
      .metric1.rows.map(row => row.path)
      .sort(),
    ['first-try', 'first-try'],
  );
});

test('a failure before the Intent last landed never counts against its later landings (review 1240fe03 finding 4)', async () => {
  const f = fixture(),
    e = evidence(f);
  const lane = randomUUID(),
    intent = randomUUID();
  e.fail('old-failed', at(1), at(2), e.input(lane, intent, head('a'), at(-10)));
  e.landing('fixed', at(4), at(6), e.input(lane, intent, head('b'), at(3), 1));
  e.landing('later', at(10), at(12), e.input(lane, intent, head('c'), at(8), 2));
  f.run('fixed', at(4), at(6), 120);
  f.run('later', at(10), at(12), 120);
  const { records } = await readHostedMetricPages(f.query, period);
  const paths = Object.fromEntries(
    calculateSelfMetrics(records, period).metric1.rows.map(row => [row.submissionId ?? row.id, row.path]),
  );
  assert.deepEqual(
    paths,
    { fixed: 'after-fixer', later: 'first-try' },
    'the landing after the fix is a first try',
  );
});

test('a main race resolved by adopting the passing run is one reuse, not a recheck or a lost check', async () => {
  const f = fixture(),
    e = evidence(f);
  const first = e.input(randomUUID(), randomUUID(), head('a'), at(-30));
  e.landing('first', at(1), at(5), first);
  f.run('first', at(1), at(5), 180);
  // Second disjoint submission: main moved at 5; the replacement adopts its own passing run and lands 30 s later.
  const second = e.input(randomUUID(), randomUUID(), head('b'), at(-20));
  e.landing('second', at(1), at(12), second, 'second-run');
  e.attempt('second/child', at(5), second, 'second-run', head('2'), 'second');
  const request = f.tables.projectHostedLandingRequests.at(-1);
  request.value = JSON.stringify({
    id: 'second',
    at: at(1),
    attemptId: 'second/child',
    actor: 'builder',
    phase: 'landed',
    error: null,
  });
  const move = f.tables.projectHostedAcceptances.at(-1);
  const mv = JSON.parse(move.value);
  mv.attemptId = 'second/child';
  mv.at = at(5.5);
  move.value = JSON.stringify(mv);
  f.run('second-run', at(1), at(4), 240);
  const { records } = await readHostedMetricPages(f.query, period);
  const waste = calculateWaste(records, period);
  assert.equal(waste.mainRaceRecheckRuns, 0);
  assert.equal(waste.mainRaceRecheckRunnerMinutes, 0);
  const race = waste.byCause.find(row => row.cause === 'main-race');
  assert.equal(race.attempts, 1);
  assert.equal(
    race.elapsedMinutes,
    0.5,
    'elapsed is the race-to-acceptance gap, not the whole first attempt',
  );
  assert.equal(race.runnerMinutes, 0);
  assert.equal(waste.rows.find(row => row.cause === 'main-race').reusedAfterRace, true);
  const result = calculateSelfMetrics(records, period);
  assert.deepEqual(result.metric1.rows.map(row => row.path).sort(), ['first-try', 'reused-after-race']);
  assert.equal(result.metric6.reused, 1, 'reuse is counted once in 5.6');
  assert.equal(f.meter.writes, 0);
});

test('input bytes are verified; unavailable Lane version never classifies a partial selection', async () => {
  const f = fixture(),
    e = evidence(f);
  const pin = e.input(randomUUID(), randomUUID(), head('a'), at(-5));
  e.landing('one', at(1), at(2), pin);
  f.query.objects = async () => [Buffer.from('wrong')];
  await assert.rejects(readHostedMetricPages(f.query, period), error => error.code === 'EVIDENCE_CHANGED');
  delete f.query.objects;
  const { records } = await readHostedMetricPages(f.query, period);
  const unresolved = calculateSelfMetrics(records, period).metric1;
  assert.equal(unresolved.rows[0].path, 'unresolved', 'no resolved input is its own named gap, not unknown');
  assert.equal(unresolved.unresolved, 1);
  assert(unresolved.gaps.some(gap => gap.includes('resolved no input Lane')));
});

test('30-day 6000-landing demand-driven reader has bounded page and object calls, zero writes and idle zero', async t => {
  const f = fixture(),
    e = evidence(f);
  assert.equal(f.meter.calls, 0);
  assert.equal(e.objectCalls, 0);
  const report = { from: at(0), to: at(30 * 1440) };
  for (let i = 0; i < 6000; i++) {
    const stamp = at(i * 7.2 + 1);
    const pin = e.input(randomUUID(), randomUUID(), head('a'), stamp);
    e.landing(`landing-${i}`, stamp, at(i * 7.2 + 3), pin);
    f.run(`landing-${i}`, stamp, at(i * 7.2 + 3), 120);
  }
  // Record the actual registered query responses and verified immutable objects.
  // Replay only the client in a fresh process: the fake DB and TS compiler are
  // server/test infrastructure, not allocations owned by the metrics reader.
  const pages = [],
    objects = [];
  const query = async (name, args) => {
    const value = await f.query(name, args);
    pages.push({ name, args, value });
    return value;
  };
  query.objects = async pins => {
    const values = await f.query.objects(pins);
    objects.push({ pins, values: values.map(value => Buffer.from(value).toString('base64')) });
    return values;
  };
  const start = performance.now();
  const { records } = await readHostedMetricPages(query, report);
  assert.equal(metricsSurface(records, report).totals['5.1'].landings, 6000);
  const input = { pages, objects, report };
  const client = runResourceWorker('./self-metrics-input-budget-worker.mjs', input);
  assert.equal(client.calls, f.meter.calls);
  assert.equal(client.objectCalls, e.objectCalls);
  const measured = { ...client, documents: f.meter.documents, writes: f.meter.writes };
  t.diagnostic(JSON.stringify({ ...measured, fixtureWallMs: performance.now() - start }));
  assertMetricResources(measured);
  assert.equal(f.meter.maxPage, 100);
  for (const [plant, error] of [
    ['double-work', /query\/object work budget/],
    ['leak', /retained allocation/],
  ]) {
    await t.test(`resource guard rejects planted ${plant}`, () => {
      const regression = runResourceWorker('./self-metrics-input-budget-worker.mjs', { ...input, plant });
      t.diagnostic(JSON.stringify({ plant, ...regression }));
      assert.throws(() => assertMetricResources({ ...measured, ...regression }), error);
    });
  }
});

test('waste separates explicit flakes, conflicts, cancellations, supersession and stalls without duplicating shared runs', () => {
  const records = { moves: [], submissions: [], runs: [], receipts: [], gaps: [] };
  const add = (id, code, extra = {}) => {
    records.submissions.push({
      id,
      entryId: id,
      at: at(1),
      endedAt: at(4),
      status: 'failed',
      inputs: [],
      progressAt: [],
      runIds: [id],
      errorCode: code,
      ...extra,
    });
    records.runs.push({ id, at: at(1), endedAt: at(4), status: 'passed', inputs: [], runnerMinutes: 2 });
  };
  add('conflict', 'COMPOSITION_CONFLICT');
  add('cancel', 'LANDING_CANCELLED');
  add('supersede', 'LANDING_SUPERSEDED');
  add('flake', 'CHECK_FAILED');
  add('retry', null, { supersedes: 'flake', retryReason: 'flake', status: 'landed' });
  add('stall', null, { status: 'queued', endedAt: undefined, progressAt: [at(2)] });
  records.submissions.push({ ...records.submissions[0], id: 'shared', runIds: ['conflict'] });
  const result = calculateWaste(records, { from: at(0), to: at(120) });
  for (const cause of ['flake', 'conflict', 'cancel', 'supersede', 'stall'])
    assert.equal(result.byCause.find(row => row.cause === cause).runnerMinutes, 2, cause);
  assert.equal(result.byCause.find(row => row.cause === 'stall').elapsedMinutes, 119);
  assert.equal(result.byCause.find(row => row.cause === 'check-failed').attempts, 0);
});

test('hosted full-suite flags use recorded gate selection rather than a check name', async () => {
  const f = fixture();
  f.run('full', at(1), at(2));
  f.run('scoped', at(3), at(4));
  for (const [i, mode] of ['full', 'scoped'].entries()) {
    const row = f.tables.projectHostedCheckRuns[i],
      run = JSON.parse(row.value);
    run.gate = { mode };
    row.value = JSON.stringify(run);
  }
  const { records } = await readHostedMetricPages(f.query, period);
  assert.equal(records.runs.find(run => run.id === 'full').fullSuite, true);
  assert.equal(records.runs.find(run => run.id === 'scoped').fullSuite, false);
});

test('multi-Lane input with an unavailable immutable version stays entirely unclassified', async () => {
  const { hydrateMetricInputs } = await import('../dist/self-metrics-hosted-inputs.js');
  const lane = randomUUID(),
    other = randomUUID(),
    intent = randomUUID(),
    h = head('a');
  const built = buildComposePages(
    [lane, other].map(laneId => ({
      laneId,
      head: h,
      version: 0,
      sourceVersion: 0,
      lifecycleVersion: 0,
      state: { object: { sha256: h, size: 0 }, recipe: null },
    })),
  );
  const records = { moves: [{ id: 'move', inputs: [] }], runs: [], submissions: [] };
  await hydrateMetricInputs(
    records,
    new Map([['move:move', built.manifest.root]]),
    [{ id: lane, version: 0, intentId: intent, revert: false }],
    [],
    async pins => pins.map(() => saveBytes(built.pages[0].value)),
  );
  assert.deepEqual(records.moves[0].inputs, []);
});

test('P6 exact Lane context preserves the entire legacy report and stays flat with 10x unrelated Lane/save history', async () => {
  const f = fixture(),
    e = evidence(f);
  const lane = randomUUID(),
    intent = randomUUID();
  const pin = e.input(lane, intent, head('a'), at(-20));
  e.fail('prior-failed', at(-15), at(-10), pin);
  e.landing('current-landed', at(6), at(10), pin);
  f.run('current-landed', at(6), at(10), 180);
  e.landing('bill-history', at(-25), at(-23), e.input(randomUUID(), randomUUID(), head('c'), at(-30)));
  f.run('bill-history', at(-25), at(-23), 120);
  await f.recordBill({
    operationId: randomUUID(),
    provider: 'github-actions',
    periodFrom: at(-60),
    periodTo: period.to,
    billedUsd: 2,
    listUsd: 2,
    usage: { 'runner-minute': 5 },
    rates: { 'runner-minute': 0.008 },
    basis: 'Synthetic bill parity',
  });
  const addHistory = (from, to) => {
    for (let i = from; i < to; i++) e.input(randomUUID(), randomUUID(), head('b'), at(-30));
  };
  addHistory(0, 100);
  const measured = async () => {
    const before = { ...f.meter };
    const { records } = await readHostedMetricPages(f.query, period);
    return {
      surface: metricsSurface(records, period),
      reads: f.meter.documents - before.documents,
      bytes: f.meter.bytes - before.bytes,
      calls: f.meter.calls - before.calls,
    };
  };
  const modern = await measured();
  const legacy = async (name, args) => {
    const value = await f.query(name, args);
    if (name !== 'projectSelfMetrics:page') return value;
    const page = JSON.parse(value);
    delete page.inputReferencesVersion;
    return JSON.stringify(page);
  };
  legacy.objects = f.query.objects;
  assert.deepEqual(
    modern.surface,
    metricsSurface((await readHostedMetricPages(legacy, period)).records, period),
  );
  addHistory(100, 1000);
  const grown = await measured();
  assert.deepEqual(
    grown.surface,
    modern.surface,
    'unrelated context must not alter classifications, billing, unknowns or coverage',
  );
  assert.equal(grown.reads, modern.reads, 'unrelated Lane/save history adds zero document reads');
  assert.equal(grown.bytes, modern.bytes, 'unrelated Lane/save history adds zero byte reads');
  assert.equal(grown.calls, modern.calls, 'unrelated Lane/save history adds zero RPCs');
});

test('P6 selected-Lane save pagination preserves tied timestamps and memoizes Lane context across reference batches', async () => {
  const f = fixture(),
    e = evidence(f);
  const lane = randomUUID(),
    intent = randomUUID();
  for (let version = 0; version < 150; version++) {
    const pin = e.input(lane, intent, head(version % 2 ? 'a' : 'b'), at(-30), version);
    e.landing(`version-${version}`, at(1), at(2), pin);
  }
  const calls = [];
  const query = async (name, args) => {
    calls.push({ name, args });
    return f.query(name, args);
  };
  query.objects = f.query.objects;
  const modern = (await readHostedMetricPages(query, period)).records;
  const laneSelections = calls.filter(call => call.args.inputReferences && call.args.stream === 'lanes');
  assert.equal(laneSelections.flatMap(call => call.args.inputReferences).length, 150);
  const saveSelections = calls.filter(call => call.args.inputReferences && call.args.stream === 'saves');
  assert(saveSelections.length > 1, 'one Lane with many saves continues bounded pages');
  assert(saveSelections.every(call => call.args.inputReferences.length === 1));
  const legacy = async (name, args) => {
    const raw = await f.query(name, args);
    if (name !== 'projectSelfMetrics:page') return raw;
    const page = JSON.parse(raw);
    delete page.inputReferencesVersion;
    return JSON.stringify(page);
  };
  legacy.objects = f.query.objects;
  assert.deepEqual(
    metricsSurface(modern, period),
    metricsSurface((await readHostedMetricPages(legacy, period)).records, period),
  );
  const continuation = saveSelections.find(call => call.args.cursor);
  const corrupt = JSON.parse(continuation.args.cursor);
  corrupt.key[0] = 'another-project';
  await assert.rejects(
    f.query('projectSelfMetrics:page', { ...continuation.args, cursor: JSON.stringify(corrupt) }),
    error => error.data?.code === 'EVIDENCE_CHANGED',
  );
  for (const cursor of ['null', '{'])
    await assert.rejects(
      f.query('projectSelfMetrics:page', { ...saveSelections[0].args, cursor }),
      error => error.data?.code === 'EVIDENCE_CHANGED',
    );
  f.actor('stranger');
  await assert.rejects(
    f.query('projectSelfMetrics:page', saveSelections[0].args),
    error => error.data?.code === 'PROJECT_UNAVAILABLE',
  );
});

test('P6 exact Lane context includes lifecycle-backed versions inside the original horizon', async () => {
  const f = fixture(),
    e = evidence(f);
  const lane = randomUUID(),
    intent = randomUUID();
  const pin = e.input(lane, intent, head('a'), at(-3 * 1440));
  const original = f.tables.projectHostedRecords.find(row => row.kind === 'lane');
  const { _id, _creationTime, ...version } = original;
  f.put(
    'projectHostedRecords',
    { ...version, lifecyclePlanId: 'projectHostedLifecyclePlans-synthetic' },
    at(-10),
  );
  e.landing('lifecycle', at(1), at(2), pin);
  const modern = (await readHostedMetricPages(f.query, period)).records;
  const legacy = async (name, args) => {
    const raw = await f.query(name, args);
    if (name !== 'projectSelfMetrics:page') return raw;
    const page = JSON.parse(raw);
    delete page.inputReferencesVersion;
    return JSON.stringify(page);
  };
  legacy.objects = f.query.objects;
  assert.deepEqual(
    metricsSurface(modern, period),
    metricsSurface((await readHostedMetricPages(legacy, period)).records, period),
  );
  assert.equal(calculateSelfMetrics(modern, period).metric1.rows[0].path, 'first-try');
});

test('P6 context fallback preserves an unlinked pre-window request that settles inside the report', async () => {
  const f = fixture();
  f.landing('old-unlinked', at(-30), at(2));
  f.tables.projectHostedAcceptances.pop();
  f.tables.projectHostedLandingAttempts.pop();
  const request = f.tables.projectHostedLandingRequests[0];
  request.phase = 'terminal-failed';
  request.value = JSON.stringify({
    id: 'old-unlinked',
    at: at(-30),
    phase: 'terminal-failed',
    timing: { submittedAt: at(-30), settledAt: at(2) },
    error: { code: 'CHECK_FAILED' },
  });
  const records = (await readHostedMetricPages(f.query, period)).records;
  assert.deepEqual(
    calculateWaste(records, period).rows.map(row => [row.id, row.cause, row.elapsedMinutes]),
    [['old-unlinked', 'check-failed', 2]],
  );
  const truncated = (await readHostedMetricPages(f.query, period, false, false, 0)).records;
  assert.deepEqual(
    calculateWaste(truncated, period).rows,
    [],
    'the request has no referenced identity in the window; zero context changes the required report',
  );
});

test('one first-try rule: a recompose after main moved counts against first try only when it threw a started check away', async () => {
  // src/stats-estimate.ts#firstTry: landed with no resubmission and no discarded check. Two main races; only the second ran a check
  // on the superseded attempt.
  const f = fixture(),
    e = evidence(f);
  const race = (id, input, discardedRun) => {
    e.landing(id, at(1), at(12), input, `${id}-recheck`);
    e.attempt(id, at(1), input, discardedRun ?? null);
    e.attempt(`${id}/child`, at(6), input, `${id}-recheck`, head('2'), id);
    const request = f.tables.projectHostedLandingRequests.at(-1);
    request.value = JSON.stringify({
      id,
      at: at(1),
      attemptId: `${id}/child`,
      actor: 'builder',
      phase: 'landed',
      error: null,
    });
    const move = f.tables.projectHostedAcceptances.at(-1);
    move.value = JSON.stringify({ ...JSON.parse(move.value), attemptId: `${id}/child` });
    if (discardedRun) f.run(discardedRun, at(1), at(5), 240);
    f.run(`${id}-recheck`, at(6), at(11), 300);
  };
  race('early', e.input(randomUUID(), randomUUID(), head('e'), at(-10)));
  race('late', e.input(randomUUID(), randomUUID(), head('f'), at(-10)), 'late-discarded');
  const { records } = await readHostedMetricPages(f.query, period);
  const result = calculateSelfMetrics(records, period);
  // 'early' recomposed before any check ran (nothing discarded); 'late' threw its started check away.
  assert.deepEqual(result.metric1.rows.map(row => row.path).sort(), ['after-recompose', 'first-try']);
  assert.deepEqual(result.metric1.firstTry, { landings: 2, first: 1 });
});
