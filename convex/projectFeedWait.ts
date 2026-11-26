// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v, type Infer } from 'convex/values';
import type { Id } from './_generated/dataModel';
import type { QueryCtx } from './cliServer';
import {
  hostedLandingStateSchema,
  landingObservationSchema,
  type HostedLandingState,
} from '../src/hosted-landing';
import { syncRequiredAdvice } from '../src/hosted-would-conflict';
import { hostedLandingProgressAt } from '../src/hosted-landing-stall';

const phases = hostedLandingStateSchema.shape.phase;
export const feedWaitingValidator = v.array(
  v.object({
    submissionId: v.string(),
    phase: v.union(...phases.options.map(phase => v.literal(phase))),
    version: v.number(),
    needsSync: v.boolean(),
    pending: v.optional(
      v.object({
        attemptId: v.string(),
        reason: v.union(
          v.null(),
          ...landingObservationSchema.shape.pendingReason.unwrap().options.map(reason => v.literal(reason)),
        ),
        holdCode: v.optional(v.union(v.literal('MAIN_RED'), v.literal('CI_DOWN'))),
        orderWait: v.optional(v.string()),
        lastProgressAt: v.optional(v.string()),
        stall: v.optional(
          v.object({
            code: v.literal('LANDING_STALLED'),
            step: v.string(),
            missingOwner: v.string(),
            lastProgressAt: v.string(),
            alarmAt: v.string(),
            message: v.string(),
          }),
        ),
      }),
    ),
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
    operations.map(async (operationId): Promise<Infer<typeof feedWaitingValidator>[number] | null> => {
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
            row =>
              JSON.parse(row.value) as {
                submissionId: string;
                value: string;
                wouldConflict?: string;
                orderWait?: string;
              },
          )
        : await ctx.db
            .query('projectHostedLandingRequests')
            .withIndex('by_project_and_operation', q =>
              q.eq('projectId', projectId).eq('operationId', operationId),
            )
            .take(2);
      if (selected.length !== 1) return null;
      const row = selected[0]!;
      const state = JSON.parse(row.value) as HostedLandingState;
      const holdCode = state.error?.code;
      const stall = state.observation.stall;
      return {
        submissionId: row.submissionId,
        phase: state.phase,
        version: state.version,
        needsSync: Boolean(row.wouldConflict && syncRequiredAdvice(JSON.parse(row.wouldConflict), state)),
        ...(state.observation.state === 'pending'
          ? {
              pending: {
                attemptId: state.attemptId,
                reason: state.observation.pendingReason,
                lastProgressAt: hostedLandingProgressAt(state),
                ...(stall
                  ? {
                      stall: {
                        code: stall.code,
                        step: stall.step,
                        missingOwner: stall.missingOwner,
                        lastProgressAt: stall.lastProgressAt,
                        alarmAt: stall.alarmAt,
                        message: stall.message,
                      },
                    }
                  : {}),
                ...(holdCode === 'MAIN_RED' || holdCode === 'CI_DOWN' ? { holdCode } : {}),
                ...(state.phase === 'ready' && row.orderWait ? { orderWait: row.orderWait } : {}),
              },
            }
          : {}),
      };
    }),
  );
  return rows.filter(row => row !== null);
}
