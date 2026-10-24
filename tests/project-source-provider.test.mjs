// SPDX-License-Identifier: Apache-2.0
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { randomUUID } from 'node:crypto';
import { moduleUrl } from './convex-module.mjs';
import { recordsFixture } from './hosted-records-fixture.mjs';
import { hostedPayloadHash, canonicalPayload } from '../dist/hosted-source-operation.js';
import { sourceDispatch } from '../dist/hosted-source-job-controller.js';
import { signSourceJobCallback } from '../dist/hosted-source-job.js';
const jobs = await import(moduleUrl('../convex/projectSourceJobs.ts'));
const provider = await import(moduleUrl('../convex/projectSourceProvider.ts'));
const api = await import(moduleUrl('../convex/projectSourceProviderApi.ts'));
const modalAction = await import(moduleUrl('../convex/projectModalSource.ts'));
const jobApi = await import(moduleUrl('../convex/projectSourceJobApi.ts'));
const callbacks = await import(moduleUrl('../convex/projectSourceJobCallbacks.ts'));
const all = [];
after(() => {
  const maxima = {};
  for (const c of all.flat()) {
    const value = (maxima[c.name] ??= {
      calls: 0,
      ranges: 0,
      documents: 0,
      readBytes: 0,
      writes: 0,
      writeBytes: 0,
    });
    value.calls++;
    for (const field of ['ranges', 'documents', 'readBytes', 'writes', 'writeBytes'])
      value[field] = Math.max(value[field], c[field]);
  }
  console.log(JSON.stringify({ sourceProviderFunctionMaxima: maxima }));
});
async function fixture(initialNow = Date.now()) {
  const f = recordsFixture(),
    identity = await f.setup();
  all.push(f.counts);
  const operationId = randomUUID(),
    jobId = randomUUID(),
    owner = randomUUID();
  let now = initialNow;
  const payload = {
    jobKind: 'save',
    input: { sha256: 'a'.repeat(64), size: 123 },
    inputDigest: 'a'.repeat(64),
    provider: 'modal',
    worker: 'forge-source-state-v1',
    runtime: 'b'.repeat(64),
    keyId: 'SYNTHETIC',
    workerLeaseMs: 60000,
  };
  const expected = { authorityEpoch: 1, head: 'a'.repeat(64) };
  await f.run('enqueue', () =>
    jobs.enqueueSourceJob(f.ctx, {
      ...identity,
      request: {
        schema: 1,
        projectId: identity.projectId,
        actor: identity.actor,
        operationId,
        expected,
        payloadHash: hostedPayloadHash(payload, expected),
      },
      payload,
      firstAttempt: {
        projectId: identity.projectId,
        operationId,
        id: randomUUID(),
        parentAttemptId: null,
        at: new Date(now).toISOString(),
        expected,
        ids: { job: jobId },
      },
    }),
  );
  await f.run('claim', () =>
    jobs.claimSourceJob(f.ctx, { projectId: identity.projectId, jobId, owner, leaseMs: 1000 }, now),
  );
  const job = await f.run('dispatch-intent', () =>
    jobs.advanceSourceJob(
      f.ctx,
      {
        projectId: identity.projectId,
        jobId,
        owner,
        token: 1,
        command: { kind: 'reserve', recovery: false },
      },
      now,
    ),
  );
  const request = {
    projectId: identity.projectId,
    jobId,
    input: sourceDispatch(identity.projectId, job),
    token: randomUUID(),
  };
  const call = (name, args = request) => f.run(name, () => provider[name](f.ctx, args, now));
  const check = () => {
    for (const c of f.counts) {
      assert(c.ranges <= 40, c.name);
      assert(c.documents <= 40, c.name);
    }
  };
  return {
    f,
    request,
    call,
    check,
    now: () => now,
    setNow: value => {
      now = value;
    },
  };
}

test('transactional reservation permits one paid create across original retries and overlapping bridge identities', async () => {
  const x = await fixture();
  assert.deepEqual(await x.call('lookupSourceProvider'), { status: 'empty', authoritative: true });
  assert.deepEqual(await x.call('reserveSourceProvider'), { create: true, executionId: null });
  assert.deepEqual(await x.call('reserveSourceProvider'), { create: false, executionId: null });
  assert.deepEqual(await x.call('reserveSourceProvider', { ...x.request, token: randomUUID() }), {
    create: false,
    executionId: null,
  });
  assert.deepEqual(await x.call('lookupSourceProvider'), { status: 'unknown' });
  assert.equal(
    await x.call('recordSourceProvider', { ...x.request, executionId: 'fc-original' }),
    'fc-original',
  );
  assert.deepEqual(await x.call('lookupSourceProvider'), { status: 'found', executionId: 'fc-original' });
  assert.deepEqual(await x.call('reserveSourceProvider'), { create: false, executionId: 'fc-original' });
  x.check();
});

test('lost reserve and create replies retain unknown; changed pins, token or SDK identity cannot replace execution', async () => {
  const x = await fixture();
  await x.call('reserveSourceProvider');
  x.setNow(x.now() + 70000);
  assert.deepEqual(await x.call('lookupSourceProvider'), { status: 'unknown' });
  assert.deepEqual(await x.call('reserveSourceProvider'), { create: false, executionId: null });
  await assert.rejects(
    x.call('recordSourceProvider', { ...x.request, executionId: 'fc-original' }),
    e => e.code === 'SOURCE_JOB_FENCED',
  );
  x.setNow(x.now() - 70000);
  await assert.rejects(
    x.call('recordSourceProvider', { ...x.request, token: randomUUID(), executionId: 'fc-original' }),
    e => e.code === 'SOURCE_JOB_FENCED',
  );
  await assert.rejects(
    x.call('lookupSourceProvider', {
      ...x.request,
      input: { ...x.request.input, inputDigest: 'd'.repeat(64) },
    }),
    e => e.code === 'SOURCE_PROVIDER_CHANGED',
  );
  await x.call('recordSourceProvider', { ...x.request, executionId: 'fc-original' });
  await assert.rejects(
    x.call('recordSourceProvider', { ...x.request, executionId: 'fc-second' }),
    e => e.code === 'SOURCE_EXECUTION_CHANGED',
  );
  x.check();
});

test('signed worker callback recovers SDK identity before create reply and matching terminal replay is unchanged', async () => {
  const x = await fixture();
  await x.call('reserveSourceProvider');
  const input = x.request.input,
    secret = 'synthetic';
  const { jobKind, input: _input, dispatchKey, ...pins } = input;
  const body = {
    ...pins,
    executionId: 'fc-worker',
    result: { status: 'completed', output: { sha256: 'c'.repeat(64), size: 123 } },
  };
  await x.f.run('callback', () =>
    callbacks.receiveSourceJobCallback(
      x.f.ctx,
      {
        projectId: x.request.projectId,
        callback: body,
        signature: signSourceJobCallback(body, secret),
      },
      () => secret,
      x.now(),
    ),
  );
  const writes = x.f.tables.projectHostedRecords.size;
  assert.equal(await x.call('recordSourceProvider', { ...x.request, executionId: 'fc-worker' }), 'fc-worker');
  assert.equal(x.f.tables.projectHostedRecords.size, writes);
  assert.deepEqual(await x.call('lookupSourceProvider'), { status: 'found', executionId: 'fc-worker' });
  x.check();
});

test('lookup and original reservation retries recheck project authority, epoch and worker fence', async () => {
  const x = await fixture();
  await x.call('reserveSourceProvider');
  for (const patch of [{ removal: 'trash' }, { sourceAuthority: { mode: 'server', epoch: 2 } }]) {
    const row = x.f.tables.hostedProjects.get(x.request.projectId),
      saved = { ...row };
    await x.f.ctx.db.patch(x.request.projectId, patch);
    await assert.rejects(x.call('lookupSourceProvider'));
    await assert.rejects(x.call('reserveSourceProvider'));
    Object.assign(x.f.tables.hostedProjects.get(x.request.projectId), saved);
    delete x.f.tables.hostedProjects.get(x.request.projectId).removal;
  }
  await x.f.run('cancel', () =>
    jobs.cancelSourceJob(
      x.f.ctx,
      { projectId: x.request.projectId, jobId: x.request.jobId, actor: 'owner' },
      x.now(),
    ),
  );
  await assert.rejects(x.call('lookupSourceProvider'), e => e.code === 'SOURCE_PROVIDER_CHANGED');
  await assert.rejects(x.call('reserveSourceProvider'), e => e.code === 'SOURCE_PROVIDER_CHANGED');
  x.check();
});

test('registered internal provider endpoints use constant-size exact job transactions', async () => {
  const x = await fixture(),
    args = { ...x.request, input: JSON.stringify(x.request.input) };
  const result = JSON.parse(await x.f.call('api:reserve', api.reserve, args));
  assert.equal(result.create, true);
  assert.equal(await x.f.call('api:created', api.created, { ...args, executionId: 'fc-api' }), 'fc-api');
  assert.deepEqual(
    JSON.parse(
      await x.f.call('api:lookup', api.lookup, {
        projectId: args.projectId,
        jobId: args.jobId,
        input: args.input,
      }),
    ),
    { status: 'found', executionId: 'fc-api' },
  );
  x.check();
});

test('configured Modal action performs a short exact lookup; missing configuration has no provider fallback', async () => {
  const x = await fixture(Date.now() - 10000);
  const names = [
    'FORGE_SOURCE_MODAL_URL',
    'FORGE_SOURCE_MODAL_TOKEN',
    'FORGE_SOURCE_WORKER',
    'FORGE_SOURCE_RUNTIME',
  ];
  const saved = names.map(name => process.env[name]),
    previousFetch = globalThis.fetch;
  let requests = 0;
  const ctx = {
    runMutation: (ref, input) =>
      x.f.call(`dispatch:${getFunctionName(ref)}`, jobApi[getFunctionName(ref).split(':')[1]], input),
  };
  try {
    for (const name of names) delete process.env[name];
    await assert.rejects(
      modalAction.dispatch._handler(ctx, { projectId: x.request.projectId, jobId: x.request.jobId }),
      e => e.code === 'SOURCE_WORKER_UNAVAILABLE',
    );
    process.env.FORGE_SOURCE_MODAL_URL = 'https://synthetic.modal.run/';
    process.env.FORGE_SOURCE_MODAL_TOKEN = 'synthetic';
    process.env.FORGE_SOURCE_WORKER = x.request.input.worker;
    process.env.FORGE_SOURCE_RUNTIME = x.request.input.runtime;
    globalThis.fetch = async (_url, init) => {
      requests++;
      const value = JSON.parse(init.body);
      assert.equal(value.action, 'lookup');
      return new Response(
        JSON.stringify({
          dispatchKey: value.input.dispatchKey,
          input: canonicalPayload(value.input),
          result: { status: 'found', executionId: 'fc-action' },
        }),
      );
    };
    assert.equal(
      await modalAction.dispatch._handler(ctx, { projectId: x.request.projectId, jobId: x.request.jobId }),
      'observed',
    );
    assert.equal(requests, 1);
    x.check();
  } finally {
    globalThis.fetch = previousFetch;
    names.forEach((name, i) => {
      if (saved[i] === undefined) delete process.env[name];
      else process.env[name] = saved[i];
    });
  }
});
