// SPDX-License-Identifier: Apache-2.0
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { moduleUrl } from './convex-module.mjs';
import { recordsFixture } from './hosted-records-fixture.mjs';
import { hostedPayloadHash } from '../dist/hosted-source-operation.js';
import { signSourceJobCallback, sourceJobCallbackSchema } from '../dist/hosted-source-job.js';
import { ModalSourceProvider } from '../dist/modal-source-provider.js';
import { canonicalPayload } from '../dist/hosted-source-operation.js';
import { driveSourceJob } from '../dist/hosted-source-job-controller.js';

const jobs = await import(moduleUrl('../convex/projectSourceJobs.ts'));
const callbacks = await import(moduleUrl('../convex/projectSourceJobCallbacks.ts'));
const api = await import(moduleUrl('../convex/projectSourceJobApi.ts'));
const bridge = await import(moduleUrl('../convex/projectSourceJobDispatch.ts'));
const hash = 'a'.repeat(64),
  output = { sha256: 'b'.repeat(64), size: 123 };
const secret = 'synthetic-source-worker-key-not-a-real-account';
const at = '2026-01-01T00:00:00.000Z';
const empty = { status: 'empty', authoritative: true };
const errorCode = code => error => error.code === code;
const invocationCounts = [];
after(() => {
  const maxima = {};
  for (const count of invocationCounts.flat()) {
    const item = (maxima[count.name] ??= {
      calls: 0,
      ranges: 0,
      documents: 0,
      readBytes: 0,
      writes: 0,
      writeBytes: 0,
    });
    item.calls++;
    for (const key of ['ranges', 'documents', 'readBytes', 'writes', 'writeBytes'])
      item[key] = Math.max(item[key], count[key]);
  }
  console.log(JSON.stringify({ sourceJobFunctionMaxima: maxima }));
});

async function fixture(actor = 'owner', providerId = 'fake') {
  const f = recordsFixture(),
    identity = await f.setup();
  invocationCounts.push(f.counts);
  let now = Date.parse(at);
  if (actor !== 'owner')
    await f.ctx.db.insert('projectContributors', { projectId: identity.projectId, contributor: actor });
  const payload = {
    jobKind: 'compose',
    input: { sha256: hash, size: 32 },
    inputDigest: hash,
    provider: providerId,
    worker: 'forge-source-v1',
    runtime: hash,
    keyId: 'H05_SYNTHETIC_TEST',
    workerLeaseMs: 60000,
  };
  const operationId = randomUUID(),
    jobId = randomUUID(),
    expected = { authorityEpoch: 1, head: hash, receiptId: 'receipt' };
  const request = {
    schema: 1,
    projectId: identity.projectId,
    actor,
    operationId,
    expected,
    payloadHash: hostedPayloadHash(payload, expected),
  };
  const firstAttempt = {
    projectId: identity.projectId,
    operationId,
    id: randomUUID(),
    parentAttemptId: null,
    at,
    expected,
    ids: { job: jobId },
  };
  const enqueue = { projectId: identity.projectId, actor, request, payload, firstAttempt };
  const invoke = (name, fn, args) => f.run(name, () => fn(f.ctx, args, now));
  await f.run('enqueue', () => jobs.enqueueSourceJob(f.ctx, enqueue));
  let owner = randomUUID();
  const base = () => ({ projectId: identity.projectId, jobId, owner });
  const store = {
    claim: () => invoke('claim', jobs.claimSourceJob, { ...base(), leaseMs: 1000 }),
    advance: (token, command) =>
      invoke(`advance:${command.kind}:${command.status ?? ''}`, jobs.advanceSourceJob, {
        ...base(),
        token,
        command,
      }),
  };
  const executions = new Map(),
    dispatchInputs = [],
    lookups = [];
  const provider = {
    id: providerId,
    async dispatch(input) {
      // The stable key, not a process-local retry counter, owns the paid execution.
      if (!executions.has(input.dispatchKey))
        executions.set(input.dispatchKey, `execution-${executions.size + 1}`);
      return { status: 'accepted', executionId: executions.get(input.dispatchKey) };
    },
    async lookup(input) {
      const executionId = executions.get(input.dispatchKey);
      return executionId ? { status: 'found', executionId } : empty;
    },
  };
  const adapter = {
    get id() {
      return provider.id;
    },
    dispatch(input) {
      dispatchInputs.push(input);
      return provider.dispatch(input);
    },
    lookup(input) {
      lookups.push(input);
      return provider.lookup(input);
    },
  };
  const load = () => f.run('load', () => jobs.loadSourceJob(f.ctx, identity.projectId, jobId));
  const body = async (result = { status: 'completed', output }) => {
    const job = await load();
    return {
      schema: 1,
      projectId: identity.projectId,
      jobId,
      operationId,
      attempt: job.attempt,
      fence: job.fence,
      authorityEpoch: job.authorityEpoch,
      inputDigest: job.inputDigest,
      provider: payload.provider,
      worker: payload.worker,
      runtime: payload.runtime,
      executionId: job.executionId ?? 'execution-1',
      result,
    };
  };
  const receive = (callback, signature = signSourceJobCallback(callback, secret)) =>
    f.run('callback', () =>
      callbacks.receiveSourceJobCallback(
        f.ctx,
        { projectId: identity.projectId, callback, signature },
        () => secret,
        now,
      ),
    );
  const drive = () => driveSourceJob(identity.projectId, store, adapter, randomUUID);
  const expire = () => {
    now += 1001;
    owner = randomUUID();
  };
  const check = t => {
    for (const c of f.counts) {
      assert(c.ranges <= 40, `${c.name}: constant-size index ranges`);
      assert(c.documents <= 40, `${c.name}: constant-size documents`);
    }
    t.diagnostic(
      JSON.stringify({
        calls: f.counts.length,
        maxRanges: Math.max(...f.counts.map(c => c.ranges)),
        maxDocuments: Math.max(...f.counts.map(c => c.documents)),
        maxReadBytes: Math.max(...f.counts.map(c => c.readBytes)),
        maxWrites: Math.max(...f.counts.map(c => c.writes)),
        maxWriteBytes: Math.max(...f.counts.map(c => c.writeBytes)),
        dispatchRequests: dispatchInputs.length,
        paidExecutions: executions.size,
      }),
    );
  };
  return {
    f,
    identity,
    jobId,
    enqueue,
    invoke,
    store,
    provider,
    adapter,
    executions,
    dispatchInputs,
    lookups,
    load,
    body,
    receive,
    drive,
    expire,
    check,
    setNow: value => {
      now = value;
    },
  };
}

test('enqueue retains H01 IDs/time, reconciles original and refuses changed payload', async t => {
  const x = await fixture();
  const retry = await x.f.run('enqueue-replay', () =>
    jobs.enqueueSourceJob(x.f.ctx, {
      ...x.enqueue,
      firstAttempt: {
        ...x.enqueue.firstAttempt,
        id: randomUUID(),
        at: '2026-02-01T00:00:00.000Z',
        ids: { job: randomUUID() },
      },
    }),
  );
  assert.equal(retry.id, x.jobId);
  assert.equal(retry.at, at);
  await assert.rejects(
    x.f.run('enqueue-changed', () =>
      jobs.enqueueSourceJob(x.f.ctx, {
        ...x.enqueue,
        payload: { ...x.enqueue.payload, runtime: 'c'.repeat(64) },
      }),
    ),
    errorCode('WORK_OPERATION_CHANGED'),
  );
  assert.equal(x.dispatchInputs.length, 0);
  x.check(t);
});

test('crash before dispatch intent resumes after the controller lease expires', async t => {
  const x = await fixture();
  await x.store.claim();
  x.expire();
  assert.equal(await x.drive(), 'observed');
  assert.equal(x.executions.size, 1);
  assert.equal(x.lookups.length, 0);
  x.check(t);
});

test('crash after durable intent but before dispatch uses fresh absence and one recovery', async t => {
  const x = await fixture(),
    claim = await x.store.claim();
  await x.store.advance(claim.control.lease.token, { kind: 'reserve', recovery: false });
  x.expire();
  await x.drive();
  assert.equal(x.lookups.length, 2);
  assert.equal(x.dispatchInputs.length, 1);
  assert.equal((await x.load()).control.recoveryUsed, true);
  assert.equal(x.executions.size, 1);
  x.check(t);
});

test('crash after paid dispatch adopts the stable execution without a second dispatch', async t => {
  const x = await fixture(),
    real = x.provider.dispatch;
  x.provider.dispatch = async input => {
    await real(input);
    throw new Error('lost response');
  };
  assert.equal(await x.drive(), 'unknown');
  x.expire();
  assert.equal(await x.drive(), 'observed');
  assert.equal((await x.load()).executionId, 'execution-1');
  assert.equal(x.dispatchInputs.length, 1);
  assert.equal(x.executions.size, 1);
  x.check(t);
});

test('unknown and failed lookups preserve ambiguity without redispatch', async t => {
  const x = await fixture(),
    real = x.provider.dispatch;
  x.provider.dispatch = async input => {
    await real(input);
    return { status: 'unknown' };
  };
  await x.drive();
  for (const lookup of [
    async () => ({ status: 'unknown' }),
    async () => {
      throw new Error('lookup unavailable');
    },
    async () => ({ status: 'empty', authoritative: false }),
  ]) {
    x.provider.lookup = lookup;
    x.expire();
    assert.equal(await x.drive(), 'unknown');
  }
  assert.equal(x.dispatchInputs.length, 1);
  assert.equal((await x.load()).status, 'dispatching');
  x.check(t);
});

test('single bounded redispatch is idempotent even when an accepted job is not found', async t => {
  const x = await fixture(),
    real = x.provider.dispatch;
  x.provider.dispatch = async input => {
    await real(input);
    return { status: 'unknown' };
  };
  x.provider.lookup = async () => empty;
  await x.drive();
  x.expire();
  await x.drive();
  x.expire();
  await x.drive();
  assert.equal(x.dispatchInputs.length, 2);
  assert.equal(x.executions.size, 1);
  assert.deepEqual(x.dispatchInputs[0], x.dispatchInputs[1]);
  assert.equal((await x.load()).control.dispatches, 2);
  x.check(t);
});

test('a fresh second lookup finding the job prevents the recovery dispatch', async t => {
  const x = await fixture(),
    real = x.provider.dispatch;
  x.provider.dispatch = async input => {
    await real(input);
    return { status: 'unknown' };
  };
  await x.drive();
  let calls = 0;
  x.provider.lookup = async () => (++calls === 1 ? empty : { status: 'found', executionId: 'execution-1' });
  x.expire();
  await x.drive();
  assert.equal(calls, 2);
  assert.equal(x.dispatchInputs.length, 1);
  x.check(t);
});

test('accepted dispatch cannot be replaced merely because lookup is empty', async t => {
  const x = await fixture();
  await x.drive();
  x.expire();
  x.provider.lookup = async () => empty;
  assert.equal(await x.drive(), 'unknown');
  assert.equal(x.dispatchInputs.length, 1);
  assert.equal((await x.load()).status, 'running');
  x.check(t);
});

test('definitive rejection is terminal and distinct from unknown or worker failure', async t => {
  const x = await fixture();
  x.provider.dispatch = async () => ({ status: 'rejected' });
  assert.equal(await x.drive(), 'observed');
  assert.equal((await x.load()).status, 'failed');
  assert.equal((await x.load()).control.dispatch, 'rejected');
  assert.equal(await x.drive(), 'idle');
  assert.equal(x.executions.size, 0);
  const y = await fixture();
  await y.drive();
  await y.receive(await y.body({ status: 'failed', code: 'SOURCE_HASH_MISMATCH' }));
  assert.equal((await y.load()).status, 'failed');
  assert.equal((await y.load()).output, null);
  assert.equal((await y.load()).control.failureCode, 'SOURCE_HASH_MISMATCH');
  x.check(t);
  y.check(t);
});

test('rejected recovery dispatch does not declare the original ambiguous execution failed', async t => {
  const x = await fixture(),
    real = x.provider.dispatch;
  x.provider.dispatch = async input => {
    await real(input);
    return { status: 'unknown' };
  };
  await x.drive();
  x.provider.lookup = async () => empty;
  x.provider.dispatch = async () => ({ status: 'rejected' });
  x.expire();
  await x.drive();
  assert.equal((await x.load()).status, 'dispatching');
  assert.equal((await x.load()).control.dispatch, 'ambiguous');
  await x.receive(await x.body());
  assert.equal((await x.load()).status, 'completed');
  assert.equal(x.executions.size, 1);
  x.check(t);
});

test('execution identity drift and provider selection changes cannot replace a pinned job', async t => {
  const x = await fixture();
  await x.drive();
  x.expire();
  x.provider.lookup = async () => ({ status: 'found', executionId: 'forged-second-execution' });
  await assert.rejects(x.drive(), errorCode('SOURCE_EXECUTION_CHANGED'));
  x.provider.id = 'different-provider';
  x.expire();
  await assert.rejects(x.drive(), errorCode('SOURCE_PROVIDER_CHANGED'));
  assert.equal((await x.load()).executionId, 'execution-1');
  assert.equal(x.executions.size, 1);
  x.check(t);
});

test('controller lease takeover fences old responses and competing controllers', async t => {
  const x = await fixture(),
    original = await x.store.claim();
  const old = {
    projectId: x.identity.projectId,
    jobId: x.jobId,
    owner: original.control.lease.owner,
    token: original.control.lease.token,
    command: { kind: 'reserve', recovery: false },
  };
  assert.equal(
    await x.invoke('competing-claim', jobs.claimSourceJob, { ...old, owner: randomUUID(), leaseMs: 1000 }),
    null,
  );
  x.expire();
  await x.store.claim();
  await assert.rejects(
    x.invoke('old-controller', jobs.advanceSourceJob, old),
    errorCode('SOURCE_JOB_FENCED'),
  );
  await x.drive();
  assert.equal(x.executions.size, 1);
  x.check(t);
});

test('recovery needs two distinct durable empty lookups and reserve retries do not repeat effects', async t => {
  const x = await fixture(),
    claim = await x.store.claim(),
    token = claim.control.lease.token;
  const first = await x.store.advance(token, { kind: 'reserve', recovery: false });
  assert.equal((await x.store.advance(token, { kind: 'reserve', recovery: false })).version, first.version);
  const lookupId = randomUUID();
  await x.store.advance(token, { kind: 'empty', lookupId });
  await x.store.advance(token, { kind: 'empty', lookupId });
  await assert.rejects(
    x.store.advance(token, { kind: 'reserve', recovery: true }),
    errorCode('SOURCE_DISPATCH_UNKNOWN'),
  );
  await x.store.advance(token, { kind: 'empty', lookupId: randomUUID() });
  const recovered = await x.store.advance(token, { kind: 'reserve', recovery: true });
  assert.equal(
    (await x.store.advance(token, { kind: 'reserve', recovery: true })).version,
    recovered.version,
  );
  x.check(t);
});

test('verified callback can precede the dispatch reply; duplicate terminal result is immutable', async t => {
  const x = await fixture(),
    original = x.provider.dispatch;
  x.provider.dispatch = async input => {
    const result = await original(input);
    await x.receive(await x.body());
    return result;
  };
  await x.drive();
  const callback = await x.body(),
    terminal = await x.load();
  assert.equal(terminal.status, 'completed');
  assert.deepEqual(terminal.output, output);
  x.expire();
  assert.equal((await x.receive(callback)).version, terminal.version);
  await assert.rejects(
    x.receive({ ...callback, result: { status: 'completed', output: { ...output, size: 124 } } }),
    errorCode('SOURCE_JOB_TERMINAL'),
  );
  assert.equal((await x.load()).version, terminal.version);
  x.check(t);
});

test('forged callback signatures and every mismatched execution pin are rejected', async t => {
  const x = await fixture();
  await x.drive();
  const callback = await x.body();
  await assert.rejects(x.receive(callback, '0'.repeat(64)), errorCode('SOURCE_CALLBACK_INVALID'));
  for (const patch of [
    { operationId: randomUUID() },
    { attempt: 2 },
    { fence: 0 },
    { authorityEpoch: 2 },
    { inputDigest: 'c'.repeat(64) },
    { provider: 'other' },
    { worker: 'project-code' },
    { runtime: 'c'.repeat(64) },
    { executionId: 'other-execution' },
    { projectId: 'foreign-project' },
  ]) {
    await assert.rejects(x.receive({ ...callback, ...patch }), errorCode('SOURCE_CALLBACK_INVALID'));
  }
  const changedOutput = { ...callback, result: { status: 'completed', output: { sha256: hash, size: 1 } } };
  await assert.rejects(
    x.receive(changedOutput, signSourceJobCallback(callback, secret)),
    errorCode('SOURCE_CALLBACK_INVALID'),
  );
  assert.equal(sourceJobCallbackSchema.safeParse({ ...callback, source: 'raw source bytes' }).success, false);
  assert.equal((await x.load()).status, 'running');
  x.check(t);
});

test('cancel advances the worker fence and rejects stale callbacks without terminal rewrite', async t => {
  const x = await fixture();
  await x.drive();
  const callback = await x.body();
  const cancelled = await x.invoke('cancel', jobs.cancelSourceJob, { ...x.identity, jobId: x.jobId });
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(cancelled.fence, callback.fence + 1);
  await assert.rejects(x.receive(callback), errorCode('SOURCE_CALLBACK_INVALID'));
  assert.equal(await x.drive(), 'idle');
  assert.equal(x.executions.size, 1);
  x.check(t);
});

test('heartbeats support jobs beyond action duration; duplicate heartbeat cannot extend the lease', async t => {
  const x = await fixture();
  await x.drive();
  for (let sequence = 1; sequence <= 13; sequence++) {
    x.setNow(Date.parse(at) + sequence * 50000);
    const heartbeat = await x.body({ status: 'heartbeat', sequence });
    const renewed = await x.receive(heartbeat);
    assert.equal((await x.receive(heartbeat)).control.workerUntil, renewed.control.workerUntil);
  }
  await x.receive(await x.body());
  assert.equal((await x.load()).status, 'completed');
  const y = await fixture();
  await y.drive();
  y.setNow(Date.parse(at) + 60000);
  await assert.rejects(y.receive(await y.body()), errorCode('SOURCE_JOB_FENCED'));
  await assert.rejects(
    y.receive(await y.body({ status: 'heartbeat', sequence: 1 })),
    errorCode('SOURCE_JOB_FENCED'),
  );
  x.check(t);
  y.check(t);
});

test('revocation during provider call or completed callback replay rechecks current access', async t => {
  const x = await fixture('contributor'),
    real = x.provider.dispatch;
  const project = () => x.f.tables.hostedProjects.get(x.identity.projectId);
  x.provider.dispatch = async input => {
    const result = await real(input);
    project().removal = 'trash';
    return result;
  };
  await assert.rejects(x.drive(), errorCode('PROJECT_UNAVAILABLE'));
  await assert.rejects(x.receive(await x.body()), errorCode('PROJECT_UNAVAILABLE'));
  delete project().removal;
  await x.receive(await x.body());
  const grant = [...x.f.tables.projectContributors.values()][0];
  // Replace the row through the fake DB so its cached index is invalidated too.
  await x.f.ctx.db.patch(grant._id, { contributor: 'revoked' });
  await assert.rejects(x.receive(await x.body()), errorCode('PROJECT_UNAVAILABLE'));
  x.check(t);
});

test('authority epoch changes fence dispatch, callbacks and retries without moving source', async t => {
  const x = await fixture();
  await x.drive();
  await x.f.ctx.db.patch(x.identity.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
  x.expire();
  await assert.rejects(x.drive(), errorCode('SOURCE_AUTHORITY_CHANGED'));
  await assert.rejects(x.receive(await x.body()), errorCode('SOURCE_AUTHORITY_CHANGED'));
  // Authorized operation replay still identifies the original record; no new dispatch.
  const original = await x.f.run('enqueue-old-epoch-replay', () => jobs.enqueueSourceJob(x.f.ctx, x.enqueue));
  assert.equal(original.id, x.jobId);
  assert.equal(x.dispatchInputs.length, 1);
  assert.equal(x.f.tables.projectHostedRecordHeads.size, 1);
  x.check(t);
});

test('pending recovery pages index live status without hydrating retained terminal history', async t => {
  const x = await fixture();
  for (let i = 0; i < 10255; i++)
    await x.f.ctx.db.insert('projectHostedRecordHeads', {
      projectId: x.identity.projectId,
      kind: 'job',
      key: randomUUID(),
      parent: randomUUID(),
      status: i < 10050 ? 'completed' : 'pending',
      version: 7,
      recordId: 'must-not-hydrate',
    });
  let cursor = null,
    count = 0,
    pages = 0;
  do {
    const result = await x.f.call('pending', api.pending, {
      projectId: x.identity.projectId,
      actor: 'owner',
      status: 'pending',
      cursor,
    });
    count += result.page.length;
    pages++;
    cursor = result.isDone ? null : result.continueCursor;
  } while (cursor !== null);
  assert.equal(count, 206);
  assert.equal(pages, 3);
  const measured = x.f.counts.filter(c => c.name === 'pending');
  for (const c of measured) {
    assert.equal(c.ranges, 2);
    assert(c.documents <= 101);
    assert.equal(c.writes, 0);
  }
  t.diagnostic(
    JSON.stringify({
      historyRows: 10050,
      pendingRows: count,
      pages,
      maxRanges: Math.max(...measured.map(c => c.ranges)),
      maxDocuments: Math.max(...measured.map(c => c.documents)),
      maxReadBytes: Math.max(...measured.map(c => c.readBytes)),
    }),
  );
});

test('Convex action bridge dispatches through registered internal mutations using reference-only inputs', async t => {
  const x = await fixture();
  const actionCtx = {
    runMutation: async (ref, input) => {
      const name = getFunctionName(ref).split(':')[1];
      return x.f.call(`api:${name}`, api[name], input);
    },
  };
  assert.equal(
    await bridge.dispatchSourceJob(
      actionCtx,
      { projectId: x.identity.projectId, jobId: x.jobId, owner: randomUUID(), leaseMs: 1000 },
      x.adapter,
    ),
    'observed',
  );
  assert.equal(x.executions.size, 1);
  assert.deepEqual(
    Object.keys(x.dispatchInputs[0]).sort(),
    [
      'schema',
      'projectId',
      'jobId',
      'operationId',
      'jobKind',
      'attempt',
      'fence',
      'authorityEpoch',
      'input',
      'inputDigest',
      'provider',
      'worker',
      'runtime',
      'dispatchKey',
    ].sort(),
  );
  const job = await x.load();
  assert.equal(JSON.stringify(x.dispatchInputs[0]).includes('keyId'), false);
  assert.equal(job.input.size, 32);
  x.check(t);
});

test('registered enqueue, callback and cancel preserve the same internal contract', async t => {
  const x = await fixture();
  const replay = JSON.parse(
    await x.f.call('api:enqueue', api.enqueue, {
      projectId: x.identity.projectId,
      actor: 'owner',
      request: JSON.stringify({
        request: x.enqueue.request,
        payload: x.enqueue.payload,
        firstAttempt: x.enqueue.firstAttempt,
      }),
    }),
  );
  assert.equal(replay.id, x.jobId);
  await bridge.dispatchSourceJob(
    {
      runMutation: async (ref, input) =>
        x.f.call(`api:${getFunctionName(ref)}`, api[getFunctionName(ref).split(':')[1]], input),
    },
    { projectId: x.identity.projectId, jobId: x.jobId, owner: randomUUID(), leaseMs: 1000 },
    x.adapter,
  );
  const callback = await x.body(),
    name = 'FORGE_SOURCE_JOB_KEY_H05_SYNTHETIC_TEST',
    previous = process.env[name];
  try {
    delete process.env[name];
    await assert.rejects(
      x.f.call('api:callback-missing-key', api.callback, {
        projectId: x.identity.projectId,
        callback: JSON.stringify(callback),
        signature: signSourceJobCallback(callback, secret),
      }),
      errorCode('SOURCE_WORKER_UNAVAILABLE'),
    );
    process.env[name] = secret;
    const completed = JSON.parse(
      await x.f.call('api:callback', api.callback, {
        projectId: x.identity.projectId,
        callback: JSON.stringify(callback),
        signature: signSourceJobCallback(callback, secret),
      }),
    );
    assert.equal(completed.status, 'completed');
    const cancelled = JSON.parse(
      await x.f.call('api:cancel-terminal', api.cancel, {
        projectId: x.identity.projectId,
        actor: 'owner',
        jobId: x.jobId,
      }),
    );
    assert.equal(cancelled.status, 'completed');
    assert.equal(cancelled.version, completed.version);
  } finally {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  }
  x.check(t);
});

test('Modal adapter uses short Convex action transitions, recovers lost dispatch and completes without owner source reads', async t => {
  const x = await fixture('owner', 'modal');
  let requests = 0;
  const paid = new Map();
  const provider = new ModalSourceProvider({
    endpoint: 'https://synthetic-source.modal.run/',
    token: 'synthetic-only',
    worker: 'forge-source-v1',
    runtime: hash,
    timeoutMs: 1000,
    async fetch(_url, init) {
      requests++;
      const { action, input } = JSON.parse(init.body);
      if (action === 'dispatch') {
        if (!paid.has(input.dispatchKey)) paid.set(input.dispatchKey, 'execution-1');
        throw new Error('lost dispatch response after paid create');
      }
      return new Response(
        JSON.stringify({
          dispatchKey: input.dispatchKey,
          input: canonicalPayload(input),
          result: { status: 'found', executionId: paid.get(input.dispatchKey) },
        }),
      );
    },
  });
  const ctx = {
    runMutation: async (ref, input) => {
      const name = getFunctionName(ref).split(':')[1];
      const job = await x.invoke(
        `modal:${name}`,
        name === 'claim' ? jobs.claimSourceJob : jobs.advanceSourceJob,
        name === 'advance' ? { ...input, command: JSON.parse(input.command) } : input,
      );
      return job === null ? null : JSON.stringify(job);
    },
  };
  const tick = () =>
    bridge.dispatchSourceJob(
      ctx,
      { projectId: x.identity.projectId, jobId: x.jobId, owner: randomUUID(), leaseMs: 1000 },
      provider,
    );
  assert.equal(await tick(), 'unknown');
  x.expire();
  assert.equal(await tick(), 'observed');
  assert.equal(paid.size, 1);
  assert.equal(requests, 2);
  await x.receive(await x.body());
  assert.equal((await x.load()).status, 'completed');
  x.check(t);
});
