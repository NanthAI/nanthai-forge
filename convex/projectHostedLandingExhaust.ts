// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { HostedLandingState } from '../src/hosted-landing';
import { hostedLandingProgressAt } from '../src/hosted-landing-stall';
import { cancelHostedLanding } from './projectHostedLandingCancel';
import { raiseExhaustedAlert } from './projectHostedLandingStallAlert';

/** Typed outcome when the landing supervisor gives up on a permanent fault (19328518). */
export const LANDING_DRIVER_EXHAUSTED = 'LANDING_DRIVER_EXHAUSTED';

export const exhaustedReason = (why: string) =>
  `${why} Forge ended this landing instead of leaving it pending; nothing landed. ` +
  'Finish the same Lane again to retry. If it ends the same way, the failing step needs a fix first.';

/** Owner alert for the cap. It goes out when the end is decided, so a failing
 * ending transaction still reaches the owner. */
export async function alertExhausted(
  ctx: MutationCtx,
  state: HostedLandingState,
  reason: string,
  lastProgressAt = hostedLandingProgressAt(state),
) {
  await raiseExhaustedAlert(
    ctx,
    { projectId: state.projectId as Id<'hostedProjects'>, submissionId: state.id, lastProgressAt },
    state,
    reason,
  );
}

/** End a pending entry through the cancellation path: peers re-selected, its
 * finish IO fenced, the queue released when it held it, and the requester's
 * operation settled with a reason. Accepted entries are never rewound. */
export async function exhaustLanding(ctx: MutationCtx, state: HostedLandingState, reason: string) {
  return cancelHostedLanding(ctx, {
    projectId: state.projectId as Id<'hostedProjects'>,
    actor: state.actor,
    drop: true,
    code: LANDING_DRIVER_EXHAUSTED,
    request: {
      operationId: crypto.randomUUID(),
      authorityEpoch: state.request.authorityEpoch,
      submissionId: state.id,
    },
    reason,
  });
}
