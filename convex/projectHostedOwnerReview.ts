// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { mutation, query, type MutationCtx, type QueryCtx } from './cliServer';
import type { Id } from './_generated/dataModel';
import { acceptanceActor } from './projectAutonomy';
import { accessibleProject, activeOwnedProject } from './projectAuthority';
import { acceptanceSelection } from './projectHostedAcceptanceStore';
import { cancelHostedLanding } from './projectHostedLandingCancel';
import { landingStateFromRow, loadLanding, writeLanding } from './projectHostedLandingStore';
import { finishRow } from './projectHostedFinishWake';
import { landingObservation, type HostedLandingState } from '../src/hosted-landing';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';

export const REVIEW_HELD = 'waiting-for-review';
export const held = (state: HostedLandingState) =>
  state.observation.state === 'pending' && state.observation.pendingReason === REVIEW_HELD;

/** After an approval that could not publish at once (queue busy or main moved), the held entry
 * returns to the finish driver: this write wakes it once; it takes its turn and lands with the grant,
 * or recomposes on current main first. No timer of its own, no poll. */
export async function releaseApprovedReview(
  ctx: MutationCtx,
  input: { projectId: Id<'hostedProjects'>; submissionId: string },
) {
  const { row, state } = await loadLanding(ctx, input);
  if (!held(state) || !(await finishRow(ctx, input))) return false;
  await writeLanding(
    ctx,
    row,
    { ...state, version: state.version + 1, observation: landingObservation('queued'), error: null },
    false,
  );
  return true;
}

const selection = { projectId: v.id('hostedProjects'), submissionId: v.string(), attemptId: v.string() };
async function ownerPerson(ctx: MutationCtx | QueryCtx, projectId: Id<'hostedProjects'>) {
  const actor = await acceptanceActor(ctx);
  await activeOwnedProject(ctx, projectId, actor.id);
  invariant(
    actor.kind === 'person',
    'PROJECT_UNAVAILABLE',
    'Owner review requires explicit person acceptance.',
  );
  return actor;
}
/** Decline one exact held attempt: the same cancel transaction, with its own outcome code, so the
 * submitter's wait returns REVIEW_DECLINED with the owner's reason. */
export const decline = mutation({
  args: { ...selection, operationId: v.string(), reason: v.optional(v.string()) },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const actor = await ownerPerson(ctx, input.projectId);
      const { state } = await acceptanceSelection(ctx, input);
      invariant(
        held(state) || state.phase === 'terminal-failed',
        'WORK_STALE',
        'Only a landing waiting for review can be declined.',
      );
      const why = input.reason?.trim().slice(0, 500);
      return canonicalPayload(
        await cancelHostedLanding(ctx, {
          projectId: input.projectId,
          actor: actor.id,
          code: 'REVIEW_DECLINED',
          reason: `Declined by the project owner${why ? `: ${why}` : '.'} Address it in the same Lane and land again.`,
          request: {
            operationId: input.operationId,
            authorityEpoch: state.request.authorityEpoch,
            submissionId: state.id,
          },
        }),
      );
    } catch (error) {
      return report(error);
    }
  },
});
export function approveUrl(projectId: string, submissionId: string) {
  const web = process.env.FORGE_WEB_URL;
  if (!web) return null;
  const url = new URL('/approve', web);
  url.searchParams.set('project', projectId);
  url.searchParams.set('submission', submissionId);
  return url.href;
}
/** One indexed read: the approve link of a landing operation, for any project reader (an agent
 * hands it to the owner). Opening it approves nothing; the page needs a signed-in owner. */
export const link = query({
  args: { projectId: v.id('hostedProjects'), operationId: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read landing links.');
      await accessibleProject(ctx, input.projectId, user.subject);
      const [row] = await ctx.db
        .query('projectHostedLandingRequests')
        .withIndex('by_project_and_operation', q =>
          q.eq('projectId', input.projectId).eq('operationId', input.operationId),
        )
        .take(1);
      invariant(row, 'NOT_FOUND', 'No hosted landing has this operation id.');
      const state = landingStateFromRow(row);
      return canonicalPayload({
        operationId: state.operationId,
        submissionId: state.id,
        attemptId: state.attemptId,
        held: held(state),
        reason: held(state) ? (state.error?.message ?? 'Waiting for review by the project owner') : null,
        phase: state.phase,
        url: approveUrl(input.projectId, state.id),
      });
    } catch (error) {
      return report(error);
    }
  },
});
