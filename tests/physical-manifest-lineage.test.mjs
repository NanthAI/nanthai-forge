// SPDX-License-Identifier: Apache-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
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

test('every Candidate/main publisher proves composed source, a rootless seed, or an unchanged authoritative head', async t => {
  const { publicationInventory } = await import('./physical-manifest-publication-guard.mjs');
  const report = publicationInventory(fileURLToPath(new URL('../', import.meta.url)));
  assert.deepEqual(report.findings, []);
  assert(report.inventory.length > 0);
  t.diagnostic(JSON.stringify(report.inventory));
});

test('publisher inventory rejects new direct, aliased, generic and unproven Candidate writes without a name allowlist', async () => {
  const { publicationInventory } = await import('./physical-manifest-publication-guard.mjs');
  const report = publicationInventory(fileURLToPath(new URL('../', import.meta.url)), {
    'convex/publicationProbe.ts': `
      import type { MutationCtx, Id } from './_generated/server';
      import { internalMutation } from './server';
      import { v } from 'convex/values';
      import { writeHostedRecord as persist } from './projectHostedRecords';
      import { assertRootlessSeed as checkedSeed } from './projectHostedChannels';
      import { canonicalPayload as encode } from '../src/hosted-source-operation';
      import { hostedMainV2Schema } from '../src/hosted-main';
      import type { z } from 'zod';
      type Main = z.infer<typeof hostedMainV2Schema>;
      export async function direct(ctx: MutationCtx, projectId: Id<'hostedProjects'>, main: Main) {
        await ctx.db.insert('projectHostedChannels', { projectId, operationId: 'synthetic', name: 'main', selection: encode(main) });
      }
      export async function aliased(ctx: MutationCtx, value: any) {
        const insert = ctx.db['insert'];
        await insert('projectHostedChannels', value);
      }
      export async function generic(ctx: MutationCtx, table: any, value: any) {
        await ctx.db.insert(table, { ...value });
      }
      export async function forwarding(ctx: MutationCtx, table: any, value: any) {
        await ctx.db.insert(table, value);
      }
      export async function computed(ctx: MutationCtx, method: any, args: any[]) {
        await ctx.db[method](...args);
      }
      export async function replacement(ctx: MutationCtx, id: Id<'projectHostedRecords'>, value: any) {
        await ctx.db.replace(id, value);
      }
      export async function patching(ctx: MutationCtx, id: Id<'projectHostedRecords'>, value: any) {
        await ctx.db.patch(id, { digest: value.digest, bodyId: value.bodyId });
      }
      export function changedForwarder(ctx: MutationCtx) {
        return new Proxy(ctx.db, { get(_db, method) {
          if (method === 'insert') return async (table: any, value: any) => {
            let selected = value;
            selected = { ...value, selection: 'changed source' };
            return ctx.db.insert(table, selected);
          };
        }});
      }
      export async function arbitrary(ctx: MutationCtx, projectId: Id<'hostedProjects'>, record: unknown) {
        await persist(ctx, { projectId, actor: 'owner', authorityEpoch: 1, expectedVersion: null, record });
      }
      export async function wrongPin(ctx: MutationCtx, projectId: Id<'hostedProjects'>, main: Main) {
        await checkedSeed(ctx, projectId, 'b'.repeat(64));
        await ctx.db.insert('projectHostedChannels', { projectId, operationId: 'synthetic', name: 'main', selection: encode(main) });
      }
      export async function conditional(ctx: MutationCtx, projectId: Id<'hostedProjects'>, main: Main) {
        if (false) { await checkedSeed(ctx, projectId, main.head); }
        await ctx.db.insert('projectHostedChannels', { projectId, operationId: 'synthetic', name: 'main', selection: encode(main) });
      }
      async function exposed(ctx: MutationCtx, input: { record: any }) {
        await ctx.db.insert('projectHostedRecords', input.record); return null;
      }
      export const exposedMutation = internalMutation({ args: { record: v.any() }, returns: v.null(), handler: exposed });
      export const raw = internalMutation({ args: { row: v.any() }, returns: v.null(), handler: async (ctx, { row }) => {
        await ctx.db.insert('projectHostedRecords', row); return null;
      }});
    `,
  });
  const bad = report.findings.filter(item => item.file === 'convex/publicationProbe.ts');
  assert(
    bad.some(item => item.kind === 'dynamic-record-entry'),
    'a generic writer registered by function reference must fail',
  );
  for (const name of [
    'direct',
    'aliased',
    'generic',
    'forwarding',
    'computed',
    'replacement',
    'patching',
    'arbitrary',
    'wrongPin',
    'conditional',
  ])
    assert(
      bad.some(item => item.function === name),
      `${name} bypass must fail`,
    );
  assert(
    bad.some(item => item.line > 0 && item.kind === 'main-insert' && item.function === '<handler>'),
    'a changed DB forwarder must fail',
  );
  assert(
    bad.some(item => item.kind === 'dynamic-record-sink'),
    'registered raw record sink must fail',
  );
});
