// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Team grants on a project (Item b6588425; docs/access.md#teams): `projectTeams` rows link the owner's teams to a
// project, each with its own role. The person's effective role is the highest of their direct grant and every team.
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';

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

/** People holding write through the project's linked teams (at most `limit`), for the rare listing of everyone who can
 * work here. A project without links reads nothing; otherwise one bounded read of its links, then a point read and one
 * bounded member read per write team. Never on a per-call authorization path (`teamGrant` is that). */
export async function teamWriters(ctx: QueryCtx | MutationCtx, project: Project, limit: number) {
  if (!project.teamLinks) return [];
  const links = await ctx.db
    .query('projectTeams')
    .withIndex('by_projectId_and_teamId', q => q.eq('projectId', project._id))
    .take(PROJECT_TEAM_LINKS);
  const writers = new Set<string>();
  for (const link of links) {
    if (link.role !== 'write' || writers.size >= limit) continue;
    const team = await ctx.db.get(link.teamId);
    if (!team || team.removal || team.owner !== project.owner) continue;
    const rows = await ctx.db
      .query('teamMembers')
      .withIndex('by_teamId_and_member', q => q.eq('teamId', link.teamId))
      .take(limit);
    for (const row of rows) if (writers.size < limit) writers.add(row.member);
  }
  return [...writers];
}

// Projects a person reaches only through a linked team (Item b6588425 line 4e; docs/access.md#teams), for the two
// lists that follow direct grants: Account > Projects (convex/accountProjects.ts) and the device project picker
// (projectContributors.shared). Read time, bounded, first page only; nothing is written and no row is kept per
// person, so a team change costs the writer nothing and the next read sees it.
//
// Reads: one indexed range of the person's team rows (at most REACHED_TEAMS). A person in no team stops there:
// zero documents, zero bytes. Otherwise one point read per team, one range of at most REACHED_LINKS links per live
// team, and per candidate project one point read plus one range for the person's own order row (a project they hold
// directly is listed by its own page, so it is skipped here). A project whose `teamLinks` is 0 is skipped (`teamGrant` would refuse it). At most REACHED_SCAN candidates are read, and the walk
// stops at REACHED_PROJECTS reached projects.
export const REACHED_TEAMS = 20;
export const REACHED_LINKS = 25;
export const REACHED_PROJECTS = 25;
const REACHED_SCAN = 40;

/** The projects the person reaches through a team and holds no direct grant on, each with the strongest role a live
 * linked team gives (the team is the project owner's, not being deleted, and lists the person now: the same rule as
 * `teamGrant`). The project's own owner is skipped, since they hold it directly. */
export async function teamReachedProjects(ctx: QueryCtx, person: string, skipListed = true) {
  const memberships = await ctx.db
    .query('teamMembers')
    .withIndex('by_member_and_teamId', q => q.eq('member', person))
    .take(REACHED_TEAMS);
  if (!memberships.length) return [];
  const teams = await Promise.all(memberships.map(row => ctx.db.get(row.teamId)));
  const links = await Promise.all(
    teams.map(team =>
      team && !team.removal
        ? ctx.db
            .query('projectTeams')
            .withIndex('by_teamId_and_projectId', q => q.eq('teamId', team._id))
            .take(REACHED_LINKS)
        : [],
    ),
  );
  const candidates = new Map<Id<'hostedProjects'>, { owner: string; role: TeamRole }>();
  teams.forEach((team, index) => {
    for (const link of links[index]!) {
      const seen = candidates.get(link.projectId);
      if (!seen || rank[link.role] > rank[seen.role])
        candidates.set(link.projectId, { owner: team!.owner, role: link.role });
    }
  });
  const reached: { project: Doc<'hostedProjects'>; role: TeamRole }[] = [];
  let scanned = 0;
  for (const [projectId, { owner, role }] of candidates) {
    if (reached.length >= REACHED_PROJECTS || scanned++ >= REACHED_SCAN) break;
    const project = await ctx.db.get(projectId);
    if (
      !project ||
      project.removal ||
      !project.teamLinks ||
      project.owner !== owner ||
      project.owner === person
    )
      continue;
    // Account > Projects lists a project with an order row from that row (it can outlive a direct grant while a team
    // still gives access); the picker passes false and dedupes against its own grant page and lists.
    const direct =
      skipListed &&
      (await ctx.db
        .query('accountProjectOrder')
        .withIndex('by_project_and_person', q => q.eq('projectId', projectId).eq('person', person))
        .unique());
    if (!direct) reached.push({ project, role });
  }
  return reached;
}
