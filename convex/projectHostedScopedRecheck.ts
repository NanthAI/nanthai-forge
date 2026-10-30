// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import { requireHostedCheckEvidence } from './projectHostedCheckRead';
import type { HostedLandingAttempt } from '../src/hosted-landing';
import type { ScopedRecheckBasis } from '../src/scoped-recheck-policy';
import { ForgeError } from '../src/errors';

/** The basis is the latest exact full pass of this finish's own (non-batch)
 * Candidate. A scoped or cancelled retry keeps the basis it inherited; it never
 * becomes a basis itself. Reads stay inside the caller's mutation. */
export async function scopedRecheckBasis(
  ctx: MutationCtx,
  previous: HostedLandingAttempt,
): Promise<ScopedRecheckBasis | undefined> {
  const policy = previous.policy.acceptance;
  if (policy.gate !== 'contract' || policy.scopedRecheck === false) return undefined;
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
      const run = await requireHostedCheckEvidence(ctx, {
        projectId: previous.projectId as Parameters<typeof requireHostedCheckEvidence>[1]['projectId'],
        actor: previous.actor.id,
        candidateId: own.checked.id,
        head: own.checked.head,
        authorityEpoch: previous.authorityEpoch,
        ...previous.check,
      });
      if (run.gate?.effective === 'full' && run.candidate.digest === own.checked.digest) return own;
    } catch (error) {
      if (!(error instanceof ForgeError)) throw error;
    }
  }
  return previous.recheck;
}
