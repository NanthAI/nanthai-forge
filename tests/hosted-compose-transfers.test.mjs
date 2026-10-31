// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { composeFixture, transfers, jobApi, code, maxima } from './hosted-compose-fixture.mjs';
import { sourceWorkerHttp } from '../dist/hosted-source-worker-http.js';
import { savePin } from '../dist/hosted-save.js';
import { buildHostedSourceState } from '../dist/hosted-source-worker.js';
async function fixture() {
  const s = await composeFixture(),
    entry = await s.lane(s.state([s.file('a.txt', 'A\nb\nc\n'), s.hidden], [s.baseline.sha256])),
    x = s.selection([entry]);
  await s.prepare(x);
  await s.stage(x);
  const submitted = await s.submit(x),
    job = await s.activate(submitted.jobId);
  await s.callback(job, { status: 'heartbeat', sequence: 1 });
  const dispatch = {
    schema: 1,
    projectId: s.projectId,
    jobId: job.id,
    operationId: job.operationId,
    jobKind: job.jobKind,
    attempt: job.attempt,
    fence: job.fence,
    authorityEpoch: 1,
    input: job.input,
    inputDigest: job.inputDigest,
    provider: job.control.provider,
    worker: job.control.worker,
    runtime: job.control.runtime,
    dispatchKey: job.control.dispatchKey,
  };
  return {
    ...s,
    x,
    job,
    dispatch,
    args: {
      projectId: s.projectId,
      input: JSON.stringify(dispatch),
      executionId: 'synthetic-execution',
      sha256: s.baseline.sha256,
    },
  };
}
test('compose lazy descriptors recheck current job execution, fence, epoch and committed project membership', async t => {
  const s = await fixture(),
    ref = JSON.parse(await s.call('describe', transfers.describe, s.args));
  assert.deepEqual(ref, { object: s.baseline, recipe: null });
  await assert.rejects(
    s.call('describe', transfers.describe, { ...s.args, executionId: 'forged' }),
    code('SOURCE_JOB_FENCED'),
  );
  await assert.rejects(
    s.call('describe', transfers.describe, { ...s.args, input: JSON.stringify({ ...s.dispatch, fence: 2 }) }),
    code('SOURCE_JOB_FENCED'),
  );
  await assert.rejects(
    s.call('describe', transfers.describe, { ...s.args, sha256: 'f'.repeat(64) }),
    code('SOURCE_UNAVAILABLE'),
  );
  s.patch('hostedProjects', s.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
  await assert.rejects(s.call('describe', transfers.describe, s.args), code('SOURCE_AUTHORITY_CHANGED'));
  s.patch('hostedProjects', s.projectId, { sourceAuthority: { mode: 'server', epoch: 1 }, removal: 'trash' });
  await assert.rejects(s.call('describe', transfers.describe, s.args), code('PROJECT_UNAVAILABLE'));
  t.diagnostic(JSON.stringify(maxima.describe));
});
test('HTTP descriptor transport binds exact digests, sends credentials only to control, and rejects malformed metadata', async () => {
  const s = await fixture(),
    calls = [];
  const http = sourceWorkerHttp({
    endpoint: 'https://synthetic.invalid/control',
    token: 'synthetic',
    executionId: s.args.executionId,
    input: s.dispatch,
    timeoutMs: 1000,
    fetch: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body), headers: init.headers });
      return Response.json({ object: s.baseline, recipe: null });
    },
  });
  assert.deepEqual(await http.transport.describe(s.baseline.sha256), { object: s.baseline, recipe: null });
  assert.equal(calls[0].url, 'https://synthetic.invalid/control/describe');
  assert.equal(calls[0].body.sha256, s.baseline.sha256);
  assert.deepEqual(calls[0].body.input, s.dispatch);
  await assert.rejects(http.transport.describe('f'.repeat(64)), e => e.code === 'SOURCE_HASH_MISMATCH');
  const invalid = sourceWorkerHttp({
    endpoint: 'https://synthetic.invalid/',
    token: 'synthetic',
    executionId: 'x',
    input: s.dispatch,
    timeoutMs: 1000,
    fetch: async () => Response.json({ parents: ['forged'] }),
  });
  await assert.rejects(invalid.transport.describe(s.baseline.sha256));
});
test('real worker uses the authenticated descriptor API and exact output grants; finalizer is source-byte free and retryable', async t => {
  const s = await fixture(),
    plan = (await s.progress(s.x)).input,
    input = savePin(plan),
    calls = [];
  const output = await buildHostedSourceState(input, {
    async describe(sha256) {
      return JSON.parse(await s.call('describe', transfers.describe, { ...s.args, sha256 }));
    },
    async read(pin) {
      calls.push(pin);
      return [s.objects.get(pin.sha256)];
    },
    async upload(pin, stream) {
      const chunks = [];
      for await (const c of stream) chunks.push(c);
      assert.deepEqual(s.put(Buffer.concat(chunks)), pin);
    },
  });
  await s.callback(s.job, { status: 'completed', output: output.output });
  const resultBytes = s.objects.get(output.output.sha256);
  let fetched = 0;
  t.mock.method(globalThis, 'fetch', async () => {
    fetched++;
    return new Response(resultBytes);
  });
  const prior = {};
  const env = {
    CONVEX_CLOUD_URL: 'https://example.convex.cloud',
    R2_ACCOUNT_ID: 'synthetic',
    R2_BUCKET: 'synthetic',
    R2_ACCESS_KEY_ID: 'synthetic',
    R2_SECRET_ACCESS_KEY: 'synthetic',
  };
  for (const k of Object.keys(env)) prior[k] = process.env[k];
  Object.assign(process.env, env);
  t.after(() => {
    for (const [k, v] of Object.entries(prior)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  const ctx = {
    runMutation: async (ref, args) => {
      const name = getFunctionName(ref);
      return s.call(
        name.endsWith(':publish') ? 'composePublish' : 'resultDownload',
        name.endsWith(':publish') ? jobApi.publish : jobApi.resultDownload,
        args,
      );
    },
  };
  const args = { projectId: s.projectId, jobId: s.job.id };
  const terminal = JSON.parse(await jobApi.complete._handler(ctx, args));
  assert.equal(terminal.outcome.result.result.status, 'clean');
  assert.equal(await jobApi.complete._handler(ctx, args), null);
  assert.equal(fetched, 1);
  assert(resultBytes.length < 4096);
  assert(!calls.some(p => p.sha256 === s.hidden.blob));
  t.diagnostic(
    JSON.stringify({ metrics: output.metrics, resultBytes: resultBytes.length, finalizerDownloads: fetched }),
  );
});

test('compose reuses committed legacy or recipe outputs without PUT/HEAD and still verifies exact bytes', async () => {
  const s = await fixture(),
    pin = s.put('existing output'),
    row = [...s.tables.projectObjects.values()].find(r => r.digest === pin.sha256);
  s.patch('projectObjects', row._id, {
    location: undefined,
    r2Committed: undefined,
    r2Key: undefined,
    storageId: 'synthetic-storage',
  });
  const args = {
    projectId: s.projectId,
    input: s.args.input,
    executionId: s.args.executionId,
    pin,
    action: 'upload',
  };
  assert.deepEqual(await s.call('reuseGrant', transfers.grant, args), { stored: true });
  s.patch('projectObjects', row._id, { storageId: undefined, recipe: { digest: 'e'.repeat(64), size: 1 } });
  assert.deepEqual(await s.call('reuseGrant', transfers.grant, args), { stored: true });
  await assert.rejects(
    s.call('reuseGrant', transfers.grant, { ...args, pin: { ...pin, size: pin.size + 1 } }),
    code('SOURCE_HASH_MISMATCH'),
  );
  const routes = [];
  const http = sourceWorkerHttp({
    endpoint: 'https://synthetic.invalid/',
    token: 'synthetic',
    executionId: s.args.executionId,
    input: s.dispatch,
    timeoutMs: 1000,
    fetch: async url => {
      routes.push(new URL(url).pathname);
      return Response.json({ stored: true });
    },
  });
  let consumed = 0;
  await http.transport.upload(
    pin,
    (async function* () {
      consumed++;
      yield Buffer.from('existing output');
    })(),
  );
  assert.equal(consumed, 1);
  assert.deepEqual(routes, ['/grant']);
  await assert.rejects(
    http.transport.upload(pin, [Buffer.from('wrong bytes')]),
    e => e.code === 'SOURCE_HASH_MISMATCH',
  );
  await assert.rejects(http.transport.read(pin), e => e.code === 'SOURCE_WORKER_UNAVAILABLE');
});
