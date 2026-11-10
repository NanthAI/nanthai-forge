// SPDX-License-Identifier: Apache-2.0
import { workRecordTables } from './projectWorkRecordTables';
import { hostedPaths } from '../src/hosted-paths';
import { v } from 'convex/values';
import { internalMutation, internalQuery, type QueryCtx, type MutationCtx } from './server';
import type { Doc, Id } from './_generated/dataModel';
import { selectedGeneration, recordPartition } from './projectWorkIndexStore';
import { accessibleProject } from './projectAuthority';
import { invariant } from '../src/errors';
async function known(
  ctx: QueryCtx | MutationCtx,
  project: Doc<'hostedProjects'>,
  actor: string,
  reader: string,
) {
  if (actor === project.owner || actor === reader) return true;
  // A cached name alone is never membership or identity authority.
  if (
    (
      await ctx.db
        .query('projectActorNames')
        .withIndex('by_project_and_actor', q => q.eq('projectId', project._id).eq('actor', actor))
        .unique()
    )?.wasMember
  )
    return true;
  const participant = await ctx.db
    .query('projectContributors')
    .withIndex('by_project_and_contributor', q => q.eq('projectId', project._id).eq('contributor', actor))
    .unique();
  if (reader === project.owner && participant) return true; // The owner can already read the roster.
  if (
    (
      await ctx.db
        .query('projectCoordinationSessions')
        .withIndex('by_project_and_actor', q => q.eq('projectId', project._id).eq('actor', actor))
        .take(1)
    ).length ||
    (
      await ctx.db
        .query('projectCoordinationEvents')
        .withIndex('by_project_and_actor', q => q.eq('projectId', project._id).eq('actor', actor))
        .take(1)
    ).length
  )
    return true;
  if (
    (
      await ctx.db
        .query('projectCoordinationEvents')
        .withIndex('by_project_and_recipientActor', q =>
          q.eq('projectId', project._id).eq('recipientActor', actor),
        )
        .take(1)
    ).length
  )
    return true;
  // Imported actor declarations are data, never fresh identity authority. The
  // account must also be a current participant, and the actor ID already readable.
  const generation = participant ? await selectedGeneration(ctx, project) : null;
  if (!generation) return false;
  for (const table of workRecordTables) {
    if (
      (
        await ctx.db
          .query(table)
          .withIndex('by_generation_and_actor', q =>
            q.eq('generationId', recordPartition(generation)).eq('actor', actor),
          )
          .take(1)
      ).length
    )
      return true;
  }
  return false;
}
const args = { projectId: v.id('hostedProjects'), reader: v.string(), actors: v.array(v.string()) };
export const authorize = internalQuery({
  args,
  returns: v.array(v.string()),
  handler: async (ctx, input) => {
    const project = await accessibleProject(ctx, input.projectId, input.reader);
    const result: string[] = [];
    for (const actor of new Set(input.actors)) {
      invariant(
        (await membership(ctx, project._id, actor)) && (await known(ctx, project, actor, input.reader)),
        'PROJECT_UNAVAILABLE',
        'Select an actor already visible in this project.',
      );
      result.push(actor);
    }
    return result;
  },
});
/** One-time cleanup of stored provider display names (personal data we must not hold). Retry the
 * returned cursor until `isDone`. Former-member provenance (`wasMember`) is kept; every other row
 * existed only for its name and is deleted. Each call touches at most 100 rows. */
export const purgeDisplayNames = internalMutation({
  args: { cursor: v.union(v.string(), v.null()) },
  returns: v.object({
    cursor: v.string(),
    isDone: v.boolean(),
    deleted: v.number(),
    cleared: v.number(),
  }),
  handler: async (ctx, input) => {
    const page = await ctx.db.query('projectActorNames').paginate({ cursor: input.cursor, numItems: 100 });
    let deleted = 0,
      cleared = 0;
    for (const row of page.page) {
      if (row.displayName === undefined) continue;
      if (row.wasMember) {
        await ctx.db.patch(row._id, { displayName: undefined });
        cleared++;
      } else {
        await ctx.db.delete(row._id);
        deleted++;
      }
    }
    return { cursor: page.continueCursor, isDone: page.isDone, deleted, cleared };
  },
});
/** Only call after current project read authority has been established. People are named
 * by handle at the public boundary (convex/publicPeople.ts); no provider name is added here. */
export async function actorSummary(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  value: string,
  former?: Map<string, Promise<boolean>>,
) {
  const row = JSON.parse(value) as {
    actor?: unknown;
    actorFormerMember?: boolean;
    actorDisplayName?: string;
  };
  delete row.actorFormerMember;
  delete row.actorDisplayName;
  if (typeof row.actor !== 'string') return JSON.stringify(hostedPaths(row));
  let pending = former?.get(row.actor);
  if (!pending) {
    pending = formerMember(ctx, projectId, row.actor);
    former?.set(row.actor, pending);
  }
  return JSON.stringify(hostedPaths({ ...row, ...((await pending) ? { actorFormerMember: true } : {}) }));
}

export async function withActorName<T extends { actor: string }>(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  row: T,
) {
  const former = await formerMember(ctx, projectId, row.actor);
  const result = { ...row } as T & { actorFormerMember?: boolean; actorDisplayName?: string };
  delete result.actorFormerMember;
  delete result.actorDisplayName;
  return hostedPaths({ ...result, ...(former ? { actorFormerMember: true } : {}) });
}

/** Preserve membership provenance before deleting a live grant. No name is stored. */
export async function retainMembership(ctx: MutationCtx, projectId: Id<'hostedProjects'>, actor: string) {
  const row = await ctx.db
    .query('projectActorNames')
    .withIndex('by_project_and_actor', q => q.eq('projectId', projectId).eq('actor', actor))
    .unique();
  if (row) await ctx.db.patch(row._id, { wasMember: true });
  else await ctx.db.insert('projectActorNames', { projectId, actor, wasMember: true });
}

async function membership(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>, actor: string) {
  const project = await ctx.db.get(projectId);
  if (project?.owner === actor) return 'current';
  const contributor = await ctx.db
    .query('projectContributors')
    .withIndex('by_project_and_contributor', q => q.eq('projectId', projectId).eq('contributor', actor))
    .unique();
  const reader = await ctx.db
    .query('projectReaders')
    .withIndex('by_project_and_reader', q => q.eq('projectId', projectId).eq('reader', actor))
    .unique();
  if (contributor || reader) return 'current';
  const retained = await ctx.db
    .query('projectActorNames')
    .withIndex('by_project_and_actor', q => q.eq('projectId', projectId).eq('actor', actor))
    .unique();
  return retained?.wasMember ? 'former' : undefined;
}

async function formerMember(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>, actor: string) {
  return (await membership(ctx, projectId, actor)) === 'former';
}
