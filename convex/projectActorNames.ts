// SPDX-License-Identifier: Apache-2.0
import { workRecordTables } from './projectWorkRecordTables';
import { hostedPaths } from '../src/hosted-paths';
import { v } from 'convex/values';
import { internalQuery, type QueryCtx, type MutationCtx } from './server';
import type { Doc, Id } from './_generated/dataModel';
import { selectedGeneration, recordPartition } from './projectWorkIndexStore';
import { accessibleProject } from './projectAuthority';
import { coordinationAccess } from './projectAudience';
import { invariant } from '../src/errors';
import { projectRole } from './projectRole';
import { endInvitationEpoch } from './projectInvitationRevocation';
async function known(
  ctx: QueryCtx | MutationCtx,
  project: Doc<'hostedProjects'>,
  actor: string,
  reader: string,
  readsCoordination: () => Promise<boolean>,
) {
  if (actor === project.owner || actor === reader) return true;
  // Retained membership provides project provenance.
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
  // Sessions and messages are coordination: they name an actor only for a reader of coordination, so an outsider
  // cannot learn from this answer whether a member ran a session or sent or received a message (Item b6588425).
  const coordination = await readsCoordination();
  if (
    coordination &&
    ((
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
      ).length)
  )
    return true;
  if (
    coordination &&
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
    // The viewer's audience is read once per call, and only when a target needs it.
    let coordination: Promise<boolean> | undefined;
    const readsCoordination = () => (coordination ??= coordinationAccess(ctx, project, input.reader));
    for (const actor of new Set(input.actors)) {
      invariant(
        (await membership(ctx, project._id, actor)) &&
          (await known(ctx, project, actor, input.reader, readsCoordination)),
        'PROJECT_UNAVAILABLE',
        'Select an actor already visible in this project.',
      );
      result.push(actor);
    }
    return result;
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
export async function retainMembership(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  actor: string,
  owner?: string,
) {
  const projectOwner = owner ?? (await ctx.db.get(projectId))?.owner;
  const invitationsEndedBeforeEpoch = projectOwner
    ? await endInvitationEpoch(ctx, projectId, projectOwner)
    : undefined;
  const row = await ctx.db
    .query('projectActorNames')
    .withIndex('by_project_and_actor', q => q.eq('projectId', projectId).eq('actor', actor))
    .unique();
  const retained = {
    wasMember: true,
    ...(invitationsEndedBeforeEpoch !== undefined ? { invitationsEndedBeforeEpoch } : {}),
  };
  if (row) await ctx.db.patch(row._id, retained);
  else await ctx.db.insert('projectActorNames', { projectId, actor, ...retained });
}

async function membership(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>, actor: string) {
  const project = await ctx.db.get(projectId);
  if (project && (await projectRole(ctx, project, actor))) return 'current';
  const retained = await ctx.db
    .query('projectActorNames')
    .withIndex('by_project_and_actor', q => q.eq('projectId', projectId).eq('actor', actor))
    .unique();
  return retained?.wasMember ? 'former' : undefined;
}

async function formerMember(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>, actor: string) {
  return (await membership(ctx, projectId, actor)) === 'former';
}
