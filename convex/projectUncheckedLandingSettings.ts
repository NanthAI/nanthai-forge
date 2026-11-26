// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { query } from './cliServer';
import { activeOwnedProject, projectSettingsReader } from './projectAuthority';
import { autonomyPolicy } from './autonomyFields';
import { effectivePolicy } from '../src/autonomy-policy';
import { invariant } from '../src/errors';
import { report } from './errors';
const selection = autonomyPolicy.fields.acceptance.fields.withoutCheck;
const initial = { mode: 'owner' as const, people: [], teams: [] };

/** Current policy and chosen team labels in one finite settings read. No landing caller uses it. */
export const read = query({
  args: { projectId: v.id('hostedProjects') },
  returns: v.object({ policy: autonomyPolicy, teamNames: v.record(v.string(), v.string()) }),
  handler: async (ctx, { projectId }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read the landing policy.');
      const project = await projectSettingsReader(ctx, projectId, user.subject);
      const policy = effectivePolicy(project);
      const teamNames: Record<string, string> = {};
      if (user.subject === project.owner)
        for (const value of policy.acceptance.withoutCheck?.teams ?? []) {
          const id = ctx.db.normalizeId('teams', value);
          const team = id ? await ctx.db.get(id) : null;
          if (team?.owner === project.owner && !team.removal) teamNames[value] = team.name;
        }
      return { policy, teamNames };
    } catch (e) {
      return report(e);
    }
  },
});

/** The same existing teams, paged directly by owner; choosing a team never grants write access. */
export const teams = query({
  args: { projectId: v.id('hostedProjects'), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(v.object({ id: v.id('teams'), name: v.string() })),
  handler: async (ctx, { projectId, paginationOpts }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to choose a team.');
      await activeOwnedProject(ctx, projectId, user.subject);
      const page = await ctx.db
        .query('teams')
        .withIndex('by_owner_and_operationId', q => q.eq('owner', user.subject))
        .paginate(paginationOpts);
      return {
        ...page,
        page: page.page.filter(team => !team.removal).map(team => ({ id: team._id, name: team.name })),
      };
    } catch (e) {
      return report(e);
    }
  },
});

/** Existing policy-change history, paged once on opening; Undo writes another ordinary policy edit. */
export const history = query({
  args: { projectId: v.id('hostedProjects'), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(
    v.object({ operationId: v.string(), at: v.string(), previous: selection, policy: selection }),
  ),
  handler: async (ctx, { projectId, paginationOpts }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read policy history.');
      await activeOwnedProject(ctx, projectId, user.subject);
      const page = await ctx.db
        .query('projectPolicyChanges')
        .withIndex('by_project', q => q.eq('projectId', projectId))
        .order('desc')
        .paginate(paginationOpts);
      return {
        ...page,
        page: page.page.flatMap(row => {
          const previous = row.previous.acceptance.withoutCheck ?? initial;
          const policy = row.policy.acceptance.withoutCheck ?? initial;
          return JSON.stringify(previous) === JSON.stringify(policy)
            ? []
            : [{ operationId: row.operationId, at: row.at, previous, policy }];
        }),
      };
    } catch (e) {
      return report(e);
    }
  },
});
