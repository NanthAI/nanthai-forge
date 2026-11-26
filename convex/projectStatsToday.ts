// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { makeFunctionReference } from 'convex/server';
import { v } from 'convex/values';
import { mutation } from './cliServer';
import { accessibleProject, requireDeviceWrite } from './projectAuthority';
import { projectRole } from './projectRole';
import { report } from './errors';
import { utcDay } from './projectStatsClose';
import { invariant } from '../src/errors';
import { statsDaySchema } from '../src/stats-estimate';
import { STATS_TODAY_REFRESH_MS, provisionalAt } from '../src/stats-period';

/** Today so far (Item 580b1a1a): called when a member opens Stats on a period that holds today. It schedules one
 * provisional close of today only after a landing today since the last one, at most once in STATS_TODAY_REFRESH_MS:
 * one row read, at most one receipt read and one scheduled close. Idle, or with Stats closed, nothing runs. */
export const refreshToday = mutation({
  args: { projectId: v.id('hostedProjects') },
  returns: v.boolean(),
  handler: async (ctx, { projectId }) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'AUTH_REQUIRED', 'Sign in to see Stats.');
      await requireDeviceWrite(ctx, projectId);
      const project = await accessibleProject(ctx, projectId, user.subject);
      invariant(
        project.visibility !== 'public' || (await projectRole(ctx, project, user.subject)),
        'PROJECT_UNAVAILABLE',
        'Project membership is required to refresh Stats.',
      );
      const now = Date.now(),
        day = utcDay(now);
      const row = await ctx.db
        .query('projectStatsDays')
        .withIndex('by_project_and_day', q => q.eq('projectId', projectId).eq('day', day))
        .unique();
      const upTo = row ? provisionalAt(statsDaySchema.parse(JSON.parse(row.value))) : null;
      if (row && (upTo === null || now - upTo < STATS_TODAY_REFRESH_MS)) return false;
      // A landing after the last provisional close (it read every receipt up to then), or any landing today.
      const since = upTo ?? Date.parse(`${day}T00:00:00.000Z`) - 1;
      const landed = await ctx.db
        .query('projectHostedAcceptances')
        .withIndex('by_project', q => q.eq('projectId', projectId).gt('_creationTime', since))
        .first();
      if (!landed) return false;
      await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectStats:closeDay'), {
        projectId,
        day,
        provisional: true,
      });
      return true;
    } catch (error) {
      return report(error);
    }
  },
});
