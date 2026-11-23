// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Team access to a project (Item b6588425; docs/access.md#teams). The owner links their own teams, each with read or
// write; every current member of a linked team gets that role, and leaving the team removes it on the next call.
import { v } from 'convex/values';
import { mutation, query } from './cliServer';
import { activeOwnedProject, ownedProject } from './projectAuthority';
import { requireOwnerPerson } from './ownerPerson';
import { PROJECT_TEAM_LINKS } from './teamGrant';
import { continueMarking, markTeamPage } from './sealedSecretMarkers';
import { invariant } from '../src/errors';
import { report } from './errors';

const role = v.union(v.literal('read'), v.literal('write'));

/** Give one of the owner's teams a role on the project, change it, or remove it (`role: null`). Person-only, like
 * adding people. Compare-and-set on `revision`, the project's team-access revision the owner read (`list`): a
 * retry after its own commit finds the role already set and returns; any other change since bumps the revision and
 * refuses, so a lost-response retry cannot re-grant a link the owner removed. One link row, the link count and the
 * revision change in one transaction. */
export const set = mutation({
  args: {
    projectId: v.id('hostedProjects'),
    teamId: v.id('teams'),
    role: v.union(role, v.null()),
    revision: v.number(),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    try {
      const user = await requireOwnerPerson(ctx, 'give a team access');
      const project = await activeOwnedProject(ctx, input.projectId, user.subject);
      const link = await ctx.db
        .query('projectTeams')
        .withIndex('by_projectId_and_teamId', q => q.eq('projectId', project._id).eq('teamId', input.teamId))
        .unique();
      if ((link?.role ?? null) === input.role) return null;
      const revision = project.teamRevision ?? 0;
      invariant(
        revision === input.revision,
        'WORK_OPERATION_CHANGED',
        'This team’s access changed since you read it. Reload People and access.',
      );
      if (!link) {
        const team = await ctx.db.get(input.teamId);
        invariant(
          team && team.owner === user.subject && !team.removal,
          'BAD_ARGUMENT',
          'Choose one of your own teams.',
        );
        invariant(
          (project.teamLinks ?? 0) < PROJECT_TEAM_LINKS,
          'BAD_ARGUMENT',
          `A project can link at most ${PROJECT_TEAM_LINKS} teams.`,
        );
        await ctx.db.insert('projectTeams', {
          projectId: project._id,
          teamId: input.teamId,
          role: input.role!,
        });
        await ctx.db.patch(project._id, {
          teamLinks: (project.teamLinks ?? 0) + 1,
          teamRevision: revision + 1,
        });
      } else if (input.role === null) {
        await ctx.db.delete(link._id);
        await ctx.db.patch(project._id, {
          teamLinks: Math.max(0, (project.teamLinks ?? 1) - 1),
          teamRevision: revision + 1,
        });
      } else {
        await ctx.db.patch(link._id, { role: input.role });
        await ctx.db.patch(project._id, { teamRevision: revision + 1 });
      }
      // Unlinking a write team or lowering it to read: its members who no longer write are marked for sealed-secret
      // removal, as a direct removal is (convex/sealedSecretMarkers.ts). A team larger than one step continues in a
      // scheduled step.
      if (link?.role === 'write') {
        const step = await markTeamPage(ctx, project, input.teamId, null);
        if (step.next !== null) await continueMarking(ctx, project._id, input.teamId, step.next);
      }
      return null;
    } catch (error) {
      return report(error);
    }
  },
});

/** The project's team links with their names and the revision `set` compares, for the owner. One bounded read plus
 * one point read per team. */
export const list = query({
  args: { projectId: v.id('hostedProjects') },
  returns: v.object({
    revision: v.number(),
    teams: v.array(v.object({ teamId: v.id('teams'), name: v.string(), role })),
  }),
  handler: async (ctx, { projectId }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to manage project access.');
      const project = await ownedProject(ctx, projectId, user.subject);
      const links = await ctx.db
        .query('projectTeams')
        .withIndex('by_projectId_and_teamId', q => q.eq('projectId', projectId))
        .take(PROJECT_TEAM_LINKS);
      const rows = [];
      for (const link of links) {
        const team = await ctx.db.get(link.teamId);
        if (team && !team.removal) rows.push({ teamId: link.teamId, name: team.name, role: link.role });
      }
      return { revision: project.teamRevision ?? 0, teams: rows };
    } catch (error) {
      return report(error);
    }
  },
});
