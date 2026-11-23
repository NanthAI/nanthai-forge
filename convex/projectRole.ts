// SPDX-License-Identifier: Apache-2.0
// The one place a project role is resolved (Item b987e608; docs/access.md). Every access check reads membership here:
// the owner costs no read, write one indexed read, read at most two. A project with team grants (Item b6588425) adds
// one indexed read of the actor's team rows, and one point read of a matching team, only after the direct grants miss.
// Membership is current-state only: a removed person's next call reads no row and is refused, with no cache to expire.
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import type { ProjectRole } from './projectAccessContract';
import { rememberMemberWorkBudget } from './abuseLimits';
import { teamGrant } from './teamGrant';

type Project = Pick<Doc<'hostedProjects'>, '_id' | 'owner' | 'teamLinks'>;
// Roles a transaction checked. Authorization reads current membership; one query reuses its own check (one snapshot).
const checkedRoles = new WeakMap<object, Map<string, ProjectRole | null>>();
const roleKey = (project: Project, actor: string) => `${project._id}:${actor}`;
export function checkedProjectRole(ctx: QueryCtx, project: Project, actor: string) {
  return checkedRoles.get(ctx.auth ?? ctx.db)?.get(roleKey(project, actor));
}
function checked(ctx: QueryCtx | MutationCtx, project: Project, actor: string, role: ProjectRole | null) {
  const key = ctx.auth ?? ctx.db;
  let roles = checkedRoles.get(key);
  if (!roles) checkedRoles.set(key, (roles = new Map()));
  roles.set(roleKey(project, actor), role);
  return role;
}

const queryAuths = new WeakSet<object>();
/** The public query boundary marks its query: a role it checked is reused for the rest of that query (one snapshot).
 * Mutations are never marked, since one can change membership in its own transaction. */
export function shareQueryRoles(ctx: QueryCtx) {
  if (ctx.auth) queryAuths.add(ctx.auth);
}
/** A role this query already checked: no second membership read. */
const checkedInQuery = (ctx: QueryCtx | MutationCtx, project: Project, actor: string) =>
  ctx.auth && queryAuths.has(ctx.auth) ? checkedProjectRole(ctx as QueryCtx, project, actor) : undefined;

/** Write membership only (one indexed read; the owner none). */
export async function hasWriteRole(ctx: QueryCtx | MutationCtx, project: Project, actor: string) {
  if (project.owner === actor) return true;
  const known = checkedInQuery(ctx, project, actor);
  if (known !== undefined) return known === 'write';
  const member = await contributorRow(ctx, project._id, actor);
  if (member) {
    rememberMemberWorkBudget(ctx, member);
    checked(ctx, project, actor, 'write');
    return true;
  }
  const team = await teamGrant(ctx, project, actor);
  if (team) checked(ctx, project, actor, team.role);
  return team?.role === 'write';
}

/** The actor's current role on the project, or null for no grant (public visibility is not a role). */
export async function projectRole(
  ctx: QueryCtx | MutationCtx,
  project: Project,
  actor: string,
): Promise<ProjectRole | null> {
  if (project.owner === actor) return 'owner';
  const known = checkedInQuery(ctx, project, actor);
  if (known !== undefined) return known;
  if (await contributorRow(ctx, project._id, actor)) return checked(ctx, project, actor, 'write');
  const team = await teamGrant(ctx, project, actor);
  if (team) return checked(ctx, project, actor, team.role);
  const reader = await ctx.db
    .query('projectReaders')
    .withIndex('by_project_and_reader', q => q.eq('projectId', project._id).eq('reader', actor))
    .unique();
  return checked(ctx, project, actor, reader ? 'read' : null);
}

function contributorRow(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>, actor: string) {
  return ctx.db
    .query('projectContributors')
    .withIndex('by_project_and_contributor', q => q.eq('projectId', projectId).eq('contributor', actor))
    .unique();
}
