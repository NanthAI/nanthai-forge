// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { internalMutation, internalQuery } from './server';
import { isPublicProject } from './publicVisibility';
import { accountFor } from './urlIdentity';
import { accountSuspended } from './accountLimits';
import { weekOf } from './publicRead';
import { directoryDisplayName } from './publicDirectoryProjection';
import { publicRow } from './publicListing';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { invariant } from '../src/errors';

const pageSize = 128;
export const directoryAuditPage = 32;
const cursorArg = v.union(v.string(), v.null());

const reader = (ctx: QueryCtx, now: number) => {
  const handles = new Map<string, Promise<string | undefined>>();
  const lookup = async (owner: string) => {
    const [account, suspended] = await Promise.all([accountFor(ctx, owner), accountSuspended(ctx, owner)]);
    return suspended || account?.closing ? undefined : account?.handle;
  };
  return async (projectId: Id<'hostedProjects'>, known?: Doc<'projectPublic'>) => {
    const project = await ctx.db.get(projectId);
    if (!project || !isPublicProject(project) || !project.slug) return null;
    const listing = known ?? (await publicRow(ctx, projectId));
    if (!listing?.listed) return null;
    let handle = handles.get(project.owner);
    if (!handle) {
      handle = lookup(project.owner);
      handles.set(project.owner, handle);
    }
    const currentHandle = await handle;
    if (!currentHandle) return null;
    const { landings, days, main } = await weekOf(ctx, project, now);
    return {
      handle: currentHandle,
      id: project._id,
      slug: project.slug,
      name: directoryDisplayName(project.name),
      since: project._creationTime,
      stars: listing.stars,
      landings,
      days,
      main,
    };
  };
};
export type DirectoryRow = NonNullable<Awaited<ReturnType<ReturnType<typeof reader>>>>;

/** Read all rows only at initial publication. Later wakes use one small audit page. */
export const readSlice = internalQuery({
  args: { now: v.number(), cursor: cursorArg, audit: v.optional(v.boolean()) },
  handler: async (ctx: QueryCtx, { now, cursor, audit }) => {
    const { page, isDone, continueCursor } = await ctx.db
      .query('projectPublic')
      .withIndex('by_listed', q => q.eq('listed', true))
      .paginate({ numItems: audit ? directoryAuditPage : pageSize, cursor });
    const read = reader(ctx, now);
    const values = await Promise.all(page.map(row => read(row.projectId, row)));
    return { projects: values.filter(row => row !== null), cursor: isDone ? null : continueCursor };
  },
});

/** The marker survives project deletion and an unknown R2 outcome; serials newer than the action are not consumed. */
export async function markDirectoryChange(ctx: MutationCtx, projectId: Id<'hostedProjects'>, serial: number) {
  const changed = await ctx.db
    .query('publicDirectoryChanges')
    .withIndex('by_source', q => q.eq('source', projectId))
    .unique();
  if (!changed) await ctx.db.insert('publicDirectoryChanges', { source: projectId, serial });
  else if (changed.serial < serial) await ctx.db.patch(changed._id, { serial });
}

export const changedSlice = internalQuery({
  args: { now: v.number(), serial: v.number(), cursor: cursorArg },
  handler: async (ctx, { now, serial, cursor }) => {
    const page = await ctx.db
      .query('publicDirectoryChanges')
      .withIndex('by_serial', q => q.lte('serial', serial))
      .paginate({ numItems: pageSize, cursor });
    const read = reader(ctx, now);
    const changes = await Promise.all(
      page.page.map(async ({ source }) => ({ projectId: source, row: await read(source) })),
    );
    return { changes, cursor: page.isDone ? null : page.continueCursor };
  },
});

export const checkPublished = internalQuery({
  args: { now: v.number(), ids: v.array(v.id('hostedProjects')) },
  handler: async (ctx, { now, ids }) => {
    invariant(ids.length <= directoryAuditPage, 'BAD_ARGUMENT', 'Directory drift checks are bounded.');
    const read = reader(ctx, now);
    return Promise.all(ids.map(async projectId => ({ projectId, row: await read(projectId) })));
  },
});

export const consumeChanges = internalMutation({
  args: { id: v.id('publicSnapshotJobs'), serial: v.number() },
  handler: async (ctx, { id, serial }): Promise<'stale' | 'done' | 'more'> => {
    const job = await ctx.db.get(id);
    if (job?.key !== 'directory' || job.serial !== serial || job.phase !== 'running') return 'stale';
    const rows = await ctx.db
      .query('publicDirectoryChanges')
      .withIndex('by_serial', q => q.lte('serial', serial))
      .take(pageSize);
    for (const row of rows) await ctx.db.delete(row._id);
    return rows.length < pageSize ? 'done' : 'more';
  },
});
