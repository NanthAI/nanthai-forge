// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import type { Id } from './_generated/dataModel';
import type { QueryCtx } from './cliServer';
import { hostedLandingStateSchema, type HostedLandingState } from '../src/hosted-landing';
import { syncRequiredAdvice } from '../src/hosted-would-conflict';

const phases = hostedLandingStateSchema.shape.phase;
export const feedWaitingValidator = v.array(
  v.object({
    submissionId: v.string(),
    phase: v.union(...phases.options.map(phase => v.literal(phase))),
    version: v.number(),
    needsSync: v.boolean(),
  }),
);

/** Watch only the selected operations' existing projected rows. No queue directory,
 * request bodies, retained versions or unrelated Lane dependencies. */
export async function feedWaitObservations(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  operations: string[],
) {
  const rows = await Promise.all(
    operations.map(async operationId => {
      const projected = await ctx.db
        .query('projectFinishReadRows')
        .withIndex('by_kind_and_project_and_operation', q =>
          q
            .eq('kind', 'projectHostedLandingRequests')
            .eq('projectId', projectId)
            .eq('operationId', operationId),
        )
        .take(2);
      const selected = projected.length
        ? projected.map(
            row => JSON.parse(row.value) as { submissionId: string; value: string; wouldConflict?: string },
          )
        : await ctx.db
            .query('projectHostedLandingRequests')
            .withIndex('by_project_and_operation', q =>
              q.eq('projectId', projectId).eq('operationId', operationId),
            )
            .take(2);
      if (selected.length !== 1) return null;
      const row = selected[0]!;
      const state = JSON.parse(row.value) as Pick<HostedLandingState, 'phase' | 'version' | 'observation'>;
      return {
        submissionId: row.submissionId,
        phase: state.phase,
        version: state.version,
        needsSync: Boolean(row.wouldConflict && syncRequiredAdvice(JSON.parse(row.wouldConflict), state)),
      };
    }),
  );
  return rows.filter(row => row !== null);
}
