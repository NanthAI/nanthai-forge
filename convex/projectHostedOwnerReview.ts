// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { mutation, query, type MutationCtx, type QueryCtx } from './cliServer';
import type { Doc, Id } from './_generated/dataModel';
import { loadLandingAttempt } from './projectHostedLandingAttemptRead';
import { effectivePolicy } from '../src/autonomy-policy';
import { policyDigestCurrent } from '../src/policy-digest';
import { acceptanceActor } from './projectAutonomy';
import { accessibleProject, activeOwnedProject } from './projectAuthority';
import { acceptanceSelection } from './projectHostedAcceptanceStore';
import { cancelHostedLanding } from './projectHostedLandingCancel';
import { landingStateFromRow, loadLanding, writeLanding } from './projectHostedLandingStore';
import { finishRow } from './projectHostedFinishWake';
import {
  landingObservation,
  type HostedLandingAttempt,
  type HostedLandingState,
} from '../src/hosted-landing';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';
import { settleAttemptApprovals } from './projectHostedApprovalStore';

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
      return canonicalPayload(await declineHeldLanding(ctx, actor.id, input));
    } catch (error) {
      return report(error);
    }
  },
});
/** The owner person's decline (the decline mutation, and a decline of the Lane's approval request
 * while its landing is held). The caller has checked that the actor is the owner person. */
export async function declineHeldLanding(
  ctx: MutationCtx,
  actor: string,
  input: {
    projectId: Id<'hostedProjects'>;
    submissionId: string;
    attemptId: string;
    operationId: string;
    reason?: string;
  },
) {
  const { state, attempt } = await acceptanceSelection(ctx, input);
  invariant(
    held(state) || state.phase === 'terminal-failed',
    'WORK_STALE',
    'Only a landing waiting for review can be declined.',
  );
  const why = input.reason?.trim().slice(0, 500);
  if (held(state))
    await settleAttemptApprovals(ctx, {
      projectId: input.projectId,
      receiptId: attempt.operations.accept,
      operationId: input.operationId,
      by: actor,
      status: 'declined',
      ...(why ? { reason: why } : {}),
    });
  return cancelHostedLanding(ctx, {
    projectId: input.projectId,
    actor,
    code: 'REVIEW_DECLINED',
    reason: `Declined by the project owner${why ? `: ${why}` : '.'} Address it in the same Lane and land again.`,
    request: {
      operationId: input.operationId,
      authorityEpoch: state.request.authorityEpoch,
      submissionId: state.id,
    },
  });
}
/** Which policy a held landing is pinned to, and when it re-reads it (721cd45c; 991a1a94 traced on
 * 2026-11-09). A held attempt keeps the policy it was prepared under: a policy edit never re-checks it,
 * and no sweep, alarm or recompose touches a held entry. Only a fresh attempt re-reads the policy: the
 * owner's approve when main moved or the policy changed since (the approval carries to it only while
 * the policy is unchanged), or withdraw and land again. 991a1a94: the owner approved 16 minutes after
 * main moved; the fresh attempt pinned the lifted policy, needed no review and landed in the
 * submitter's (agent) name. */
export const HELD_POLICY_REREADS =
  'policy edits never re-check a held landing; it re-reads the current policy only on a fresh attempt: the owner approves after main moved or the policy changed, or it is withdrawn and landed again';
export type HeldPolicy = {
  attempt: number;
  pinnedAt: string;
  changed: boolean;
  protectedPaths?: { pinned: string[]; current: string[] };
  rereads: string;
};
export function heldPolicy(project: Doc<'hostedProjects'>, attempt: HostedLandingAttempt): HeldPolicy {
  const current = effectivePolicy(project);
  const changed = !policyDigestCurrent(current, attempt.policyDigest);
  const pinned = attempt.policy.acceptance.protectedPaths;
  const now = current.acceptance.protectedPaths;
  return {
    attempt: attempt.number,
    pinnedAt: attempt.at,
    changed,
    ...(changed && canonicalPayload(pinned) !== canonicalPayload(now)
      ? { protectedPaths: { pinned, current: now } }
      : {}),
    rereads: HELD_POLICY_REREADS,
  };
}
/** The pin in one sentence (approve-link always; held reasons once the policy changed). */
export function heldPolicyNote(pin: HeldPolicy) {
  const head = `Pinned to the landing policy of attempt ${pin.attempt} (${pin.pinnedAt})`;
  return pin.changed
    ? `${head}; the policy changed since, and ${HELD_POLICY_REREADS}. Approving starts that fresh attempt: it holds for the owner once more if the current policy still needs review, otherwise it lands without review (its receipt then names the submitter).`
    : `${head}; ${HELD_POLICY_REREADS}.`;
}
/** One attempt read, only for a held landing. */
export async function loadHeldPolicy(
  ctx: QueryCtx | MutationCtx,
  project: Doc<'hostedProjects'>,
  state: HostedLandingState,
) {
  if (!held(state)) return null;
  const attempt = await loadLandingAttempt(ctx, { projectId: project._id, attemptId: state.attemptId }).catch(
    () => null,
  );
  return attempt ? heldPolicy(project, attempt) : null;
}
/** Readers of a held landing see the note in its reason once the policy changed under it (wait hold
 * lines, status, the owner page); approve-link always carries `policy` and `policyNote`. */
export function noteHeldPolicy<T extends { error?: { code: string; message: string } | null }>(
  submission: T,
  pin: HeldPolicy | null,
): T {
  if (!pin?.changed) return submission;
  const error = submission.error ?? { code: 'REVIEW_REQUIRED', message: 'Waiting for review by a person' };
  return { ...submission, error: { ...error, message: `${error.message}. ${heldPolicyNote(pin)}` } };
}
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
      const project = await accessibleProject(ctx, input.projectId, user.subject);
      const [row] = await ctx.db
        .query('projectHostedLandingRequests')
        .withIndex('by_project_and_operation', q =>
          q.eq('projectId', input.projectId).eq('operationId', input.operationId),
        )
        .take(1);
      invariant(row, 'NOT_FOUND', 'No hosted landing has this operation id.');
      const state = landingStateFromRow(row);
      const policy = await loadHeldPolicy(ctx, project, state);
      return canonicalPayload({
        operationId: state.operationId,
        submissionId: state.id,
        attemptId: state.attemptId,
        held: held(state),
        reason: held(state) ? (state.error?.message ?? 'Waiting for review by the project owner') : null,
        // Which policy the held attempt is pinned to and when it re-reads it (991a1a94).
        ...(policy ? { policy, policyNote: heldPolicyNote(policy) } : {}),
        phase: state.phase,
        url: approveUrl(input.projectId, state.id),
      });
    } catch (error) {
      return report(error);
    }
  },
});
