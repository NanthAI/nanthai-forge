// SPDX-License-Identifier: Apache-2.0
import { providerRetryDelay } from '../src/ci-provider-recovery';
import type { MutationCtx } from './_generated/server';
import type { LandingClaim } from './projectHostedLandingControl';
import type { HostedLandingAttempt } from '../src/hosted-landing';
import type { HostedCheckRun } from '../src/hosted-check';
import { HOSTED_PLATFORM_RETRIES, checkFailureKind } from '../src/hosted-landing-admission';
import { enqueueHostedCheck } from './projectHostedChecks';
import { installBatchAttempt } from './projectHostedLandingBatchStore';

/** The same platform budget and exact-attempt installation as batch checks.
 * Only an explicit infrastructure result retries; test exits and cancellations settle. */
export async function retrySoloLandingCheck(
  ctx: MutationCtx,
  claim: LandingClaim,
  attempt: HostedLandingAttempt,
  run: HostedCheckRun,
) {
  if (
    !['runner-unavailable', 'interrupted'].includes(run.status) ||
    run.cancelRequested ||
    run.counts.failed > 0 ||
    checkFailureKind(run, { conflicts: [] }) !== 'platform' ||
    !attempt.candidate.head ||
    (attempt.platformRetries ?? 0) >= HOSTED_PLATFORM_RETRIES
  )
    return false;
  const operationId = crypto.randomUUID();
  const reason = providerRetryDelay(run.failureReason);
  const next = await enqueueHostedCheck(ctx, {
    ...(reason ? { providerDelayReason: reason } : {}),
    projectId: claim.projectId,
    actor: attempt.actor.id,
    ...(attempt.recheck ? { recheck: attempt.recheck } : {}),
    request: { ...run.request, operationId },
  });
  await installBatchAttempt(ctx, {
    projectId: claim.projectId,
    ...(reason ? { providerDelayed: true } : {}),
    original: { ...attempt, platformRetries: (attempt.platformRetries ?? 0) + 1 },
    checkOperationId: operationId,
    check: {
      runId: next.id,
      checkId: next.check.id,
      definition: next.check.definition,
      configuration: next.request.expectedConfiguration,
      environment: next.request.expectedEnvironment,
    },
  });
  return true;
}
