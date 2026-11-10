// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import { requireHostedCheckEvidence } from './projectHostedCheckRead';
import type { HostedLandingAttempt } from '../src/hosted-landing';
import { scopedRecheckPolicy, type ScopedRecheckBasis } from '../src/scoped-recheck-policy';
import { ForgeError } from '../src/errors';
import type { HostedCheckRun } from '../src/hosted-check';

/** The basis is the latest exact full pass of this finish's own (non-batch)
 * Candidate. A scoped or cancelled retry keeps the basis it inherited; it never
 * becomes a basis itself. Reads stay inside the caller's mutation. */
export async function scopedRecheckBasis(
  ctx: MutationCtx,
  previous: HostedLandingAttempt,
  checkedRun?: HostedCheckRun,
): Promise<ScopedRecheckBasis | undefined> {
  // Either gate (Issue fc215574); the actor and main rules apply when the recheck is enqueued.
  if (!scopedRecheckPolicy(previous.policy.acceptance)) return undefined;
  const proof = previous.crossHeadProof;
  const own = proof
    ? { checked: proof.checked, checkedBase: proof.checkedBase, runId: proof.runId }
    : previous.check && previous.candidate.head && !previous.memberCandidate
      ? {
          checked: {
            id: previous.candidate.id,
            head: previous.candidate.head,
            digest: previous.candidate.digest,
          },
          checkedBase: previous.main,
          runId: previous.check.runId,
        }
      : null;
  if (own && previous.check && !previous.semanticPlan?.members.length) {
    try {
      const run = await requireHostedCheckEvidence(
        ctx,
        {
          projectId: previous.projectId as Parameters<typeof requireHostedCheckEvidence>[1]['projectId'],
          actor: previous.actor.id,
          candidateId: own.checked.id,
          head: own.checked.head,
          authorityEpoch: previous.authorityEpoch,
          ...previous.check,
        },
        checkedRun,
      );
      // A run with no gate (a project with no configured gate) ran the whole check, or its docs
      // selection for a docs-only change; a gated run says so in its echoed effective gate.
      const whole = run.gate === undefined || run.gate.effective === 'full';
      if (whole && run.candidate.digest === own.checked.digest) return own;
    } catch (error) {
      if (!(error instanceof ForgeError)) throw error;
    }
  }
  return previous.recheck;
}
/** Why a main-race recheck could not be scoped (attempt
 * `scopedFallback`, src/fallback-reasons.ts): its own full pass is not exact evidence. */
export const scopedRecheckFallback = (
  previous: HostedLandingAttempt,
  basis: ScopedRecheckBasis | undefined,
) =>
  !basis && scopedRecheckPolicy(previous.policy.acceptance) ? ('scoped-no-evidence' as const) : undefined;

/** A passing cohort refused only because main moved (Issue 28f08555): its own exact whole pass is the
 * basis of the retried cohort's scoped recheck, covering every member together. A scoped pass keeps
 * the basis the cohort inherited. Reads stay inside the caller's mutation. */
export async function cohortRecheckBasis(
  ctx: MutationCtx,
  inherited: ScopedRecheckBasis | undefined,
  runId: string | undefined,
  shared: HostedLandingAttempt,
): Promise<ScopedRecheckBasis | undefined> {
  const head = shared.candidate.head;
  if (
    !scopedRecheckPolicy(shared.policy.acceptance) ||
    !shared.check ||
    shared.check.runId !== runId ||
    !head
  )
    return inherited;
  try {
    const run = await requireHostedCheckEvidence(ctx, {
      projectId: shared.projectId as Parameters<typeof requireHostedCheckEvidence>[1]['projectId'],
      actor: shared.actor.id,
      candidateId: shared.candidate.id,
      head,
      authorityEpoch: shared.authorityEpoch,
      ...shared.check,
    });
    const whole = run.gate === undefined || run.gate.effective === 'full';
    if (whole && run.status === 'passed' && run.candidate.digest === shared.candidate.digest)
      return {
        checked: { id: shared.candidate.id, head, digest: shared.candidate.digest },
        checkedBase: shared.main,
        runId: run.id,
      };
  } catch (error) {
    if (!(error instanceof ForgeError)) throw error;
  }
  return inherited;
}
