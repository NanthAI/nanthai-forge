// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { landingFixture, api, control, store, pins, maxima, code } from './hosted-landing-fixture.mjs';
import { HOSTED_LANDING_LEASE_MS, hostedLandingRequestSchema } from '../dist/hosted-landing.js';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
const priorKeyId = process.env.FORGE_HOSTED_CHECK_KEY_ID;
test.before(() => {
  process.env.FORGE_HOSTED_CHECK_KEY_ID = 'SYNTHETIC';
});
test.after(() => {
  if (priorKeyId === undefined) delete process.env.FORGE_HOSTED_CHECK_KEY_ID;
  else process.env.FORGE_HOSTED_CHECK_KEY_ID = priorKeyId;
});
const requestCheck = f => ({
  kind: 'request',
  checkId: f.checkId,
  expectedDefinition: f.definition.digest,
  expectedConfiguration: f.configuration.digest,
  expectedEnvironment: f.runner.environmentFingerprint,
});
const driverTasks = f => f.pendingTasks().filter(t => t.name.endsWith(':drive'));

test('concurrent original retries retain one request, attempt, check and atomic driver wake', async () => {
  const f = await landingFixture(),
    r = f.request({ check: requestCheck(f) });
  const results = await Promise.all([f.enqueue(r), f.enqueue(r), f.enqueue(r)]);
  assert(results.every(s => canonicalPayload(s) === canonicalPayload(results[0])));
  assert.equal(f.tables.projectHostedLandingRequests.size, 1);
  assert.equal(f.tables.projectHostedLandingAttempts.size, 1);
  assert.equal(f.tables.projectHostedCheckRuns.size, 1);
  assert.equal(driverTasks(f).length, 1);
  const state = results[0],
    before = (await f.status(state.id)).attempt;
  await f.drain();
  assert.equal((await f.status(state.id)).request.phase, 'checking');
  const replay = await f.enqueue(r);
  assert.equal(replay.id, state.id);
  assert.deepEqual((await f.status(state.id)).attempt, before);
  assert.equal(f.tables.projectHostedCheckRuns.size, 1);
  await f.drain();
  assert.equal(f.pendingTasks().length, 0);
});

test('two simultaneous requests retain FIFO sequence and a single committed wake', async () => {
  const f = await landingFixture();
  const states = await Promise.all([f.enqueue(), f.enqueue()]);
  assert.deepEqual(states.map(s => s.sequence).sort(), [1, 2]);
  assert.notEqual(states[0].id, states[1].id);
  assert.equal(driverTasks(f).length, 1);
  const first = await f.execute();
  assert.equal(first.id, states.find(s => s.sequence === 1).id);
  assert.equal(first.phase, 'ready');
  assert.equal(driverTasks(f).length, 1);
  await f.drain();
  assert.equal(f.queue().lease, null);
  assert.equal(f.queue().wake, null);
  assert(f.metrics.actionTransactions.every(calls => calls.length <= 2));
});

test('scheduler failure rolls back enqueue, child check, queue, attempt and operation together', async () => {
  const f = await landingFixture(),
    r = f.request({ check: requestCheck(f) });
  const operations = f.tables.projectHostedOperations.size;
  f.schedulerFailure(true);
  await assert.rejects(f.enqueue(r), code('HOSTED_REQUEST_FAILED'));
  assert.equal(f.tables.projectHostedLandingRequests.size, 0);
  assert.equal(f.tables.projectHostedLandingAttempts.size, 0);
  assert.equal(f.tables.projectHostedLandingQueues.size, 0);
  assert.equal(f.tables.projectHostedCheckRuns.size, 0);
  assert.equal(f.tables.projectHostedOperations.size, operations);
  assert.equal(f.pendingTasks().length, 0);
  f.schedulerFailure(false);
  await f.enqueue(r);
  assert.equal(driverTasks(f).length, 1);
});

test('lost wake/reply replay repairs a failed scheduler receipt using original immutable pins', async () => {
  const f = await landingFixture(),
    r = f.request(),
    s = await f.enqueue(r);
  const task = f.nextTask(),
    attempt = (await f.status(s.id)).attempt;
  f.patch('_scheduled_functions', task._id, { state: { kind: 'failed', error: 'lost before claim' } });
  const again = await f.enqueue(r);
  assert.deepEqual(again, s);
  assert.equal(driverTasks(f).length, 1);
  assert.notEqual(f.nextTask()._id, task._id);
  await f.drain();
  assert.deepEqual((await f.status(s.id)).attempt, attempt);
  assert.equal(f.tables.projectHostedLandingRequests.size, 1);
});

test('stopped driver watchdog recovers the same attempt/run and fences a late old driver', async () => {
  const f = await landingFixture(),
    s = await f.enqueue(f.request({ check: requestCheck(f) }));
  const attempt = (await f.status(s.id)).attempt;
  const old = await f.execute(f.nextTask(), true);
  assert.equal(f.pendingTasks().length, 1);
  assert.equal(f.nextTask().scheduledTime, f.now() + HOSTED_LANDING_LEASE_MS);
  f.elapse(HOSTED_LANDING_LEASE_MS + 1);
  const current = await f.execute(f.nextTask(), true);
  assert.equal(current.submissionId, old.submissionId);
  assert.equal(current.attemptId, old.attemptId);
  assert(current.token > old.token);
  await assert.rejects(f.advance(old), code('WORK_STALE'));
  const result = await f.advance(current);
  assert.equal(result.phase, 'checking');
  assert.deepEqual((await f.status(s.id)).attempt, attempt);
  assert.equal(f.tables.projectHostedCheckRuns.size, 1);
  assert.equal(
    [...f.tables.projectHostedCheckRuns.values()].map(r => JSON.parse(r.value))[0].dispatchStarted,
    false,
  );
  assert.equal(f.pendingTasks().length, 0);
});

test('lost claim and advance replies reconcile without lease extension or another attempt', async () => {
  const f = await landingFixture(),
    s = await f.enqueue(),
    task = f.nextTask();
  const claim = await f.execute(task, true),
    until = f.queue().lease.until;
  f.elapse(100);
  assert.deepEqual(await f.claim(task), claim);
  assert.equal(f.queue().lease.until, until);
  const result = await f.advance(claim);
  assert.deepEqual(await f.advance(claim), result);
  assert.equal(result.attemptId, s.attemptId);
  assert.equal(f.tables.projectHostedLandingAttempts.size, 1);
  assert.equal(f.pendingTasks().length, 0);
});

test('a conflicted head retains its terminal receipt and never hides later runnable work', async () => {
  const f = await landingFixture(),
    mainBefore = f.tables.projectHostedChannels.get(f.mainId).selection;
  const conflict = await f.candidate({
    result: { status: 'conflict', conflicts: f.put('synthetic-conflicts') },
  });
  const badRequest = f.request({ candidateId: conflict.id, expectedHead: null });
  const bad = await f.enqueue(badRequest),
    good = await f.enqueue();
  await f.drain();
  const failed = (await f.status(bad.id)).request;
  assert.equal(failed.phase, 'terminal-failed');
  assert.equal(failed.observation.cause, 'conflict');
  assert.equal((await f.status(good.id)).request.phase, 'ready');
  const op = [...f.tables.projectHostedOperations.values()]
    .map(r => JSON.parse(r.value))
    .find(op => op.operationId === badRequest.operationId);
  assert.equal(op.terminal.outcome.status, 'failed');
  assert.equal((await f.enqueue(badRequest)).observation.cause, 'conflict');
  assert.equal(f.pendingTasks().length, 0);
  assert.equal(f.tables.projectHostedChannels.get(f.mainId).selection, mainBefore);
});

test('running checks sleep without polling while independent ready work advances; completion wakes once', async () => {
  const f = await landingFixture();
  const run = await f.rawChecks.enqueue(f.rawChecks.selection());
  const active = await f.rawChecks.activate(run.id);
  const waiting = await f.enqueue(f.request({ check: { kind: 'run', runId: run.id } }));
  const ready = await f.enqueue();
  await f.drain();
  assert.equal((await f.status(waiting.id)).request.phase, 'checking');
  assert.equal((await f.status(ready.id)).request.phase, 'ready');
  assert.equal(f.pendingTasks().length, 0);
  const scheduled = f.metrics.scheduled;
  assert.equal(await f.recover(), false);
  assert.equal(f.metrics.scheduled, scheduled);
  await f.rawChecks.pass(active);
  assert.equal(f.pendingTasks().filter(t => t.name.endsWith(':checkWake')).length, 1);
  assert.equal(driverTasks(f).length, 0);
  await f.drain();
  const result = (await f.status(waiting.id)).request;
  assert.equal(result.phase, 'ready');
  assert.equal(result.observation.state, 'pending');
  assert.equal(result.observation.pendingReason, 'queued');
  assert.equal(f.pendingTasks().length, 0);
});

test('failed exact checks settle only their own request and retain later ready work', async () => {
  const f = await landingFixture();
  const r = await f.rawChecks.enqueue(f.rawChecks.selection()),
    active = await f.rawChecks.activate(r.id);
  const failed = await f.enqueue(f.request({ check: { kind: 'run', runId: r.id } })),
    later = await f.enqueue();
  await f.drain();
  await f.rawChecks.callback(f.rawChecks.shard(active, 0, 'failed'));
  await f.rawChecks.callback(f.rawChecks.shard(active, 1));
  await f.rawChecks.callback(f.rawChecks.complete(active, 'failed'));
  await f.drain();
  assert.equal((await f.status(failed.id)).request.observation.cause, 'check-failed');
  assert.equal((await f.status(later.id)).request.phase, 'ready');
  assert.equal(f.tables.projectHostedCheckRuns.size, 1);
});

test('overall success with incomplete shards remains checking under the same run', async () => {
  const f = await landingFixture();
  const r = await f.rawChecks.enqueue(f.rawChecks.selection()),
    active = await f.rawChecks.activate(r.id);
  const s = await f.enqueue(f.request({ check: { kind: 'run', runId: r.id } }));
  await f.drain();
  await f.rawChecks.callback(f.rawChecks.complete(active));
  await f.drain();
  assert.equal((await f.status(s.id)).request.phase, 'checking');
  assert.equal(f.pendingTasks().length, 0);
  await f.rawChecks.pass(active);
  await f.drain();
  assert.equal((await f.status(s.id)).request.phase, 'ready');
  assert.equal(f.tables.projectHostedCheckRuns.size, 1);
});

test('source and check selections are exact; changed request payload never creates a second effect', async () => {
  const f = await landingFixture(),
    r = f.request(),
    saved = await f.enqueue(r);
  await assert.rejects(f.enqueue({ ...r, expectedHead: 'e'.repeat(64) }), code('WORK_OPERATION_CHANGED'));
  await assert.rejects(f.enqueue(f.request({ expectedHead: 'e'.repeat(64) })), code('VIEW_STALE'));
  const foreign = await f.candidate();
  const check = await f.rawChecks.enqueue(f.rawChecks.selection());
  await assert.rejects(
    f.enqueue(f.request({ candidateId: foreign.id, check: { kind: 'run', runId: check.id } })),
    code('EVIDENCE_CHANGED'),
  );
  const a = (await f.status(saved.id)).attempt;
  await assert.rejects(
    f.run('landingAttemptReplace', store.insertLandingAttempt, { ...a, at: '2026-02-01T00:00:00.000Z' }),
    code('WORK_OPERATION_CHANGED'),
  );
  assert.equal(f.tables.projectHostedLandingRequests.size, 1);
  assert.equal(f.tables.projectHostedLandingAttempts.size, 1);
  const row = [...f.tables.projectHostedLandingRequests.values()][0];
  const state = (await f.status(saved.id)).request;
  await assert.rejects(
    f.run(
      'landingChangedProgress',
      ctx =>
        store.writeLanding(
          ctx,
          row,
          {
            ...state,
            version: state.version + 1,
            request: { ...state.request, expectedHead: 'e'.repeat(64) },
          },
          true,
        ),
      {},
    ),
    code('WORK_OPERATION_CHANGED'),
  );
  assert.deepEqual((await f.status(saved.id)).request.request, r);
});

test('main receipt ABA rejects fresh requests while authorized old retries retain original pins', async () => {
  const f = await landingFixture(),
    r = f.request(),
    s = await f.enqueue(r);
  f.patch('projectHostedChannels', f.mainId, {
    selection: canonicalPayload({ ...f.main, receipt: { ...f.main.receipt, id: 'same-bytes-new-receipt' } }),
  });
  await assert.rejects(f.enqueue(f.request()), code('CHANNEL_CHANGED'));
  f.patch('hostedProjects', f.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
  assert.deepEqual(await f.enqueue(r), s);
  assert.equal((await f.status(s.id)).attempt.main.receiptId, f.main.receipt.id);
  await f.drain();
  assert.equal((await f.status(s.id)).request.error.code, 'SOURCE_AUTHORITY_CHANGED');
});

test('current project access precedes replay and reads; device requests retain agent authority', async () => {
  const f = await landingFixture(),
    r = f.request(),
    s = await f.enqueue(r);
  await assert.rejects(f.enqueue(r, null), code('PROJECT_UNAVAILABLE'));
  await assert.rejects(f.status(s.id, 'stranger'), code('PROJECT_UNAVAILABLE'));
  f.insert('projectReaders', { projectId: f.projectId, reader: 'reader' });
  assert.equal((await f.status(s.id, 'reader')).request.id, s.id);
  await assert.rejects(f.enqueue(f.request(), 'reader'), code('PROJECT_UNAVAILABLE'));
  const contributor = f.insert('projectContributors', { projectId: f.projectId, contributor: 'contributor' });
  const cr = f.request(),
    cs = await f.enqueue(cr, 'contributor');
  f.tables.projectContributors.delete(contributor);
  await assert.rejects(f.enqueue(cr, 'contributor'), code('PROJECT_UNAVAILABLE'));
  await f.drain();
  assert.equal((await f.status(cs.id)).request.phase, 'terminal-failed');
  f.insert('cliCredentials', {
    credentialId: 'synthetic-device',
    owner: 'owner',
    scope: 'cli',
    revoked: false,
    expiresAt: Date.now() + 60000,
  });
  const dr = f.request({ agent: false });
  const ds = await f.enqueue(dr, { subject: 'owner', forgeCredential: 'synthetic-device' });
  assert.equal((await f.status(ds.id)).attempt.actor.kind, 'agent');
  await assert.rejects(f.enqueue(dr), code('WORK_OPERATION_CHANGED'));
});

test('clean unchecked person selection stays pending for H14 without a universal check requirement', async () => {
  const f = await landingFixture(),
    s = await f.enqueue(f.request({ agent: false }));
  await f.drain();
  const current = await f.status(s.id);
  assert.equal(current.request.phase, 'ready');
  assert.equal(current.attempt.actor.kind, 'person');
  assert.equal(current.attempt.check, null);
  assert.equal(current.request.observation.state, 'pending');
  assert.equal(f.tables.projectHostedCheckRuns.size, 0);
  assert.equal(f.main.head, JSON.parse(f.tables.projectHostedChannels.get(f.mainId).selection).head);
});

test('strict metadata schema rejects source/output bytes and forged actor-kind fields', () => {
  const r = {
    operationId: randomUUID(),
    authorityEpoch: 1,
    channel: 'main',
    expectedMain: {
      head: 'a'.repeat(64),
      receiptId: 'receipt',
    },
    candidateId: randomUUID(),
    expectedHead: 'b'.repeat(64),
    agent: false,
    check: null,
  };
  for (const extra of [{ actor: 'owner' }, { actorKind: 'person' }, { stdout: 'bytes' }, { files: [] }])
    assert.equal(hostedLandingRequestSchema.safeParse({ ...r, ...extra }).success, false);
});

test('ready publication lease is fenced and shares the same Channel queue without accepting source', async () => {
  const f = await landingFixture(),
    s = await f.enqueue();
  await f.drain();
  const input = {
    projectId: f.projectId,
    channel: 'main',
    submissionId: s.id,
    attemptId: s.attemptId,
    owner: randomUUID(),
  };
  const claim = await f.run(
    'landingReadyClaim',
    (ctx, args) => control.claimReadyLanding(ctx, args, f.now()),
    input,
  );
  assert(claim);
  assert.equal(
    await f.run('landingReadyClaim', (ctx, args) => control.claimReadyLanding(ctx, args, f.now()), {
      ...input,
      owner: randomUUID(),
    }),
    null,
  );
  await f.run('landingReadyLease', (ctx, args) => control.requireLandingLease(ctx, args, f.now()), claim);
  f.elapse(HOSTED_LANDING_LEASE_MS + 1);
  const newer = await f.execute(f.nextTask(), true);
  await assert.rejects(
    f.run('landingReadyLease', (ctx, args) => control.requireLandingLease(ctx, args, f.now()), claim),
    code('WORK_STALE'),
  );
  assert.equal(newer.attemptId, claim.attemptId);
  await f.advance(newer);
  assert.equal((await f.status(s.id)).request.phase, 'ready');
});

test.after(() => console.log('H13 synthetic per-invocation maxima', JSON.stringify(maxima)));

test('lost check-completion wake reconciles on original submission replay without redispatch', async () => {
  const f = await landingFixture(),
    run = await f.rawChecks.enqueue(f.rawChecks.selection());
  const request = f.request({ check: { kind: 'run', runId: run.id } }),
    saved = await f.enqueue(request);
  await f.drain();
  await f.rawChecks.pass(await f.rawChecks.activate(run.id));
  const task = f.nextTask();
  f.patch('_scheduled_functions', task._id, {
    state: { kind: 'failed', error: 'synthetic lost completion wake' },
  });
  await f.enqueue(request);
  await f.drain();
  assert.equal((await f.status(saved.id)).request.phase, 'ready');
  assert.equal(f.tables.projectHostedCheckRuns.size, 1);
  assert.equal(f.pendingTasks().length, 0);
});

test('an unexpected step failure rolls back progress and preserves the original recovery wake', async () => {
  const f = await landingFixture(),
    first = await f.enqueue(),
    second = await f.enqueue();
  const claim = await f.execute(f.nextTask(), true),
    recovery = f.nextTask()._id;
  f.schedulerFailure(true);
  await assert.rejects(f.advance(claim), /synthetic scheduler unavailable/);
  assert.equal((await f.status(first.id)).request.phase, 'queued');
  assert.equal(f.queue().lease.token, claim.token);
  assert.equal(f.nextTask()._id, recovery);
  f.schedulerFailure(false);
  await f.drain();
  assert.equal((await f.status(first.id)).request.phase, 'ready');
  assert.equal((await f.status(second.id)).request.phase, 'ready');
  assert.equal(f.tables.projectHostedLandingAttempts.size, 2);
  assert.equal(f.pendingTasks().length, 0);
});

test('check result and its notification commit together; failed scheduling replays the same signed event', async () => {
  const f = await landingFixture(),
    run = await f.rawChecks.enqueue(f.rawChecks.selection());
  const active = await f.rawChecks.activate(run.id),
    saved = await f.enqueue(f.request({ check: { kind: 'run', runId: run.id } }));
  await f.drain();
  const callback = f.rawChecks.shard(active, 0),
    before = f.tables.projectHostedCheckCallbacks.size;
  f.schedulerFailure(true);
  await assert.rejects(f.rawChecks.callback(callback), /synthetic scheduler unavailable/);
  assert.equal(f.tables.projectHostedCheckCallbacks.size, before);
  assert.equal((await f.rawChecks.status(run.id)).counts.completed, 0);
  assert.equal(f.pendingTasks().length, 0);
  f.schedulerFailure(false);
  await f.rawChecks.callback(callback);
  await f.drain();
  assert.equal((await f.rawChecks.status(run.id)).counts.completed, 1);
  assert.equal((await f.status(saved.id)).request.phase, 'checking');
  assert.equal(f.tables.projectHostedCheckRuns.size, 1);
});
