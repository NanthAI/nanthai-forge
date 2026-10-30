// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { landingFixture, api, control, store, wake, pins, maxima, code } from './hosted-landing-fixture.mjs';
import { canonicalPayload } from '../dist/hosted-source-operation.js';

test('indexed fan-out pages 205 waiting requests without scanning 10,050 terminal heads', async t => {
  const f = await landingFixture();
  const run = await f.rawChecks.enqueue(f.rawChecks.selection()),
    active = await f.rawChecks.activate(run.id);
  const saved = await f.enqueue(f.request({ check: { kind: 'run', runId: run.id } }));
  await f.drain();
  const original = [...f.tables.projectHostedLandingRequests.values()][0];
  const firstAttempt = (await f.status(saved.id)).attempt;
  const beforeAttempts = [];
  for (let i = 1; i < 205; i++) {
    const id = randomUUID(),
      attemptId = randomUUID(),
      operationId = randomUUID();
    const state = {
      ...JSON.parse(original.value),
      id,
      attemptId,
      firstAttemptId: attemptId,
      operationId,
      sequence: i + 1,
      request: { ...saved.request, operationId },
    };
    const attempt = { ...firstAttempt, id: attemptId, submissionId: id, operationId };
    f.insert('projectHostedLandingRequests', {
      ...original,
      _id: undefined,
      _creationTime: undefined,
      submissionId: id,
      operationId,
      attemptId,
      sequence: i + 1,
      value: canonicalPayload(state),
    });
    f.insert('projectHostedLandingAttempts', {
      projectId: f.projectId,
      submissionId: id,
      attemptId,
      number: 0,
      value: canonicalPayload(attempt),
    });
    beforeAttempts.push(canonicalPayload(attempt));
  }
  for (let i = 0; i < 10050; i++) {
    const id = randomUUID(),
      state = {
        ...saved,
        id,
        sequence: 1000 + i,
        phase: 'terminal-failed',
        observation: { state: 'terminal-failed', pendingReason: null, cause: 'conflict' },
        error: { code: 'COMPOSITION_CONFLICT', message: 'retained synthetic conflict' },
      };
    f.insert('projectHostedLandingRequests', {
      ...original,
      _id: undefined,
      _creationTime: undefined,
      submissionId: id,
      sequence: 1000 + i,
      phase: 'terminal-failed',
      value: canonicalPayload(state),
    });
  }
  const started = performance.now();
  await f.rawChecks.pass(active);
  assert.equal(f.pendingTasks().filter(t => t.name.endsWith(':checkWake')).length, 1);
  const pageSizes = [];
  for (;;) {
    const task = f.pendingTasks().find(t => t.name.endsWith(':checkWake'));
    if (!task) break;
    const before = [...f.tables.projectHostedLandingRequests.values()].filter(r => r.runnable).length;
    await f.execute(task);
    pageSizes.push(
      [...f.tables.projectHostedLandingRequests.values()].filter(r => r.runnable).length - before,
    );
  }
  assert.equal(
    pageSizes.reduce((a, b) => a + b, 0),
    205,
  );
  assert(pageSizes.length >= 3 && pageSizes.every(n => n > 0 && n <= 100));
  assert.equal(f.pendingTasks().filter(t => t.name.endsWith(':drive')).length, 1);
  const result = await f.execute();
  assert.equal(result.id, saved.id);
  assert.equal(result.phase, 'ready');
  assert.deepEqual(
    [...f.tables.projectHostedLandingAttempts.values()].slice(1).map(r => r.value),
    beforeAttempts,
  );
  assert.equal(f.tables.projectHostedCheckRuns.size, 1);
  assert.equal(f.tables.projectHostedLandingRequests.size, 10255);
  await f.status(saved.id);
  const page = JSON.parse(
    await f.call('landingListPage', api.list, {
      projectId: f.projectId,
      channel: 'main',
      phase: 'terminal-failed',
      cursor: null,
    }),
  );
  assert.equal(page.isDone, false);
  assert(page.page.length > 0 && page.page.every(s => s.phase === 'terminal-failed'));
  t.diagnostic(
    JSON.stringify({
      maxima,
      pageSizes,
      retainedRequests: f.tables.projectHostedLandingRequests.size,
      runIdentities: f.tables.projectHostedCheckRuns.size,
      metadataCalls: f.metrics.calls,
      metadataArgumentBytes: f.metrics.metadataArgumentBytes,
      actionTicks: f.metrics.actionTicks,
      elapsedMs: performance.now() - started,
      sampledRssBytes: process.memoryUsage().rss,
      maxRssBytes: process.resourceUsage().maxRSS * 1024,
    }),
  );
});

test('immutable attempt history pages completely and status never hydrates that history', async () => {
  const f = await landingFixture(),
    saved = await f.enqueue(),
    a = (await f.status(saved.id)).attempt;
  let parent = a.id;
  for (let i = 1; i < 205; i++) {
    const id = randomUUID(),
      attempt = { ...a, id, number: i, parentAttemptId: parent };
    f.insert('projectHostedLandingAttempts', {
      projectId: f.projectId,
      submissionId: saved.id,
      attemptId: id,
      number: i,
      value: canonicalPayload(attempt),
    });
    parent = id;
  }
  let cursor = null,
    total = 0;
  for (;;) {
    const page = JSON.parse(
      await f.call('landingAttemptsPage', api.attempts, {
        projectId: f.projectId,
        submissionId: saved.id,
        cursor,
      }),
    );
    assert(page.page.length <= 100);
    total += page.page.length;
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
  assert.equal(total, 205);
  assert.equal((await f.status(saved.id)).attempt.id, a.id);
  const reads = f.counts.filter(c => c.name === 'landingStatus').at(-1);
  assert.equal(
    reads.documents,
    6,
    'selected request/attempt plus the three active queue ranges for position; no attempt history',
  );
});

test('H14 can append a named child under the fence while original request/attempt/check pins remain immutable', async () => {
  const f = await landingFixture(),
    request = f.request(),
    saved = await f.enqueue(request);
  await f.drain();
  const original = (await f.status(saved.id)).attempt;
  const main = { ...f.main, receipt: { ...f.main.receipt, id: 'new-main-receipt' } };
  f.patch('projectHostedChannels', f.mainId, { selection: canonicalPayload(main) });
  const expectation = { head: main.head, receiptId: main.receipt.id };
  const candidate = await f.candidate({ base: expectation });
  const childRun = await f.rawChecks.enqueue(f.rawChecks.selection({ candidateId: candidate.id }));
  const current = await f.run(
    'landingChildAttempt',
    async ctx => {
      const claim = await control.claimReadyLanding(
        ctx,
        {
          projectId: f.projectId,
          channel: 'main',
          submissionId: saved.id,
          attemptId: original.id,
          owner: randomUUID(),
        },
        f.now(),
      );
      const held = await control.requireLandingLease(ctx, claim, f.now());
      const attempt = await pins.pinLandingAttempt(ctx, {
        projectId: f.projectId,
        actor: original.actor,
        request: {
          ...request,
          expectedMain: expectation,
          candidateId: candidate.id,
          check: { kind: 'run', runId: childRun.id },
        },
        submissionId: saved.id,
        attemptId: randomUUID(),
        parentAttemptId: original.id,
        number: 1,
        at: new Date().toISOString(),
        operations: { check: randomUUID(), accept: randomUUID() },
      });
      await store.insertLandingAttempt(ctx, attempt);
      await store.writeLanding(
        ctx,
        held.row,
        { ...held.state, attemptId: attempt.id, phase: 'queued', version: held.state.version + 1 },
        true,
      );
      await wake.releaseLandingQueue(ctx, held.queue, f.now());
      return attempt;
    },
    {},
  );
  assert.equal(current.parentAttemptId, original.id);
  assert.equal(current.operationId, original.operationId);
  assert.equal(current.main.receiptId, 'new-main-receipt');
  assert.notEqual(current.id, original.id);
  assert.deepEqual(
    await f.run('landingOriginalAttempt', store.loadLandingAttempt, {
      projectId: f.projectId,
      attemptId: original.id,
    }),
    original,
  );
  await f.drain();
  assert.equal((await f.status(saved.id)).request.phase, 'checking');
  assert.equal([...f.tables.projectHostedLandingRequests.values()][0].runId, childRun.id);
  await f.rawChecks.pass(await f.rawChecks.activate(childRun.id));
  await f.drain();
  const result = await f.status(saved.id);
  assert.equal(result.request.phase, 'ready');
  assert.equal(result.attempt.id, current.id);
  assert.deepEqual(result.request.request, request);
  assert.equal((await f.enqueue(request)).attemptId, current.id);
  await assert.rejects(
    f.run('landingBadParent', store.insertLandingAttempt, {
      ...current,
      id: randomUUID(),
      number: 2,
      parentAttemptId: original.id,
    }),
    code('WORK_OPERATION_CHANGED'),
  );
});

test('stale check definitions remain historical and cannot make a queued request ready', async () => {
  const f = await landingFixture(),
    r = await f.rawChecks.enqueue(f.rawChecks.selection());
  const active = await f.rawChecks.activate(r.id);
  const s = await f.enqueue(f.request({ check: { kind: 'run', runId: r.id } }));
  await f.drain();
  await f.rawChecks.pass(active);
  await f.rawChecks.configure(
    {
      kind: 'definition',
      checkId: f.checkId,
      command: {
        name: 'verify',
        executable: 'node',
        args: ['new-definition.mjs'],
        environmentLabel: 'clean',
      },
    },
    f.definition.digest,
  );
  await f.drain();
  const result = await f.status(s.id);
  assert.equal(result.request.phase, 'terminal-failed');
  assert.equal(result.request.error.code, 'EVIDENCE_CHANGED');
  assert.equal(result.attempt.check.runId, r.id);
  assert.equal((await f.rawChecks.status(r.id)).status, 'passed');
});

test('a person request cannot be silently reinterpreted as a child Candidate', async () => {
  const f = await landingFixture(),
    request = f.request({ agent: false }),
    s = await f.enqueue(request);
  const a = (await f.status(s.id)).attempt;
  await assert.rejects(
    f.run('landingPersonChild', pins.pinLandingAttempt, {
      projectId: f.projectId,
      actor: a.actor,
      request,
      submissionId: s.id,
      attemptId: randomUUID(),
      parentAttemptId: a.id,
      number: 1,
      at: new Date().toISOString(),
      operations: { check: randomUUID(), accept: randomUUID() },
    }),
    code('VIEW_STALE'),
  );
  assert.equal(f.tables.projectHostedLandingAttempts.size, 1);
});

test('H08 worker Candidate and complete H10 evidence reach H13 ready without moving main', async () => {
  const { composeFixture } = await import('./hosted-compose-fixture.mjs');
  const source = await composeFixture(),
    selection = source.selection([await source.lane(source.baseline)]);
  await source.prepare(selection);
  await source.stage(selection);
  await source.submit(selection);
  const candidate = (await source.publish(await source.work(selection))).outcome.result;
  const f = await landingFixture({
    store: source,
    projectId: source.projectId,
    candidate,
    state: { sha256: candidate.result.head, size: source.objects.get(candidate.result.head).length },
  });
  const before = f.tables.projectHostedChannels.get(f.mainId).selection;
  const run = await f.rawChecks.enqueue(f.rawChecks.selection());
  const saved = await f.enqueue(f.request({ check: { kind: 'run', runId: run.id } }));
  await f.drain();
  await f.rawChecks.pass(await f.rawChecks.activate(run.id, 1));
  await f.drain();
  const result = await f.status(saved.id);
  assert.equal(result.request.phase, 'ready');
  assert.equal(result.attempt.candidate.id, candidate.id);
  assert.deepEqual(result.attempt.candidate.inputs, candidate.inputs);
  assert.equal(result.attempt.check.runId, run.id);
  assert.equal(f.tables.projectHostedChannels.get(f.mainId).selection, before);
});
