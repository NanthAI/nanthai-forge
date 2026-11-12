// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { physicalProject, physicalObjectRow } from './convex-physical-manifest-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
import { PhysicalManifestReader } from '../dist/physical-manifest.js';
import { writePhysicalManifest } from '../dist/physical-manifest-write.js';
import { physicalBucket } from '../dist/physical-manifest-codec.js';
const jobs = await import(moduleUrl('../convex/projectSourceJobs.ts'));
test('fast-forward compose excludes every metadata pack containing a removed Lane-only file', async t => {
  const f = await physicalProject(t, 1000),
    initial = await f.compose(f.files, f.base, 'main-0');
  f.s.main.head = initial.head.sha256;
  f.s.main.receipt.id = 'main-1';
  f.s.moveMain(initial.head.sha256, 'main-1');
  const extra = Array.from({ length: 8 }, (_, i) =>
    f.s.file(`extra-${i}.txt`, `Lane intermediate ${i}`),
  ).sort((a, b) => physicalBucket(a.blob) - physicalBucket(b.blob));
  const privateFile = extra[3],
    intermediateFiles = [...f.files, ...extra],
    finalFiles = intermediateFiles.filter(file => file !== privateFile);
  const intermediate = f.s.state(intermediateFiles, [initial.head.sha256]),
    final = f.s.state(finalFiles, [intermediate.sha256]);
  const put = async bytes => f.s.put(Buffer.from(bytes));
  const describe = async ids => ids.map(sha256 => ({ sha256, size: f.s.objects.get(sha256).length }));
  const mainRoot = physicalObjectRow(f.s, initial.head.sha256).statePhysical;
  const mainReader = await PhysicalManifestReader.open(initial.head.sha256, mainRoot, f.read);
  const midRoot = await writePhysicalManifest({
    state: intermediate.sha256,
    members: intermediateFiles.map(f => f.blob),
    parent: mainReader,
    parentMembers: f.files.map(f => f.blob),
    describe,
    put,
  });
  f.s.patch('projectObjects', physicalObjectRow(f.s, intermediate.sha256)._id, {
    statePhysical: midRoot.pin,
    stateParents: [initial.head.sha256],
    stateGeneration: 3,
  });
  const midReader = await PhysicalManifestReader.open(intermediate.sha256, midRoot.pin, f.read);
  const finalRoot = await writePhysicalManifest({
    state: final.sha256,
    members: finalFiles.map(f => f.blob),
    parent: midReader,
    parentMembers: intermediateFiles.map(f => f.blob),
    describe,
    put,
  });
  f.s.patch('projectObjects', physicalObjectRow(f.s, final.sha256)._id, {
    statePhysical: finalRoot.pin,
    stateParents: [intermediate.sha256],
    stateGeneration: 4,
  });
  const entry = await f.s.lane(final, { base: { head: initial.head.sha256, receiptId: 'main-1' } }),
    selection = f.s.selection([entry]);
  await f.s.prepare(selection);
  await f.s.stage(selection);
  const pending = await f.s.submit(selection),
    identity = { projectId: f.s.projectId, jobId: pending.jobId };
  const old = process.env.FORGE_PHYSICAL_MANIFESTS;
  process.env.FORGE_PHYSICAL_MANIFESTS = '1';
  await f.c.call('projectConvexSource:dispatch', identity);
  if (old === undefined) delete process.env.FORGE_PHYSICAL_MANIFESTS;
  else process.env.FORGE_PHYSICAL_MANIFESTS = old;
  await f.c.call('projectConvexSource:step', { ...identity, step: 0 });
  let job = await f.s.run('probe load job', ctx => jobs.loadSourceJob(ctx, f.s.projectId, pending.jobId));
  for (let i = 0; i < 8 && job.status !== 'completed'; i++) {
    const step = [...f.s.tables.projectSourceSteps.values()].find(v => v.jobId === pending.jobId);
    await f.c.call('projectConvexSourceNode:step', { ...identity, step: step.step });
    job = await f.s.run('probe load job', ctx => jobs.loadSourceJob(ctx, f.s.projectId, pending.jobId));
  }
  assert.equal(job.status, 'completed');
  const output = JSON.parse(f.s.objects.get(job.output.sha256)),
    selected = output.result.state.sha256;
  const selectedRoot = physicalObjectRow(f.s, selected).statePhysical,
    reader = await PhysicalManifestReader.open(selected, selectedRoot, f.read);
  const privateChunk = midRoot.root.chunks.find(chunk => chunk.bucket === physicalBucket(privateFile.blob));
  const reachable = reader.root.chunks.filter(chunk => chunk.pack?.digest === privateChunk.pack?.digest);
  const start = Math.min(...reachable.map(chunk => chunk.pack.offset)),
    end = Math.max(...reachable.map(chunk => chunk.pack.offset + chunk.size));
  const observation = {
    files: 1000,
    intermediateAdds: 8,
    removedBeforeCompose: 1,
    fastForward: selected === final.sha256,
    preservedLaneRoot: selectedRoot.sha256 === finalRoot.pin.sha256,
    privateChunkBytes: privateChunk.size,
    reachableLiveBuckets: reachable.length,
    coverBytes: end - start,
    privateBucketInsideCover:
      start <= privateChunk.pack.offset && end >= privateChunk.pack.offset + privateChunk.size,
    privateFileInLogicalManifest: (await reader.lookup([privateFile.blob]))[0] !== null,
  };
  t.diagnostic(JSON.stringify(observation));
  assert.equal(observation.privateFileInLogicalManifest, false);
  assert.equal(
    reachable.length,
    0,
    'compose must extend main metadata; no pack containing a removed Lane-only digest is reachable',
  );
});
