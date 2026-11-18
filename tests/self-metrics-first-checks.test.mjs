// SPDX-License-Identifier: Apache-2.0
// First-submission check red rate (Item 9ce2ee79): the definition's edge cases, and proof the
// request pages carry it with no extra read, write or landing-path call.
import test from 'node:test';
import assert from 'node:assert/strict';
import { firstCheckMetric } from '../dist/self-metrics-second-checks.js';
import { readHostedMetricPages } from '../dist/self-metrics-hosted-pages.js';
import { metricsSurface } from '../dist/self-metrics-surface.js';
import { formatMetrics } from '../dist/self-metrics-format.js';
import { fixture, period, at, empty } from './self-metrics-hosted-fixture.mjs';

const lane = (laneId, head) => [{ laneId, head, intentId: laneId }];
const entry = (id, minute, status, extra = {}) => ({
  id,
  entryId: id,
  entryAt: at(minute),
  at: at(minute),
  entryStatus: status,
  status,
  inputs: lane(`lane-${id}`, `head-${id}`),
  progressAt: [],
  runIds: [`run-${id}`],
  ...extra,
});
const run = (id, status, extra = {}) => ({ id, at: at(1), status, inputs: [], ...extra });
const metric = (submissions, runs) => firstCheckMetric({ ...empty(), submissions, runs }, period);

test('green and red first checks decide the rate; everything else is reported apart', () => {
  const value = metric(
    [
      entry('g1', 1, 'landed'),
      entry('g2', 2, 'landed'),
      entry('r1', 3, 'terminal-failed'),
      entry('flaky-in-run', 4, 'landed'),
      entry('flaky-later', 5, 'terminal-failed'),
      entry('flaky-later-retry', 30, 'landed', { inputs: lane('lane-flaky-later', 'head-flaky-later') }),
      entry('cancelled', 6, 'cancelled'),
      entry('infra', 7, 'terminal-failed'),
      entry('interrupted', 8, 'terminal-failed'),
      entry('open', 9, 'checking'),
      entry('no-check', 10, 'terminal-failed', { runIds: [] }),
      entry('no-row', 11, 'terminal-failed'),
      entry('cohort', 12, 'landed', {
        sharedBatch: { runId: 'run-cohort', individualPassed: true, likelyCulprit: false },
      }),
    ],
    [
      run('run-g1', 'passed'),
      run('run-g2', 'passed'),
      run('run-r1', 'failed'),
      run('run-flaky-in-run', 'passed', { flaky: { total: 1, files: [] } }),
      run('run-flaky-later', 'failed'),
      run('run-cancelled', 'cancelled'),
      run('run-infra', 'runner-unavailable'),
      run('run-interrupted', 'interrupted'),
      run('run-open', 'running'),
      run('run-cohort', 'failed'),
    ],
  );
  // The retry of flaky-later is the same Intent: not a first submission, but its landing vouches.
  assert.equal(value.firstSubmissions, 12);
  assert.equal(value.decided, 3);
  assert.equal(value.red, 1);
  assert.equal(value.rate, 1 / 3);
  assert.deepEqual(value.excluded, {
    flaky: 2,
    cohort: 1,
    cancelled: 1,
    runnerUnavailable: 2,
    pending: 1,
    noCheck: 1,
    unresolved: 1,
  });
});

test('the admission run is the first check when one ran, ahead of the queue run; an unavailable one with no run is a runner exclusion', () => {
  const value = metric(
    [
      // Admission failed, then the queue run (from a later retry attempt) passed: the first check was red.
      entry('a', 1, 'landed', {
        admissionRun: { runId: 'run-a-admission', status: 'failed' },
        runIds: ['run-a-queue'],
      }),
      entry('b', 2, 'landed', {
        admissionRun: { runId: 'run-b-admission', status: 'passed' },
        runIds: ['run-b-queue'],
      }),
      entry('c', 3, 'terminal-failed', { admissionRun: { runId: '', status: 'unavailable' }, runIds: [] }),
      // Two attempt rows of one submission: the earliest attempt's run is the first check.
      entry('d', 4, 'landed', { runIds: ['run-d-1'] }),
      { ...entry('d', 5, 'landed', { runIds: ['run-d-2'] }), id: 'd-2', at: at(5) },
    ],
    [
      run('run-a-admission', 'failed'),
      run('run-a-queue', 'passed'),
      run('run-b-admission', 'passed'),
      run('run-b-queue', 'failed'),
      run('run-d-1', 'passed'),
      run('run-d-2', 'failed'),
    ],
  );
  assert.equal(value.red, 1, 'only a: admission failed first');
  assert.equal(value.decided, 3, 'a red, b and d green');
  assert.equal(value.excluded.runnerUnavailable, 1);
});

test('retries, reverts and later submissions of the same Intent are not first submissions; the window bounds entries, not history', () => {
  const value = metric(
    [
      entry('before', -60 * 24, 'terminal-failed', { inputs: lane('L', 'h1') }),
      // Same Intent after an earlier submission: a resubmission, so not counted.
      entry('again', 5, 'landed', { inputs: lane('L', 'h2') }),
      entry('retry', 6, 'landed', { supersedes: 'x' }),
      entry('revert', 7, 'landed', { compensating: true }),
      entry('revert-input', 8, 'landed', {
        inputs: [{ laneId: 'R', head: 'r', intentId: 'R', compensating: true }],
      }),
      entry('fresh', 9, 'landed'),
      entry('after-window', 60 * 24 * 30, 'landed'),
    ],
    [
      run('run-before', 'failed'),
      run('run-again', 'passed'),
      run('run-retry', 'passed'),
      run('run-revert', 'passed'),
      run('run-revert-input', 'passed'),
      run('run-fresh', 'passed'),
      run('run-after-window', 'failed'),
    ],
  );
  assert.equal(value.firstSubmissions, 1);
  assert.equal(value.red, 0);
  assert.equal(value.rate, 0);
});

test('an empty window has no rate; recent tails are the newest decided checks and say when short', () => {
  assert.equal(metric([], []).rate, null);
  const submissions = Array.from({ length: 60 }, (_, i) => entry(`e${i}`, i + 1, 'landed'));
  // The oldest ten are red, the newest fifty green.
  const runs = submissions.map((row, i) => run(row.runIds[0], i < 10 ? 'failed' : 'passed'));
  const value = metric(submissions, runs);
  assert.equal(value.decided, 60);
  const [fifty, twoHundred] = value.recent;
  assert.deepEqual(
    [fifty.size, fifty.decided, fifty.red, fifty.complete],
    [50, 50, 0, true],
    'the last 50 skip the early reds',
  );
  assert.deepEqual([twoHundred.decided, twoHundred.red, twoHundred.complete], [60, 10, false]);
  assert.equal(twoHundred.rate, 10 / 60);
});

test('request pages carry the first check with no extra read or write; older deployments are partial, not zero', async () => {
  const f = fixture();
  f.run('run-adm', at(2), at(6), 240, { status: 'failed' });
  f.put(
    'projectHostedLandingRequests',
    {
      projectId: 'project',
      channel: 'main',
      submissionId: 'x',
      operationId: 'x',
      actor: 'owner',
      sequence: 9,
      runnable: false,
      phase: 'terminal-failed',
      runId: null,
      attemptId: 'x',
      admission: { runId: 'run-adm', status: 'failed', full: true },
      value: JSON.stringify({
        id: 'x',
        at: at(1),
        phase: 'terminal-failed',
        timing: { submittedAt: at(1) },
        error: { code: 'CHECK_FAILED', message: 'The check failed.' },
      }),
    },
    at(1),
  );
  const { records } = await readHostedMetricPages(f.query, period);
  const submission = records.submissions.find(row => row.entryId === 'x');
  assert.deepEqual(submission.admissionRun, { runId: 'run-adm', status: 'failed' });
  const callsBefore = f.meter.calls;
  const surface = metricsSurface(records, period);
  assert.equal(f.meter.calls, callsBefore, 'computing the rate adds no read');
  assert.equal(f.meter.writes, 0);
  const value = surface.totals.firstChecks;
  assert.deepEqual([value.firstSubmissions, value.decided, value.red], [1, 1, 1]);
  assert.match(formatMetrics(surface), /First-submission check red rate: /);
  const older = async (name, args) => {
    const raw = await f.query(name, args);
    if (name !== 'projectSelfMetrics:page' || args.stream !== 'requests') return raw;
    const page = JSON.parse(raw);
    page.page = page.page.map(({ admissionRun: _a, ...row }) => row);
    return JSON.stringify(page);
  };
  const stale = metricsSurface((await readHostedMetricPages(older, period)).records, period).totals
    .firstChecks;
  assert.equal(stale.partial, true);
  assert.match(stale.gaps[0], /predate the admission-run projection/);
});
