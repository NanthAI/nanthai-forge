import { hostedPaths } from '../src/hosted-paths';
// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalQuery, internalMutation, type QueryCtx, type MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { selectedGeneration, recordPartition } from './projectWorkIndexStore';
import { accessibleProject } from './projectAuthority';
import { invariant } from '../src/errors';
export async function actorName(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>, actor: string) {
  const user = await ctx.auth.getUserIdentity();
  if (!user) return undefined;
  const project = await accessibleProject(ctx, projectId, user.subject);
  if (!(await membership(ctx, projectId, actor)) || !(await known(ctx, project, actor, user.subject)))
    return undefined;
  return (
    await ctx.db
      .query('projectActorNames')
      .withIndex('by_project_and_actor', q => q.eq('projectId', projectId).eq('actor', actor))
      .unique()
  )?.displayName;
}
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
  return !!(
    generation &&
    (
      await ctx.db
        .query('projectWorkRecords')
        .withIndex('by_generation_and_actor', q =>
          q.eq('generationId', recordPartition(generation)).eq('actor', actor),
        )
        .take(1)
    ).length
  );
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
export const remember = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    reader: v.string(),
    labels: v.array(v.object({ actor: v.string(), displayName: v.string() })),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    const project = await accessibleProject(ctx, input.projectId, input.reader);
    for (const label of input.labels) {
      invariant(
        (await membership(ctx, project._id, label.actor)) &&
          (await known(ctx, project, label.actor, input.reader)),
        'PROJECT_UNAVAILABLE',
        'Select an actor already visible in this project.',
      );
      const row = await ctx.db
        .query('projectActorNames')
        .withIndex('by_project_and_actor', q => q.eq('projectId', project._id).eq('actor', label.actor))
        .unique();
      if (row) await ctx.db.patch(row._id, { displayName: label.displayName });
      else await ctx.db.insert('projectActorNames', { projectId: project._id, ...label });
    }
    return null;
  },
});
/** Only call after current project read authority has been established. */
export async function actorSummary(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  value: string,
  names?: Map<string, Promise<string | undefined>>,
) {
  const row = JSON.parse(value) as {
    actor?: unknown;
    actorFormerMember?: boolean;
    actorDisplayName?: string;
  };
  delete row.actorFormerMember;
  delete row.actorDisplayName;
  if (typeof row.actor !== 'string') return JSON.stringify(hostedPaths(row));
  let pending = names?.get(row.actor);
  if (!pending) {
    pending = actorName(ctx, projectId, row.actor);
    names?.set(row.actor, pending);
  }
  const displayName = await pending;
  const former = displayName && (await formerMember(ctx, projectId, row.actor));
  return JSON.stringify(
    hostedPaths({
      ...row,
      ...(displayName ? { actorDisplayName: displayName } : {}),
      ...(former ? { actorFormerMember: true } : {}),
    }),
  );
}

export async function rememberActor(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  actor: string,
  name?: string,
) {
  if (!name || name.includes('@')) return;
  const row = await ctx.db
    .query('projectActorNames')
    .withIndex('by_project_and_actor', q => q.eq('projectId', projectId).eq('actor', actor))
    .unique();
  if (row) await ctx.db.patch(row._id, { displayName: name });
  else await ctx.db.insert('projectActorNames', { projectId, actor, displayName: name });
}
export async function withActorName<T extends { actor: string }>(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  row: T,
) {
  const name = await actorName(ctx, projectId, row.actor);
  const former = name && (await formerMember(ctx, projectId, row.actor));
  const result = { ...row } as T & { actorFormerMember?: boolean; actorDisplayName?: string };
  delete result.actorFormerMember;
  delete result.actorDisplayName;
  return hostedPaths({
    ...result,
    ...(name ? { actorDisplayName: name } : {}),
    ...(former ? { actorFormerMember: true } : {}),
  });
}

/** Preserve membership provenance before deleting a live grant, even without a name. */
export async function retainMembership(ctx: MutationCtx, projectId: Id<'hostedProjects'>, actor: string) {
  const row = await ctx.db
    .query('projectActorNames')
    .withIndex('by_project_and_actor', q => q.eq('projectId', projectId).eq('actor', actor))
    .unique();
  if (row) await ctx.db.patch(row._id, { wasMember: true });
  else await ctx.db.insert('projectActorNames', { projectId, actor, displayName: '', wasMember: true });
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
