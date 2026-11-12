// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { PhysicalManifestReader } from '../dist/physical-manifest.js';
import { physicalProject as project, physicalObjectRow as row } from './convex-physical-manifest-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const jobs = await import(moduleUrl('../convex/projectSourceJobs.ts'));

for (const points of [false, true])
  test(`100k ${points ? 'point' : 'legacy/mixed'} seed completes in bounded background steps without a source request`, async t => {
    // Directly exercise the background job: this does not expand the existing
    // synchronous repository envelope to admit a 100k-file compose.
    const f = await project(t, 100000, { points });
    await f.queueSeed();
    assert.equal(f.requests.filter(request => request.seed).length, 0);
    await f.seed();
    const pin = row(f.s, f.base.sha256).statePhysical;
    assert(pin);
    const reader = await PhysicalManifestReader.open(f.base.sha256, pin, f.read);
    for (let at = 0; at < f.files.length; at += 1000) {
      const ids = f.files.slice(at, at + 1000).map(file => file.blob);
      assert.deepEqual(
        (await reader.lookup(ids)).map(pin => pin?.sha256),
        ids,
      );
    }
    const requests = f.requests.filter(request => request.seed),
      measures = f.s.counts.filter(row => row.name === 'projectConvexSourceObjects:resolve'),
      seedId = f.s.tables.hostedProjects.get(f.s.projectId).physicalSeed.jobId,
      seed = [...f.s.tables.projectSourceSteps.values()].find(row => row.jobId === seedId);
    assert.equal(requests.length, 100);
    assert.equal(seed.step, 101, 'one membership-index step plus exactly one resolver prefix per page');
    assert(requests.every(request => request.digests.length <= 1000));
    assert(measures.every(row => row.ranges < 4096 && row.readBytes < 16 * 1024 * 1024));
    assert.equal(seed.seedWatchId, undefined, 'completed seeds leave no recovery wake');
    assert.equal(f.c.storageCalls(), 0, 'State/index/cursor/pack/root bytes all live in R2');
    t.diagnostic(
      JSON.stringify({
        files: 100000,
        catalog: points ? 'point' : 'legacy',
        steps: seed.step,
        resolverCalls: requests.length,
        maxQueries: Math.max(...measures.map(row => row.ranges)),
        maxDocuments: Math.max(...measures.map(row => row.returnedDocuments)),
        maxReadBytes: Math.max(...measures.map(row => row.readBytes)),
        maxPutBytesPerStep: Math.max(...f.seedStats.map(step => step.putBytes)),
        maxPutBytesAfterIndex: Math.max(...f.seedStats.slice(1).map(step => step.putBytes)),
        maxPutsPerStep: Math.max(...f.seedStats.map(step => step.puts)),
        metadataPacks: new Set(reader.root.chunks.map(chunk => chunk.pack?.digest)).size,
      }),
    );
  });

test('concurrent rootless composes reserve one seed and a failed page resumes its original cursor and job', async t => {
  const f = await project(t, 40),
    owner = await f.queueSeed(),
    seedId = f.s.tables.hostedProjects.get(f.s.projectId).physicalSeed.jobId;
  await f.c.call('projectPhysicalSeed:queue', { ...owner, step: 0, state: f.base });
  assert.equal(f.s.tables.hostedProjects.get(f.s.projectId).physicalSeed.jobId, seedId);
  const identity = { projectId: f.s.projectId, jobId: seedId };
  await f.c.call('projectConvexSourceNode:step', { ...identity, step: 0 });
  const before = [...f.s.tables.projectSourceSteps.values()].find(row => row.jobId === seedId),
    original = f.c.context.runMutation;
  let fail = true;
  f.c.context.runMutation = (ref, args) => {
    if (fail && args.seed && getFunctionName(ref) === 'projectConvexSourceObjects:resolve') {
      fail = false;
      throw new TypeError('synthetic transient disconnect');
    }
    return original(ref, args);
  };
  await assert.rejects(f.c.call('projectConvexSourceNode:step', { ...identity, step: 1 }));
  const resumed = [...f.s.tables.projectSourceSteps.values()].find(row => row.jobId === seedId);
  assert.equal(resumed.cursor, before.cursor);
  assert.equal(resumed.generation, 1);
  await f.seed();
  assert.equal(f.s.tables.hostedProjects.get(f.s.projectId).physicalSeed.jobId, seedId);
  const job = await f.s.run('load exact seed', ctx => jobs.loadSourceJob(ctx, f.s.projectId, seedId));
  assert.equal(job.status, 'completed');
});

test('a crashed scheduled seed action is recovered by its one wake with the same job and durable prefix', async t => {
  const f = await project(t, 40);
  await f.queueSeed();
  const jobId = f.s.tables.hostedProjects.get(f.s.projectId).physicalSeed.jobId,
    identity = { projectId: f.s.projectId, jobId };
  await f.c.call('projectConvexSourceNode:step', { ...identity, step: 0 });
  const before = [...f.s.tables.projectSourceSteps.values()].find(row => row.jobId === jobId);
  // The provider reports a dead action, including process death with no catch.
  f.s.decorateContext(ctx => {
    ctx.db.system = { get: async () => ({ state: { kind: 'failed' } }) };
  });
  await f.c.call('projectPhysicalSeed:watch', { ...identity, step: 1 });
  const after = [...f.s.tables.projectSourceSteps.values()].find(row => row.jobId === jobId);
  assert.equal(after.cursor, before.cursor);
  assert.equal(after.generation, 1);
  await f.seed();
  assert(row(f.s, f.base.sha256).statePhysical);
  assert.equal(f.s.tables.hostedProjects.get(f.s.projectId).physicalSeed.jobId, jobId);
});

test('an unavailable binding cannot complete a seed without a verified root or fail its independent compose', async t => {
  const f = await project(t, 40),
    owner = await f.queueSeed(),
    firstId = f.s.tables.hostedProjects.get(f.s.projectId).physicalSeed.jobId,
    catalog = [...f.s.tables.projectObjectCatalog];
  f.s.tables.projectObjectCatalog.clear();
  const identity = { projectId: f.s.projectId, jobId: firstId };
  await f.c.call('projectConvexSourceNode:step', { ...identity, step: 0 });
  await f.c.call('projectConvexSourceNode:step', { ...identity, step: 1 });
  const failed = await f.s.run('read unavailable seed', ctx =>
      jobs.loadSourceJob(ctx, f.s.projectId, firstId),
    ),
    compose = await f.s.run('read independent compose', ctx =>
      jobs.loadSourceJob(ctx, f.s.projectId, owner.jobId),
    );
  assert.equal(failed.status, 'failed');
  assert.equal(failed.control.failureCode, 'SOURCE_UNAVAILABLE');
  assert.equal(compose.status, 'running');
  assert.equal(row(f.s, f.base.sha256).statePhysical, undefined);
  for (const [id, page] of catalog) f.s.tables.projectObjectCatalog.set(id, page);
  await f.c.call('projectPhysicalSeed:queue', { ...owner, step: 0, state: f.base });
  assert.notEqual(f.s.tables.hostedProjects.get(f.s.projectId).physicalSeed.jobId, firstId);
  await f.seed();
  assert(row(f.s, f.base.sha256).statePhysical);
});
