// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { getFunctionName } from 'convex/server';
import { saveFixture, maxima } from './hosted-saves-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { digest } from '../dist/hash.js';
const transfer = await import(moduleUrl('../convex/projectHostedSaveTransfers.ts'));
const batch = await import(moduleUrl('../convex/projectHostedSourceTransferBatch.ts'));
const { catalogPages } = await import(moduleUrl('../convex/projectObjectFind.ts'));
const jobs = await import(moduleUrl('../convex/projectSourceJobs.ts'));
const callbacks = await import(moduleUrl('../convex/projectSourceJobApi.ts'));
const code = value => error => (error.data?.code ?? error.code) === value;
async function fixture(t) {
  const s = await saveFixture(),
    x = await s.prepare([s.change()]);
  await s.stage(x);
  const submitted = await s.submit(x),
    jobId = submitted.jobId,
    owner = randomUUID();
  const claim = await s.run('claim', (ctx, input) => jobs.claimSourceJob(ctx, input), {
    projectId: s.projectId,
    jobId,
    owner,
    leaseMs: 60000,
  });
  await s.run('reserve', (ctx, input) => jobs.advanceSourceJob(ctx, input), {
    projectId: s.projectId,
    jobId,
    owner,
    token: claim.control.lease.token,
    command: { kind: 'reserve', recovery: false },
  });
  let job = await s.run('loadJob', (ctx, input) => jobs.loadSourceJob(ctx, input.projectId, input.jobId), {
    projectId: s.projectId,
    jobId,
  });
  const callback = {
    schema: 1,
    projectId: s.projectId,
    jobId,
    operationId: job.operationId,
    attempt: job.attempt,
    fence: job.fence,
    authorityEpoch: 1,
    inputDigest: job.inputDigest,
    provider: job.control.provider,
    worker: job.control.worker,
    runtime: job.control.runtime,
    executionId: 'transfer-execution',
    result: { status: 'heartbeat', sequence: 1 },
  };
  const env = {
      CONVEX_CLOUD_URL: 'https://example.convex.cloud',
      R2_ACCOUNT_ID: 'h07-fixture',
      R2_BUCKET: 'synthetic',
      R2_ACCESS_KEY_ID: 'synthetic-id',
      R2_SECRET_ACCESS_KEY: 'synthetic-secret',
    },
    saved = Object.fromEntries(Object.keys(env).map(k => [k, process.env[k]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  s.patch('hostedProjects', s.projectId, { r2Writes: true });
  await s.call('heartbeat', callbacks.callback, {
    projectId: s.projectId,
    callback: JSON.stringify(callback),
  });
  job = await s.run('loadJob', (ctx, input) => jobs.loadSourceJob(ctx, input.projectId, input.jobId), {
    projectId: s.projectId,
    jobId,
  });
  const dispatch = {
    schema: 1,
    projectId: s.projectId,
    jobId,
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
    job,
    x,
    args: {
      projectId: s.projectId,
      input: JSON.stringify(dispatch),
      executionId: 'transfer-execution',
      pin: s.original,
    },
    dispatch,
  };
}
test('exact grants and HEAD commits recheck execution, epoch, project membership and verified checksum', async t => {
  const s = await fixture(t),
    read = await s.call('grant', transfer.grant, { ...s.args, action: 'read' });
  assert.equal(new URL(read.url).protocol, 'https:');
  await assert.rejects(
    s.call('grant', transfer.grant, { ...s.args, executionId: 'forged', action: 'read' }),
    code('SOURCE_JOB_FENCED'),
  );
  await assert.rejects(
    s.call('grant', transfer.grant, {
      ...s.args,
      input: JSON.stringify({ ...s.dispatch, fence: 2 }),
      action: 'read',
    }),
    code('SOURCE_JOB_FENCED'),
  );
  await assert.rejects(
    s.call('grant', transfer.grant, {
      ...s.args,
      pin: { sha256: digest('foreign'), size: 7 },
      action: 'read',
    }),
    code('SOURCE_UNAVAILABLE'),
  );
  const pin = { sha256: digest('new source state'), size: 16 },
    args = { ...s.args, pin };
  await s.call('grant', transfer.grant, { ...args, action: 'upload' });
  let heads = 0,
    checksum = Buffer.from(pin.sha256, 'hex').toString('base64');
  t.mock.method(globalThis, 'fetch', async (_url, init) => {
    assert.equal(init.method, 'HEAD');
    heads++;
    return new Response(null, {
      headers: { 'content-length': String(pin.size), 'x-amz-checksum-sha256': checksum },
    });
  });
  let lostCommit = true;
  const ctx = {
    runMutation: async (ref, args) => {
      const name = getFunctionName(ref);
      const result = await s.call(
        name.endsWith('pending') ? 'pending' : 'verified',
        name.endsWith('pending') ? transfer.pending : transfer.verified,
        args,
      );
      if (name.endsWith('verified') && lostCommit) {
        lostCommit = false;
        throw Error('lost verified commit reply');
      }
      return result;
    },
  };
  await assert.rejects(transfer.commit._handler(ctx, args), /lost verified commit reply/);
  await transfer.commit._handler(ctx, args);
  await transfer.commit._handler(ctx, args);
  assert.equal(heads, 1);
  const second = { ...s.args, pin: { sha256: digest('bad output'), size: 10 } };
  await s.call('grant', transfer.grant, { ...second, action: 'upload' });
  checksum = 'incorrect';
  await assert.rejects(transfer.commit._handler(ctx, second), code('R2_VERIFY_FAILED'));
  const pending = await s.call('pending', transfer.pending, second);
  s.patch('hostedProjects', s.projectId, { sourceAuthority: { mode: 'server', epoch: 2 } });
  await assert.rejects(
    s.call('verified', transfer.verified, { ...second, key: pending.key }),
    code('SOURCE_AUTHORITY_CHANGED'),
  );
  await assert.rejects(
    s.call('grant', transfer.grant, { ...s.args, action: 'read' }),
    code('SOURCE_AUTHORITY_CHANGED'),
  );
  t.diagnostic(JSON.stringify({ HEAD: heads, sourceBytesThroughActions: 0, maxima }));
});
test('verified single and batch transfers reuse a catalog binding and commit only the exact pending row', async t => {
  const s = await fixture(t);
  const pin = { sha256: digest('retained output'), size: 15 };
  const [page] = catalogPages([{ digest: pin.sha256, size: pin.size }]);
  s.insert('projectObjectCatalog', { projectId: s.projectId, origin: 'synthetic', ...page });
  const { pin: _, ...identity } = s.args;
  const key = `v1/p/${s.projectId}/o/${pin.sha256}`;
  const rows = s.tables.projectObjects.size;
  await s.call('verifiedCatalog', transfer.verified, { ...identity, pin, key });
  assert.equal(s.tables.projectObjects.size, rows);
  await assert.rejects(
    s.call('verifiedCatalog', transfer.verified, { ...identity, pin: { ...pin, size: 16 }, key }),
    code('SOURCE_UNAVAILABLE'),
  );
  await assert.rejects(
    s.call('verifiedCatalog', transfer.verified, { ...identity, pin, key: `${key}/u/old` }),
    code('SOURCE_UNAVAILABLE'),
  );

  const pendingPin = { sha256: digest('pending output'), size: 14 };
  await s.call('grant', transfer.grant, { ...identity, pin: pendingPin, action: 'upload' });
  const pending = await s.call('pending', transfer.pending, { ...identity, pin: pendingPin });
  assert.equal(pending.stored, false);
  const input = {
    ...identity,
    objects: [
      { pin, key, stored: true },
      { pin: pendingPin, ...pending },
    ],
  };
  for (let attempt = 0; attempt < 2; attempt++) await s.call('verifiedCatalogBatch', batch.verified, input);
  assert.equal(s.tables.projectObjects.size, rows + 1);
  assert.deepEqual(await s.call('pending', transfer.pending, { ...identity, pin: pendingPin }), {
    key: pending.key,
    stored: true,
  });
});

test('revoked project writes and expired workers cannot obtain or commit transfers', async t => {
  const s = await fixture(t);
  s.patch('hostedProjects', s.projectId, { removal: 'trash' });
  await assert.rejects(
    s.call('grant', transfer.grant, { ...s.args, action: 'read' }),
    code('PROJECT_UNAVAILABLE'),
  );
  s.patch('hostedProjects', s.projectId, { removal: undefined });
  const before = Date.now;
  t.mock.method(Date, 'now', () => before() + 120000);
  await assert.rejects(
    s.call('grant', transfer.grant, { ...s.args, action: 'read' }),
    code('SOURCE_JOB_FENCED'),
  );
});
