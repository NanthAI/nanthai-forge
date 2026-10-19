// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { blobStore } from './blobStore';
import { internalMutation, internalQuery, type QueryCtx } from './_generated/server';
import { internal } from './_generated/api';
import { githubImportDocument } from './projectGithubImportFields';
import { activeOwnedProject } from './projectAuthority';
import { createProject } from './projectCreation';
import { githubHostedProject } from '../src/hosted-github-bootstrap';
import { HOSTED_WORK_INDEX_FORMAT } from '../src/work-hosted-summary';
import { invariant } from '../src/errors';

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
async function readJob(
  ctx: QueryCtx,
  { id, actor }: { id: import('./_generated/dataModel').Id<'projectGithubImports'>; actor: string },
) {
  const row = await ctx.db.get(id);
  invariant(
    row && row.owner === actor,
    'PROJECT_UNAVAILABLE',
    'This import is unavailable with current access.',
  );
  await activeOwnedProject(ctx, row.projectId, actor);
  return row;
}
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
    cursor: v.id('_storage'),
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
      cursor: input.cursor,
      step: 0,
      phase: 'discovering',
      totalKnown: false,
      completed: 0,
      total: 0,
      bytes: 0,
      totalBytes: 0,
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
    cursor: v.id('_storage'),
    completed: v.number(),
    total: v.number(),
    bytes: v.number(),
    totalBytes: v.number(),
    discovering: v.boolean(),
  },
  returns: v.boolean(),
  handler: async (ctx, input) => {
    const row = await readJob(ctx, input);
    if (row.step !== input.step || row.phase === 'ready') {
      if (row.cursor !== input.cursor) await blobStore(ctx).delete(input.cursor);
      return false;
    }
    await ctx.db.patch(row._id, {
      cursor: input.cursor,
      step: row.step + 1,
      completed: input.completed,
      total: input.total,
      bytes: input.bytes,
      totalBytes: input.totalBytes,
      phase: input.discovering ? 'discovering' : 'importing',
      totalKnown: !input.discovering,
      error: undefined,
    });
    await blobStore(ctx).delete(row.cursor);
    const task = await ctx.scheduler.runAfter(0, internal.projectGithubImportWorker.run, {
      id: row._id,
      actor: row.owner,
    });
    await ctx.db.patch(row._id, { task });
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
  mode: v.union(v.literal('file'), v.literal('executable'), v.literal('symlink')),
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
      const bound = await ctx.db
        .query('projectObjects')
        .withIndex('by_project_and_digest', q => q.eq('projectId', row.projectId).eq('digest', object.sha256))
        .unique();
      invariant(
        bound && !bound.removed && bound.size === object.size && (bound.storageId || bound.recipe),
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
