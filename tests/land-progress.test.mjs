// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir, hostname } from 'node:os';
import { randomUUID } from 'node:crypto';
import { deriveLandingPhases, landingEta, phaseDuration, phaseSummary } from '../dist/land-phases.js';
import { readLandingProgress } from '../dist/land-progress.js';
import { readLandCheckController, readLandCheckProgress } from '../dist/land-check-progress.js';
import { withQueueSlot } from '../dist/landing-queue.js';
import { processIdentity } from '../dist/local-process.js';
import { saveLandingWorkerState } from '../dist/landing-worker-status.js';
import { changeOnlyLandingReporter, landingProgressLine } from '../dist/land-progress-live.js';
import { landReceipt } from '../dist/land-receipt.js';
import { finishSubmissions } from '../dist/landing-submission-read.js';
const at = seconds => new Date(seconds * 1000).toISOString();
const times = {
  queuedAt: at(0),
  selectedAt: at(10),
  dispatchAt: at(20),
  ciAt: at(30),
  checkedAt: at(130),
  acceptedAt: at(140),
};
const completed = deriveLandingPhases({ ...times, current: 'accepted' });
for (const current of [
  'queued',
  'composing',
  'dispatching',
  'ci-running',
  'recording-accepting',
  'accepted',
]) {
  test(`phase model derives ${current} from recorded boundaries`, () => {
    const keys = ['queuedAt', 'selectedAt', 'dispatchAt', 'ciAt', 'checkedAt', 'acceptedAt'];
    const index = [
      'queued',
      'composing',
      'dispatching',
      'ci-running',
      'recording-accepting',
      'accepted',
    ].indexOf(current);
    const selected = Object.fromEntries(keys.slice(0, index + 1).map(key => [key, times[key]]));
    const phases = deriveLandingPhases({ ...selected, current });
    assert.equal(phases.current, current);
    assert.equal(phases.timeline[index].startedAt, times[keys[index]]);
    assert.equal(phases.timeline[index].endedAt, current === 'accepted' ? at(140) : 'unknown');
    if (index > 0) assert.equal(phases.timeline[index - 1].durationMs, index === 4 ? 100000 : 10000);
  });
}
test('missing, invalid and reversed timestamps remain unknown', () => {
  const phases = deriveLandingPhases({ current: 'accepted', acceptedAt: at(140) });
  assert.equal(phases.timeline[0].startedAt, 'unknown');
  assert.equal(phases.timeline[0].durationMs, 'unknown');
  assert.equal(phaseDuration(at(10), at(1)), 'unknown');
  assert.equal(phaseDuration('invalid', at(1)), 'unknown');
  assert.match(phaseSummary(phases), /queued=unknown/);
  assert.match(phaseSummary(completed), /ci-running=100s/);
});
test('ETA uses phase medians of recent completed landings and scales remaining shards', () => {
  const second = deriveLandingPhases({
    ...times,
    checkedAt: at(330),
    acceptedAt: at(340),
    current: 'accepted',
  });
  const current = deriveLandingPhases({
    ...times,
    checkedAt: undefined,
    acceptedAt: undefined,
    current: 'ci-running',
    progress: { shards: { done: 1, total: 4 } },
  });
  const eta = landingEta(current, [completed, second], 40000);
  assert.equal(eta.label, 'estimate');
  assert.equal(eta.phaseMedianMs['ci-running'], 200000);
  assert.equal(eta.remainingMs, 160000);
  assert.equal(eta.samples, 2);
  assert.equal(landingEta(current, []), undefined);
  assert.equal(landingEta(current, [deriveLandingPhases({ current: 'accepted' })]), undefined);
  assert.equal(landingEta(completed, [second]), undefined);
});
test('ETA history limit takes only the newest N, and unknown remaining phases omit ETA', () => {
  const current = deriveLandingPhases({ ...times, acceptedAt: undefined, current: 'recording-accepting' });
  assert.equal(
    landingEta(
      current,
      [completed, deriveLandingPhases({ ...times, acceptedAt: at(150), current: 'accepted' })],
      130000,
      1,
    ).remainingMs,
    20000,
  );
  assert.equal(
    landingEta(
      {
        ...current,
        current: 'main-audit',
        timeline: [
          ...current.timeline,
          {
            phase: 'main-audit',
            state: 'running',
            startedAt: 'unknown',
            endedAt: 'unknown',
            durationMs: 'unknown',
          },
        ],
      },
      [completed],
    ),
    undefined,
  );
});
test('live stderr reporter emits only phase/progress/queue changes, including multiple Lanes', () => {
  const output = [],
    report = changeOnlyLandingReporter(line => output.push(line));
  const queued = deriveLandingPhases({
    current: 'queued',
    queue: { position: 2, total: 3, waitingOn: 'batch ahead' },
  });
  report('abcdefgh-1', queued);
  report('abcdefgh-1', { ...queued, eta: { remainingMs: 40000 } });
  report('abcdefgh-1', { ...queued, eta: { remainingMs: 39000 } });
  report('ijklmnop-2', queued);
  report('abcdefgh-1', { ...queued, queue: { position: 1, total: 2, waitingOn: 'runner' } });
  const ci = deriveLandingPhases({
    current: 'ci-running',
    progress: { jobs: { done: 1, total: 5 }, files: { done: 2, total: 6 } },
  });
  report('abcdefgh-1', ci);
  report('abcdefgh-1', ci);
  report('abcdefgh-1', {
    ...ci,
    progress: { ...ci.progress, files: { done: 3, total: 6 } },
    eta: { remainingMs: 25000 },
  });
  assert.equal(output.length, 5);
  assert.match(output[0], /position 2 of 3 · waiting on: batch ahead\n$/);
  assert.match(output[3], /ci-running · jobs 1\/5 · files 2\/6/);
  assert.match(output[4], /ETA ~25s \(estimate\)/);
  assert.ok(output.every(line => !/[\r\x1b]/.test(line)));
});
function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'forge-progress-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const data = { landingEntries: [], landingBatches: [], runs: [], views: [], channelMoves: [] };
  let revision = 1;
  const store = {
    root: directory,
    directory,
    revision: () => revision++,
    readRecords: () => undefined,
    load: () => data,
    page: collection => ({ records: data[collection], nextOffset: null }),
    select: (collection, id) => data[collection]?.find(item => item.id === id),
  };
  const write = (name, value) => {
    const path = join(directory, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
  };
  return { store, data, write };
}
test('local records project queue, composition, dispatch, CI, recording and accepted stages', t => {
  const { store, data, write } = fixture(t);
  const entry = {
    id: 'entry',
    channel: 'main',
    viewId: 'view',
    arrivedAt: at(0),
    priority: 'normal',
    status: 'queued',
    submitter: 'fixture',
  };
  data.landingEntries.push({ ...entry, id: 'ahead', arrivedAt: at(-1) }, entry);
  const read = () => readLandingProgress(store, 'entry', undefined, 40000);
  assert.deepEqual(read().queue, { position: 2, total: 2, waitingOn: 'batch ahead' });
  entry.status = 'checking';
  entry.firstSelectedAt = at(10);
  entry.batchId = 'batch';
  data.landingBatches.push({ id: 'batch', status: 'composing', prefixes: [] });
  assert.equal(read().current, 'composing');
  entry.runId = 'run';
  const run = {
    id: 'run',
    viewId: 'view',
    startedAt: at(20),
    status: 'preparing',
    backend: { actual: 'github-actions' },
  };
  data.runs.push(run);
  assert.equal(read().current, 'dispatching');
  write('check-run/modal-plan.json', { groups: [['a'], ['b']], selection: { tests: ['a', 'b'] } });
  write('check-run/github-actions.json', {
    runId: 1,
    jobUsage: [{ id: 1, started_at: at(30), completed_at: at(100), status: 'completed' }],
    states: { 1: 'completed/success' },
  });
  write('check-run/modal-shard-logs.json', [{ executionId: '1', index: 0, attempt: 0 }]);
  write('check-run/shards/0.log', '__FORGE_TESTS__{"file":"a","complete":true,"results":[]}\n');
  assert.equal(read().current, 'ci-running');
  assert.deepEqual(read().progress.files, { done: 1, total: 2 });
  assert.deepEqual(read().progress.shards, { done: 1, total: 2 });
  run.endedAt = at(130);
  run.status = 'passed';
  assert.equal(read().current, 'recording-accepting');
  data.channelMoves.push({ id: 'move', viewId: 'view', channel: 'main', status: 'accepted', at: at(140) });
  entry.acceptanceId = 'move';
  entry.status = 'accepted';
  assert.equal(read().current, 'accepted');
  assert.equal(read().timeline[4].durationMs, 10000);
});
test('test-file markers deduplicate completed files and ignore unknown/incomplete/malformed markers', t => {
  const { store, write } = fixture(t);
  write('check-r/modal-plan.json', { groups: [['a']], selection: { tests: ['a'] } });
  write('check-r/modal-shard-logs.json', [
    { index: 0, attempt: 0, executionId: 'old', exitCode: 1 },
    { index: 0, attempt: 1, executionId: 'new' },
  ]);
  write('check-r/shards/0.log', '__FORGE_TESTS__{"file":"a","complete":true}\n');
  write(
    'check-r/shards/0.attempt-2.log',
    '__FORGE_TESTS__{"file":"a","complete":false}\n__FORGE_TESTS__{broken',
  );
  assert.deepEqual(readLandCheckProgress(store.directory, 'r').progress.files, { done: 0, total: 1 });
  write(
    'check-r/shards/0.attempt-2.log',
    ['a', 'a', 'unselected']
      .map(file => `2026-01-01T00:00:00Z __FORGE_TESTS__${JSON.stringify({ file, complete: true })}`)
      .join('\n'),
  );
  assert.deepEqual(readLandCheckProgress(store.directory, 'r').progress.files, { done: 1, total: 1 });
  assert.equal(readLandCheckProgress(store.directory, 'missing').progress.jobs, undefined);
});
test('accepted results expose pending main audit and mirror push without inventing timestamps', t => {
  const { store, data } = fixture(t);
  data.channelMoves.push({
    id: 'm',
    channel: 'main',
    viewId: 'v',
    status: 'accepted',
    at: at(140),
    postAccept: {},
    postAcceptRunId: 'audit',
  });
  data.landingEntries.push({ id: 'e', channel: 'main', status: 'accepted', acceptanceId: 'm' });
  data.githubAutoPush = { acceptanceId: 'm', status: 'queued', at: at(150) };
  let phases = readLandingProgress(store, 'e');
  assert.equal(phases.current, 'main-audit');
  assert.equal(phases.timeline.find(item => item.phase === 'main-audit').startedAt, 'unknown');
  assert.equal(phases.timeline.find(item => item.phase === 'github-mirror-push').startedAt, 'unknown');
  data.runs.push({ id: 'audit', startedAt: at(150), endedAt: at(200), status: 'passed' });
  phases = readLandingProgress(store, 'e');
  assert.equal(phases.current, 'github-mirror-push');
  assert.equal(phases.timeline.find(item => item.phase === 'main-audit').durationMs, 50000);
  data.githubSync = { commits: [{ acceptanceId: 'm' }], pushed: 1, pushedAt: at(210) };
  phases = readLandingProgress(store, 'e');
  assert.equal(phases.current, 'accepted');
  assert.equal(phases.timeline.find(item => item.phase === 'github-mirror-push').durationMs, 'unknown');
});

test('landing and delegated finish receipts stay identical while live follow-up timings change', t => {
  const { store, data } = fixture(t);
  const operationId = randomUUID(),
    laneId = randomUUID(),
    intentId = randomUUID();
  const pin = { laneId, head: 'a'.repeat(64) };
  data.lanes = [{ id: laneId, intentId, head: pin.head }];
  data.views.push({ id: 'v', inputs: [pin] });
  data.landingEntries.push({
    id: operationId,
    channel: 'main',
    viewId: 'v',
    runId: 'r',
    status: 'accepted',
    arrivedAt: at(0),
    firstSelectedAt: at(10),
    acceptanceId: 'm',
  });
  data.runs.push({ id: 'r', viewId: 'v', status: 'passed', startedAt: at(20), endedAt: at(130) });
  data.channelMoves.push({
    id: 'm',
    channel: 'main',
    viewId: 'v',
    status: 'accepted',
    at: at(140),
    postAccept: {},
    postAcceptRunId: 'audit',
  });
  data.githubAutoPush = { acceptanceId: 'm', status: 'queued', at: at(150) };
  const command = { operationId, laneIds: [laneId] };
  const finish = { operationId, laneId, accept: { channel: 'main' } };
  const journal = {
    state: { entries: [{ command: finish, inputs: [pin], result: { status: 'accepted' } }] },
  };
  const receipt = () => landReceipt(store, command, journal).result;
  const delegated = result =>
    JSON.parse(JSON.stringify(finishSubmissions(store, finish, [{ head: pin.head }], result)));
  const original = receipt();
  const saved = delegated(original);
  assert.equal(original.entries[0].phases.current, 'accepted');
  assert.equal(original.entries[0].phases.timeline.length, 6);
  assert.equal(original.entries[0].phases.eta, undefined);
  assert.deepEqual(original.entries[0].phases, original.entries[0].submissions[0].phases);
  const assertStable = () => {
    const replay = receipt();
    assert.deepEqual(replay.entries, original.entries);
    assert.equal(replay.table, original.table);
    assert.deepEqual(delegated(replay), saved);
  };
  assert.equal(readLandingProgress(store, operationId).current, 'main-audit');
  const audit = { id: 'audit', status: 'running', startedAt: at(150) };
  data.runs.push(audit);
  assertStable();
  Object.assign(audit, { status: 'passed', endedAt: at(200) });
  const live = readLandingProgress(store, operationId);
  assert.equal(live.current, 'github-mirror-push');
  assert.equal(live.timeline.find(item => item.phase === 'main-audit').durationMs, 50000);
  assertStable();
  data.githubSync = { commits: [{ acceptanceId: 'm' }], pushed: 1, pushedAt: at(210) };
  assert.equal(readLandingProgress(store, operationId).current, 'accepted');
  assertStable();
});

test('owner history supplies the same estimated phase structure used by status and wait', t => {
  const { store, data, write } = fixture(t);
  data.landingEntries.push(
    {
      id: 'old',
      channel: 'main',
      arrivedAt: at(0),
      firstSelectedAt: at(10),
      runId: 'old-run',
      acceptanceId: 'old-move',
      status: 'accepted',
    },
    {
      id: 'new',
      channel: 'main',
      arrivedAt: at(150),
      firstSelectedAt: at(160),
      runId: 'new-run',
      status: 'checking',
    },
  );
  data.channelMoves.push({
    id: 'old-move',
    channel: 'main',
    at: at(140),
    status: 'accepted',
    viewId: 'old-view',
  });
  data.runs.push(
    {
      id: 'old-run',
      viewId: 'old-view',
      status: 'passed',
      startedAt: at(20),
      endedAt: at(130),
      backend: { actual: 'github-actions' },
    },
    {
      id: 'new-run',
      viewId: 'new-view',
      status: 'running',
      startedAt: at(170),
      backend: { actual: 'github-actions' },
    },
  );
  for (const id of ['old-run', 'new-run']) {
    write(`check-${id}/modal-plan.json`, { groups: [['a'], ['b']], selection: { tests: ['a', 'b'] } });
    write(`check-${id}/github-actions.json`, {
      runId: 1,
      jobUsage: [{ id: 1, started_at: id === 'old-run' ? at(30) : at(180), status: 'running' }],
      states: { 1: 'completed/success' },
    });
    write(`check-${id}/modal-shard-logs.json`, [{ index: 0, executionId: '1', attempt: 0 }]);
  }
  const phases = readLandingProgress(store, 'new', undefined, 190000);
  assert.equal(phases.current, 'ci-running');
  assert.equal(phases.eta.label, 'estimate');
  assert.equal(phases.eta.samples, 1);
  // 100s CI × 2/3 unfinished jobs (including static) + 10s acceptance.
  assert.equal(phases.eta.remainingMs, 76667);
  assert.equal(phases.eta.phaseMedianMs['ci-running'], 100000);
});
test('retry in progress cannot reuse old completion counts or test-file markers', t => {
  const { store, write } = fixture(t);
  write('check-r/modal-plan.json', { groups: [['a']], selection: { tests: ['a'] } });
  write('check-r/github-actions.json', {
    retrying: [0],
    retrySources: { 0: 1 },
    states: { 1: 'completed/failure' },
  });
  write('check-r/modal-shard-logs.json', [{ index: 0, attempt: 0, executionId: '1' }]);
  write('check-r/shards/0.log', '__FORGE_TESTS__{"file":"a","complete":true}\n');
  const progress = readLandCheckProgress(store.directory, 'r').progress;
  assert.equal(progress.jobs.done, 0);
  assert.equal(progress.shards.done, 0);
  assert.equal(progress.files, undefined);
});
test('missing provider timestamps remain unknown even when a provider run is adopted', t => {
  const { store, data, write } = fixture(t);
  data.landingEntries.push({ id: 'entry', channel: 'main', status: 'checking', runId: 'r' });
  data.runs.push({ id: 'r', status: 'running', startedAt: at(20), backend: { actual: 'github-actions' } });
  write('check-r/github-actions.json', { runId: 123 });
  const phases = readLandingProgress(store, 'entry');
  assert.equal(phases.current, 'ci-running');
  assert.equal(phases.timeline[3].startedAt, 'unknown');
  assert.equal(phases.timeline[2].durationMs, 'unknown');
  assert.equal(phases.eta, undefined);
});

test('an earlier mirrored acceptance never borrows a later push timestamp', t => {
  const { store, data } = fixture(t);
  data.landingEntries.push({ id: 'e', channel: 'main', status: 'accepted', acceptanceId: 'm' });
  data.channelMoves.push({ id: 'm', channel: 'main', viewId: 'v', status: 'accepted', at: at(140) });
  data.githubSync = {
    commits: [{ acceptanceId: 'm' }, { acceptanceId: 'later' }],
    pushed: 2,
    pushedAt: at(300),
  };
  const phases = readLandingProgress(store, 'e');
  assert.equal(phases.current, 'accepted');
  const mirror = phases.timeline.find(item => item.phase === 'github-mirror-push');
  assert.equal(mirror.state, 'completed');
  assert.equal(mirror.endedAt, 'unknown');
});
test('failed or interrupted main audits remain the visible trailing phase', t => {
  const { store, data } = fixture(t);
  data.landingEntries.push({ id: 'e', channel: 'main', status: 'accepted', acceptanceId: 'm' });
  data.channelMoves.push({
    id: 'm',
    channel: 'main',
    viewId: 'v',
    status: 'accepted',
    at: at(140),
    postAccept: {},
    postAcceptRunId: 'r',
  });
  data.runs.push({ id: 'r', status: 'interrupted', startedAt: at(150), endedAt: at(180) });
  const phases = readLandingProgress(store, 'e');
  assert.equal(phases.current, 'main-audit');
  assert.equal(phases.waitingOn, 'interrupted');
  assert.equal(phases.timeline.find(item => item.phase === 'main-audit').durationMs, 30000);
});

test('legacy owners without optional landing collections retain unknown progress', t => {
  const { store, data } = fixture(t);
  delete data.landingEntries;
  const phases = readLandingProgress(store, 'unsubmitted');
  assert.equal(phases.current, 'queued');
  assert.equal(phases.timeline[0].startedAt, 'unknown');
  assert.equal(phases.queue.position, 'unknown');
  assert.equal(phases.eta, undefined);
});

test('re-admitted attempts do not count earlier CI as composition time', t => {
  const { store, data } = fixture(t);
  data.landingEntries.push({
    id: 'e',
    channel: 'main',
    status: 'checking',
    arrivedAt: at(0),
    firstSelectedAt: at(10),
    infrastructureRetries: [{ at: at(200), code: 'infra', runId: 'previous' }],
    runId: 'r',
  });
  data.runs.push({ id: 'r', status: 'running', startedAt: at(220) });
  const phases = readLandingProgress(store, 'e');
  assert.equal(phases.timeline[0].startedAt, at(200));
  assert.equal(phases.timeline[1].startedAt, 'unknown');
  assert.equal(phases.timeline[1].durationMs, 'unknown');
});

for (const backend of ['github-actions', 'modal'])
  test(`${backend} controller preparation is distinct from recorded remote execution`, t => {
    const { store, data, write } = fixture(t);
    data.landingEntries.push({ id: 'e', channel: 'main', status: 'checking', runId: 'r' });
    const run = { id: 'r', status: 'running', startedAt: at(20), backend: { actual: backend } };
    data.runs.push(run);
    let phases = readLandingProgress(store, 'e');
    assert.equal(phases.current, 'dispatching');
    assert.equal(phases.check.phase, 'running');
    assert.equal(phases.timeline[3].startedAt, 'unknown');
    if (backend === 'github-actions') write('check-r/github-actions.json', { runId: 123 });
    else write('check-r/modal-shard-logs.json', [{ index: 0, attempt: 0, executionId: 'remote' }]);
    phases = readLandingProgress(store, 'e');
    assert.equal(phases.current, 'ci-running');
    assert.equal(phases.timeline[3].startedAt, 'unknown');
  });

test('a legacy Modal execution without a shard index still reports recorded CI with unknown time', t => {
  const { store, data } = fixture(t);
  data.landingEntries.push({ id: 'e', channel: 'main', status: 'checking', runId: 'r' });
  data.runs.push({
    id: 'r',
    status: 'running',
    startedAt: at(20),
    backend: { actual: 'modal', executionIds: ['remote'] },
  });
  const phases = readLandingProgress(store, 'e');
  assert.equal(phases.current, 'ci-running');
  assert.equal(phases.timeline[3].startedAt, 'unknown');
});

test('live ownership follows the physical controller lease instead of the submitting transport', async t => {
  const { store, data, write } = fixture(t);
  const run = {
    id: randomUUID(),
    viewId: randomUUID(),
    head: 'a'.repeat(64),
    check: { definition: 'b'.repeat(64) },
    environment: { fingerprint: 'c'.repeat(64) },
    status: 'queued',
    runner: { pid: 2147483647, startTime: 'gone submitter', host: hostname() },
  };
  data.runs.push(run);
  data.landingEntries.push({ id: 'e', channel: 'main', status: 'checking', runId: run.id });
  write(`check-${run.id}/controller-request.json`, {
    schema: 1,
    id: run.id,
    viewId: run.viewId,
    head: run.head,
    definition: run.check.definition,
    environment: run.environment.fingerprint,
    runner: run.runner,
  });
  const before = readLandCheckController(store, run);
  assert.equal(before.holder, undefined);
  assert.equal(before.waitingOn, 'check controller lease');
  const receipt = readLandingProgress(store, 'e', undefined, undefined, false);
  const output = [],
    report = changeOnlyLandingReporter(line => output.push(line));
  report('lane-id', readLandingProgress(store, 'e'));
  const directory = join(store.directory, 'check-controllers', run.id);
  await withQueueSlot(
    directory,
    async () => {
      const control = readLandCheckController(store, run);
      assert.equal(control.holder.pid, process.pid);
      assert.equal(control.holder.lease, `check-controllers/${run.id}`);
      assert.equal(control.phase, 'queued');
      assert.equal(run.runner.pid, 2147483647);
      report('lane-id', readLandingProgress(store, 'e'));
      report('lane-id', readLandingProgress(store, 'e'));
      assert.equal(output.length, 2);
      assert.match(
        output[1],
        new RegExp(`run=${run.id} phase=queued.*holder=check controller pid ${process.pid}`),
      );
      assert.deepEqual(readLandingProgress(store, 'e', undefined, undefined, false), receipt);
      run.status = 'preparing';
      report('lane-id', readLandingProgress(store, 'e'));
      assert.equal(output.length, 3);
      assert.match(output[2], /phase=preparing/);
    },
    { anchor: store.directory, waitMs: 0 },
  );
  assert.equal(readLandCheckController(store, run).holder, undefined);
  assert.equal(readLandCheckController(store, { ...run, status: 'passed' }), undefined);
});

test('stale or partially written controller tickets are observation only and never removed', t => {
  const { store, write } = fixture(t);
  const run = { id: 'r', status: 'running' };
  const name = `2147483647.${Buffer.from('gone').toString('base64url')}.${randomUUID()}`;
  const path = `check-controllers/r/${name}/ticket.json`;
  write(path, { holding: true, number: 1, limit: 1 });
  assert.equal(readLandCheckController(store, run).holder, undefined);
  assert.ok(existsSync(join(store.directory, path)));
  write(path, '{unfinished');
  assert.equal(readLandCheckController(store, run).holder, undefined);
  assert.ok(existsSync(join(store.directory, path)));
});

test('worker errors retain affected Lane, operation and run identities only in live progress', t => {
  const { store, data } = fixture(t);
  const operationId = randomUUID(),
    laneId = randomUUID(),
    runId = randomUUID();
  data.landingEntries.push({ id: operationId, channel: 'main', status: 'checking', runId });
  data.runs.push({ id: runId, status: 'running', startedAt: at(20) });
  const receipt = readLandingProgress(store, operationId, undefined, undefined, false);
  const state = {
    schema: 1,
    id: randomUUID(),
    worker: processIdentity(),
    status: 'error',
    observedAt: at(30),
    endpoint: 'synthetic',
    code: 'CHECK_RECOVERY_FAILED',
    affected: { laneIds: [laneId], operationId, runId, channel: 'main' },
  };
  saveLandingWorkerState(store, state);
  const phases = readLandingProgress(store, operationId);
  assert.deepEqual(phases.workerError, { code: state.code, ...state.affected });
  const line = landingProgressLine(laneId, phases);
  for (const identity of [laneId, operationId, runId]) assert.ok(line.includes(identity));
  assert.ok(line.includes(state.code));
  assert.deepEqual(readLandingProgress(store, operationId, undefined, undefined, false), receipt);
  assert.equal(readLandingProgress(store, 'unrelated').workerError, undefined);
});
