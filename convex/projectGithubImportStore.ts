// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { blobStore } from './blobStore';
import { internalMutation, internalQuery, type QueryCtx } from './_generated/server';
import { internal } from './_generated/api';
import { githubImportDocument } from './projectGithubImportFields';
import { activeOwnedProject } from './projectAuthority';
import { readJob } from './projectGithubImportRead';
import { createProject } from './projectCreation';
import { githubHostedProject } from '../src/hosted-github-bootstrap';
import { HOSTED_WORK_INDEX_FORMAT } from '../src/work-hosted-summary';
import { isStored } from './projectObjectFields';
import { findObject } from './projectObjectFind';
import { invariant } from '../src/errors';
import { initialImportProgress, initialArchiveCursor } from '../src/github-import-pages';
import { completion, recipePin, completeObjects } from './projectGithubImportBatch';
import { retain, inventoryEntry } from './projectGithubImportInventory';
import { catalogEntry, recordWindow } from './projectGithubImportCatalog';

const key = { actor: v.string(), operationId: v.string(), request: v.string() };
async function find(ctx: QueryCtx, input: { actor: string; operationId: string; request: string }) {
  const row = await ctx.db
    .query('projectGithubImports')
    .withIndex('by_owner_and_operation', q => q.eq('owner', input.actor).eq('operationId', input.operationId))
    .unique();
  if (row) {
    invariant(
      row.request === input.request,
      'WORK_OPERATION_CHANGED',
      'Retry import with its original repository and ref.',
    );
    await activeOwnedProject(ctx, row.projectId, input.actor);
  }
  return row;
}
export const lookup = internalQuery({
  args: key,
  returns: v.union(githubImportDocument, v.null()),
  handler: find,
});
export const get = internalQuery({
  args: { id: v.id('projectGithubImports'), actor: v.string() },
  returns: githubImportDocument,
  handler: async (ctx, input) => {
    const row = await readJob(ctx, input);
    if (row.phase === 'ready' || row.phase === 'error' || !row.task) return row;
    const task = await ctx.db.system.get(row.task);
    if (!task || ['failed', 'canceled'].includes(task.state.kind))
      return {
        ...row,
        phase: 'error' as const,
        error: {
          code: 'GITHUB_IMPORT_INTERRUPTED',
          message:
            'Import worker stopped. Retry the original operation to resume its saved commit and progress.',
        },
      };
    return row;
  },
});
export const begin = internalMutation({
  args: {
    ...key,
    name: v.string(),
    repository: v.string(),
    commit: v.string(),
    at: v.string(),
    cursor: v.string(),
    rootTree: v.optional(v.string()),
    /** A complete recursive listing was seen: stream the commit archive. */
    archive: v.optional(v.object({ total: v.number(), totalBytes: v.number(), submodules: v.number() })),
    visibility: v.union(v.literal('public'), v.literal('private')),
  },
  returns: v.id('projectGithubImports'),
  handler: async (ctx, input) => {
    const previous = await find(ctx, input);
    if (previous) return previous._id;
    const project = await createProject(ctx, {
      owner: input.actor,
      key: input.operationId,
      name: input.name,
      visibility: input.visibility,
    });
    invariant(
      !project.currentBackup && !project.hostingRequest,
      'WORK_OPERATION_CHANGED',
      'This operation already identifies another project.',
    );
    await ctx.db.patch(project._id, {
      hostingRequest: input.request,
    });
    const id = await ctx.db.insert('projectGithubImports', {
      visibility: input.visibility,
      owner: input.actor,
      operationId: input.operationId,
      request: input.request,
      projectId: project._id,
      repository: input.repository,
      commit: input.commit,
      at: input.at,
      cursor:
        input.rootTree && input.archive
          ? JSON.stringify(initialArchiveCursor(input.rootTree))
          : input.rootTree
            ? JSON.stringify(initialImportProgress())
            : input.cursor,
      ...(input.rootTree ? { protocol: input.archive ? (3 as const) : (2 as const) } : {}),
      step: 0,
      phase: input.archive ? 'importing' : 'discovering',
      totalKnown: Boolean(input.archive),
      completed: 0,
      total: input.archive?.total ?? 0,
      bytes: 0,
      totalBytes: input.archive?.totalBytes ?? 0,
      ...(input.archive ? { submodules: input.archive.submodules } : {}),
    });
    if (input.rootTree && !input.archive)
      await ctx.db.insert('projectGithubImportInventory', {
        projectId: project._id,
        jobId: id,
        part: 'directories',
        key: '',
        position: 0,
        value: JSON.stringify({ path: '', sha: input.rootTree }),
      });
    const task = await ctx.scheduler.runAfter(0, internal.projectGithubImportWorker.run, {
      id,
      actor: input.actor,
    });
    await ctx.db.patch(id, { task });
    return id;
  },
});
const identity = { id: v.id('projectGithubImports'), actor: v.string(), step: v.number() };
export const advance = internalMutation({
  args: {
    ...identity,
    cursor: v.string(),
    completed: v.number(),
    total: v.number(),
    bytes: v.number(),
    totalBytes: v.number(),
    submodules: v.optional(v.number()),
    discovering: v.boolean(),
    objects: v.optional(v.array(completion)),
    recipes: v.optional(v.array(recipePin)),
    entries: v.optional(v.array(inventoryEntry)),
  },
  returns: v.boolean(),
  handler: async (ctx, input) => {
    const row = await readJob(ctx, input);
    if (row.step !== input.step || row.phase === 'ready') {
      if (row.protocol === undefined && row.cursor !== input.cursor)
        await blobStore(ctx).delete(input.cursor);
      return false;
    }
    if (row.protocol === 2) {
      await completeObjects(ctx, row.projectId, input.objects ?? [], input.recipes ?? []);
      await retain(ctx, row, input.entries ?? []);
      for (const entry of input.entries ?? [])
        if (entry.part === 'imported') {
          const file = JSON.parse(entry.value);
          await retain(ctx, row, [
            {
              part: 'blobs',
              key: file.blob,
              position: 0,
              value: JSON.stringify({ sha256: file.blob, size: file.size }),
            },
          ]);
        }
      await retain(ctx, row, [
        {
          part: 'receipts',
          key: String(input.step),
          position: input.step,
          value: JSON.stringify({
            cursor: input.cursor,
            completed: input.completed,
            total: input.total,
            bytes: input.bytes,
            totalBytes: input.totalBytes,
          }),
        },
      ]);
    }
    await ctx.db.patch(row._id, {
      cursor: input.cursor,
      step: row.step + 1,
      completed: input.completed,
      total: input.total,
      bytes: input.bytes,
      totalBytes: input.totalBytes,
      submodules: input.submodules ?? row.submodules ?? 0,
      phase: input.discovering ? 'discovering' : 'importing',
      totalKnown: !input.discovering,
      error: undefined,
    });
    if (row.protocol === undefined) await blobStore(ctx).delete(row.cursor);
    const task = await ctx.scheduler.runAfter(0, internal.projectGithubImportWorker.run, {
      id: row._id,
      actor: row.owner,
    });
    await ctx.db.patch(row._id, { task });
    return true;
  },
});
/** Archive window receipt: the verified objects one upload window stored (one
 * inventory row, no row per object) plus counters. It schedules nothing. */
export const archiveProgress = internalMutation({
  args: {
    ...identity,
    completed: v.number(),
    total: v.number(),
    bytes: v.number(),
    totalBytes: v.number(),
    submodules: v.number(),
    objects: v.array(catalogEntry),
  },
  returns: v.boolean(),
  handler: async (ctx, input) => {
    const row = await readJob(ctx, input);
    invariant(row.protocol === 3, 'IMPORT_PAGE_CHANGED', 'Only archive imports record archive pages.');
    if (row.phase === 'ready') return false;
    // Objects name bytes already verified in storage, so a superseded run may still record them.
    await recordWindow(ctx, row, input.objects);
    if (row.step !== input.step) return false;
    await ctx.db.patch(row._id, {
      completed: input.completed,
      total: input.total,
      bytes: input.bytes,
      totalBytes: input.totalBytes,
      submodules: input.submodules,
      totalKnown: true,
      phase: 'importing',
      error: undefined,
    });
    return true;
  },
});
export const fail = internalMutation({
  args: { ...identity, code: v.string(), message: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    const row = await readJob(ctx, input);
    if (row.step === input.step && row.phase !== 'ready')
      await ctx.db.patch(row._id, { phase: 'error', error: { code: input.code, message: input.message } });
    return null;
  },
});
export const resume = internalMutation({
  args: { id: v.id('projectGithubImports'), actor: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    const row = await readJob(ctx, input);
    if (row.phase === 'ready') return null;
    const task = row.task ? await ctx.db.system.get(row.task) : null;
    if (task && ['pending', 'inProgress'].includes(task.state.kind) && row.phase !== 'error') return null;
    const scheduled = await ctx.scheduler.runAfter(0, internal.projectGithubImportWorker.run, input);
    await ctx.db.patch(row._id, {
      task: scheduled,
      error: undefined,
      phase: row.total > 0 ? 'importing' : 'discovering',
    });
    return null;
  },
});
const file = v.object({
  path: v.string(),
  blob: v.string(),
  size: v.number(),
  mode: v.union(v.literal('file'), v.literal('executable'), v.literal('symlink'), v.literal('gitlink')),
});
export const publish = internalMutation({
  args: { ...identity, files: v.array(file) },
  returns: v.boolean(),
  handler: async (ctx, input) => {
    const row = await readJob(ctx, input);
    if (row.phase === 'ready') return true;
    if (row.step !== input.step) return false;
    invariant(
      row.completed === row.total && input.files.length === row.total,
      'IMPORT_INCOMPLETE',
      'Source import is incomplete.',
    );
    const project = await activeOwnedProject(ctx, row.projectId, row.owner);
    invariant(
      !project.currentBackup,
      'PROJECT_CHANGED',
      'Project source changed during import; original main is preserved.',
    );
    const bootstrap = githubHostedProject(row.operationId, row.at, row.commit, input.files);
    // Each source binding was committed in an earlier bounded import step. Only
    // metadata and the final selected-main pointer publish here.
    for (const object of bootstrap.objects) {
      const bound = await findObject(ctx, row.projectId, object.sha256);
      invariant(
        bound && !bound.removed && bound.size === object.size && isStored(bound),
        'INVALID_WORK_BACKUP',
        'Import metadata is not retained.',
      );
    }
    const root = bootstrap.objects[2]!;
    const backupId = await ctx.db.insert('projectBackups', {
      projectId: row.projectId,
      operationId: row.operationId,
      request: row.request,
      nonce: row.operationId,
      previous: null,
      digest: root.sha256,
      size: root.size,
      objectManifest: { digest: root.sha256, size: root.size },
      transport: 'objects',
      validatedClosure: 1,
      preview: bootstrap.preview,
      status: 'stored',
    });
    const generationId = await ctx.db.insert('projectWorkGenerations', {
      projectId: row.projectId,
      backupId,
      revision: 0,
      initialRevision: 0,
      format: HOSTED_WORK_INDEX_FORMAT,
      status: 'ready',
      nextBatch: 1,
      metadata: JSON.stringify(bootstrap.projection.metadata),
    });
    for (const entry of bootstrap.projection.entries)
      await ctx.db.insert('projectWorkRecords', { projectId: row.projectId, generationId, ...entry });
    await ctx.db.patch(row.projectId, {
      currentBackup: backupId,
      revision: 1,
      work: { backupId, generationId, operationId: row.operationId, initialRevision: 0, revision: 0 },
    });
    await ctx.db.patch(row._id, { phase: 'ready', error: undefined });
    return true;
  },
});
