// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { invariant } from '../src/errors';
import { internalMutation } from './server';
import { finishPlanProjectProjection, finishReadProjection } from './projectFinishReadProjection';
import { planHeaderFits, planProjectHeaderWanted } from './projectPlanHeaderStore';
import { selectedGeneration } from './projectWorkIndexStore';

/** Repair the two compact Plan headers from the same pinned source. The exact reader is
 * still needed for valid optional headers too large to project.
 * @remove-after 2026-12-31
 */
export const plan = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    generationId: v.id('projectWorkGenerations'),
    apply: v.boolean(),
  },
  returns: v.object({
    eligible: v.number(),
    oversized: v.number(),
    different: v.number(),
    changed: v.number(),
  }),
  handler: async (ctx, { projectId, generationId, apply }) => {
    const project = await ctx.db.get(projectId);
    invariant(project && planProjectHeaderWanted(project), 'WORK_STALE', 'The project Plan source changed.');
    const generation = await selectedGeneration(ctx, project);
    invariant(generation?._id === generationId, 'WORK_STALE', 'The selected Plan generation changed.');
    const headers = [
      finishPlanProjectProjection(project),
      finishReadProjection('projectWorkGenerations', generation),
    ];
    const counts = { eligible: 0, oversized: 0, different: 0, changed: 0 };
    for (const next of headers) {
      const old = await ctx.db
        .query('projectFinishReadRows')
        .withIndex('by_kind_and_source', q => q.eq('kind', next.kind).eq('sourceId', next.sourceId))
        .unique();
      if (!planHeaderFits(next.value)) {
        counts.oversized++;
        if (old) {
          counts.different++;
          if (apply) {
            await ctx.db.delete(old._id);
            counts.changed++;
          }
        }
        continue;
      }
      counts.eligible++;
      if (old?.value === next.value && old?.projectId === next.projectId) continue;
      counts.different++;
      if (!apply) continue;
      if (old) await ctx.db.replace(old._id, next);
      else await ctx.db.insert('projectFinishReadRows', next);
      counts.changed++;
    }
    return counts;
  },
});
