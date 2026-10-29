// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  finishFixture,
  api,
  driver,
  control,
  landingApi,
  records,
  code,
  maxima,
} from './hosted-finish-fixture.mjs';
import { hostedFinishBackoff } from '../dist/hosted-finish.js';
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
const stateOf = f => [...f.tables.projectHostedLandingRequests.values()].map(x => JSON.parse(x.value));
async function begin(f, overrides = {}) {
  const request = f.request(overrides),
    state = await f.enqueue(request);
  await f.drain();
  return { request, state };
}
async function complete(f) {
  await f.passChecks();
  await f.drain();
}

test('finish lands through ordinary H13/H14 evidence and original operation retry is immutable', async t => {
  const f = await finishFixture(t),
    { request, state } = await begin(f);
  assert.equal((await f.current(state.id)).submission.observation.pendingReason, 'checking');
  await complete(f);
  const landed = await f.current(state.id);
  assert.equal(landed.submission.phase, 'landed');
  assert.equal(f.tables.projectHostedAcceptances.size, 1);
  assert.deepEqual(await f.enqueue(request), landed.submission);
  await assert.rejects(f.enqueue({ ...request, check: null }), code('WORK_OPERATION_CHANGED'));
  assert.equal(f.tables.projectHostedCheckRuns.size, 1);
  assert.equal(f.pending().length, 0);
  assert(f.metrics.stepCalls.every(calls => calls.length <= 2));
  const cursor = JSON.parse(
    await f.tx('finishCursor', api.status, {
      projectId: f.projectId,
      submissionId: state.id,
      version: landed.version,
    }),
  );
  assert.equal(cursor.unchanged, true);
});

test('disjoint main movement during check recomposes and rechecks with named IDs while a person selection stays pinned across later saves', async t => {
  const f = await finishFixture(t),
    { request, state } = await begin(f, { agent: false });
  const initial = (await f.status(state.id)).attempt;
  const main = f.moveMain();
  const original = await f.readLane(f.lane.laneId);
  const later = f.c.state(
    [
      f.c.baseFile,
      f.c.hidden,
      f.c.file('selected.txt', 'selected\n'),
      f.c.file('later-save.txt', 'leave open\n'),
    ],
    [original.head],
  );
  f.c.register(later);
  await f.changeLane(original.id, { head: later.sha256, sourceVersion: original.sourceVersion + 1 });
  await complete(f);
  const checked = await f.current(state.id),
    second = (await f.status(state.id)).attempt;
  assert.equal(checked.submission.phase, 'checking');
  assert.equal(second.parentAttemptId, initial.id);
  assert.equal(second.number, 1);
  assert.notEqual(second.check.runId, initial.check.runId);
  assert.deepEqual(second.main, { head: main.head, receiptId: main.receipt.id });
  assert.deepEqual(second.candidate.inputs, initial.candidate.inputs);
  assert.deepEqual(second.candidate.dependencies, initial.candidate.dependencies);
  assert.equal(f.metrics.sourceJobs, 1);
  assert.deepEqual((await f.enqueue(request)).request, request);
  await complete(f);
  assert.equal((await f.current(state.id)).submission.phase, 'landed');
  const files = JSON.parse(f.c.objects.get(f.currentMain().head).toString()).files;
  assert(files.some(x => x.path === 'selected.txt'));
  assert(files.some(x => x.path === 'accepted.txt'));
  assert(!files.some(x => x.path === 'later-save.txt'));
  assert.equal((await f.readLane(original.id)).head, later.sha256);
  assert.equal((await f.readLane(original.id)).state, 'active');
  const history = JSON.parse(
    await f.tx('finishAttempts', landingApi.attempts, {
      projectId: f.projectId,
      submissionId: state.id,
      cursor: null,
    }),
  );
  assert.equal(history.page[0].superseded, true);
  assert.equal(history.page[0].observation.state, 'terminal-failed');
  assert.equal(history.page[0].observation.cause, 'stale-head');
  assert.equal(history.page[0].progress.error.code, 'CHANNEL_CHANGED');
  assert.equal(history.page[1].observation.state, 'landed');
  assert(history.page[0].progress.timing.settledAt, 'replacement freezes its own settlement');
  assert.equal(history.page[0].progress.timing.committedAt, undefined);
  assert(history.page[1].progress.timing.composeStartedAt);
  assert(history.page[1].progress.timing.composedAt);
  assert(history.page[1].progress.timing.committedAt);
  assert(history.page[1].progress.timing.settledAt);
  assert.equal(history.page[0].progress.acceptance, null);
  assert.equal(
    history.page[1].progress.acceptance.receiptId,
    checked.submission.acceptance?.receiptId ?? (await f.current(state.id)).submission.acceptance.receiptId,
  );
  const oldInputs = JSON.parse(
    await f.tx('finishOldInputs', api.inputs, {
      projectId: f.projectId,
      submissionId: state.id,
      attemptId: initial.id,
      index: 0,
    }),
  );
  assert.equal(oldInputs.entries[0].state, 'superseded');
  assert.equal(oldInputs.entries[0].outcome, 'terminal-failed');
  assert.equal(oldInputs.entries[0].cause, 'stale-head');
  assert.equal(oldInputs.entries[0].error.code, 'CHANNEL_CHANGED');
  assert.equal(oldInputs.entries[0].acceptance, null);
});

test('overlapping main movement retains the new conflicted Candidate and H09 resolution root without accepting old passing evidence', async t => {
  const f = await finishFixture(t, { overlap: true }),
    { state } = await begin(f);
  const main = f.moveMain({ overlap: true });
  await complete(f);
  const result = await f.current(state.id),
    attempt = (await f.status(state.id)).attempt;
  assert.equal(result.submission.observation.cause, 'conflict');
  assert.equal(result.submission.phase, 'terminal-failed');
  const row = await f.tx(
    'finishConflictRead',
    {
      _handler: ctx =>
        records.readHostedRecord(ctx, { ...f.auth, kind: 'candidate', key: attempt.candidate.id }),
    },
    {},
  );
  assert.equal(JSON.parse(row.value).result.status, 'conflict');
  assert(JSON.parse(row.value).result.conflicts.sha256);
  assert.equal(f.currentMain().head, main.head);
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
  assert.equal(f.tables.projectHostedCheckRuns.size, 1);
});

test('a same-head new main receipt starts a distinct exact Candidate/check attempt', async t => {
  const f = await finishFixture(t),
    { state } = await begin(f);
  f.moveMain({ sameHead: true });
  await complete(f);
  await complete(f);
  assert.equal((await f.current(state.id)).submission.phase, 'landed');
  assert.equal(f.tables.projectHostedCheckRuns.size, 2);
  assert.equal(f.tables.projectHostedLandingAttempts.size, 2);
});

for (const crash of ['before-step', 'after-step', 'before-resume']) {
  test(`crash ${crash} during acceptance metadata resumes only the retained phase`, async t => {
    const f = await finishFixture(t),
      { state } = await begin(f);
    await f.passChecks();
    while (f.pending()[0]?.name !== 'projectHostedFinishDriver:drive') await f.execute();
    const task = f.pending()[0];
    if (crash === 'before-step') {
      await f.execute(task, crash);
      // A process died before acquiring a step: explicit startup/reconnect repair.
      f.patch('_scheduled_functions', task._id, { state: { kind: 'failed' } });
      await f.tx('finishRepair', api.resume, { projectId: f.projectId, submissionId: state.id });
    } else await assert.rejects(f.execute(task, crash), /synthetic crash/);
    await f.drain();
    assert.equal((await f.current(state.id)).submission.phase, 'landed');
    assert.equal(f.tables.projectHostedCheckRuns.size, 1);
    assert.equal(f.tables.projectHostedAcceptances.size, 1);
  });
}

test('crash after plan upload and after source publication does not create another source job, attempt or check', async t => {
  const f = await finishFixture(t),
    { state, request } = await begin(f);
  f.moveMain();
  await f.passChecks();
  // Stop when the named pending attempt has been reserved, before source IO.
  while (!(await f.current(state.id)).pendingAttempt) await f.execute();
  const pending = (await f.current(state.id)).pendingAttempt;
  await assert.rejects(f.execute(f.pending()[0], 'before-resume'), /synthetic crash/);
  await f.tx('finishRepair', api.resume, { projectId: f.projectId, submissionId: state.id });
  assert.equal((await f.current(state.id)).pendingAttempt.id, pending.id);
  await f.drain();
  assert.equal(f.metrics.sourceJobs, 1);
  assert.equal((await f.status(state.id)).attempt.id, pending.id);
  await complete(f);
  const accepted = await f.current(state.id),
    main = f.currentMain();
  assert.deepEqual(await f.enqueue(request), accepted.submission);
  assert.deepEqual(f.currentMain(), main);
  assert.equal(f.tables.projectHostedCheckRuns.size, 2);
  assert.equal(f.tables.projectHostedLandingAttempts.size, 2);
});

test('stacked dependency waits own no idle timer and resume on the parent receipt', async t => {
  const f = await finishFixture(t),
    parent = await begin(f);
  const childRequest = f.request({
    finish: { composeOperationId: f.selection.request.operationId, after: parent.state.id },
  });
  const child = await f.enqueue(childRequest);
  await f.drain();
  const waiting = (await f.current(child.id)).submission.observation;
  assert.equal(waiting.pendingReason, 'waiting-for-dependency');
  assert.equal(waiting.stall.step, 'dependency');
  assert.equal(waiting.stall.missingOwner, 'parent landing controller');
  assert.equal(f.pending().length, 0);
  await complete(f); // parent lands; child rebases its original selection onto parent
  await complete(f);
  assert.equal((await f.current(parent.state.id)).submission.phase, 'landed');
  assert.equal((await f.current(child.id)).submission.phase, 'landed');
  assert.equal(f.tables.projectHostedAcceptances.size, 2);
  assert.equal(f.pending().length, 0);
});

test('changed selection roots and old IO generations are refused without changing a newer attempt', async t => {
  const f = await finishFixture(t),
    { state } = await begin(f);
  await f.passChecks();
  while (f.pending()[0]?.name !== 'projectHostedFinishDriver:drive') await f.execute();
  const input = f.pending()[0].args[0];
  const command = JSON.parse(await f.tx('finishStep', driver.step, input));
  const original = f.c.objects.get(command.pin.sha256).toString();
  await assert.rejects(
    f.tx('finishResume', driver.resume, {
      ...input,
      command: JSON.stringify(command),
      page: JSON.stringify({ ...JSON.parse(original), entries: [] }),
    }),
    code('WORK_OPERATION_CHANGED'),
  );
  await f.tx('finishResume', driver.resume, { ...input, command: JSON.stringify(command), page: original });
  const before = (await f.current(state.id)).submission;
  await f.tx('finishResume', driver.resume, { ...input, command: JSON.stringify(command), page: original });
  assert.deepEqual((await f.current(state.id)).submission, before);
  await f.drain();
  assert.equal((await f.current(state.id)).submission.phase, 'landed');
});

test('repeated main contention yields bounded backoff and preserves all earlier attempts instead of spinning', async t => {
  const f = await finishFixture(t),
    { state } = await begin(f);
  for (let i = 0; i < 3; i++) {
    f.moveMain({ sameHead: true });
    await f.passChecks();
    while (!(await f.current(state.id)).pendingAttempt) await f.execute();
    const row = f.row(state.id),
      pending = (await f.current(state.id)).pendingAttempt;
    assert(row.wake.at - Date.now() >= hostedFinishBackoff(pending.number));
    assert.equal(pending.number, i + 1);
    await f.drain();
  }
  await complete(f);
  assert.equal((await f.current(state.id)).submission.phase, 'landed');
  assert.equal(f.tables.projectHostedCheckRuns.size, 4);
  assert.equal(f.metrics.sourceJobs, 3);
  assert.equal(hostedFinishBackoff(500), 30_000);
  t.diagnostic(JSON.stringify({ maxima, metrics: f.metrics, rss: process.memoryUsage().rss }));
});

test('concurrent lost enqueue replies keep one finish, submission and check; a different original composition is rejected', async t => {
  const f = await finishFixture(t),
    request = f.request();
  const [one, two] = await Promise.all([f.enqueue(request), f.enqueue(request)]);
  assert.equal(one.id, two.id);
  assert.equal(f.tables.projectHostedFinishes.size, 1);
  assert.equal(f.tables.projectHostedCheckRuns.size, 1);
  await assert.rejects(
    f.enqueue({ ...request, finish: { ...request.finish, composeOperationId: randomUUID() } }),
    code('WORK_OPERATION_CHANGED'),
  );
  await f.drain();
  await complete(f);
  assert.equal(f.tables.projectHostedAcceptances.size, 1);
});

test('an old passing run cannot supply evidence for a recomposed Candidate', async t => {
  const f = await finishFixture(t),
    { state } = await begin(f);
  const first = (await f.status(state.id)).attempt;
  f.moveMain();
  await complete(f);
  const child = (await f.status(state.id)).attempt;
  const row = [...f.tables.projectHostedLandingAttempts.values()].find(x => x.attemptId === child.id);
  f.patch('projectHostedLandingAttempts', row._id, {
    value: JSON.stringify({ ...child, check: first.check }),
  });
  await f.tx('finishRepair', api.resume, { projectId: f.projectId, submissionId: state.id });
  // Wake the original child request through its run; publication independently
  // validates Candidate/head/digest and refuses the substituted old evidence.
  await complete(f);
  const result = await f.current(state.id);
  assert.equal(result.submission.phase, 'terminal-failed');
  assert.equal(result.submission.error.code, 'EVIDENCE_CHANGED');
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
});

test('current project access precedes finish status and resume, including completed receipts', async t => {
  const f = await finishFixture(t),
    { state } = await begin(f);
  await complete(f);
  await assert.rejects(
    f.tx('finishDeniedRead', api.status, { projectId: f.projectId, submissionId: state.id }, 'stranger'),
    code('PROJECT_UNAVAILABLE'),
  );
  await assert.rejects(
    f.tx('finishDeniedResume', api.resume, { projectId: f.projectId, submissionId: state.id }, 'stranger'),
    code('PROJECT_UNAVAILABLE'),
  );
  assert.equal(f.pending().length, 0);
});

for (const retainedRead of ['none', 'reader', 'public']) {
  test(`revoked finish contributor with ${retainedRead} read access cannot repair a scheduler receipt`, async t => {
    const f = await finishFixture(t);
    f.patch('hostedProjects', f.projectId, { owner: 'project-owner' });
    const grant = f.insert('projectContributors', { projectId: f.projectId, contributor: 'owner' });
    const state = await f.enqueue(f.request());
    // The original actor remains authenticated, but its formerly valid write
    // grant is gone. Read access must not authorize explicit resume.
    f.tables.projectContributors.delete(grant);
    if (retainedRead === 'reader') f.insert('projectReaders', { projectId: f.projectId, reader: 'owner' });
    if (retainedRead === 'public') f.patch('hostedProjects', f.projectId, { visibility: 'public' });
    const wake = f.row(state.id).wake;
    f.patch('_scheduled_functions', wake.taskId, { state: { kind: 'failed' } });
    const scheduled = structuredClone(f.tables._scheduled_functions),
      finish = structuredClone(f.row(state.id));
    await assert.rejects(
      f.tx('finishRevokedResume', api.resume, { projectId: f.projectId, submissionId: state.id }),
      code('PROJECT_UNAVAILABLE'),
    );
    assert.deepEqual(f.tables._scheduled_functions, scheduled);
    assert.deepEqual(f.row(state.id), finish);
    const count = f.counts.filter(c => c.name === 'finishRevokedResume').at(-1);
    assert(count.ranges <= 8 && count.documents <= 8, 'constant-size current authority lookup');
    assert.equal(count.writes, 0);
  });
}

for (const removal of ['trash', 'deleting', 'deleted']) {
  test(`explicit finish resume refuses a project marked ${removal} before scheduling`, async t => {
    const f = await finishFixture(t),
      state = await f.enqueue(f.request());
    f.patch('hostedProjects', f.projectId, { removal });
    const scheduled = structuredClone(f.tables._scheduled_functions);
    await assert.rejects(
      f.tx('finishRemovedResume', api.resume, { projectId: f.projectId, submissionId: state.id }),
      code('PROJECT_UNAVAILABLE'),
    );
    assert.deepEqual(f.tables._scheduled_functions, scheduled);
    assert.equal(f.counts.filter(c => c.name === 'finishRemovedResume').at(-1).writes, 0);
  });
}

test('explicit pending resume refuses a stale epoch while completed receipt resume keeps historical epoch', async t => {
  const f = await finishFixture(t),
    { state } = await begin(f);
  f.patch('hostedProjects', f.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
  const scheduled = structuredClone(f.tables._scheduled_functions);
  await assert.rejects(
    f.tx('finishStaleResume', api.resume, { projectId: f.projectId, submissionId: state.id }),
    code('SOURCE_AUTHORITY_CHANGED'),
  );
  assert.deepEqual(f.tables._scheduled_functions, scheduled);
  assert.equal(f.metrics.sourceJobs, 0);
  assert.equal(f.tables.projectHostedCheckRuns.size, 1);
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
  f.patch('hostedProjects', f.projectId, { sourceAuthority: { mode: 'server', epoch: 1 } });
  await complete(f);
  const main = f.currentMain();
  f.patch('hostedProjects', f.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
  await f.tx('finishHistoricalResume', api.resume, { projectId: f.projectId, submissionId: state.id });
  assert.deepEqual(f.currentMain(), main);
  assert.equal(f.pending().length, 0);
  f.patch('hostedProjects', f.projectId, { owner: 'different-owner' });
  await assert.rejects(
    f.tx('finishHistoricalRevokedResume', api.resume, { projectId: f.projectId, submissionId: state.id }),
    code('PROJECT_UNAVAILABLE'),
  );
});

test('landing cancellation leaves its check and Lane intact and a delayed passing callback cannot revive finish', async t => {
  const f = await finishFixture(t),
    { state } = await begin(f),
    lane = await f.readLane(f.lane.laneId),
    main = f.currentMain(),
    run = (await f.status(state.id)).attempt.check.runId;
  const cancelled = JSON.parse(
    await f.tx('finishLandingCancel', landingApi.cancel, {
      projectId: f.projectId,
      request: JSON.stringify({ operationId: randomUUID(), submissionId: state.id, authorityEpoch: 1 }),
    }),
  );
  assert.equal(cancelled.error.code, 'LANDING_CANCELLED');
  assert.equal((await f.rawChecks.status(run)).status, 'queued');
  assert.deepEqual(await f.readLane(f.lane.laneId), lane);
  await complete(f);
  assert.equal((await f.current(state.id)).submission.error.code, 'LANDING_CANCELLED');
  assert.deepEqual(f.currentMain(), main);
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
  assert.equal(f.pending().length, 0);
});

test('cancellation during metadata IO fences its delayed resume and retains pending source selection', async t => {
  const f = await finishFixture(t),
    { state } = await begin(f);
  f.moveMain();
  await f.passChecks();
  while (!(await f.current(state.id)).pendingAttempt) await f.execute();
  const task = f.pending().find(task => task.name === 'projectHostedFinishDriver:drive');
  f.advanceClock(task.scheduledTime - Date.now());
  const command = JSON.parse(await f.tx('finishStep', driver.step, task.args[0]));
  assert.equal(command.kind, 'plan');
  const pending = (await f.current(state.id)).pendingAttempt;
  await f.tx('finishLandingCancel', landingApi.cancel, {
    projectId: f.projectId,
    request: JSON.stringify({ operationId: randomUUID(), submissionId: state.id, authorityEpoch: 1 }),
  });
  await f.tx('finishLateIO', driver.resume, {
    ...task.args[0],
    command: JSON.stringify(command),
    storageId: 'ignored-late-upload',
  });
  await f.drain();
  const current = await f.current(state.id);
  assert.equal(current.submission.error.code, 'LANDING_CANCELLED');
  assert.deepEqual(current.pendingAttempt, pending);
  assert.equal(f.metrics.sourceJobs, 0);
  assert.equal(f.tables.projectHostedCheckRuns.size, 1);
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
});

test('a source completion after landing cancellation cannot install a child attempt or check', async t => {
  const f = await finishFixture(t),
    { state } = await begin(f);
  f.moveMain();
  await f.passChecks();
  while (f.pending()[0]?.name !== 'projectModalSource:dispatch') await f.execute();
  await f.tx('finishLandingCancel', landingApi.cancel, {
    projectId: f.projectId,
    request: JSON.stringify({ operationId: randomUUID(), submissionId: state.id, authorityEpoch: 1 }),
  });
  const pending = (await f.current(state.id)).pendingAttempt;
  await f.drain();
  assert.equal((await f.current(state.id)).submission.error.code, 'LANDING_CANCELLED');
  assert.deepEqual((await f.current(state.id)).pendingAttempt, pending);
  assert.equal(f.tables.projectHostedLandingAttempts.size, 1);
  assert.equal(f.tables.projectHostedCheckRuns.size, 1);
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
  assert.equal(f.metrics.sourceJobs, 1);
  assert.equal(f.pending().length, 0);
});

test('a failed parent settles its dependent without an idle wake or acceptance', async t => {
  const f = await finishFixture(t),
    parent = await begin(f);
  const child = await f.enqueue(
    f.request({ finish: { composeOperationId: f.selection.request.operationId, after: parent.state.id } }),
  );
  await f.drain();
  const run = (await f.status(parent.state.id)).attempt.check.runId;
  const { checks } = await import('./hosted-checks-fixture.mjs');
  await f.tx('finishCancelParent', checks.cancel, {
    projectId: f.projectId,
    request: JSON.stringify({ operationId: randomUUID(), runId: run, authorityEpoch: 1 }),
  });
  await f.drain();
  assert.equal((await f.current(child.id)).submission.phase, 'terminal-failed');
  assert.equal((await f.current(child.id)).submission.error.code, 'DEPENDENCY_NOT_LANDED');
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
  assert.equal(f.pending().length, 0);
});

test('included-input status uses the native superseded state while retaining the actual landed outcome', async t => {
  const f = await finishFixture(t),
    { state } = await begin(f);
  await complete(f);
  await f.changeLane(f.lane.laneId, { head: 'a'.repeat(64), sourceVersion: 1 });
  const page = JSON.parse(
    await f.tx('finishInputs', api.inputs, {
      projectId: f.projectId,
      submissionId: state.id,
      attemptId: state.attemptId,
      index: 0,
    }),
  );
  assert.equal(page.entries[0].state, 'superseded');
  assert.equal(page.entries[0].outcome, 'landed');
  assert.equal(page.entries[0].head, f.lane.head);
  assert.equal(page.entries[0].complete, false);
  assert.equal(page.nextIndex, null);
});

for (const crash of ['before-source', 'after-source-callback', 'after-source-publish']) {
  test(`source crash ${crash} repairs the original named job and only its pending attempt`, async t => {
    const f = await finishFixture(t),
      { state } = await begin(f);
    f.moveMain();
    await f.passChecks();
    while (f.pending()[0]?.name !== 'projectModalSource:dispatch') await f.execute();
    const pending = (await f.current(state.id)).pendingAttempt;
    const sourceCount = f.tables.projectHostedComposes.size;
    await assert.rejects(f.execute(f.pending()[0], crash), /synthetic crash/);
    await f.tx('finishRepair', api.resume, { projectId: f.projectId, submissionId: state.id });
    await f.drain();
    assert.equal((await f.status(state.id)).attempt.id, pending.id);
    assert.equal(f.tables.projectHostedComposes.size, sourceCount);
    assert.equal(f.metrics.sourceJobs, 1);
    await complete(f);
    assert.equal((await f.current(state.id)).submission.phase, 'landed');
    assert.equal(f.tables.projectHostedCheckRuns.size, 2);
  });
}

test('lost final publication reply is reconciled through the actual receipt without another effect', async t => {
  const f = await finishFixture(t),
    { state, request } = await begin(f);
  await f.passChecks();
  while (true) {
    const plan = [...f.tables.projectHostedAcceptancePlans.values()][0];
    if (plan && plan.inputsNext === null && plan.dependenciesNext === null) break;
    await f.execute();
  }
  await assert.rejects(f.execute(f.pending()[0], 'after-step'), /synthetic crash/);
  assert.equal((await f.current(state.id)).submission.phase, 'landed');
  const main = f.currentMain();
  assert.equal((await f.enqueue(request)).acceptance.receiptId, main.receipt.id);
  await f.drain();
  assert.equal(f.tables.projectHostedAcceptances.size, 1);
  assert.deepEqual(f.currentMain(), main);
});

test('205 exact inputs and 10050 unrelated receipts keep final finish calls constant and metadata pages bounded', async t => {
  const f = await finishFixture(t, { inputCount: 205 });
  for (let i = 0; i < 10050; i++)
    f.insert('projectHostedAcceptances', {
      projectId: f.projectId,
      receiptId: randomUUID(),
      submissionId: randomUUID(),
      attemptId: randomUUID(),
      sequence: i + 10,
      value: '{}',
    });
  const started = performance.now(),
    { state } = await begin(f);
  await complete(f);
  const result = await f.current(state.id);
  assert.equal(result.submission.phase, 'landed');
  const plan = [...f.tables.projectHostedAcceptancePlans.values()].find(x => x.submissionId === state.id);
  assert.equal(plan.inputPages, 3);
  assert.equal(plan.lanes, 205);
  assert.equal(f.metrics.transfers, 4);
  const pages = [];
  let index = 0;
  while (index !== null) {
    const page = JSON.parse(
      await f.tx('finishInputPage', api.inputs, {
        projectId: f.projectId,
        submissionId: state.id,
        attemptId: state.attemptId,
        index,
      }),
    );
    pages.push(page.entries.length);
    index = page.nextIndex;
  }
  assert.deepEqual(pages, [100, 100, 5]);
  assert.equal(f.pending().length, 0);
  t.diagnostic(
    JSON.stringify({
      elapsedMs: performance.now() - started,
      rssBytes: process.memoryUsage().rss,
      maxRssBytes: process.resourceUsage().maxRSS * 1024,
      metrics: f.metrics,
      maxima,
    }),
  );
});

test('unchecked person finish stays available without adding a check obligation', async t => {
  const f = await finishFixture(t);
  const person = await begin(f, { agent: false, check: null });
  assert.equal((await f.current(person.state.id)).submission.phase, 'landed');
  assert.equal(f.tables.projectHostedCheckRuns.size, 0);
  assert.equal(f.pending().length, 0);
});

test('reviewed person finish requests keep independent selections for the same saved head', async t => {
  const f = await finishFixture(t);
  const first = await f.enqueue(f.request({ agent: false, check: null }));
  const secondRequest = f.request({ agent: false, check: null });
  const second = await f.enqueue(secondRequest);
  assert.notEqual(second.id, first.id);
  assert.notEqual(second.operationId, first.operationId);
  assert.equal(f.tables.projectHostedLandingRequests.size, 2);
  await f.drain();
  assert.equal((await f.current(first.id)).submission.phase, 'landed');
  assert.deepEqual((await f.current(second.id)).submission.request, secondRequest);
  assert.equal(f.tables.projectHostedCheckRuns.size, 0);
});

test('a prepared but uncommitted metadata binding reconciles to the verified plan without replacing the pending job', async t => {
  const f = await finishFixture(t),
    { state } = await begin(f);
  f.moveMain();
  await f.passChecks();
  while (!(await f.current(state.id)).pendingAttempt) await f.execute();
  const task = f.pending()[0];
  f.advanceClock(task.scheduledTime - Date.now());
  const raw = await f.tx('finishStep', driver.step, task.args[0]),
    command = JSON.parse(raw);
  assert.equal(command.kind, 'plan');
  const reserved = [...f.tables.projectObjects.values()].find(row => row.digest === command.pin.sha256);
  assert(reserved && reserved.location === 'r2' && !reserved.r2Committed);
  // Recover this same IO generation. The real action uploads its exact plan and
  // the completion transaction makes the prepared object readable atomically.
  await f.drain();
  await complete(f);
  assert.equal((await f.current(state.id)).submission.phase, 'landed');
  assert.equal(f.metrics.sourceJobs, 1);
});

test('a main-race recompose retains newly accepted peer contracts in its named child check', async t => {
  const f = await finishFixture(t);
  const ownPath = 'tests/own-contract.test.mjs',
    peerPath = 'tests/peer-contract.test.mjs';
  const makeContract = (candidateId, head, path) => ({
    version: 1,
    operationId: randomUUID(),
    request: 'a'.repeat(64),
    candidateId,
    measuredOn: head,
    runId: randomUUID(),
    at: '2026-01-01T00:00:00.000Z',
    proposedTests: [path],
    tests: [{ path, durationMs: 1 }],
    totalMs: 1,
  });
  await f.tx(
    'finishSemanticOwn',
    {
      _handler: async ctx => {
        const row = await records.readHostedRecord(ctx, { ...f.auth, kind: 'intent', key: f.c.intentId });
        const intent = JSON.parse(row.value);
        return records.writeHostedRecord(ctx, {
          ...f.auth,
          expectedVersion: intent.version,
          record: {
            ...intent,
            version: intent.version + 1,
            testContracts: [makeContract(f.candidate.id, f.candidate.result.head, ownPath)],
          },
        });
      },
    },
    {},
  );
  const { state } = await begin(f);
  const main = f.moveMain();
  const peerIntentId = randomUUID(),
    peerCandidateId = randomUUID();
  await f.tx(
    'finishSemanticPeer',
    {
      _handler: async ctx => {
        await records.writeHostedRecord(ctx, {
          ...f.auth,
          expectedVersion: null,
          record: {
            kind: 'intent',
            id: peerIntentId,
            version: 0,
            at: '2026-01-01T00:00:00.000Z',
            outcome: 'Accepted peer contract',
            constraints: '',
            creatorAccountId: 'owner',
            assigneeAccountIds: [],
            base: f.candidate.base,
            status: 'active',
            testContracts: [makeContract(peerCandidateId, main.head, peerPath)],
          },
        });
        await records.writeHostedRecord(ctx, {
          ...f.auth,
          expectedVersion: null,
          record: {
            ...f.candidate,
            id: peerCandidateId,
            intentId: peerIntentId,
            result: { status: 'clean', head: main.head },
          },
        });
        await ctx.db.insert('projectHostedAcceptances', {
          projectId: f.projectId,
          receiptId: main.receipt.id,
          submissionId: randomUUID(),
          attemptId: randomUUID(),
          sequence: 1,
          value: JSON.stringify({ candidate: { id: peerCandidateId } }),
        });
      },
    },
    {},
  );
  await complete(f);
  const runs = [...f.tables.projectHostedCheckRuns.values()].map(row => JSON.parse(row.value));
  assert.equal(runs.length, 2);
  const child = runs.find(run => run.request.candidateId !== f.candidate.id);
  assert.deepEqual(
    new Set(child.semanticPlan.members.map(member => member.intentId)),
    new Set([f.c.intentId, peerIntentId]),
  );
  assert.equal(
    child.semanticPlan.members.find(member => member.intentId === peerIntentId).acceptedSequence,
    1,
  );
  assert.equal((await f.current(state.id)).submission.observation.pendingReason, 'checking');
});

test('a ten-file finish publishes a small R2 plan with no Convex file write and no idle wake', async t => {
  const f = await finishFixture(t, { fileCount: 10 }),
    { state } = await begin(f);
  f.moveMain();
  await complete(f);
  await complete(f);
  assert.equal((await f.current(state.id)).submission.phase, 'landed');
  const plans = [...f.tables.projectObjects.values()].filter(
    row =>
      row.location === 'r2' &&
      row.r2Committed &&
      f.metrics.planUploads.some(plan => plan.digest === row.digest),
  );
  assert(plans.length >= 1);
  assert(plans.every(row => row.size < 128 * 1024 && !row.storageId));
  assert.equal(f.metrics.legacyPlanWrites.length, 0);
  assert.equal(f.pending().length, 0);
  assert(f.metrics.stepCalls.every(calls => calls.length <= 2));
  assert(f.metrics.stepCalls.reduce((sum, calls) => sum + calls.length, 0) <= 15);
  t.diagnostic(
    JSON.stringify({
      files: 10,
      planBytes: plans.reduce((sum, row) => sum + row.size, 0),
      uploadBytes: f.metrics.uploadBytes,
      downloadBytes: f.metrics.downloadBytes,
      driverCalls: f.metrics.stepCalls.reduce((sum, calls) => sum + calls.length, 0),
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
    }),
  );
});

test('Convex source recompose reaches the ordinary checked finish receipt without Modal configuration or idle source wakes', async t => {
  const f = await finishFixture(t, { fileCount: 10 });
  const keys = [
      'FORGE_SOURCE_PROVIDER',
      'FORGE_SOURCE_WORKER',
      'FORGE_SOURCE_RUNTIME',
      'FORGE_SOURCE_KEY_ID',
    ],
    old = Object.fromEntries(keys.map(k => [k, process.env[k]]));
  for (const key of keys) delete process.env[key];
  process.env.FORGE_SOURCE_PROVIDER = 'convex';
  try {
    const { state } = await begin(f);
    assert.equal((await f.current(state.id)).submission.observation.pendingReason, 'checking');
    f.moveMain();
    await complete(f);
    await complete(f);
    const landed = await f.current(state.id);
    assert.equal(landed.submission.phase, 'landed');
    assert.equal(f.tables.projectSourceSteps.size, 1);
    assert(f.metrics.convexSourceCalls.includes('projectConvexSource:step'));
    assert(f.metrics.convexSourceCalls.length <= 10);
    assert(f.metrics.convexStorageCalls <= 2);
    assert.equal(f.metrics.legacyPlanWrites.length, 0);
    assert.equal(f.pending().length, 0);
    t.diagnostic(
      JSON.stringify({
        convexSourceCalls: f.metrics.convexSourceCalls,
        convexStorageCalls: f.metrics.convexStorageCalls,
        driverControlCalls: f.metrics.stepCalls.reduce((sum, calls) => sum + calls.length, 0),
        legacyPlanBytes: f.metrics.legacyPlanWrites.reduce((sum, row) => sum + row.size, 0),
        r2PlanBytes: f.metrics.planUploads.reduce((sum, row) => sum + row.size, 0),
        pendingWakes: f.pending().length,
        sourceExecutions: f.tables.projectSourceSteps.size,
      }),
    );
  } finally {
    for (const [key, value] of Object.entries(old)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test('5,000-file / 512 MB finish recomposes after main advances and lands through one atomic acceptance', async t => {
  const f = await finishFixture(t, { selectedFileCount: 5000 });
  const previous = process.env.FORGE_SOURCE_PROVIDER;
  process.env.FORGE_SOURCE_PROVIDER = 'convex';
  try {
    const { state } = await begin(f);
    f.moveMain();
    await complete(f);
    await complete(f);
    const landed = await f.current(state.id);
    assert.equal(landed.submission.phase, 'landed');
    assert.equal(f.tables.projectSourceSteps.size, 1);
    assert.equal(f.pending().length, 0);
    t.diagnostic(
      JSON.stringify({
        files: 5000,
        logicalChangedBytes: 5000 * 100 * 1024,
        convexCalls: f.metrics.convexSourceCalls.length,
        storage: f.metrics.convexStorageCalls,
      }),
    );
  } finally {
    if (previous === undefined) delete process.env.FORGE_SOURCE_PROVIDER;
    else process.env.FORGE_SOURCE_PROVIDER = previous;
  }
});
