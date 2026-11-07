// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { z } from 'zod';
import { mutation } from './cliServer';
import { acceptanceActor } from './projectAutonomy';
import { activeProject } from './projectAuthority';
import { hostedOperationRow } from './projectHostedOperations';
import { cancelHostedLanding } from './projectHostedLandingCancel';
import { liveLaneFinish } from './projectHostedLaneFinish';
import { saveLane } from './projectHostedSaveStore';
import { requireMemberAuthorityById } from './projectLaneAuthority';
import { hostedLandingWithdrawSchema } from '../src/hosted-landing';
import { canonicalPayload, hostedOperationSchema } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';

export const withdrawReason = (laneId: string) =>
  `Withdrawn by its agent from Lane ${laneId}: fix the Lane, save, then land again.`;

/**
 * Agent withdraw (Issue 78a97771): cancel the live landing of one Lane, named by the Lane, so a
 * known failing landing stops before its checks repeat and the builder can save a fix on the same
 * Lane. One mutation: the Lane read, the bounded live-finish lookup (the save freeze's own reverse
 * lookup) and the existing cancellation transaction. The Lane, its saves, Candidates and check
 * evidence stay; only the submission ends (LANDING_CANCELLED). A replay of the same operationId
 * returns the first receipt, never a later landing of the Lane.
 */
export async function withdrawHostedLanding(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    actor: string;
    request: z.infer<typeof hostedLandingWithdrawSchema>;
  },
) {
  const { projectId, actor, request } = input;
  const reason = request.reason ?? withdrawReason(request.laneId);
  const cancel = (submissionId: string) =>
    cancelHostedLanding(ctx, {
      projectId,
      actor,
      reason,
      withdrawLaneId: request.laneId,
      request: { operationId: request.operationId, authorityEpoch: request.authorityEpoch, submissionId },
    });
  const old = await hostedOperationRow(ctx, projectId, actor, request.operationId);
  // The retained operation names the submission it cancelled; the cancel replay checks the payload.
  if (old) return cancel(hostedOperationSchema.parse(JSON.parse(old.value)).expected.resourceId ?? '');
  // Readers and removed projects are refused before any Lane or landing read.
  await activeProject(ctx, projectId, actor);
  const lane = await saveLane(ctx, { projectId, actor, laneId: request.laneId });
  await requireMemberAuthorityById(ctx, projectId, lane.actor, actor, 'Lane');
  const live = await liveLaneFinish(
    ctx,
    { projectId, laneId: lane.id, headWrittenAt: '' },
    { queuedConflicts: true },
  );
  invariant(
    live,
    'LANDING_NOT_LIVE',
    `Lane ${lane.id} has no live landing to withdraw. Save and land it with land --save.`,
  );
  return cancel(live.submissionId);
}

/** `land --withdraw`: the Lane author or the project owner (8809fba5); the cancel checks the submitter. */
export const withdraw = mutation({
  args: { projectId: v.id('hostedProjects'), request: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const actor = await acceptanceActor(ctx, true);
      return canonicalPayload(
        await withdrawHostedLanding(ctx, {
          projectId: input.projectId,
          actor: actor.id,
          request: hostedLandingWithdrawSchema.parse(JSON.parse(input.request)),
        }),
      );
    } catch (error) {
      return report(error);
    }
  },
});
