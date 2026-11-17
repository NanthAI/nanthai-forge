// SPDX-License-Identifier: Apache-2.0
// The one place a project role is resolved (Item b987e608; docs/access.md). Every access check reads membership here:
// the owner costs no read, write one indexed read, read at most two. Membership is current-state only: a removed
// person's next call reads no row and is refused, with no cache to expire.
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import type { ProjectRole } from './projectAccessContract';

type Project = Pick<Doc<'hostedProjects'>, '_id' | 'owner'>;

/** Write membership only (one indexed read; the owner none). */
export async function hasWriteRole(ctx: QueryCtx | MutationCtx, project: Project, actor: string) {
  if (project.owner === actor) return true;
  return !!(await contributorRow(ctx, project._id, actor));
}

/** The actor's current role on the project, or null for no grant (public visibility is not a role). */
export async function projectRole(
  ctx: QueryCtx | MutationCtx,
  project: Project,
  actor: string,
): Promise<ProjectRole | null> {
  if (project.owner === actor) return 'owner';
  if (await contributorRow(ctx, project._id, actor)) return 'write';
  const reader = await ctx.db
    .query('projectReaders')
    .withIndex('by_project_and_reader', q => q.eq('projectId', project._id).eq('reader', actor))
    .unique();
  return reader ? 'read' : null;
}

function contributorRow(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>, actor: string) {
  return ctx.db
    .query('projectContributors')
    .withIndex('by_project_and_contributor', q => q.eq('projectId', projectId).eq('contributor', actor))
    .unique();
}
