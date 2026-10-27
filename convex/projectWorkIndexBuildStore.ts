// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import { internalQuery, internalMutation, type QueryCtx } from './_generated/server';
import { accessibleProject } from './projectAuthority';
import { workProject } from './projectWorkHead';
import { record } from './projectWorkIndexStore';
import { generationDocument, indexEntry } from './projectWorkIndexFields';
import { indexActivity } from '../src/work-hosted-index';
import { invariant } from '../src/errors';
import { HOSTED_WORK_INDEX_FORMAT } from '../src/work-hosted-summary';
const identity = { projectId: v.id('hostedProjects'), owner: v.string() };
const selected = { ...identity, generationId: v.id('projectWorkGenerations') };
export const resume = internalQuery({
  args: identity,
  returns: v.union(generationDocument, v.null()),
  handler: async (ctx, input) => {
    const project = await workProject(ctx, await accessibleProject(ctx, input.projectId, input.owner));
    if (!project.work) return null;
    const [generation] = await ctx.db
      .query('projectWorkGenerations')
      .withIndex('by_project_and_backup_and_revision_and_format', q =>
        q
          .eq('projectId', input.projectId)
          .eq('backupId', project.work!.backupId)
          .eq('revision', project.work!.revision)
          .eq('format', HOSTED_WORK_INDEX_FORMAT),
      )
      .order('desc')
      .take(1);
    return generation?.ensureCursor ? generation : null;
  },
});
const rowRequest = v.object({
  collection: v.string(),
  parent: v.optional(v.string()),
  offset: v.optional(v.number()),
  last: v.optional(v.boolean()),
});
type RowRequest = { collection: string; parent?: string; offset?: number; last?: boolean };
async function readRows(
  ctx: QueryCtx,
  input: RowRequest & { generationId: Doc<'projectWorkGenerations'>['_id'] },
) {
  const query =
    input.parent === undefined
      ? ctx.db.query('projectWorkRecords').withIndex('by_generation_and_collection_and_position', q =>
          q
            .eq('generationId', input.generationId)
            .eq('collection', input.collection)
            .gte('position', input.offset ?? 0),
        )
      : ctx.db
          .query('projectWorkRecords')
          .withIndex('by_generation_and_collection_and_parent_and_position', q =>
            q
              .eq('generationId', input.generationId)
              .eq('collection', input.collection)
              .eq('parent', input.parent!)
              .gte('position', input.offset ?? 0),
          );
  const rows = await query.order(input.last ? 'desc' : 'asc').take(input.last ? 1 : 100);
  return rows.map(({ collection, key, parent, position, value }) => ({
    collection,
    key,
    parent,
    position,
    value,
  }));
}
export const rows = internalQuery({
  args: { ...selected, ...rowRequest.fields },
  returns: v.array(indexEntry),
  handler: async (ctx, input) => {
    await accessibleProject(ctx, input.projectId, input.owner);
    const generation = await ctx.db.get(input.generationId);
    invariant(generation?.projectId === input.projectId, 'WORK_STALE', 'The index build changed.');
    return readRows(ctx, input);
  },
});
/** Read the first context pages for one summary window under one authority
 * snapshot. A bounded prefix is returned; remaining pages use ordinary rows. */
export const rowBatch = internalQuery({
  args: { ...selected, requests: v.array(rowRequest) },
  returns: v.array(v.array(indexEntry)),
  handler: async (ctx, input) => {
    await accessibleProject(ctx, input.projectId, input.owner);
    const generation = await ctx.db.get(input.generationId);
    invariant(generation?.projectId === input.projectId, 'WORK_STALE', 'The index build changed.');
    invariant(input.requests.length <= 30, 'BAD_ARGUMENT', 'Read one summary context window.');
    const result = [];
    let bytes = 0;
    for (const request of input.requests) {
      const rows = await readRows(ctx, { ...request, generationId: input.generationId });
      const size = new TextEncoder().encode(JSON.stringify(rows)).length;
      if (result.length && bytes + size > 500000) break;
      result.push(rows);
      bytes += size;
    }
    return result;
  },
});
export const lookup = internalQuery({
  args: { ...selected, collection: v.string(), key: v.string() },
  returns: v.union(indexEntry, v.null()),
  handler: async (ctx, input) => {
    await accessibleProject(ctx, input.projectId, input.owner);
    const generation = await ctx.db.get(input.generationId);
    invariant(generation?.projectId === input.projectId, 'WORK_STALE', 'The index build changed.');
    const row = await record(ctx, input.generationId, input.collection, input.key);
    return row
      ? {
          collection: row.collection,
          key: row.key,
          parent: row.parent,
          position: row.position,
          value: row.value,
        }
      : null;
  },
});
/** Rows and their computational continuation commit together. Unknown replies
 * reconcile the saved cursor; concurrent drivers cannot append the same step. */
export const step = internalMutation({
  args: {
    ...selected,
    expected: v.optional(v.string()),
    cursor: v.string(),
    entries: v.array(indexEntry),
    metadata: v.optional(v.string()),
    cleanup: v.optional(v.string()),
  },
  returns: v.union(generationDocument, v.null()),
  handler: async (ctx, input) => {
    const project = await workProject(ctx, await accessibleProject(ctx, input.projectId, input.owner));
    const generation = await ctx.db.get(input.generationId);
    invariant(generation?.projectId === input.projectId, 'WORK_STALE', 'The index build changed.');
    if (project.work?.backupId !== generation.backupId || project.work.revision !== generation.revision)
      return null;
    if (generation.status !== 'building' || generation.ensureCursor !== input.expected) return null;
    const metadata = {
      ...JSON.parse(input.metadata ?? generation.metadata),
      counts: JSON.parse(generation.metadata).counts,
    };
    const counts: Record<string, number> = metadata.counts;
    for (const entry of input.entries) {
      const old = await record(ctx, generation._id, entry.collection, entry.key);
      const fields = { ...entry, ...indexActivity(entry) };
      if (old) await ctx.db.patch(old._id, { ...fields, position: old.position });
      else {
        // Payload positions are offsets within one record, never collection positions.
        if (
          !entry.collection.endsWith(':payload') &&
          !['sourceTreePaths', 'sourceStateParentChunks'].includes(entry.collection)
        )
          fields.position = counts[entry.collection] ?? 0;
        counts[entry.collection] = (counts[entry.collection] ?? 0) + 1;
        await ctx.db.insert('projectWorkRecords', {
          projectId: input.projectId,
          generationId: generation._id,
          ...fields,
        });
      }
    }
    const [lastActive] = await ctx.db
      .query('projectWorkRecords')
      .withIndex('by_generation_and_collection_and_status_and_position', q =>
        q.eq('generationId', generation._id).eq('collection', 'intents').eq('status', 'active'),
      )
      .order('desc')
      .take(1);
    const [last] = lastActive
      ? []
      : await ctx.db
          .query('projectWorkRecords')
          .withIndex('by_generation_and_collection_and_position', q =>
            q.eq('generationId', generation._id).eq('collection', 'intents'),
          )
          .order('desc')
          .take(1);
    metadata.defaultIntentId = lastActive?.key ?? last?.key;
    let cursor = input.cursor;
    if (input.cleanup) {
      const rows =
        input.cleanup === '_pages'
          ? await ctx.db
              .query('projectReturnPages')
              .withIndex('by_partition_and_key_and_position', q => q.eq('partitionId', generation._id))
              .take(100)
          : await ctx.db
              .query('projectWorkRecords')
              .withIndex('by_generation_and_collection_and_position', q =>
                q.eq('generationId', generation._id).eq('collection', input.cleanup!),
              )
              .take(100);
      for (const row of rows) await ctx.db.delete(row._id);
      if (rows.length) cursor = generation.ensureCursor!;
    }
    const previous = generation.ensureCursor ? JSON.parse(generation.ensureCursor).output : undefined;
    const next = JSON.parse(cursor).output;
    if (previous && previous.key !== next?.key) {
      const pages = await ctx.db
        .query('projectReturnPages')
        .withIndex('by_partition_and_key_and_position', q =>
          q.eq('partitionId', generation._id).eq('key', previous.key),
        )
        .take(100);
      for (const page of pages) await ctx.db.delete(page._id);
    }
    const update = {
      ensureCursor: cursor,
      metadata: JSON.stringify(metadata),
      nextBatch: generation.nextBatch + 1,
    };
    await ctx.db.patch(generation._id, update);
    return { ...generation, ...update };
  },
});

const pageIdentity = { ...selected, key: v.string(), position: v.number() };
export const putPage = internalMutation({
  args: { ...pageIdentity, body: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    await accessibleProject(ctx, input.projectId, input.owner);
    const generation = await ctx.db.get(input.generationId);
    invariant(generation?.projectId === input.projectId, 'WORK_STALE', 'The index build changed.');
    const old = await ctx.db
      .query('projectReturnPages')
      .withIndex('by_partition_and_key_and_position', q =>
        q.eq('partitionId', input.generationId).eq('key', input.key).eq('position', input.position),
      )
      .unique();
    invariant(!old || old.body === input.body, 'WORK_OPERATION_CHANGED', 'The staged index page changed.');
    if (!old)
      await ctx.db.insert('projectReturnPages', {
        projectId: input.projectId,
        partitionId: input.generationId,
        key: input.key,
        position: input.position,
        body: input.body,
      });
    return null;
  },
});
export const readPage = internalQuery({
  args: pageIdentity,
  returns: v.string(),
  handler: async (ctx, input) => {
    await accessibleProject(ctx, input.projectId, input.owner);
    const generation = await ctx.db.get(input.generationId);
    invariant(generation?.projectId === input.projectId, 'WORK_STALE', 'The index build changed.');
    const page = await ctx.db
      .query('projectReturnPages')
      .withIndex('by_partition_and_key_and_position', q =>
        q.eq('partitionId', input.generationId).eq('key', input.key).eq('position', input.position),
      )
      .unique();
    invariant(page, 'WORK_STALE', 'The staged index page is unavailable.');
    return page.body;
  },
});
