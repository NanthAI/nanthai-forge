// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { getFunctionName } from 'convex/server';
import { composeFixture } from './hosted-compose-fixture.mjs';
import { controls, environment } from './hosted-source-efficiency-fixture.mjs';
import { moduleUrl } from './convex-module.mjs';
const { catalogPages } = await import(moduleUrl('../convex/projectObjectFind.ts'));
const jobs = await import(moduleUrl('../convex/projectSourceJobs.ts'));
const { pointBinding } = await import(moduleUrl('../convex/projectObjectPointBinding.ts'));
export const physicalObjectRow = (s, id) =>
  [...s.tables.projectObjects.values()].find(row => row.digest === id);
export async function physicalProject(t, count, { points = false } = {}) {
  environment(t);
  const now = Date.now();
  t.mock.method(Date, 'now', () => now);
  const s = await composeFixture(),
    files = [];
  for (let index = 0; index < count; index++)
    files.push(s.file(`src/${String(index).padStart(6, '0')}.txt`, `first\nfile-${index}\nlast\n`));
  const members = new Set(files.map(file => file.blob)),
    bindings = [];
  for (let at = 0; at < files.length; at += 1000) {
    const group = files.slice(at, at + 1000),
      bytes = Buffer.concat(group.map(file => s.objects.get(file.blob))),
      pack = s.put(bytes);
    s.patch('projectObjects', physicalObjectRow(s, pack.sha256)._id, { sourceReferenced: true });
    let offset = 0;
    for (const file of group) {
      const size = s.objects.get(file.blob).length;
      bindings.push({ digest: file.blob, size, pack: { digest: pack.sha256, size: pack.size, offset } });
      offset += size;
    }
  }
  for (const [id, value] of s.tables.projectObjects)
    if (members.has(value.digest)) s.tables.projectObjects.delete(id);
  for (const page of catalogPages(bindings))
    s.insert('projectObjectCatalog', { projectId: s.projectId, origin: 'synthetic import', ...page });
  if (points) {
    s.insert('projectObjectReceipts', {
      projectId: s.projectId,
      key: `source-points:${s.projectId}`,
      value: '2',
    });
    for (const pin of bindings)
      s.insert('projectObjectReceipts', {
        projectId: s.projectId,
        key: `source-point:${s.projectId}:${pin.digest}`,
        value: pin.digest,
        size: pin.size,
        sourceBinding: pointBinding({
          ...pin,
          projectId: s.projectId,
          nonce: '',
          removed: false,
          sourceReferenced: true,
          location: 'r2',
          r2Committed: true,
          r2Key: `v1/p/${s.projectId}/o/${pin.pack.digest}`,
        }),
      });
    s.tables.projectObjectCatalog.clear();
  }
  const base = s.state(files);
  s.register(base);
  s.patch('projectObjects', physicalObjectRow(s, base.sha256)._id, { stateGeneration: 1, stateParents: [] });
  s.main.head = base.sha256;
  s.moveMain(base.sha256, 'main-0');
  const c = controls(t, s),
    requests = [];
  const original = c.context.runMutation;
  c.context.runMutation = async (ref, args) => {
    if (getFunctionName(ref) === 'projectConvexSourceObjects:resolve') requests.push(args);
    try {
      return await original(ref, args);
    } catch (error) {
      console.error('synthetic physical source failure', {
        call: getFunctionName(ref),
        digests: args.digests?.length,
        code: error.data?.code ?? error.code,
        message: error.data?.message ?? error.message,
      });
      throw error;
    }
  };
  t.after(() => {
    c.context.runMutation = original;
  });
  const read = async pin =>
    pin.pack
      ? s.objects.get(pin.pack.digest).subarray(pin.pack.offset, pin.pack.offset + pin.size)
      : s.objects.get(pin.sha256);
  async function compose(nextFiles, parent, receipt, capture = true) {
    const head = s.state(nextFiles, [parent.sha256]);
    s.patch('projectObjects', physicalObjectRow(s, head.sha256)._id, {
      stateParents: [parent.sha256],
      stateGeneration: (physicalObjectRow(s, parent.sha256).stateGeneration ?? 1) + 1,
    });
    const entry = await s.lane(head, { base: { head: parent.sha256, receiptId: receipt } }),
      selection = s.selection([entry]);
    await s.prepare(selection);
    await s.stage(selection);
    const pending = await s.submit(selection),
      identity = { projectId: s.projectId, jobId: pending.jobId };
    const old = process.env.FORGE_PHYSICAL_MANIFESTS;
    try {
      if (capture) process.env.FORGE_PHYSICAL_MANIFESTS = '1';
      else delete process.env.FORGE_PHYSICAL_MANIFESTS;
      await c.call('projectConvexSource:dispatch', identity);
      // The original dispatch setting survives changes before the first action.
      if (capture) delete process.env.FORGE_PHYSICAL_MANIFESTS;
      else process.env.FORGE_PHYSICAL_MANIFESTS = '1';
      const step = [...s.tables.projectSourceSteps.values()].find(value => value.jobId === pending.jobId);
      assert.equal(step.physicalManifests, capture ? true : undefined);
      await c.call('projectConvexSource:step', { ...identity, step: 0 });
      let job = await s.run('S5 load job', ctx => jobs.loadSourceJob(ctx, s.projectId, pending.jobId));
      for (let index = 0; index < 8 && job.status !== 'completed'; index++) {
        const step = [...s.tables.projectSourceSteps.values()].find(value => value.jobId === pending.jobId);
        await c.call('projectConvexSourceNode:step', { ...identity, step: step.step });
        job = await s.run('S5 load job', ctx => jobs.loadSourceJob(ctx, s.projectId, pending.jobId));
      }
      assert.equal(job.status, 'completed');
      const output = JSON.parse(s.objects.get(job.output.sha256));
      assert.equal(output.result.state.sha256, head.sha256, 'a fast-forward retains the exact State');
      return { head, job, selection };
    } finally {
      if (old === undefined) delete process.env.FORGE_PHYSICAL_MANIFESTS;
      else process.env.FORGE_PHYSICAL_MANIFESTS = old;
    }
  }
  async function queueSeed() {
    const entry = await s.lane(base, { base: { head: base.sha256, receiptId: 'main-0' } }),
      selection = s.selection([entry]);
    await s.prepare(selection);
    await s.stage(selection);
    const pending = await s.submit(selection),
      identity = { projectId: s.projectId, jobId: pending.jobId };
    const old = process.env.FORGE_PHYSICAL_MANIFESTS;
    try {
      process.env.FORGE_PHYSICAL_MANIFESTS = '1';
      await c.call('projectConvexSource:dispatch', identity);
      await c.call('projectPhysicalSeed:queue', { ...identity, step: 0, state: base });
    } finally {
      if (old === undefined) delete process.env.FORGE_PHYSICAL_MANIFESTS;
      else process.env.FORGE_PHYSICAL_MANIFESTS = old;
    }
    const seedId = s.tables.hostedProjects.get(s.projectId).physicalSeed.jobId;
    await c.call('projectPhysicalSeed:dispatch', { projectId: s.projectId, jobId: seedId });
    return identity;
  }
  const seedStats = [];
  async function seed() {
    const project = s.tables.hostedProjects.get(s.projectId),
      identity = { projectId: s.projectId, jobId: project.physicalSeed.jobId };
    if (![...s.tables.projectSourceSteps.values()].some(row => row.jobId === identity.jobId))
      await c.call('projectPhysicalSeed:dispatch', identity);
    let job;
    for (let at = 0; at < 2000; at++) {
      job = await s.run('load background seed', ctx => jobs.loadSourceJob(ctx, s.projectId, identity.jobId));
      if (['completed', 'failed'].includes(job.status)) break;
      const step = [...s.tables.projectSourceSteps.values()].find(row => row.jobId === identity.jobId);
      const putAt = c.r2Puts.length;
      await c.call('projectConvexSourceNode:step', {
        ...identity,
        step: step.step,
        generation: step.generation ?? 0,
      });
      seedStats.push({
        step: step.step,
        putBytes: c.r2Puts.slice(putAt).reduce((sum, id) => sum + s.objects.get(id).length, 0),
        puts: c.r2Puts.length - putAt,
      });
    }
    assert.equal(job.status, 'completed');
    return job;
  }
  return { s, c, base, files, read, requests, compose, seed, queueSeed, seedStats };
}
