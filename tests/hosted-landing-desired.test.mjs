// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { finishFixture, desired, api as finishApi, landingApi, code } from './hosted-finish-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { policyPreset } from '../dist/autonomy-policy.js';
const synthetic = {
  FORGE_HOSTED_CHECK_KEY_ID: 'SYNTHETIC',
  FORGE_SOURCE_PROVIDER: 'convex',
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
const feed = await import(moduleUrl('../convex/projectFeed.ts'));
const proof = await import(moduleUrl('../convex/projectRunProofActions.ts'));
const feedRows = (f, operationId) =>
  [...f.tables.projectFeedEvents.values()].filter(event => event.operationId === operationId);
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
test('replaying a supervised desired landing returns current approval details on the original submission', async t => {
  const web = 'https://forge.example.invalid';
  const priorWeb = process.env.FORGE_WEB_URL;
  process.env.FORGE_WEB_URL = web;
  t.after(() => {
    if (priorWeb === undefined) delete process.env.FORGE_WEB_URL;
    else process.env.FORGE_WEB_URL = priorWeb;
  });
  const f = await finishFixture(t);
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: { ...policyPreset('supervised'), agentDefaults: { preflight: 'advise' } },
  });
  f.insert('forgeAccounts', { owner: 'owner', handle: 'river' });
  const command = request(f);
  const submitted = await submit(f, command);
  assert.equal(submitted.url, undefined);
  await f.drain();
  await f.passChecks();
  await f.drain();
  const held = await submit(f, command);
  assert.equal(held.id, submitted.id);
  assert.equal(held.operationId, command.operationId);
  assert.equal(held.observation.pendingReason, 'waiting-for-review');
  assert.equal(held.approver, 'river');
  assert.equal(held.url, `${web}/approve?project=${f.projectId}&submission=${submitted.id}`);
});

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
    const before = structuredClone(f.tables);
    const reconnected = (await read(f, alias.operationId)).submission;
    assert.equal(reconnected.id, state.id);
    assert.equal(reconnected.phase, 'landed');
    assert.deepEqual(f.tables, before);
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
  assert.equal((await submit(f, command)).id, failed.id);
  const [event, ...rest] = feedRows(f, command.operationId);
  assert.equal(rest.length, 0);
  assert.equal(event.id, `landing.failed:${failed.id}:${f.lane.laneId}`);
  assert.equal(event.code, failed.error.code);
});

test('a project writer can observe the exact pre-admission feed failure until access is lost', async t => {
  const startAt = Date.UTC(2026, 0, 1);
  const f = await finishFixture(t, { startAt });
  pauseSource(f);
  const command = request(f);
  const submitted = await submit(f, command);
  const membership = f.insert('projectContributors', { projectId: f.projectId, contributor: 'writer' });
  f.insert('projectReaders', { projectId: f.projectId, reader: 'reader' });
  // Even with the project publicly readable, the desired outcome requires current write access.
  f.patch('hostedProjects', f.projectId, { visibility: 'public' });
  const readSubmission = (submissionId, actor = 'writer', version, projectId = f.projectId) =>
    f
      .tx('desiredSubmissionObservation', finishApi.status, { projectId, submissionId, version }, actor)
      .then(JSON.parse);
  await assert.rejects(readSubmission(submitted.id), code('NOT_FOUND'));
  const desiredRow = [...f.tables.projectHostedLandingDesired.values()][0];
  await f.tx('desiredAdmissionFailed', desired.fail, {
    projectId: f.projectId,
    submissionId: submitted.id,
    wakeId: desiredRow.wake.id,
    code: 'SOURCE_UNAVAILABLE',
    message: 'Synthetic pre-admission failure.',
  });
  const page = await f.tx(
    'desiredFeed',
    feed.page,
    { projectId: f.projectId, since: 1, project: true },
    'writer',
  );
  const event = page.events.find(event => event.kind === 'landing.failed');
  assert.equal(event.submissionId, submitted.id);
  assert.equal(event.operationId, command.operationId);
  await assert.rejects(read(f, event.operationId, 'writer'), code('NOT_FOUND'));
  await assert.rejects(readSubmission(event.operationId), code('NOT_FOUND'));
  const pending = f.pending().length;
  const result = await readSubmission(event.submissionId);
  const observationCost = f.counts.at(-1);
  assert.equal(result.submission.id, event.submissionId);
  assert.equal(result.submission.operationId, event.operationId);
  assert.equal(result.submission.phase, 'terminal-failed');
  assert.equal(result.submission.error.code, event.code);
  assert.equal(result.submission.error.message, 'Synthetic pre-admission failure.');
  assert.equal(result.pendingAttempt, null);
  assert.equal(result.unchanged, false);
  assert.equal((await readSubmission(event.submissionId, 'writer', result.version)).unchanged, true);
  assert.equal(observationCost.readDocumentsByTable.projectHostedLandingDesired, 1);
  assert.equal(observationCost.writes, 0);
  assert.equal(f.pending().length, pending);
  const otherProject = f.insert('hostedProjects', {
    name: 'Another project',
    key: 'another-project',
    owner: 'writer',
    visibility: 'private',
    currentBackup: null,
    revision: 0,
  });
  await assert.rejects(
    readSubmission(event.submissionId, 'writer', undefined, otherProject),
    code('NOT_FOUND'),
  );
  const device = { subject: 'writer', forgeCredential: randomUUID() };
  const credential = f.insert('cliCredentials', {
    owner: device.subject,
    credentialId: device.forgeCredential,
    name: 'Synthetic',
    scope: 'cli',
    tokenHash: 'synthetic',
    issuedAt: startAt,
    expiresAt: startAt + 60_000,
    revoked: false,
    settings: { source: 'write', projects: { kind: 'all' } },
  });
  assert.equal((await readSubmission(event.submissionId, device)).submission.id, event.submissionId);
  f.patch('cliCredentials', credential, { settings: { source: 'read', projects: { kind: 'all' } } });
  await assert.rejects(readSubmission(event.submissionId, device), code('AUTH_SCOPE_DENIED'));
  for (const actor of [null, 'reader', 'outsider'])
    await assert.rejects(readSubmission(event.submissionId, actor), code('PROJECT_UNAVAILABLE'));
  f.tables.projectContributors.delete(membership);
  await assert.rejects(readSubmission(event.submissionId, 'writer'), code('PROJECT_UNAVAILABLE'));
  t.diagnostic(
    JSON.stringify({
      calls: 1,
      documents: observationCost.documents,
      ranges: observationCost.ranges,
      readBytes: observationCost.readBytes,
    }),
  );
});

test('combined landing emits one independently replayable id for each original Lane', async t => {
  const f = await finishFixture(t, { inputCount: 2 });
  const command = request(f);
  const submission = await submit(f, command);
  await f.drain();
  await f.passChecks();
  await f.drain();
  const landed = (await read(f, command.operationId)).submission;
  assert.equal(landed.phase, 'landed');
  assert.equal((await submit(f, command)).id, submission.id);
  const events = feedRows(f, command.operationId);
  assert.equal(events.length, 2);
  assert.equal(new Set(events.map(event => event.laneId)).size, 2);
  for (const event of events) {
    assert.equal(event.id, `landing.landed:${submission.id}:${event.laneId}`);
    assert.equal(event.receiptId, landed.acceptance.receiptId);
  }
});

test('check-only success and failure wake the selected Lane once per run', async t => {
  const f = await finishFixture(t);
  for (const status of ['failed', 'passed']) {
    const command = f.rawChecks.selection();
    const run = await f.rawChecks.enqueue(command);
    if (status === 'passed') await f.rawChecks.pass(await f.rawChecks.activate(run.id));
    else {
      const active = await f.rawChecks.activate(run.id);
      await f.rawChecks.callback(f.rawChecks.shard(active, 0, 'failed'));
      await f.rawChecks.callback(f.rawChecks.complete(active, 'failed'));
    }
    assert.equal((await f.rawChecks.enqueue(command)).id, run.id);
    const events = feedRows(f, command.operationId);
    assert.deepEqual(
      events.map(event => event.id),
      [`check.${status}:${run.id}:${f.lane.laneId}`],
    );
  }
});

test('queue feed projects a Lane position only when requested and leaves no stored queue event', async t => {
  const f = await finishFixture(t);
  const command = f.request();
  const pending = await f.enqueue(command);
  const input = { projectId: f.projectId, lanes: [f.lane.laneId], since: Date.parse(pending.at) };
  const queued = await f.tx('readFeed', feed.page, { ...input, queue: { laneId: f.lane.laneId } });
  const event = queued.events.find(event => event.kind === 'queue.moved');
  assert.equal(event?.id, `queue.moved:${pending.id}:1`);
  assert.equal(event.position, 1);
  assert.deepEqual(event.resume.input.operationIds, [command.operationId]);
  assert.deepEqual((await f.tx('readFeed', feed.page, input)).events, []);
  assert(![...f.tables.projectFeedEvents.values()].some(event => event.kind === 'queue.moved'));
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
  assert.equal(feedRows(f, state.operationId)[0]?.kind, 'landing.cancelled');
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
  assert.equal(
    f.pending().find(task => task.name === 'projectHostedLandingDesired:drive').scheduledTime,
    Date.now(),
    'source event bypasses backoff',
  );
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
  const operationId = randomUUID();
  const proofRun = JSON.parse(
    await f.tx('proofCheckFeed', proof.runAll, {
      projectId: f.projectId,
      runId: attempt.check.runId,
      operationId,
    }),
  );
  assert.equal(proofRun.request.candidateId, attempt.candidate.id);
  await f.passChecks();
  assert.deepEqual(
    feedRows(f, operationId).map(event => event.id),
    [`check.passed:${proofRun.id}:${f.lane.laneId}`],
  );
});

test('cancelling browser-reviewed source emits for the canonical Candidate Lane', async t => {
  const f = await finishFixture(t);
  const original = f.request({ agent: false, check: null });
  const command = {
    ...original,
    finish: {
      reviewedSource: { ...f.selection.request, operationId: original.operationId },
      after: null,
    },
  };
  const pending = await f.enqueue(command);
  const cancelled = {
    projectId: f.projectId,
    request: JSON.stringify({
      operationId: randomUUID(),
      authorityEpoch: 1,
      submissionId: pending.id,
    }),
  };
  await f.tx('reviewedCancelFeed', landingApi.cancel, cancelled);
  await f.tx('reviewedCancelFeed', landingApi.cancel, cancelled);
  assert.deepEqual(
    feedRows(f, command.operationId).map(event => event.id),
    [`landing.cancelled:${pending.id}:${f.lane.laneId}`],
  );
});

test('owner urgent priority survives desired composition into its canonical queued submission', async t => {
  const f = await finishFixture(t),
    command = { ...request(f), priority: 'urgent' };
  // Finishes arrive as agent calls; urgentRoles must include agents for them to stay urgent.
  const project = f.tables.hostedProjects.get(f.projectId);
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: {
      ...project.autonomyPolicy,
      agentDefaults: { ...project.autonomyPolicy.agentDefaults, urgentRoles: ['owner', 'agents'] },
    },
  });
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

test('Issue 029138ef: the server refuses a direct desired landing that skips the CLI preflight result; the CLI result for the composed head lands as before', async t => {
  const f = await finishFixture(t);
  const project = f.tables.hostedProjects.get(f.projectId);
  const policy = gates =>
    f.patch('hostedProjects', f.projectId, {
      autonomyPolicy: {
        ...project.autonomyPolicy,
        agentDefaults: { ...project.autonomyPolicy.agentDefaults, ...gates },
      },
    });
  const [selected] = [...f.tables.projectHostedComposeSelections.values()].filter(
    row => row.kind === 'inputs' && row.operationId === f.selection.request.operationId,
  );
  assert.match(selected.head, /^[0-9a-f]{64}$/, 'the selection records the composed head');
  const lane = { laneId: selected.key, head: selected.head };
  const submitWith = (command, value) =>
    f
      .tx('desiredSubmit', desired.submit, {
        projectId: f.projectId,
        request: JSON.stringify(command),
        ...(value === undefined ? {} : { gates: value }),
      })
      .then(JSON.parse);
  const command = request(f);
  // overlapGate stays a client-side, advisory check until flip 4 (853fcde3): never judged here.
  policy({ overlapGate: 'block', preflight: 'require' });
  // A client that skips the CLI (no result, or one for another head) is refused, as the CLI would.
  await assert.rejects(submitWith(command), error => {
    assert(code('PREFLIGHT_REQUIRED')(error));
    assert.match(error.data?.message ?? error.message, /nforge agent ROOT preflight .*Then land again/);
    return true;
  });
  assert.equal(f.tables.projectHostedLandingDesired.size, 0, 'a refusal writes nothing');
  await assert.rejects(
    submitWith(command, JSON.stringify({ lanes: [{ ...lane, head: 'a'.repeat(64), preflight: 'passed' }] })),
    code('PREFLIGHT_REQUIRED'),
  );
  await assert.rejects(submitWith(command, '{"lanes":[{"laneId":"x"}]}'), code('BAD_ARGUMENT'));
  // The CLI's result for this head: the landing proceeds and lands exactly as before.
  const state = await submitWith(
    command,
    JSON.stringify({ lanes: [{ ...lane, preflight: 'passed', saveMs: 15000, preflightMs: 49779 }] }),
  );
  assert.equal(state.timing.ms[0], 15000);
  assert.equal(state.timing.ms[1], 49779);
  assert.equal(state.phase, 'composing');
  // A replay of the same operation returns its landing unjudged (no gates needed).
  assert.equal((await submitWith(command)).id, state.id);
  await f.drain();
  await f.passChecks();
  await f.drain();
  assert.equal((await read(f, command.operationId)).submission.phase, 'landed');
  const canonical = JSON.parse(
    [...f.tables.projectHostedLandingRequests.values()].find(row => row.operationId === command.operationId)
      .value,
  );
  assert.equal(canonical.timing.ms[0], 15000);
  assert.equal(canonical.timing.ms[1], 49779);
  assert.equal(
    (await read(f, command.operationId)).submission.timing.ms,
    undefined,
    'released strict read DTO retains its shape',
  );
  // Budget: a gated landing reads one indexed range more than an ungated one.
  const plain = await finishFixture(t);
  const ungatedFrom = plain.counts.length;
  await plain.tx('desiredSubmit', desired.submit, {
    projectId: plain.projectId,
    request: JSON.stringify(request(plain)),
  });
  const ungated = plain.counts.slice(ungatedFrom).find(count => count.name === 'desiredSubmit');
  const healthy = await finishFixture(t);
  const healthyProject = healthy.tables.hostedProjects.get(healthy.projectId);
  healthy.patch('hostedProjects', healthy.projectId, {
    autonomyPolicy: {
      ...healthyProject.autonomyPolicy,
      agentDefaults: { ...healthyProject.autonomyPolicy.agentDefaults, preflight: 'require' },
    },
  });
  const [own] = [...healthy.tables.projectHostedComposeSelections.values()].filter(
    row => row.kind === 'inputs' && row.operationId === healthy.selection.request.operationId,
  );
  const healthyFrom = healthy.counts.length;
  await healthy.tx('desiredSubmit', desired.submit, {
    projectId: healthy.projectId,
    request: JSON.stringify(request(healthy)),
    gates: JSON.stringify({ lanes: [{ laneId: own.key, head: own.head, preflight: 'passed' }] }),
  });
  const gated = healthy.counts.slice(healthyFrom).find(count => count.name === 'desiredSubmit');
  assert.equal(gated.ranges - ungated.ranges, 1, 'one indexed read on a healthy gated landing');
});

test('Issue 029138ef: a direct agent enqueue is judged like a desired one; naming no composition is refused', async t => {
  const f = await finishFixture(t);
  const project = f.tables.hostedProjects.get(f.projectId);
  f.patch('hostedProjects', f.projectId, {
    autonomyPolicy: {
      ...project.autonomyPolicy,
      agentDefaults: { ...project.autonomyPolicy.agentDefaults, preflight: 'require' },
    },
  });
  const [selected] = [...f.tables.projectHostedComposeSelections.values()].filter(
    row => row.kind === 'inputs' && row.operationId === f.selection.request.operationId,
  );
  const enqueue = (request, gates) =>
    f
      .tx('finishEnqueue', landingApi.enqueue, {
        projectId: f.projectId,
        request: JSON.stringify(request),
        ...(gates ? { gates } : {}),
      })
      .then(JSON.parse);
  const { finish: _finish, ...unnamed } = f.request({ agent: true });
  await assert.rejects(enqueue({ ...unnamed, operationId: randomUUID() }), error => {
    assert(code('PREFLIGHT_REQUIRED')(error));
    assert.match(error.data?.message ?? error.message, /names no Lane composition/);
    return true;
  });
  const agent = f.request({ agent: true });
  await assert.rejects(enqueue(agent), code('PREFLIGHT_REQUIRED'));
  // The preflight result for the composed head is enough.
  const gates = JSON.stringify({ lanes: [{ laneId: selected.key, head: selected.head, preflight: 'none' }] });
  const state = await enqueue(agent, gates);
  assert.equal(state.request.operationId, agent.operationId);
});

for (const preflight of ['off', 'advise']) {
  test(`optional timing metadata cannot add a landing refusal with preflight ${preflight}`, async t => {
    const f = await finishFixture(t);
    const project = f.tables.hostedProjects.get(f.projectId);
    f.patch('hostedProjects', f.projectId, {
      autonomyPolicy: {
        ...project.autonomyPolicy,
        agentDefaults: { ...project.autonomyPolicy.agentDefaults, preflight },
      },
    });
    const state = JSON.parse(
      await f.tx('desiredSubmit', desired.submit, {
        projectId: f.projectId,
        request: JSON.stringify(request(f)),
        gates: 'not valid optional metadata',
      }),
    );
    assert.equal(state.phase, 'composing');
    assert.equal(state.timing.ms, undefined, 'unknown timing stays unknown; policy is unchanged');
  });
}

test('incident replay 08169467: completed compose replaces a running desired wake without cancellation and lands after client exit', async t => {
  const f = await finishFixture(t),
    command = request(f),
    resume = pauseSource(f);
  const state = await submit(f, command);
  const row = [...f.tables.projectHostedLandingDesired.values()][0];
  const old = row.wake;
  f.patch('_scheduled_functions', old.taskId, { state: { kind: 'inProgress' } });
  const wake = await import(moduleUrl('../convex/projectHostedLandingDesiredWake.ts'));
  let cancelled = 0;
  f.extendContext(ctx => {
    const cancel = ctx.scheduler.cancel;
    ctx.scheduler.cancel = async id => {
      if (id === old.taskId) {
        cancelled++;
        throw new Error('A mutation cannot cancel itself');
      }
      return cancel(id);
    };
  });
  resume();
  await f.tx(
    'sourceCompletion',
    { _handler: ctx => wake.notifyDesiredCompose(ctx, f.projectId, command.composeOperationId) },
    {},
  );
  assert.equal(cancelled, 0, 'a running source/desired ancestor is never cancelled');
  assert.notEqual([...f.tables.projectHostedLandingDesired.values()][0].wake.id, old.id);
  await f.drain();
  await f.passChecks();
  await f.drain();
  assert.equal((await read(f, command.operationId)).submission.phase, 'landed');
  assert.equal(f.tables.projectHostedAcceptances.size, 1);
  assert.equal(f.pending().length, 0);
  assert.equal((await read(f, command.operationId)).submission.id, state.id);
});

test('08169467: replaying the original desired request repairs its failed wake without another submission', async t => {
  const f = await finishFixture(t),
    command = request(f);
  const state = await submit(f, command);
  const row = [...f.tables.projectHostedLandingDesired.values()][0];
  f.patch('_scheduled_functions', row.wake.taskId, { state: { kind: 'failed' } });
  assert.equal((await submit(f, command)).id, state.id);
  await f.drain();
  await f.passChecks();
  await f.drain();
  assert.equal((await read(f, command.operationId)).submission.phase, 'landed');
  assert.equal(f.tables.projectHostedLandingDesired.size, 1);
  assert.equal(f.tables.projectHostedAcceptances.size, 1);
});

test('08169467: queue lists preparation without inventing a dispatch position or a review blocker', async t => {
  const f = await finishFixture(t),
    command = request(f),
    resume = pauseSource(f);
  const state = await submit(f, command);
  const view = await import(moduleUrl('../convex/projectHostedQueueView.ts'));
  const snapshot = JSON.stringify([...f.tables.projectHostedLandingDesired]);
  const queue = JSON.parse(await f.tx('preparingQueue', view.read, { projectId: f.projectId }));
  assert.equal(queue.total, 0);
  assert.equal(queue.preparing, 1);
  assert.equal(queue.entries[0].submissionId, state.id);
  assert.equal(queue.entries[0].position, null);
  assert.equal(queue.entries[0].laneId, f.lane.laneId);
  assert.equal(queue.entries[0].waitingOn.kind, 'source-preparation');
  assert.equal(queue.entries[0].waitingOn.composeOperationId, command.composeOperationId);
  assert.match(queue.entries[0].landingState.nextStep, /before queue admission/);
  assert.equal(JSON.stringify([...f.tables.projectHostedLandingDesired]), snapshot);
  resume();
  await f.drain();
  assert.equal([...f.tables.projectHostedLandingDesired.values()][0].preparing, undefined);
});

test('incident replay e62d834b (dceb1bef): the queue and a stalled wait name the failed source step and its cause', async t => {
  const f = await finishFixture(t),
    command = request(f),
    resume = pauseSource(f);
  const state = await submit(f, command);
  const compose = [...f.tables.projectHostedComposes.values()].find(
    row => row.operationId === command.composeOperationId,
  );
  assert(compose, 'the landing has its compose');
  const failure = {
    failedAttempts: 2,
    lastFailure: {
      stage: 'small-save',
      exception: 'ForgeError',
      code: 'SOURCE_JOB_FENCED',
      elapsedMs: 60_200,
      httpStatus: null,
    },
    lastFailureAt: Date.now(),
    retryAt: Date.now() + 4_000,
  };
  const existing = [...f.tables.projectSourceSteps.values()].find(row => row.jobId === compose.jobId);
  if (existing) f.patch('projectSourceSteps', existing._id, { step: 1, ...failure });
  else
    f.insert('projectSourceSteps', {
      projectId: f.projectId,
      jobId: compose.jobId,
      dispatch: 'synthetic',
      executionId: 'synthetic',
      step: 1,
      cursor: null,
      ...failure,
    });
  const view = await import(moduleUrl('../convex/projectHostedQueueView.ts'));
  const queue = JSON.parse(await f.tx('preparingQueue', view.read, { projectId: f.projectId }));
  const waiting = queue.entries[0].waitingOn;
  assert.equal(waiting.kind, 'source-preparation');
  assert.equal(waiting.sourceFailure?.code, 'SOURCE_JOB_FENCED', 'the queue names the cause');
  assert.equal(waiting.sourceFailure.step, 1);
  assert.equal(waiting.sourceFailure.attempts, 2);
  assert.equal(waiting.sourceFailure.stage, 'small-save');
  // A wait reads the step only once the landing stalled: a healthy wait page has no extra read.
  assert.equal((await read(f, state.operationId)).sourceFailure, undefined);
  const start = Date.now();
  while (Date.now() < start + 15 * 60_000) {
    await f.execute();
    if (f.metrics.ticks > 100) assert.fail('no hot watchdog loop');
  }
  const stalled = await read(f, state.operationId);
  assert.equal(stalled.submission.observation.stall.step, 'composing');
  assert.equal(stalled.sourceFailure?.code, 'SOURCE_JOB_FENCED', 'the stalled wait names the cause');
  resume();
});
test('desired preparation budget: one server goal lands with no idle tasks or replacement calls', async t => {
  const f = await finishFixture(t),
    command = request(f);
  const before = f.counts.length;
  await submit(f, command);
  await f.drain();
  await f.passChecks();
  await f.drain();
  const counts = f.counts.slice(before);
  const sum = key => counts.reduce((total, count) => total + (count[key] ?? 0), 0);
  // 26 = 25 + one accountProjectOrder:touch: the landing opens an hour bucket for its project (Item 3d5d8839).
  // 26 -> 28 (Item 9a04d916, compose settle; owner-approved +$0.02/1k): each finish wake with no IO in flight is the settle mutation, and a step that needs IO hands it to one drive action (an acceptance page or cohort plan steps once more there).
  assert.equal(counts.length, 28, 'preparation retains the original server-call budget');
  assert.equal(f.pending().length, 0);
  assert.equal(f.tables.projectHostedAcceptances.size, 1);
  t.diagnostic(
    JSON.stringify({
      desiredPreparation: {
        calls: counts.length,
        readBytes: sum('readBytes'),
        writeBytes: sum('writeBytes'),
        indexes: sum('indexEntriesWritten'),
        reads: sum('documents'),
        writes: sum('writes'),
      },
    }),
  );
});

for (const mode of ['desired', 'direct']) {
  test(`${mode} landing coalesces the same declaration but preserves a distinct claim on identical source`, async t => {
    const f = await finishFixture(t);
    const base = mode === 'desired' ? request(f) : f.request();
    const send = command => (mode === 'desired' ? submit(f, command) : f.enqueue(command));
    const first = await send({ ...base, notVerified: [] });
    const alias = await send({ ...base, operationId: randomUUID(), notVerified: [] });
    assert.equal(alias.id, first.id);
    const different = await send({
      ...base,
      operationId: randomUUID(),
      notVerified: ['Transport recovery was not checked'],
    });
    assert.notEqual(different.id, first.id);
    assert.deepEqual(different.request.notVerified, ['Transport recovery was not checked']);
    const absent = await send({ ...base, operationId: randomUUID() });
    assert.notEqual(absent.id, first.id);
    assert.equal(Object.hasOwn(absent.request, 'notVerified'), false);
  });
}

test('desired landing stamps survive handoff and reconcile after a model or app switch', async t => {
  const f = await finishFixture(t);
  const command = { ...request(f), authorship: { kind: 'agent', declaration: 'unknown' } };
  const send = (value, agentClient) =>
    f
      .tx('desiredAuthorship', desired.submit, {
        projectId: f.projectId,
        request: JSON.stringify(value),
        agent: 'quiet-otter',
        agentClient,
      })
      .then(JSON.parse);
  const first = await send(command, 'fixture:model-one');
  const replay = await send(
    { ...command, authorship: { kind: 'agent', declaration: 'not-declared' } },
    'another:model-two',
  );
  assert.equal(replay.id, first.id);
  assert.equal(f.tables.projectHostedLandingDesired.size, 1);
  const row = [...f.tables.projectHostedLandingDesired.values()][0];
  assert.equal(row.agentClient, 'fixture:model-one');
  assert.deepEqual(JSON.parse(row.value).request.authorship, command.authorship);
  await assert.rejects(
    send({ ...command, after: randomUUID() }, 'another:model-two'),
    code('WORK_OPERATION_CHANGED'),
  );
});
