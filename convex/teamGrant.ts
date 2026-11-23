// SPDX-License-Identifier: Apache-2.0
// Team grants on a project (Item b6588425; docs/access.md#teams): `projectTeams` rows link the owner's teams to a
// project, each with its own role. The person's effective role is the highest of their direct grant and every team.
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';

type Project = Pick<Doc<'hostedProjects'>, '_id' | 'owner' | 'teamLinks'>;
export type TeamRole = Doc<'projectTeams'>['role'];
/** Teams one project can link: the role check reads all of a project's links in one bounded read. */
export const PROJECT_TEAM_LINKS = 50;
/** Team rows read for one actor; a member of more teams falls back to one indexed read per linked team. */
const MEMBER_TEAM_ROWS = 50;
const rank: Record<TeamRole, number> = { read: 1, write: 2 };

/** The highest live team role the actor holds on the project: the team belongs to the project owner, is not being
 * deleted, and lists the actor now. A project without links reads nothing; otherwise one read of its links, one of
 * the actor's team rows, then the matching teams strongest first (one point read each, stopping at the first live
 * one). Removing a member deletes their team row, so their next call finds no grant. */
export async function teamGrant(ctx: QueryCtx | MutationCtx, project: Project, actor: string) {
  if (!project.teamLinks) return null;
  const links = await ctx.db
    .query('projectTeams')
    .withIndex('by_projectId_and_teamId', q => q.eq('projectId', project._id))
    .take(PROJECT_TEAM_LINKS);
  if (!links.length) return null;
  const granted = new Map<string, TeamRole>(links.map(link => [link.teamId, link.role]));
  let rows = await ctx.db
    .query('teamMembers')
    .withIndex('by_member_and_teamId', q => q.eq('member', actor))
    .take(MEMBER_TEAM_ROWS + 1);
  if (rows.length > MEMBER_TEAM_ROWS) {
    rows = [];
    for (const link of links) {
      const row = await ctx.db
        .query('teamMembers')
        .withIndex('by_teamId_and_member', q => q.eq('teamId', link.teamId).eq('member', actor))
        .unique();
      if (row) rows.push(row);
    }
  }
  const matches = rows
    .filter(row => granted.has(row.teamId))
    .sort((a, b) => rank[granted.get(b.teamId)!] - rank[granted.get(a.teamId)!]);
  for (const row of matches) {
    const team = await ctx.db.get(row.teamId);
    if (team && !team.removal && team.owner === project.owner)
      return { role: granted.get(row.teamId)!, member: row };
  }
  return null;
}
