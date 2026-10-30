// SPDX-License-Identifier: Apache-2.0
import { indexActivity } from '../src/work-hosted-index';
import { workProject, generationHead, setWorkHead } from './projectWorkHead';
import { v } from 'convex/values';
import { HOSTED_WORK_INDEX_FORMAT } from '../src/work-hosted-summary';
import { internalMutation, internalQuery, type QueryCtx, type MutationCtx } from './_generated/server';
import { internal } from './_generated/api';
import type { Doc, Id } from './_generated/dataModel';
import { accessibleProject } from './projectAuthority';
import { generationDocument, indexEntry } from './projectWorkIndexFields';
import { invariant } from '../src/errors';
import { projectExecution } from './projectExecution';

// Incremental source returns retain the public generation. Its disposable
// record partition can be reused directly; this pointer never forms a chain.
export const recordPartition = (generation: Doc<'projectWorkGenerations'>) =>
  generation.recordsGenerationId ?? generation._id;

export async function selectedGeneration(ctx: QueryCtx | MutationCtx, project: Doc<'hostedProjects'>) {
  const generation = project.work?.generationId ? await ctx.db.get(project.work.generationId) : null;
  return generation?.format === HOSTED_WORK_INDEX_FORMAT &&
    generation.status === 'ready' &&
    generation.projectId === project._id &&
    generation.backupId === project.work?.backupId &&
    (!project.work?.intentMigration || [16, 18, 20, 22, 24].includes(JSON.parse(generation.metadata).schema))
    ? generation
    : null;
}
export async function record(
  ctx: QueryCtx | MutationCtx,
  generationId: Id<'projectWorkGenerations'>,
  collection: string,
  key: string,
) {
  return await ctx.db
    .query('projectWorkRecords')
    .withIndex('by_generation_and_collection_and_key', q =>
      q.eq('generationId', generationId).eq('collection', collection).eq('key', key),
    )
    .unique();
}
export const current = internalQuery({
  args: { projectId: v.id('hostedProjects'), owner: v.string() },
  returns: v.union(generationDocument, v.null()),
  handler: async (ctx, { projectId, owner }) =>
    selectedGeneration(ctx, await accessibleProject(ctx, projectId, owner)).then(g =>
      g ? generationHead(ctx, g) : null,
    ),
});
// Source return compares actual rows: append-time note positions can differ from
// a fresh full materialization. A moving generation simply uses the rebuild path.
export const snapshotEntries = internalQuery({
  args: {
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    generationId: v.id('projectWorkGenerations'),
    revision: v.number(),
    cursor: v.union(v.string(), v.null()),
    returnBatch: v.optional(v.boolean()),
  },
  returns: v.union(
    v.null(),
    v.object({ entries: v.array(indexEntry), cursor: v.union(v.string(), v.null()) }),
  ),
  handler: async (ctx, input) => {
    const project = await workProject(ctx, await accessibleProject(ctx, input.projectId, input.owner)),
      generation = await selectedGeneration(ctx, project);
    if (generation?._id !== input.generationId || project.work?.revision !== input.revision) return null;
    const page = await ctx.db
      .query('projectWorkRecords')
      .withIndex('by_generation', q => q.eq('generationId', recordPartition(generation)))
      .paginate({
        cursor: input.cursor,
        numItems: input.returnBatch ? 1000 : 100,
        maximumBytesRead: input.returnBatch ? 2000000 : 500000,
      });
    return {
      entries: page.page.map(row => ({
        ...(row.activityAt === undefined ? {} : { activityAt: row.activityAt }),
        collection: row.collection,
        key: row.key,
        parent: row.parent,
        position: row.position,
        value: row.value,
        ...(row.status === undefined ? {} : { status: row.status }),
        ...(row.actor === undefined ? {} : { actor: row.actor }),
      })),
      cursor: page.isDone ? null : page.continueCursor,
    };
  },
});
export const begin = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    backupId: v.id('projectBackups'),
    revision: v.number(),
    initialRevision: v.number(),
    metadata: v.string(),
    cursor: v.optional(v.string()),
  },
  returns: v.union(generationDocument, v.null()),
  handler: async (ctx, input) => {
    const project = await workProject(ctx, await accessibleProject(ctx, input.projectId, input.owner));
    if (
      project.work?.backupId !== input.backupId ||
      project.work.revision !== input.revision ||
      (project.work.intentMigration && ![16, 18, 20, 22, 24].includes(JSON.parse(input.metadata).schema))
    )
      return null;
    const current = await selectedGeneration(ctx, project);
    if (current) return current;
    const previous = await ctx.db
      .query('projectWorkGenerations')
      .withIndex('by_project_and_backup_and_revision_and_format_and_work_schema', q =>
        q
          .eq('projectId', input.projectId)
          .eq('backupId', input.backupId)
          .eq('revision', input.revision)
          .eq('format', HOSTED_WORK_INDEX_FORMAT)
          .eq('workSchema', JSON.parse(input.metadata).schema),
      )
      .order('desc')
      .take(1);
    const old = previous[0];
    if (old && (!input.cursor || old.ensureCursor || old.status === 'ready')) return old;
    if (old && input.cursor && old.nextBatch === 0) {
      await ctx.db.patch(old._id, { ensureCursor: input.cursor, metadata: input.metadata });
      return await ctx.db.get(old._id);
    }
    const { owner: _owner, cursor, ...fields } = input;
    void _owner;
    const id = await ctx.db.insert('projectWorkGenerations', {
      ...fields,
      format: HOSTED_WORK_INDEX_FORMAT,
      workSchema: JSON.parse(input.metadata).schema,
      ...(cursor ? { ensureCursor: cursor } : {}),
      status: 'building',
      nextBatch: 0,
    });
    return await ctx.db.get(id);
  },
});
export const batch = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    generationId: v.id('projectWorkGenerations'),
    batch: v.number(),
    entries: v.array(indexEntry),
  },
  returns: v.boolean(),
  handler: async (ctx, input) => {
    const project = await workProject(ctx, await accessibleProject(ctx, input.projectId, input.owner)),
      generation = await ctx.db.get(input.generationId);
    invariant(
      generation?.projectId === project._id,
      'PROJECT_UNAVAILABLE',
      'Select this project’s Work generation.',
    );
    if (
      project.work?.backupId !== generation.backupId ||
      project.work.revision !== generation.revision ||
      (project.work.intentMigration && ![16, 18, 20, 22, 24].includes(JSON.parse(generation.metadata).schema))
    ) {
      await ctx.scheduler.runAfter(0, internal.projectWorkIndexStore.retire, {
        generationId: generation._id,
        projectId: generation.projectId,
      });
      return false;
    }
    if (generation.status === 'ready' || input.batch < generation.nextBatch) return true;
    invariant(
      input.batch === generation.nextBatch,
      'INVALID_WORK_JOURNAL',
      'Resume the next materialization batch.',
    );
    for (const entry of input.entries)
      await ctx.db.insert('projectWorkRecords', {
        projectId: project._id,
        generationId: generation._id,
        ...entry,
        ...indexActivity(entry),
      });
    await ctx.db.patch(generation._id, { nextBatch: generation.nextBatch + 1 });
    return true;
  },
});
export const publish = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    generationId: v.id('projectWorkGenerations'),
    batches: v.number(),
    metadata: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, input) => {
    const project = await workProject(ctx, await accessibleProject(ctx, input.projectId, input.owner)),
      generation = await ctx.db.get(input.generationId);
    invariant(
      generation?.projectId === project._id,
      'PROJECT_UNAVAILABLE',
      'Select this project’s Work generation.',
    );
    if (
      project.work?.backupId !== generation.backupId ||
      project.work.revision !== generation.revision ||
      (project.work.intentMigration &&
        ![16, 18, 20, 22, 24].includes(JSON.parse(input.metadata ?? generation.metadata).schema))
    ) {
      await ctx.scheduler.runAfter(0, internal.projectWorkIndexStore.retire, {
        generationId: generation._id,
        projectId: generation.projectId,
      });
      return false;
    }
    invariant(
      generation.nextBatch === input.batches &&
        (!generation.ensureCursor || JSON.parse(generation.ensureCursor).phase === 'done'),
      'INVALID_WORK_JOURNAL',
      'Materialization batches are incomplete.',
    );
    await ctx.db.patch(generation._id, {
      status: 'ready',
      workSchema: JSON.parse(input.metadata ?? generation.metadata).schema,
      ...(input.metadata ? { metadata: input.metadata } : {}),
    });
    await setWorkHead(
      ctx,
      project._id,
      generation.backupId,
      generation.revision,
      input.metadata ?? generation.metadata,
    );
    const previous = project.work.generationId;
    await ctx.db.patch(project._id, { work: { ...project.work, generationId: generation._id } });
    if (previous && previous !== generation._id)
      await ctx.scheduler.runAfter(0, internal.projectWorkIndexStore.retire, {
        generationId: previous,
        projectId: project._id,
      });
    await ctx.scheduler.runAfter(0, internal.projectWorkIndexStore.sweep, {
      projectId: project._id,
      cursor: null,
    });
    return true;
  },
});
/** Only derived rows can retire; original backup, source and event history are never touched. */
export const retire = internalMutation({
  args: { generationId: v.id('projectWorkGenerations'), projectId: v.optional(v.id('hostedProjects')) },
  returns: v.null(),
  handler: async (ctx, { generationId, projectId }) => {
    if (projectId) projectExecution(ctx, projectId);
    const generation = await ctx.db.get(generationId);
    if (!generation || generation.retainedForIntentMigration) return null;
    const project = await ctx.db.get(generation.projectId);
    projectExecution(ctx, generation.projectId, project?.name, project?.key);
    if (project?.work?.generationId === generationId) return null;
    const current = project?.work?.generationId ? await ctx.db.get(project.work.generationId) : null;
    if (current?.recordsGenerationId === generationId) return null;
    if (generation.recordsGenerationId) {
      await ctx.db.delete(generationId);
      return null;
    }
    const rows = await ctx.db
      .query('projectWorkRecords')
      .withIndex('by_generation', q => q.eq('generationId', generationId))
      .take(100);
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length === 100)
      await ctx.scheduler.runAfter(0, internal.projectWorkIndexStore.retire, {
        generationId,
        projectId: generation.projectId,
      });
    else await ctx.db.delete(generationId);
    return null;
  },
});
/** Return preparation pages point lookups by response bytes as well as keys. */
export const returnLookups = internalQuery({
  args: {
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    generationId: v.id('projectWorkGenerations'),
    keys: v.array(v.object({ collection: v.string(), key: v.string() })),
  },
  returns: v.array(v.union(indexEntry, v.null())),
  handler: async (ctx, input) => {
    const project = await workProject(ctx, await accessibleProject(ctx, input.projectId, input.owner));
    const generation = await selectedGeneration(ctx, project);
    invariant(generation?._id === input.generationId, 'WORK_STALE', 'Hosted Work changed.');
    invariant(input.keys.length <= 1000, 'BAD_ARGUMENT', 'Page return lookups.');
    const result: (import('../src/work-hosted-index').IndexEntry | null)[] = [];
    let bytes = 0;
    for (const key of input.keys) {
      const row = await record(ctx, recordPartition(generation), key.collection, key.key);
      const size = row ? new TextEncoder().encode(JSON.stringify(row)).byteLength : 4;
      if (result.length && bytes + size > 2 * 1024 * 1024) break;
      result.push(
        row
          ? {
              collection: row.collection,
              key: row.key,
              parent: row.parent,
              position: row.position,
              value: row.value,
              ...(row.status ? { status: row.status } : {}),
              ...(row.actor ? { actor: row.actor } : {}),
            }
          : null,
      );
      bytes += size;
    }
    return result;
  },
});
/** Only keys are needed to remove obsolete file rows across changed Views. */
export const returnViewFiles = internalQuery({
  args: {
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    generationId: v.id('projectWorkGenerations'),
    viewIds: v.array(v.string()),
    view: v.number(),
    after: v.number(),
  },
  returns: v.object({ keys: v.array(v.string()), view: v.number(), after: v.number(), bytes: v.number() }),
  handler: async (ctx, input) => {
    const project = await workProject(ctx, await accessibleProject(ctx, input.projectId, input.owner));
    const generation = await selectedGeneration(ctx, project);
    invariant(generation?._id === input.generationId, 'WORK_STALE', 'Hosted Work changed.');
    invariant(input.viewIds.length <= 100, 'BAD_ARGUMENT', 'Page changed Views.');
    const keys: string[] = [];
    let view = input.view,
      after = input.after,
      bytes = 0;
    while (view < input.viewIds.length && keys.length < 1000 && bytes < 2 * 1024 * 1024) {
      const rows = await ctx.db
        .query('projectWorkRecords')
        .withIndex('by_generation_and_collection_and_parent_and_position', q =>
          q
            .eq('generationId', recordPartition(generation))
            .eq('collection', 'viewFiles')
            .eq('parent', input.viewIds[view]!)
            .gt('position', after),
        )
        .take(Math.min(100, 1000 - keys.length));
      for (const row of rows) {
        keys.push(row.key);
        bytes += new TextEncoder().encode(JSON.stringify(row)).byteLength + 2048;
        after = row.position;
      }
      if (rows.length < Math.min(100, 1000 - (keys.length - rows.length))) {
        view++;
        after = -1;
      }
    }
    return { keys, view, after, bytes };
  },
});
export const lookups = internalQuery({
  args: {
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    generationId: v.optional(v.id('projectWorkGenerations')),
    backupId: v.optional(v.id('projectBackups')),
    keys: v.array(v.object({ collection: v.string(), key: v.string() })),
  },
  returns: v.array(
    v.union(
      v.object({
        status: v.optional(v.string()),
        actor: v.optional(v.string()),
        collection: v.string(),
        key: v.string(),
        parent: v.string(),
        position: v.number(),
        value: v.string(),
      }),
      v.null(),
    ),
  ),
  handler: async (ctx, input) => {
    const project = await workProject(ctx, await accessibleProject(ctx, input.projectId, input.owner)),
      generation = await selectedGeneration(ctx, project);
    invariant(input.generationId || input.backupId, 'BAD_ARGUMENT', 'Pin a generation or checkpoint.');
    if (
      !generation ||
      (input.generationId && generation._id !== input.generationId) ||
      (input.backupId && generation.backupId !== input.backupId)
    ) {
      // Exact-backup source reads may use their retained manifest when its disposable index is absent.
      if (!input.generationId && input.backupId) return input.keys.map(() => null);
      invariant(false, 'WORK_STALE', 'Hosted source or Work changed.');
    }
    return await Promise.all(
      input.keys.map(async key => {
        const row = await record(ctx, recordPartition(generation), key.collection, key.key);
        return row
          ? {
              ...(row.status ? { status: row.status } : {}),
              ...(row.actor === undefined ? {} : { actor: row.actor }),
              collection: row.collection,
              key: row.key,
              parent: row.parent,
              position: row.position,
              value: row.value,
            }
          : null;
      }),
    );
  },
});
/** Reclaim superseded/abandoned derived builds by source binding, never age. */
export const sweep = internalMutation({
  args: { projectId: v.id('hostedProjects'), cursor: v.union(v.string(), v.null()) },
  returns: v.null(),
  handler: async (ctx, { projectId, cursor }) => {
    const project = await ctx.db.get(projectId);
    projectExecution(ctx, projectId, project?.name, project?.key);
    if (!project) return null;
    const page = await ctx.db
      .query('projectWorkGenerations')
      .withIndex('by_project', q => q.eq('projectId', projectId))
      .paginate({ cursor, numItems: 100 });
    for (const generation of page.page)
      if (
        project.work?.generationId !== generation._id &&
        (generation.format !== HOSTED_WORK_INDEX_FORMAT ||
          project.work?.backupId !== generation.backupId ||
          project.work.revision !== generation.revision)
      ) {
        await ctx.scheduler.runAfter(0, internal.projectWorkIndexStore.retire, {
          generationId: generation._id,
          projectId: generation.projectId,
        });
      }
    if (!page.isDone)
      await ctx.scheduler.runAfter(0, internal.projectWorkIndexStore.sweep, {
        projectId,
        cursor: page.continueCursor,
      });
    return null;
  },
});
export const retirePayload = internalMutation({
  args: {
    generationId: v.id('projectWorkGenerations'),
    projectId: v.optional(v.id('hostedProjects')),
    collection: v.string(),
    key: v.string(),
    payloadKey: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    const projectId = input.projectId ?? (await ctx.db.get(input.generationId))?.projectId;
    if (projectId) projectExecution(ctx, projectId);
    const header = await record(ctx, input.generationId, input.collection, input.key);
    if (header && JSON.parse(header.value).payloadKey === input.payloadKey) return null;
    const rows = await ctx.db
      .query('projectWorkRecords')
      .withIndex('by_generation_and_collection_and_parent_and_position', q =>
        q
          .eq('generationId', input.generationId)
          .eq('collection', `${input.collection}:payload`)
          .eq('parent', input.payloadKey),
      )
      .take(100);
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length === 100)
      await ctx.scheduler.runAfter(0, internal.projectWorkIndexStore.retirePayload, {
        ...input,
        ...(projectId ? { projectId } : {}),
      });
    return null;
  },
});
export const payload = internalQuery({
  args: {
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    generationId: v.id('projectWorkGenerations'),
    collection: v.string(),
    parent: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.object({ values: v.array(v.string()), cursor: v.union(v.string(), v.null()) }),
  handler: async (ctx, input) => {
    const project = await workProject(ctx, await accessibleProject(ctx, input.projectId, input.owner)),
      generation = await selectedGeneration(ctx, project);
    invariant(generation?._id === input.generationId, 'WORK_STALE', 'Hosted source or Work changed.');
    const page = await ctx.db
      .query('projectWorkRecords')
      .withIndex('by_generation_and_collection_and_parent_and_position', q =>
        q
          .eq('generationId', recordPartition(generation))
          .eq('collection', `${input.collection}:payload`)
          .eq('parent', input.parent),
      )
      .paginate({ cursor: input.cursor, numItems: 100 });
    return { values: page.page.map(row => row.value), cursor: page.isDone ? null : page.continueCursor };
  },
});

/** Bounded provenance replacement; unchanged Views never scan their file rows. */
export const viewFiles = internalQuery({
  args: {
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    generationId: v.id('projectWorkGenerations'),
    viewId: v.string(),
    cursor: v.union(v.string(), v.null()),
  },
  returns: v.object({ entries: v.array(indexEntry), cursor: v.union(v.string(), v.null()) }),
  handler: async (ctx, input) => {
    const project = await workProject(ctx, await accessibleProject(ctx, input.projectId, input.owner)),
      generation = await selectedGeneration(ctx, project);
    invariant(generation?._id === input.generationId, 'WORK_STALE', 'Hosted source or Work changed.');
    const page = await ctx.db
      .query('projectWorkRecords')
      .withIndex('by_generation_and_collection_and_parent_and_position', q =>
        q
          .eq('generationId', recordPartition(generation))
          .eq('collection', 'viewFiles')
          .eq('parent', input.viewId),
      )
      .paginate({ cursor: input.cursor, numItems: 100, maximumBytesRead: 500000 });
    return {
      entries: page.page.map(({ collection, key, parent, position, value }) => ({
        collection,
        key,
        parent,
        position,
        value,
      })),
      cursor: page.isDone ? null : page.continueCursor,
    };
  },
});
