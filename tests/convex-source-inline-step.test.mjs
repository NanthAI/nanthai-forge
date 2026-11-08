// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { scaleFixture, saveInput } from './convex-source-scale-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const store = await import(moduleUrl('../convex/projectConvexSourceStore.ts'));

// projectSourceRun:submit (1eef1b43): the submit dispatches in its own transaction and the submitting
// action runs step 0 itself, so neither the dispatch hop nor the step hop waits for the scheduler.
// A delayed fallback step covers an action that dies; a failed inline step retries on schedule.

/** Enqueue a source job and dispatch it as the submit-run action does, without the scheduled hop. */
async function inlineJob(s, files = 3) {
  const input = await saveInput(s, files),
    jobId = await s.enqueue(input);
  // enqueue schedules a dispatch hop; the submit-run path dispatches inside the submit instead.
  const hop = s.ready.pop();
  assert.equal(hop.name, 'projectConvexSource:dispatch');
  s.scheduled.delete(hop.id);
  const dispatched = await s.run('inline-dispatch', () =>
    store.dispatchConvexSource(s.ctx, { projectId: s.projectId, jobId }, true),
  );
  return { jobId, dispatched };
}
const active = await import(moduleUrl('../convex/projectConvexSourceActive.ts'));
const row = (s, jobId) => s.run('row', () => active.rowFor(s.ctx, s.projectId, jobId));
const inlineStep = (s, jobId) => ({
  id: 'inline',
  name: 'projectConvexSource:step',
  args: { projectId: s.projectId, jobId, step: 0, inline: true },
  state: { kind: 'pending' },
});
async function scheduledOutput(files = 3) {
  const s = await scaleFixture();
  try {
    const id = await s.enqueue(await saveInput(s, files));
    await s.drain();
    return (await s.job(id)).output;
  } finally {
    s.restore();
  }
}

test('an inline first step skips both scheduler hops, cancels its fallback and gives the same output', async () => {
  const expected = await scheduledOutput();
  const s = await scaleFixture();
  try {
    const { jobId, dispatched } = await inlineJob(s);
    assert.equal(dispatched.inline, true);
    const fallback = [...s.scheduled.values()].find(item => item.name === 'projectConvexSource:step');
    assert.equal(fallback.delayMs, store.inlineFallbackMs);
    assert.equal((await row(s, jobId)).inlineFallback, true);
    await s.execute(inlineStep(s, jobId));
    assert.equal(fallback.state.kind, 'canceled');
    assert.equal((await row(s, jobId)).inlineFallback, undefined);
    const before = s.calls.length;
    await s.drain();
    const job = await s.job(jobId);
    assert.equal(job.status, 'completed');
    assert.deepEqual(job.output, expected);
    // Only the publication that follows the commit remains: no dispatch, no second step.
    const later = s.calls.slice(before);
    assert(!later.includes('projectConvexSource:dispatch'), later.join());
    assert(!later.includes('projectConvexSource:step'), later.join());
  } finally {
    s.restore();
  }
});

test('a submit-run action that dies before its step is recovered by the delayed fallback', async () => {
  const expected = await scheduledOutput();
  const s = await scaleFixture();
  try {
    const { jobId } = await inlineJob(s);
    await s.drain();
    const job = await s.job(jobId);
    assert.equal(job.status, 'completed');
    assert.deepEqual(job.output, expected);
    // Inside the submit's lease the fallback cannot tell a dead action from a slow one: it re-arms
    // once to the lease end (R1), then runs the step. Only this crash path pays that extra hop.
    assert.equal(s.calls.filter(name => name === 'projectConvexSource:step').length, 2);
    assert.equal(commits(s), 1);
  } finally {
    s.restore();
  }
});

test('a failed inline step retries on the normal schedule, not at the fallback delay', async () => {
  const expected = await scheduledOutput();
  const s = await scaleFixture();
  try {
    const { jobId } = await inlineJob(s);
    const fallback = [...s.scheduled.values()].find(item => item.name === 'projectConvexSource:step');
    s.failRequestOnce.push(message => message.kind === 'fetch');
    await assert.rejects(s.execute(inlineStep(s, jobId)));
    assert.equal(fallback.state.kind, 'canceled');
    const retry = [...s.scheduled.values()].filter(
      item => item.name === 'projectConvexSource:step' && item.state.kind === 'pending',
    );
    assert.equal(retry.length, 1);
    assert.equal(retry[0].args.generation, 1);
    assert(retry[0].delayMs < store.inlineFallbackMs, String(retry[0].delayMs));
    assert.equal((await row(s, jobId)).failedAttempts, 1);
    await s.drain();
    const job = await s.job(jobId);
    assert.equal(job.status, 'completed');
    assert.deepEqual(job.output, expected);
  } finally {
    s.restore();
  }
});

const pendingSteps = s =>
  [...s.scheduled.values()].filter(
    item => item.name === 'projectConvexSource:step' && item.state.kind === 'pending',
  );
const commits = s => s.calls.filter(name => name === 'projectConvexSourceStore:commit').length;

test('a fallback that fires while the inline step may still run re-arms once instead of running the step twice (review 0f10873e R1)', async () => {
  const expected = await scheduledOutput();
  const s = await scaleFixture();
  try {
    const { jobId } = await inlineJob(s);
    const [fallback] = pendingSteps(s);
    s.ready.splice(s.ready.indexOf(fallback), 1);
    // The fallback fires first (the inline step outran its 30 s delay): it must not run the step.
    await s.execute(fallback);
    assert.equal(commits(s), 0, 'the fallback ran no step');
    const [rearmed] = pendingSteps(s);
    assert(rearmed && rearmed !== fallback, 'one re-armed fallback');
    const lease = (await s.job(jobId)).control.workerLeaseMs;
    assert(rearmed.delayMs > 0 && rearmed.delayMs <= lease, String(rearmed.delayMs));
    assert.equal((await row(s, jobId)).inlineRearmed, true);
    // The inline step finishes; its commit cancels the re-armed fallback.
    s.ready.splice(s.ready.indexOf(rearmed), 1);
    await s.execute(inlineStep(s, jobId));
    assert.equal(rearmed.state.kind, 'canceled');
    await s.drain();
    const job = await s.job(jobId);
    assert.equal(job.status, 'completed');
    assert.deepEqual(job.output, expected);
    assert.equal(commits(s), 1, 'the step ran once');
  } finally {
    s.restore();
  }
});

test('a fallback that runs the step after the inline lease renews the worker lease first, so its commit lands (review 0f10873e R2)', async t => {
  const expected = await scheduledOutput();
  const s = await scaleFixture();
  try {
    const { jobId } = await inlineJob(s);
    const before = await s.job(jobId),
      lease = before.control.workerLeaseMs,
      real = Date.now.bind(Date),
      skew = lease + 1_000;
    // The submitting action died; the fallback starts after the lease that submit opened.
    t.mock.method(Date, 'now', () => real() + skew);
    assert(before.control.workerUntil <= Date.now(), 'the submit lease has passed');
    await s.drain();
    const job = await s.job(jobId);
    assert.equal(job.status, 'completed', 'no stranded job waiting for a CLI replay');
    assert.deepEqual(job.output, expected);
    assert.equal(commits(s), 1);
  } finally {
    s.restore();
  }
});
