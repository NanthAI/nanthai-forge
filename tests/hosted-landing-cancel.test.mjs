// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { landingFixture, api, code, maxima, store } from './hosted-landing-fixture.mjs';
import { acceptanceFixture } from './hosted-acceptance-fixture.mjs';

async function cancel(f, submissionId, operationId = randomUUID(), actor = 'owner', authorityEpoch = 1) {
  try {
    return JSON.parse(
      await f.call(
        'landingCancel',
        api.cancel,
        {
          projectId: f.projectId,
          request: JSON.stringify({ submissionId, operationId, authorityEpoch }),
        },
        actor,
      ),
    );
  } finally {
    for (const c of f.counts.filter(c => c.name === 'landingCancel')) {
      assert(c.ranges <= 40 && c.documents <= 40, 'constant-size cancellation');
      assert(!c.touched.some(t => /Pages|Shards|WorkRecords|Backups/.test(t)), 'no history or source fan-in');
    }
  }
}
const operation = (f, id) =>
  [...f.tables.projectHostedOperations.values()]
    .map(row => JSON.parse(row.value))
    .find(op => op.operationId === id);

test('queued cancellation keeps original pins, settles both operations and repairs same-op lost replies', async () => {
  const f = await landingFixture(),
    request = f.request(),
    state = await f.enqueue(request),
    attempt = (await f.status(state.id)).attempt,
    operationId = randomUUID(),
    main = f.tables.projectHostedChannels.get(f.mainId).selection;
  const result = await cancel(f, state.id, operationId);
  assert.equal(result.phase, 'terminal-failed');
  assert.equal(result.error.code, 'LANDING_CANCELLED');
  assert.equal(result.observation.cause, 'rejected');
  assert.deepEqual(result.request, request);
  assert.deepEqual((await f.status(state.id)).attempt, attempt);
  assert.equal(operation(f, request.operationId).terminal.outcome.error.code, 'LANDING_CANCELLED');
  assert.deepEqual(operation(f, operationId).terminal.outcome.result, result);
  const metric = [...f.tables.projectHostedOperations.values()].find(
    row => row.operationId === operationId,
  ).metricMutation;
  assert.deepEqual(metric, {
    action: 'cancel',
    actor: 'owner',
    operationId,
    at: operation(f, operationId).terminal.at,
  });
  assert.deepEqual(await cancel(f, state.id, operationId), result);
  assert.deepEqual(
    [...f.tables.projectHostedOperations.values()].find(row => row.operationId === operationId)
      .metricMutation,
    metric,
  );
  assert.deepEqual(await cancel(f, state.id), result);
  await assert.rejects(cancel(f, randomUUID(), operationId), code('WORK_OPERATION_CHANGED'));
  assert.deepEqual(await f.enqueue(request), result);
  await f.drain();
  assert.equal(f.pendingTasks().length, 0);
  assert.equal(f.queue().lease, null);
  assert.equal(f.tables.projectHostedChannels.get(f.mainId).selection, main);
});

test('cancelling one queued request preserves a competing driver lease and later queue work', async () => {
  const f = await landingFixture(),
    first = await f.enqueue(),
    second = await f.enqueue(),
    third = await f.enqueue(),
    claim = await f.execute(f.nextTask(), true),
    lease = f.queue().lease;
  assert.equal(claim.submissionId, first.id);
  await cancel(f, second.id);
  assert.deepEqual(f.queue().lease, lease);
  await f.advance(claim);
  await f.drain();
  assert.equal((await f.status(first.id)).request.phase, 'ready');
  assert.equal((await f.status(second.id)).request.error.code, 'LANDING_CANCELLED');
  assert.equal((await f.status(third.id)).request.phase, 'ready');
});

test('cancellation fences a claimed landing driver and does not hold up the next request', async () => {
  const f = await landingFixture(),
    first = await f.enqueue(),
    second = await f.enqueue(),
    claim = await f.execute(f.nextTask(), true);
  const cancelled = await cancel(f, first.id);
  assert.deepEqual(await f.advance(claim), cancelled);
  await f.drain();
  assert.equal((await f.status(second.id)).request.phase, 'ready');
  assert.equal((await f.status(first.id)).request.error.code, 'LANDING_CANCELLED');
});

test('cancellation before final publication invalidates the retained acceptance claim', async () => {
  const f = await acceptanceFixture(),
    { state } = await f.ready(),
    main = f.currentMain(),
    claim = await f.claimAcceptance(state);
  await cancel(f, state.id);
  await assert.rejects(f.commit(claim), code('WORK_STALE'));
  assert.deepEqual(f.currentMain(), main);
  assert.equal(f.tables.projectHostedAcceptances.size, 0);
});

test('acceptance first returns its actual receipt; cancellation and retry never undo later main', async () => {
  const f = await acceptanceFixture(),
    { state } = await f.ready(),
    accepted = await f.accept(state),
    operationId = randomUUID();
  const result = await cancel(f, state.id, operationId);
  assert.equal(result.phase, 'landed');
  assert.equal(result.acceptance.receiptId, accepted.receipt.id);
  assert.equal(result.acceptance.head, accepted.receipt.candidate.head);
  const main = f.currentMain();
  f.patch('projectHostedChannels', f.mainId, {
    selection: JSON.stringify({ ...main, receipt: { ...main.receipt, id: randomUUID() } }),
  });
  f.patch('hostedProjects', f.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
  const later = f.currentMain();
  assert.deepEqual(await cancel(f, state.id, operationId), result);
  assert.deepEqual(f.currentMain(), later);
  assert.equal(f.tables.projectHostedAcceptances.size, 1);
  assert.equal(operation(f, state.operationId).terminal.outcome.status, 'completed');
});

for (const first of ['cancel', 'accept']) {
  test(`concurrent final CAS with ${first} started first resolves one winner by receipt`, async () => {
    const f = await acceptanceFixture(),
      { state } = await f.ready(),
      claim = await f.claimAcceptance(state),
      original = f.currentMain();
    const actions = {
      cancel: () => cancel(f, state.id),
      accept: () => f.commit(claim),
    };
    const results = await Promise.allSettled([
      actions[first](),
      actions[first === 'cancel' ? 'accept' : 'cancel'](),
    ]);
    const current = (await f.status(state.id)).request;
    if (current.phase === 'landed') {
      assert.equal(f.tables.projectHostedAcceptances.size, 1);
      assert.equal(current.acceptance.receiptId, f.currentMain().receipt.id);
      assert.equal(results.filter(r => r.status === 'fulfilled').length, 2);
      assert.equal((await cancel(f, state.id)).acceptance.receiptId, current.acceptance.receiptId);
    } else {
      assert.equal(current.error.code, 'LANDING_CANCELLED');
      assert.equal(f.tables.projectHostedAcceptances.size, 0);
      assert.deepEqual(f.currentMain(), original);
      const failed = results.find(r => r.status === 'rejected');
      assert(failed);
      assert(code('WORK_STALE')(failed.reason));
    }
    assert(
      f.counts.some(c => c.retries > 0),
      'the fake exercised an OCC retry',
    );
  });
}

test('current contributor authority precedes cancellation replay and rejects readers', async () => {
  const f = await landingFixture(),
    state = await f.enqueue(),
    operationId = randomUUID(),
    grant = f.insert('projectContributors', { projectId: f.projectId, contributor: 'contributor' });
  f.insert('projectReaders', { projectId: f.projectId, reader: 'reader' });
  await assert.rejects(cancel(f, state.id, randomUUID(), 'reader'), code('PROJECT_UNAVAILABLE'));
  await assert.rejects(cancel(f, state.id, randomUUID(), null), code('PROJECT_UNAVAILABLE'));
  const result = await cancel(f, state.id, operationId, 'contributor');
  f.tables.projectContributors.delete(grant);
  await assert.rejects(cancel(f, state.id, operationId, 'contributor'), code('PROJECT_UNAVAILABLE'));
  assert.deepEqual((await f.status(state.id)).request, result);
});

test('cancellation scheduling failure rolls back settlement and same-op retry succeeds', async () => {
  const f = await landingFixture(),
    state = await f.enqueue(),
    next = await f.enqueue(),
    operationId = randomUUID(),
    count = f.tables.projectHostedOperations.size,
    queue = f.queue();
  f.schedulerFailure(true);
  await assert.rejects(cancel(f, state.id, operationId), code('HOSTED_REQUEST_FAILED'));
  assert.deepEqual((await f.status(state.id)).request, state);
  assert.equal(f.tables.projectHostedOperations.size, count);
  assert.deepEqual(f.queue(), queue);
  f.schedulerFailure(false);
  assert.equal((await cancel(f, state.id, operationId)).error.code, 'LANDING_CANCELLED');
  await f.drain();
  assert.equal((await f.status(next.id)).request.phase, 'ready');
});

test('new stale-epoch cancellation refuses without writes and preserves an existing failure', async () => {
  const f = await landingFixture(),
    state = await f.enqueue();
  await assert.rejects(cancel(f, state.id, randomUUID(), 'owner', 2), code('SOURCE_AUTHORITY_CHANGED'));
  assert.deepEqual((await f.status(state.id)).request, state);
  assert.equal(f.counts.filter(c => c.name === 'landingCancel').at(-1).writes, 0);
  const conflict = await f.candidate({
    result: { status: 'conflict', conflicts: f.put('synthetic-conflicts') },
  });
  const failed = await f.enqueue(f.request({ candidateId: conflict.id, expectedHead: null }));
  await f.drain();
  const original = (await f.status(failed.id)).request;
  assert.equal(original.observation.cause, 'conflict');
  assert.deepEqual(await cancel(f, failed.id), original);
  assert.equal(operation(f, failed.operationId).terminal.outcome.error.code, original.error.code);
});

test('cancel stays bounded with 10050 unrelated request and acceptance records', async t => {
  const f = await landingFixture(),
    state = await f.enqueue();
  for (let i = 0; i < 10050; i++) {
    f.insert('projectHostedLandingRequests', {
      projectId: f.projectId,
      channel: 'main',
      submissionId: randomUUID(),
      operationId: randomUUID(),
      actor: 'owner',
      sequence: i + 2,
      runnable: false,
      phase: 'terminal-failed',
      runId: null,
      attemptId: randomUUID(),
      value: '{}',
    });
    f.insert('projectHostedAcceptances', {
      projectId: f.projectId,
      receiptId: randomUUID(),
      submissionId: randomUUID(),
      attemptId: randomUUID(),
      sequence: i,
      value: '{}',
    });
  }
  await cancel(f, state.id);
  t.diagnostic(JSON.stringify({ cancellationMaxima: maxima.landingCancel }));
});

async function sharedCheck(f) {
  const check = await f.rawChecks.enqueue(f.rawChecks.selection());
  const request = () => f.request({ check: { kind: 'run', runId: check.id } });
  return { check, request };
}

test('a shared check stops only when the last live submission is cancelled, including queued peers', async () => {
  const f = await landingFixture(),
    { check, request } = await sharedCheck(f);
  const first = await f.enqueue(request()),
    second = await f.enqueue(request());
  await cancel(f, first.id);
  assert.equal((await f.rawChecks.status(check.id)).status, 'queued');
  const result = await cancel(f, second.id);
  assert.equal(result.error.code, 'LANDING_CANCELLED');
  assert.equal((await f.rawChecks.status(check.id)).status, 'cancelled');
  await cancel(f, second.id);
  assert.equal((await f.rawChecks.status(check.id)).cancelRequested, true);
});

test('explicit check-run cancellation stops the selected shared run and replays inertly', async () => {
  const f = await landingFixture(),
    { check, request } = await sharedCheck(f);
  await f.enqueue(request());
  await f.enqueue(request());
  const submissions = structuredClone(f.tables.projectHostedLandingRequests);
  const operationId = randomUUID();
  const result = await f.rawChecks.cancel(check.id, 'owner', operationId);
  assert.equal(result.status, 'cancelled');
  assert.equal(result.cancelRequested, true);
  assert.deepEqual(f.tables.projectHostedLandingRequests, submissions);
  const after = structuredClone(f.tables);
  assert.deepEqual(await f.rawChecks.cancel(check.id, 'owner', operationId), result);
  assert.deepEqual(f.tables, after);
});

test('superseding an attempt stops its old check once no submission needs it', async () => {
  const f = await landingFixture(),
    { check, request } = await sharedCheck(f);
  const state = await f.enqueue(request());
  const attempt = (await f.status(state.id)).attempt;
  const nextAttempt = {
    ...attempt,
    id: randomUUID(),
    parentAttemptId: attempt.id,
    number: attempt.number + 1,
    check: null,
  };
  await f.transaction(
    'supersedeCheck',
    {
      _handler: async ctx => {
        await store.insertLandingAttempt(ctx, nextAttempt);
        const { row, state: live } = await store.loadLanding(ctx, {
          projectId: f.projectId,
          submissionId: state.id,
        });
        await store.writeLanding(
          ctx,
          row,
          { ...live, attemptId: nextAttempt.id, version: live.version + 1 },
          false,
        );
      },
    },
    {},
  );
  assert.equal((await f.rawChecks.status(check.id)).status, 'cancelled');
});

test('last-consumer cancellation stays constant at dogfood size with 1500 checks and 575 landing records', async t => {
  const f = await landingFixture(),
    { check, request } = await sharedCheck(f);
  const state = await f.enqueue(request());
  for (let i = 0; i < 1500; i++)
    f.insert('projectHostedCheckRuns', {
      projectId: f.projectId,
      runId: randomUUID(),
      candidateId: randomUUID(),
      status: 'running',
      value: '{}',
    });
  for (let i = 0; i < 575; i++)
    f.insert('projectHostedLandingRequests', {
      projectId: f.projectId,
      channel: 'main',
      submissionId: randomUUID(),
      operationId: randomUUID(),
      actor: 'owner',
      sequence: i + 2,
      runnable: false,
      phase: 'checking',
      runId: randomUUID(),
      attemptId: randomUUID(),
      value: '{}',
    });
  const start = performance.now(),
    calls = f.counts.length,
    rss = process.memoryUsage().rss;
  await cancel(f, state.id);
  const meter = f.counts.slice(calls).find(c => c.name === 'landingCancel');
  assert.equal(f.counts.length - calls, 1);
  assert(meter.documents <= 40 && meter.writes <= 20);
  assert.equal((await f.rawChecks.status(check.id)).status, 'cancelled');
  t.diagnostic(
    JSON.stringify({
      calls: 1,
      documents: meter.documents,
      writes: meter.writes,
      readBytes: meter.readBytes,
      elapsedMs: performance.now() - start,
      rssBytes: process.memoryUsage().rss,
      rssGrowthBytes: process.memoryUsage().rss - rss,
    }),
  );
});
