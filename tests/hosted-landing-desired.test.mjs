// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { finishFixture, desired, landingApi, code } from './hosted-finish-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const synthetic = {
  FORGE_HOSTED_CHECK_KEY_ID: 'SYNTHETIC',
  FORGE_SOURCE_PROVIDER: 'modal',
  FORGE_SOURCE_WORKER: 'fixed-worker',
  FORGE_SOURCE_RUNTIME: 'a'.repeat(64),
  FORGE_SOURCE_KEY_ID: 'SYNTHETIC',
  R2_ACCOUNT_ID: 'synthetic',
  R2_BUCKET: 'synthetic',
  R2_ACCESS_KEY_ID: 'synthetic',
  R2_SECRET_ACCESS_KEY: 'synthetic',
};
const prior = Object.fromEntries(Object.keys(synthetic).map(k => [k, process.env[k]]));
test.before(() => Object.assign(process.env, synthetic));
test.after(() => {
  for (const [key, value] of Object.entries(prior)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});
const observe = await import(moduleUrl('../convex/projectHostedFinishObserve.ts'));
const request = f => ({
  operationId: randomUUID(),
  authorityEpoch: 1,
  composeOperationId: f.selection.request.operationId,
  after: null,
  check: f.request().check,
});
const submit = (f, command) =>
  f
    .tx('desiredSubmit', desired.submit, { projectId: f.projectId, request: JSON.stringify(command) })
    .then(JSON.parse);
const read = (f, operationId, actor = 'owner') =>
  f
    .tx(
      'desiredRead',
      observe.page,
      { projectId: f.projectId, operationId, nextVersion: 0, priorityInfo: 1 },
      actor,
    )
    .then(JSON.parse);
function pauseSource(f) {
  const row = [...f.tables.projectHostedOperations.values()].find(
    row => row.operationId === f.selection.request.operationId,
  );
  const saved = row.value;
  const operation = JSON.parse(saved);
  f.patch('projectHostedOperations', row._id, { value: JSON.stringify({ ...operation, terminal: null }) });
  return () => f.patch('projectHostedOperations', row._id, { value: saved });
}
for (const stopped of ['submitted', 'claimed', 'composing']) {
  test(`hosted desired landing recovers after the client disappears at ${stopped}`, async t => {
    const f = await finishFixture(t),
      command = request(f),
      resumeSource = pauseSource(f);
    const state = await submit(f, command);
    assert.equal(state.phase, 'composing');
    assert.equal(state.preparing, true);
    assert.equal(f.tables.projectHostedLandingRequests.size, 0);
    assert.equal(f.tables.projectHostedCheckRuns.size, 0);
    if (stopped === 'claimed') {
      const row = [...f.tables.projectHostedLandingDesired.values()][0];
      const wakeId = await f.tx('desiredClaim', desired.claim, {
        projectId: f.projectId,
        submissionId: state.id,
        wakeId: row.wake.id,
      });
      assert(wakeId, 'claim retains a fenced server watchdog before advance');
    } else if (stopped === 'composing') await f.execute();
    const before = JSON.stringify([...f.tables.projectHostedLandingDesired]);
    assert.equal((await read(f, command.operationId)).submission.id, state.id);
    assert.equal(
      JSON.stringify([...f.tables.projectHostedLandingDesired]),
      before,
      'observation does not repair or drive',
    );
    resumeSource();
    await f.drain();
    await f.passChecks();
    await f.drain();
    const landed = (await read(f, command.operationId)).submission;
    assert.equal(landed.id, state.id);
    assert.equal(landed.firstAttemptId, state.firstAttemptId);
    assert.equal(landed.phase, 'landed', JSON.stringify(landed.error));
    assert(landed.timing.committedAt && landed.timing.settledAt);
    assert.equal(f.tables.projectHostedCheckRuns.size, 1);
    assert.equal(f.tables.projectHostedAcceptances.size, 1);
    assert.equal(f.pending().length, 0);
    assert.equal((await submit(f, command)).id, state.id);
    await assert.rejects(submit(f, { ...command, keepOpen: true }), code('WORK_OPERATION_CHANGED'));
    t.diagnostic(JSON.stringify({ stopped, droppedLandings: 0, operatorMutationsToSettle: 0, checks: 1 }));
  });
}

for (const boundary of ['checking', 'accepting']) {
  test(`a disconnected hosted requester receives its ${boundary} goal after server settlement`, async t => {
    const f = await finishFixture(t),
      command = request(f);
    const state = await submit(f, command);
    await f.drain();
    assert.equal((await read(f, command.operationId)).submission.phase, 'checking');
    if (boundary === 'accepting') {
      await f.passChecks();
      // Stop after the server stages acceptance metadata, before main publication.
      for (let steps = 0; f.tables.projectHostedAcceptancePages.size === 0; steps++) {
        assert(steps < 30, 'acceptance metadata becomes ready');
        await f.execute();
      }
      assert.equal(f.tables.projectHostedAcceptances.size, 0);
    }
    const alias = { ...command, operationId: randomUUID() };
    assert.equal((await submit(f, alias)).id, state.id);
    // No client resume or queue mutation: only the configured provider callback
    // and already-retained server scheduler run after this boundary.
    if (boundary === 'checking') await f.passChecks();
    await f.drain();
    const before = JSON.stringify(Object.entries(f.tables).map(([name, table]) => [name, [...table]]));
    const reconnected = (await read(f, alias.operationId)).submission;
    assert.equal(reconnected.id, state.id);
    assert.equal(reconnected.phase, 'landed');
    assert.equal(JSON.stringify(Object.entries(f.tables).map(([name, table]) => [name, [...table]])), before);
    assert.equal(f.tables.projectHostedCheckRuns.size, 1);
    assert.equal(f.tables.projectHostedAcceptances.size, 1);
    assert.equal(f.pending().length, 0);
    t.diagnostic(JSON.stringify({ boundary, droppedLandings: 0, operatorMutationsToSettle: 0, checks: 1 }));
  });
}

test('fresh hosted operations share one preparing and terminal handle, and every read rechecks access', async t => {
  const f = await finishFixture(t),
    command = request(f),
    resumeSource = pauseSource(f);
  const initial = await submit(f, command),
    alias = { ...command, operationId: randomUUID() };
  assert.equal((await submit(f, alias)).id, initial.id);
  assert.equal(f.tables.projectHostedLandingDesired.size, 1);
  assert.equal((await read(f, alias.operationId)).submission.id, initial.id);
  await assert.rejects(read(f, alias.operationId, 'outsider'), code('PROJECT_UNAVAILABLE'));
  resumeSource();
  await f.drain();
  await f.passChecks();
  await f.drain();
  assert.equal((await read(f, alias.operationId)).submission.phase, 'landed');
  assert.equal((await submit(f, { ...command, operationId: randomUUID() })).id, initial.id);
  assert.equal(f.tables.projectHostedCheckRuns.size, 1);
  assert.equal(f.tables.projectHostedAcceptances.size, 1);
});

test('a failed source job ends the hosted desired landing with its stated reason', async t => {
  const f = await finishFixture(t),
    command = request(f);
  const row = [...f.tables.projectHostedOperations.values()].find(
    row => row.operationId === f.selection.request.operationId,
  );
  const operation = JSON.parse(row.value);
  operation.terminal.outcome = {
    status: 'failed',
    error: { code: 'SYNTHETIC_SOURCE_FAILURE', message: 'Synthetic source execution failed.' },
  };
  f.patch('projectHostedOperations', row._id, { value: JSON.stringify(operation) });
  await submit(f, command);
  await f.drain();
  const failed = (await read(f, command.operationId)).submission;
  assert.equal(failed.phase, 'terminal-failed');
  assert.equal(failed.error.code, 'SYNTHETIC_SOURCE_FAILURE');
  assert(failed.timing.settledAt);
  assert.equal(f.tables.projectHostedCheckRuns.size, 0);
  assert.equal(f.pending().length, 0);
});

test('a newer agent Lane head supersedes the goal with the replacement named', async t => {
  const f = await finishFixture(t),
    state = await f.enqueue(f.request());
  await f.drain();
  const lane = await f.readLane(f.lane.laneId);
  const newer = f.c.state([f.c.baseFile, f.c.hidden, f.c.file('newer.txt', 'newer\n')], [lane.head]);
  f.c.register(newer);
  await f.changeLane(lane.id, { head: newer.sha256, sourceVersion: lane.sourceVersion + 1 });
  await f.passChecks();
  await f.drain();
  const superseded = (await read(f, state.operationId)).submission;
  assert.equal(superseded.observation.state, 'superseded');
  assert.equal(superseded.error.code, 'LANDING_SUPERSEDED');
  assert.match(superseded.error.message, new RegExp(newer.sha256));
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
});

test('a stalled desired composition alarms without a requester and backs off to three calls per hour', async t => {
  const f = await finishFixture(t),
    command = request(f),
    resume = pauseSource(f);
  const state = await submit(f, command);
  const start = Date.now();
  let wakes = 0;
  while (Date.now() < start + 15 * 60_000) {
    await f.execute();
    if (f.metrics.ticks > 100) assert.fail('no hot watchdog loop');
    wakes++;
  }
  const alarmed = (await read(f, state.operationId)).submission;
  assert.equal(alarmed.observation.stall.step, 'composing');
  assert.match(alarmed.observation.stall.missingOwner, /source worker.*controller/);
  const beforeCalls = f.counts.filter(c => c.name.startsWith('desired-')).length;
  // In steady state each wake is drive + claim + advance, at most once per hour.
  const next = f.pending().find(task => task.name === 'projectHostedLandingDesired:drive');
  assert(next.scheduledTime - Date.now() >= 30 * 60_000);
  await f.execute(next);
  const later = f.pending().find(task => task.name === 'projectHostedLandingDesired:drive');
  assert(later.scheduledTime - Date.now() >= 60 * 60_000);
  const steadyCalls = f.counts.filter(c => c.name.startsWith('desired-')).length - beforeCalls;
  assert.equal(steadyCalls, 2);
  resume();
  const { notifyDesiredCompose } = await import(moduleUrl('../convex/projectHostedLandingDesiredWake.ts'));
  await f.tx(
    'sourceEvent',
    { _handler: ctx => notifyDesiredCompose(ctx, f.projectId, command.composeOperationId) },
    {},
  );
  assert.equal(f.pending()[0].scheduledTime, Date.now(), 'source event bypasses backoff');
  await f.drain();
  await f.passChecks();
  await f.drain();
  const landed = (await read(f, state.operationId)).submission;
  assert.equal(landed.phase, 'landed');
  assert.equal(landed.observation.stall, undefined, 'progress clears the alarm');
  assert.equal(f.pending().length, 0, 'settled goals have no recurring wake');
  t.diagnostic(
    JSON.stringify({ wakesBeforeAlarm: wakes, operatorMutationsToAlarm: 0, steadyControllerCallsPerHour: 3 }),
  );
});

test('one alarm transfers from desired preparation, resets on run progress, and is cancelled on settlement', async t => {
  const f = await finishFixture(t),
    command = request(f);
  const state = await submit(f, command);
  const alarms = () => f.pending().filter(task => task.name === 'projectHostedLandingStall:alarm');
  assert.equal(alarms().length, 1);
  await f.execute(); // completed source job admits the same desired identity
  assert.equal(alarms().length, 1, 'admission replaces preparation alarm');
  assert.equal([...f.tables.projectHostedLandingDesired.values()][0].alarm, null);
  await f.drain(); // a deliberately unfinished queued check reaches its alarm
  let current = (await read(f, command.operationId)).submission;
  assert.equal(current.observation.stall.step, 'checking');
  const oldProgress = current.observation.stall.lastProgressAt;
  f.advanceClock(60_000);
  const run = [...f.tables.projectHostedCheckRuns.values()][0];
  const active = await f.rawChecks.activate(JSON.parse(run.value).id);
  // Only the run's recorded event wakes the controller; stop before the new alarm deadline.
  for (let n = 0; f.pending()[0]?.name !== 'projectHostedLandingStall:alarm'; n++) {
    assert(n < 20);
    await f.execute();
  }
  current = (await read(f, command.operationId)).submission;
  assert.equal(current.phase, 'checking');
  assert.equal(current.observation.stall, undefined);
  assert(Date.parse(current.timing.ciProgressAt) > Date.parse(oldProgress));
  assert.equal(alarms().length, 1);
  await f.rawChecks.pass(active);
  await f.drain();
  current = (await read(f, state.operationId)).submission;
  assert.equal(current.phase, 'landed');
  assert.equal(f.pending().length, 0, 'no delayed alarm or watchdog call while idle');
  assert([...f.tables.projectHostedLandingRequests.values()].every(row => !row.alarm));
});

test('a reserved desired landing survives main moving before admission and remains visible by Candidate', async t => {
  const f = await finishFixture(t),
    command = request(f),
    resumeSource = pauseSource(f);
  const initial = await submit(f, command);
  f.moveMain();
  resumeSource();
  await f.drain();
  const state = (await read(f, command.operationId)).submission;
  assert.equal(state.id, initial.id);
  assert.equal(state.phase, 'checking', JSON.stringify(state.error));
  const row = [...f.tables.projectHostedLandingRequests.values()][0];
  assert.equal(row.candidateId, initial.request.candidateId);
  const observed = JSON.parse(
    await f.tx('desiredCandidateRead', landingApi.candidate, {
      projectId: f.projectId,
      candidateId: state.request.candidateId,
    }),
  );
  assert.equal(observed.request.id, state.id);
  await f.passChecks();
  await f.drain();
  const rebased = await f.current(state.id);
  assert.equal(rebased.submission.phase, 'checking');
  const attempt = (await f.status(state.id)).attempt;
  assert.equal(attempt.parentAttemptId, initial.firstAttemptId);
  assert.deepEqual(attempt.main, {
    head: f.currentMain().head,
    receiptId: f.currentMain().receipt.id,
  });
  await f.passChecks();
  await f.drain();
  assert.equal((await read(f, command.operationId)).submission.phase, 'landed');
  const files = JSON.parse(f.c.objects.get(f.currentMain().head)).files;
  assert(files.some(file => file.path === 'accepted.txt'));
  assert(files.some(file => file.path === 'selected.txt'));
});

test('owner urgent priority survives desired composition into its canonical queued submission', async t => {
  const f = await finishFixture(t),
    command = { ...request(f), priority: 'urgent' };
  const state = await submit(f, command);
  assert.equal(state.priority, 'urgent');
  assert.equal(state.request.priority, 'urgent');
  await f.drain();
  const current = (await read(f, command.operationId)).submission;
  assert.equal(current.id, state.id);
  assert.equal(current.priority, 'urgent');
  assert.equal(current.request.priority, 'urgent');
  assert.match(current.priorityReason, /project owner/);
});
