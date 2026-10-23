// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation } from './_generated/server';
import { accessibleProject } from './projectAuthority';
import { invariant } from '../src/errors';
export const put = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    backupId: v.id('projectBackups'),
    actor: v.string(),
    head: v.string(),
    part: v.number(),
    value: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    await accessibleProject(ctx, input.projectId, input.actor);
    const backup = await ctx.db.get(input.backupId);
    invariant(
      backup?.projectId === input.projectId && backup.status === 'stored',
      'PROJECT_UNAVAILABLE',
      'Select a stored checkpoint from this project.',
    );
    const original = await ctx.db
      .query('projectBriefingSources')
      .withIndex('by_projectId_and_backupId_and_head_and_part', q =>
        q
          .eq('projectId', input.projectId)
          .eq('backupId', input.backupId)
          .eq('head', input.head)
          .eq('part', input.part),
      )
      .unique();
    if (original)
      invariant(
        original.value === input.value,
        'INVALID_NATIVE_SOURCE',
        'Immutable briefing paths differ from their checkpoint.',
      );
    else {
      const { actor: _actor, ...row } = input;
      void _actor;
      await ctx.db.insert('projectBriefingSources', row);
    }
    return null;
  },
});
