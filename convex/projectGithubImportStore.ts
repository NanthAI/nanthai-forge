// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { blobStore } from './blobStore';
import { internalMutation, internalQuery, type QueryCtx } from './server';
import { internal } from './_generated/api';
import { githubImportDocument, githubRequests, migrationCounts } from './projectGithubImportFields';
import { activeOwnedProject } from './projectAuthority';
import { readJob, readJobState } from './projectGithubImportRead';
import { createProject } from './projectCreation';
import { githubHostedProject } from '../src/hosted-github-bootstrap';
import { HOSTED_WORK_INDEX_FORMAT } from '../src/work-hosted-summary';
import { isStored } from './projectObjectFields';
import { findObject } from './projectObjectFind';
import { invariant } from '../src/errors';
import { archiveCursorSchema, initialImportProgress, initialArchiveCursor } from '../src/github-import-pages';
import { completion, recipePin, completeObjects } from './projectGithubImportBatch';
import { retain, retainBlob, inventoryEntry } from './projectGithubImportInventory';
import { catalogEntry, recordWindow } from './projectGithubImportCatalog';
import { beginHistory } from './projectHistoryStore';
import { cancelPendingTask } from './schedulerCancel';

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
  handler: readJobState,
});
export const begin = internalMutation({
  args: {
    ...key,
    name: v.string(),
    repository: v.string(),
    commit: v.string(),
    at: v.string(),
    rootTree: v.string(),
    lfsLimitBytes: v.optional(v.number()),
    visibility: v.union(v.literal('public'), v.literal('private')),
    githubRequests: v.optional(githubRequests),
    migration: v.optional(migrationCounts),
  },
  returns: v.object({ id: v.id('projectGithubImports'), projectId: v.id('hostedProjects') }),
  handler: async (ctx, input) => {
    const previous = await find(ctx, input);
    if (previous) return { id: previous._id, projectId: previous.projectId };
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
    await ctx.db.patch(project._id, { hostingRequest: input.request });
    const id = await ctx.db.insert('projectGithubImports', {
      visibility: input.visibility,
      owner: input.actor,
      operationId: input.operationId,
      request: input.request,
      projectId: project._id,
      repository: input.repository,
      commit: input.commit,
      at: input.at,
      cursor: JSON.stringify(initialArchiveCursor(input.rootTree, input.lfsLimitBytes)),
      protocol: 3,
      step: 0,
      phase: 'discovering',
      totalKnown: false,
      completed: 0,
      total: 0,
      bytes: 0,
      totalBytes: 0,
      ...(input.githubRequests ? { githubRequests: input.githubRequests } : {}),
      ...(input.migration ? { migration: input.migration } : {}),
    });
    const task = await ctx.scheduler.runAfter(0, internal.projectGithubImportWorker.run, {
      id,
      actor: input.actor,
    });
    await ctx.db.patch(id, { task });
    return { id, projectId: project._id };
  },
});
const identity = { id: v.id('projectGithubImports'), actor: v.string(), step: v.number() };

/** Pin the finished index and schedule acquisition in the same transaction. */
export const pinListing = internalMutation({
  args: {
    ...identity,
    listing: v.object({ sha256: v.string(), size: v.number() }),
    total: v.number(),
    totalBytes: v.number(),
    submodules: v.number(),
    githubRequests,
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    const row = await readJob(ctx, input);
    if (row.step !== input.step || row.phase === 'ready' || row.protocol !== 3) return null;
    const task = await ctx.scheduler.runAfter(0, internal.projectGithubImportWorker.run, {
      id: row._id,
      actor: row.owner,
    });
    await ctx.db.patch(row._id, {
      listing: input.listing,
      total: input.total,
      totalBytes: Math.max(row.bytes, input.totalBytes),
      submodules: input.submodules,
      githubRequests: input.githubRequests,
      totalKnown: true,
      phase: 'importing',
      step: row.step + 1,
      task,
    });
    return null;
  },
});

/** A tree that cannot be split continues from its original root in protocol 2. */
export const switchToPaged = internalMutation({
  args: { ...identity, githubRequests },
  returns: v.boolean(),
  handler: async (ctx, input) => {
    const row = await readJob(ctx, input);
    if (row.step !== input.step || row.phase === 'ready' || row.protocol !== 3) return false;
    const cursor = archiveCursorSchema.parse(JSON.parse(row.cursor));
    await retain(ctx, row, [
      {
        part: 'directories',
        key: '',
        position: 0,
        value: JSON.stringify({ path: '', sha: cursor.tree }),
      },
    ]);
    const task = await ctx.scheduler.runAfter(0, internal.projectGithubImportWorker.run, {
      id: row._id,
      actor: row.owner,
    });
    await ctx.db.patch(row._id, {
      protocol: 2,
      pagedCatalog: true,
      cursor: JSON.stringify(initialImportProgress(cursor.lfsLimitBytes)),
      listing: undefined,
      stateObject: undefined,
      completed: 0,
      total: 0,
      bytes: 0,
      totalBytes: 0,
      submodules: 0,
      githubRequests: input.githubRequests,
      totalKnown: false,
      phase: 'discovering',
      step: row.step + 1,
      task,
    });
    return true;
  },
});
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
    catalog: v.optional(v.array(catalogEntry)),
    lfsOids: v.optional(v.array(v.string())),
    entries: v.optional(v.array(inventoryEntry)),
    githubRequests: v.optional(githubRequests),
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
      if (row.pagedCatalog) await recordWindow(ctx, row, input.catalog ?? [], input.lfsOids);
      else await completeObjects(ctx, row.projectId, input.objects ?? [], input.recipes ?? []);
      await retain(ctx, row, input.entries ?? []);
      for (const entry of input.entries ?? [])
        if (entry.part === 'imported') {
          const file = JSON.parse(entry.value);
          await retainBlob(ctx, row, file.blob, file.size);
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
      ...(input.githubRequests ? { githubRequests: input.githubRequests } : {}),
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
/** Verified pins from an upload window. Archive workers also checkpoint their counters.
 * Paged workers move counters only when they advance the matching file inventory. */
export const archiveProgress = internalMutation({
  args: {
    ...identity,
    completed: v.number(),
    total: v.number(),
    bytes: v.number(),
    totalBytes: v.number(),
    submodules: v.number(),
    objects: v.array(catalogEntry),
    lfsOids: v.optional(v.array(v.string())),
    state: v.optional(v.object({ sha256: v.string(), size: v.number() })),
    githubRequests: v.optional(githubRequests),
  },
  returns: v.boolean(),
  handler: async (ctx, input) => {
    const row = await readJob(ctx, input);
    invariant(
      row.protocol === 3 || row.pagedCatalog,
      'IMPORT_PAGE_CHANGED',
      'This import does not use an object catalog.',
    );
    if (row.phase === 'ready') return false;
    if (row.pagedCatalog) {
      if (row.step !== input.step) return false;
      await recordWindow(ctx, row, input.objects, input.lfsOids);
      if (input.objects.length && row.pagedCheckpointStep !== row.step)
        await ctx.db.patch(row._id, { pagedCheckpointStep: row.step });
      return true;
    }
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
      ...(input.state ? { stateObject: input.state } : {}),
      ...(input.githubRequests ? { githubRequests: input.githubRequests } : {}),
    });
    return true;
  },
});
/** A failed archive action checkpoints verified rows without scheduling a step. */
export const archiveCheckpoint = internalMutation({
  args: { ...identity, previousCursor: v.string(), cursor: v.string() },
  returns: v.boolean(),
  handler: async (ctx, input) => {
    const row = await readJob(ctx, input);
    if (
      row.protocol !== 3 ||
      row.step !== input.step ||
      row.phase === 'ready' ||
      row.cursor !== input.previousCursor
    )
      return false;
    await ctx.db.patch(row._id, { cursor: input.cursor });
    return true;
  },
});
export const fail = internalMutation({
  args: {
    ...identity,
    code: v.string(),
    message: v.string(),
    retryAt: v.optional(v.number()),
    githubRequests: v.optional(githubRequests),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    const row = await readJob(ctx, input);
    if (row.step === input.step && row.phase !== 'ready')
      await ctx.db.patch(row._id, {
        phase: 'error',
        error: {
          code: input.code,
          message: input.message,
          ...(input.retryAt === undefined ? {} : { retryAt: input.retryAt }),
        },
        ...(input.githubRequests ? { githubRequests: input.githubRequests } : {}),
      });
    return null;
  },
});
export const resume = internalMutation({
  args: {
    id: v.id('projectGithubImports'),
    actor: v.string(),
    /** Resume at the provider reset the failure recorded (Item 2abda01f), not now. */
    atReset: v.optional(v.boolean()),
  },
  returns: v.null(),
  handler: async (ctx, { atReset, ...input }) => {
    const row = await readJob(ctx, input);
    if (row.phase === 'ready') return null;
    const task = row.task ? await ctx.db.system.get(row.task) : null;
    if (task && ['pending', 'inProgress'].includes(task.state.kind) && row.phase !== 'error') return null;
    const reset = row.phase === 'error' ? row.error?.retryAt : undefined;
    if (atReset && reset !== undefined && reset > Date.now()) {
      // One scheduled run at the reset, no client polling; a replay keeps it.
      if (task?.state.kind === 'pending' && row.error?.resumeAt === reset) return null;
      await cancelPendingTask(ctx, row.task, task);
      const later = await ctx.scheduler.runAt(reset, internal.projectGithubImportWorker.run, input);
      await ctx.db.patch(row._id, { task: later, error: { ...row.error!, resumeAt: reset } });
      return null;
    }
    // Resuming now replaces a run scheduled for the reset, so only one worker runs.
    await cancelPendingTask(ctx, row.task, task);
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
      recordTables: 'split',
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
    // Git history (log, blame, old versions) follows in its own bounded run.
    await beginHistory(ctx, row, bootstrap.head);
    return true;
  },
});
