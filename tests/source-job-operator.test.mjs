// SPDX-License-Identifier: Apache-2.0
// Issue 11fd39de: the reviewed operator path that settles a NAMED stale source job.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { finishFixture } from './hosted-finish-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const jobs = await import(moduleUrl('../convex/projectSourceJobs.ts'));
const operator = await import(moduleUrl('../convex/projectSourceJobOperator.ts'));

const reason = 'stale since cutover; continuation cannot resume (SOURCE_REF_UNOWNED)';
async function fixture(t) {
  for (const [key, value] of Object.entries({
    FORGE_HOSTED_CHECK_KEY_ID: 'SYNTHETIC',
    FORGE_SOURCE_PROVIDER: 'convex',
    R2_ACCOUNT_ID: 'synthetic',
    R2_BUCKET: 'synthetic',
    R2_ACCESS_KEY_ID: 'synthetic',
    R2_SECRET_ACCESS_KEY: 'synthetic',
  })) {
    const prior = process.env[key];
    process.env[key] = value;
    t.after(() => (prior === undefined ? delete process.env[key] : (process.env[key] = prior)));
  }
  const middle = 'unchanged '.repeat(14000) + '\n';
  const files = text =>
    Array.from({ length: 120 }, (_, i) => [`file-${String(i).padStart(4, '0')}.txt`, text]);
  const f = await finishFixture(t, {
    baselineFiles: files('start\n' + middle + 'end\n'),
    selectedFiles: files('ours\n' + middle + 'end\n'),
    mainFiles: files('start\n' + middle + 'theirs\n'),
  });
  const state = await f.enqueue(f.request());
  await f.drain();
  f.moveMain();
  await f.passChecks();
  for (let i = 0; !f.pending().some(x => x.name === 'projectConvexSourceTask:run'); i++) {
    assert(i < 30);
    await f.execute();
  }
  const step = [...f.tables.projectSourceSteps.values()][0];
  const load = () =>
    f.tx('operatorReadJob', { _handler: ctx => jobs.loadSourceJob(ctx, f.projectId, step.jobId) }, {});
  const stepRow = () => f.tables.projectSourceSteps.get(step._id);
  const args = (jobIds = [step.jobId], actor = 'owner') => ({
    projectId: f.projectId,
    actor,
    jobIds,
    reason,
  });
  return { f, state, step, load, stepRow, args };
}
/** The dev cutover shape: the worker died, nothing is scheduled or queued, a day passed. */
function strand(f, step) {
  for (const task of f.pending()) f.patch('_scheduled_functions', task._id, { state: { kind: 'canceled' } });
  if (step.batchId) f.patch('projectSourceBatches', step.batchId, { status: 'done' });
  f.advanceClock(2 * operator.STALE_SOURCE_JOB_MS);
}

test('a live source job is refused and nothing is written', async t => {
  const { f, step, load, stepRow, args } = await fixture(t);
  const before = await load(),
    cursor = stepRow().cursor;
  assert.equal(before.status, 'running');
  assert.deepEqual(await f.tx('plan', operator.plan, args()), [
    { jobId: step.jobId, action: null, code: 'SOURCE_JOB_NOT_STALE' },
  ]);
  f.advanceClock(2 * operator.STALE_SOURCE_JOB_MS);
  // The lease is long gone, but its fan-out tasks are still scheduled: active, not stale.
  assert.deepEqual(await f.tx('apply', operator.apply, { ...args(), operationId: randomUUID() }), [
    { jobId: step.jobId, action: null, code: 'SOURCE_JOB_ACTIVE' },
  ]);
  assert.equal((await load()).version, before.version);
  assert.equal(stepRow().cursor, cursor);
  // Only the project owner may name jobs; arguments are bounded.
  await assert.rejects(f.tx('plan', operator.plan, args([step.jobId], 'someone-else'), 'someone-else'));
  await assert.rejects(f.tx('plan', operator.plan, { ...args(), reason: ' ' }), { code: 'BAD_ARGUMENT' });
  await assert.rejects(f.tx('plan', operator.plan, args([step.jobId, step.jobId])), { code: 'BAD_ARGUMENT' });
  await assert.rejects(f.tx('apply', operator.apply, { ...args(), operationId: 'nope' }), {
    code: 'BAD_ARGUMENT',
  });
});

test('a named stale job fails with the reason, drops its dead cursor and settles its parent; a replay is a no-op', async t => {
  const { f, state, step, load, stepRow, args } = await fixture(t);
  strand(f, step);
  const unknown = randomUUID(),
    before = await load();
  assert.notEqual(stepRow().cursor, null);
  assert.deepEqual(await f.tx('plan', operator.plan, args([step.jobId, unknown])), [
    { jobId: step.jobId, action: 'fail', code: null },
    { jobId: unknown, action: null, code: 'SOURCE_JOB_UNAVAILABLE' },
  ]);
  assert.equal((await load()).version, before.version, 'plan writes nothing');
  const operationId = randomUUID();
  assert.deepEqual(await f.tx('apply', operator.apply, { ...args([step.jobId, unknown]), operationId }), [
    { jobId: step.jobId, action: 'fail', code: null },
    { jobId: unknown, action: null, code: 'SOURCE_JOB_UNAVAILABLE' },
  ]);
  const failed = await load();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.control.failureCode, 'SOURCE_JOB_STALE');
  assert.equal(failed.control.failureReason, reason);
  for (const key of ['id', 'executionId', 'attempt', 'fence', 'inputDigest', 'operationId'])
    assert.equal(failed[key], before[key], `${key} is retained`);
  assert.equal(stepRow().cursor, null);
  const settle = f.pending().filter(x => x.name === 'projectHostedComposeJobs:complete');
  assert.equal(settle.length, 1);
  // Retry with the same operation: everything is already done, nothing is rescheduled.
  assert.deepEqual(await f.tx('apply', operator.apply, { ...args(), operationId }), [
    { jobId: step.jobId, action: 'done', code: null },
  ]);
  assert.equal((await load()).version, failed.version);
  assert.equal(f.pending().filter(x => x.name === 'projectHostedComposeJobs:complete').length, 1);
  for (let i = 0; f.pending().length; i++) {
    assert(i < 30);
    await f.execute();
  }
  const settled = (await f.current(state.id)).submission;
  assert.equal(settled.phase, 'terminal-failed');
  assert.equal(settled.error.code, 'SOURCE_JOB_STALE');
  assert.equal(settled.error.message, reason);
});

test('an already failed job keeps its outcome and only loses its dead cursor', async t => {
  const { f, step, load, stepRow, args } = await fixture(t);
  strand(f, step);
  await f.tx('apply', operator.apply, { ...args(), operationId: randomUUID() });
  const failed = await load();
  // Simulate the dev shape of a job that failed earlier but kept its cursor.
  f.patch('projectSourceSteps', step._id, { cursor: 'r2source:' + 'a'.repeat(64) + ':10' });
  const other = { ...args(), reason: 'a different reason' };
  assert.deepEqual(await f.tx('plan', operator.plan, other), [
    { jobId: step.jobId, action: 'clear', code: null },
  ]);
  assert.deepEqual(await f.tx('apply', operator.apply, { ...other, operationId: randomUUID() }), [
    { jobId: step.jobId, action: 'clear', code: null },
  ]);
  assert.equal(stepRow().cursor, null);
  const after = await load();
  assert.equal(after.version, failed.version);
  assert.equal(after.control.failureReason, reason, 'the first reason stays');
});
