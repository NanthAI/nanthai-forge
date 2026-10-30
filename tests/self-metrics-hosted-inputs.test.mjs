// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { buildComposePages } from '../dist/hosted-compose.js';
import { readHostedMetricPages } from '../dist/self-metrics-hosted-pages.js';
import { metricsSurface } from '../dist/self-metrics-surface.js';
import { calculateSelfMetrics } from '../dist/self-metrics.js';
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
  return {
    input,
    attempt,
    landing,
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
    'after-retry',
    'after-retry',
    'first-try',
  ]);
  assert.equal(result.metric1.gaps.length, 1, 'one explicit bounded-context gap');
  assert.equal(result.metric5.interventions, 2);
  assert.equal(result.metric5.byActor[0].actor, 'person:owner');
  assert.equal(result.metric6.runnerMinutes, 22);
  assert.equal(waste.byCause.find(row => row.cause === 'main-race').runnerMinutes, 4);
  assert.equal(waste.byCause.find(row => row.cause === 'main-race').discardedPassedRunnerMinutes, 4);
  assert.equal(waste.mainRaceRecheckRunnerMinutes, 5);
  assert.equal(waste.byCause.find(row => row.cause === 'flake').attempts, 0);
  assert(e.objectCalls < 7, 'input pins deduplicate across moves/runs/attempts');
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
  assert.equal(calculateSelfMetrics(records, period).metric1.rows[0].path, 'unknown');
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
  const start = performance.now();
  const { records } = await readHostedMetricPages(f.query, report);
  const surface = metricsSurface(records, report);
  const result = calculateSelfMetrics(records, report, { headline: true });
  assert.equal(surface.totals['5.1'].landings, 6000);
  const elapsedMs = performance.now() - start;
  const measured = {
    calls: f.meter.calls,
    objectCalls: e.objectCalls,
    documents: f.meter.documents,
    writes: f.meter.writes,
    rssMiB: process.resourceUsage().maxRSS / 1024,
    elapsedMs,
  };
  t.diagnostic(JSON.stringify(measured));
  assert.equal(result.landings, 6000);
  assert.equal(
    result.metric1.days.reduce((n, day) => n + day.firstTry, 0),
    6000,
  );
  assert(measured.calls + measured.objectCalls <= 1500);
  assert(measured.documents <= 200000);
  assert.equal(measured.writes, 0);
  assert.equal(f.meter.maxPage, 100);
  assert(measured.rssMiB <= 500);
  assert(elapsedMs <= 30000);
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
