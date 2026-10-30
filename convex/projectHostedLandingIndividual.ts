// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { HostedLandingAttempt } from '../src/hosted-landing';
import { loadHostedCheck } from './projectHostedCheckStore';
import { canonicalPayload } from '../src/hosted-source-operation';
import { ForgeError } from '../src/errors';
/** Flags describe scheduling, not check provenance. An unstarted batch may
 * contain an already-running individual run; fallback must retain that run. */
export async function individualLandingRun(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  attempt: HostedLandingAttempt,
  original: HostedLandingAttempt['candidate'],
) {
  if (
    attempt.memberCandidate ||
    !attempt.check ||
    !attempt.candidate.head ||
    canonicalPayload(attempt.candidate.inputs) !== canonicalPayload(original.inputs) ||
    canonicalPayload(attempt.candidate.dependencies) !== canonicalPayload(original.dependencies)
  )
    return null;
  let run;
  try {
    run = (await loadHostedCheck(ctx, { projectId, runId: attempt.check.runId })).run;
  } catch (error) {
    if (error instanceof ForgeError) return null;
    throw error;
  }
  const checked = attempt.crossHeadProof?.checked ?? attempt.candidate;
  return run.request.candidateId === checked.id &&
    run.request.expectedHead === checked.head &&
    run.candidate.digest === checked.digest &&
    run.request.authorityEpoch === attempt.authorityEpoch &&
    run.check.id === attempt.check.checkId &&
    run.check.definition === attempt.check.definition &&
    run.request.expectedConfiguration === attempt.check.configuration &&
    run.request.expectedEnvironment === attempt.check.environment
    ? run
    : null;
}
