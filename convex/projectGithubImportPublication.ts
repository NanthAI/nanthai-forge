// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { readJob } from './projectGithubImportRead';
import { jobIdentity, retain } from './projectGithubImportInventory';
import { projectBackupPreview } from './schema';
import { indexEntry } from './projectWorkIndexFields';
import { HOSTED_WORK_INDEX_FORMAT } from '../src/work-hosted-summary';
import { digest } from '../src/portable-hash';
import { isStored } from './projectObjectFields';
import { invariant } from '../src/errors';
const pin = v.object({ sha256: v.string(), size: v.number() });
export const begin = internalMutation({
  args: {
    ...jobIdentity,
    step: v.number(),
    root: pin,
    state: pin,
    work: pin,
    preview: projectBackupPreview,
    metadata: v.string(),
  },
  returns: v.object({ generationId: v.id('projectWorkGenerations') }),
  handler: async (ctx, input) => {
    const job = await readJob(ctx, input);
    invariant(
      job.protocol === 2 && job.step === input.step && job.completed === job.total && job.totalKnown,
      'IMPORT_INCOMPLETE',
      'Complete the pinned source before publication.',
    );
    if (job.publication) {
      invariant(
        job.publication.root === input.root.sha256 && job.publication.head === input.state.sha256,
        'IMPORT_PAGE_CHANGED',
        'Publication differs from the original source pins.',
      );
      return { generationId: job.publication.generationId };
    }
    for (const pin of [input.root, input.state, input.work]) {
      const row = await ctx.db
        .query('projectObjects')
        .withIndex('by_project_and_digest', q => q.eq('projectId', job.projectId).eq('digest', pin.sha256))
        .unique();
      invariant(
        row && !row.removed && row.size === pin.size && isStored(row),
        'IMPORT_INCOMPLETE',
        'Retained metadata is incomplete.',
      );
    }
    const backupId = await ctx.db.insert('projectBackups', {
      projectId: job.projectId,
      operationId: job.operationId,
      request: job.request,
      nonce: job.operationId,
      previous: null,
      digest: input.root.sha256,
      size: input.root.size,
      objectManifest: { digest: input.root.sha256, size: input.root.size },
      transport: 'objects',
      validatedClosure: 1,
      preview: input.preview,
      status: 'stored',
    });
    const generationId = await ctx.db.insert('projectWorkGenerations', {
      projectId: job.projectId,
      backupId,
      revision: 0,
      initialRevision: 0,
      format: HOSTED_WORK_INDEX_FORMAT,
      status: 'building',
      nextBatch: 0,
      metadata: input.metadata,
    });
    await ctx.db.patch(job._id, {
      publication: { backupId, generationId, head: input.state.sha256, root: input.root.sha256 },
    });
    return { generationId };
  },
});
export const stage = internalMutation({
  args: { ...jobIdentity, batch: v.number(), entries: v.array(indexEntry) },
  returns: v.null(),
  handler: async (ctx, input) => {
    const job = await readJob(ctx, input),
      publication = job.publication;
    invariant(
      publication && input.entries.length <= 1100,
      'IMPORT_INCOMPLETE',
      'Stage a bounded projection page.',
    );
    const generation = (await ctx.db.get(publication.generationId))!;
    const receipt = {
      part: 'projection',
      key: String(input.batch),
      position: input.batch,
      value: digest(JSON.stringify(input.entries)),
    };
    if (input.batch < generation.nextBatch) {
      await retain(ctx, job, [receipt]);
      return null;
    }
    invariant(
      input.batch === generation.nextBatch && job.phase !== 'ready',
      'IMPORT_PAGE_CHANGED',
      'Projection page is out of order.',
    );
    for (const entry of input.entries)
      await ctx.db.insert('projectWorkRecords', {
        projectId: job.projectId,
        generationId: generation._id,
        ...entry,
      });
    await retain(ctx, job, [receipt]);
    await ctx.db.patch(generation._id, { nextBatch: input.batch + 1 });
    return null;
  },
});
export const finish = internalMutation({
  args: { ...jobIdentity, step: v.number(), batches: v.number() },
  returns: v.null(),
  handler: async (ctx, input) => {
    const job = await readJob(ctx, input);
    if (job.phase === 'ready') return null;
    const project = (await ctx.db.get(job.projectId))!,
      publication = job.publication;
    invariant(
      publication && job.step === input.step && job.completed === job.total,
      'IMPORT_INCOMPLETE',
      'Publication is incomplete.',
    );
    const generation = (await ctx.db.get(publication.generationId))!;
    invariant(
      generation.nextBatch === input.batches && !project.currentBackup,
      'PROJECT_CHANGED',
      'Project source changed or the projection is incomplete.',
    );
    await ctx.db.patch(generation._id, { status: 'ready' });
    await ctx.db.patch(project._id, {
      currentBackup: publication.backupId,
      revision: 1,
      work: {
        backupId: publication.backupId,
        generationId: generation._id,
        operationId: job.operationId,
        initialRevision: 0,
        revision: 0,
      },
    });
    await ctx.db.patch(job._id, { phase: 'ready', error: undefined });
    return null;
  },
});
