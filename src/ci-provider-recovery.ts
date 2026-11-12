// SPDX-License-Identifier: Apache-2.0
/** Provider-neutral recovery contract. Adapters normalize records read with their own
 * credential; job reports alone never satisfy it. No timers or IO live here. */
export const providerAckMs = 5 * 60_000;
export const providerVerdictReadsMs = [
  5 * 60_000,
  30 * 60_000,
  60 * 60_000,
  2 * 60 * 60_000,
  4 * 60 * 60_000,
] as const;
export type ProviderJob = {
  status?: unknown;
  conclusion?: unknown;
  steps?: { status?: unknown; conclusion?: unknown }[];
};
const passed = (conclusion: unknown) => ['success', 'skipped', 'neutral'].includes(String(conclusion));
const failed = (conclusion: unknown) =>
  ['failure', 'failed', 'timed_out', 'action_required', 'startup_failure'].includes(String(conclusion));
/** Missing/failed startup after an accepted dispatch uses the existing platform retry.
 * An unreadable lookup is uncertainty, not evidence that no execution exists. */
export function providerStartupUnavailable(found: boolean, conclusion: string | null) {
  return !found || ['startup_failure', 'cancelled', 'canceled'].includes(conclusion ?? '');
}
/** Incident 238b3573: job/run statuses can lag after every step has completed.
 * A complete provider page and signed passes for the entire plan are both required.
 * Failure wins even when another job or step still says running. */
export function delayedProviderVerdict(input: {
  signedShardsPassed: boolean;
  complete: boolean;
  jobs: ProviderJob[];
}): 'passed' | 'failed' | 'provider-delayed' {
  if (input.jobs.some(job => failed(job.conclusion) || job.steps?.some(step => failed(step.conclusion))))
    return 'failed';
  if (!input.signedShardsPassed || !input.complete || !input.jobs.length) return 'provider-delayed';
  return input.jobs.every(
    job =>
      (job.status === 'completed' && job.conclusion === 'skipped') ||
      ((job.conclusion === null || job.conclusion === undefined || passed(job.conclusion)) &&
        Array.isArray(job.steps) &&
        job.steps.length > 0 &&
        job.steps.every(step => step.status === 'completed' && passed(step.conclusion))),
  )
    ? 'passed'
    : 'provider-delayed';
}

/** Keep the outage visible while the existing platform retry starts its replacement. */
export function providerRetryDelay(reason: string | undefined): string | undefined {
  return reason?.startsWith('Provider outage:')
    ? `provider-delayed: retrying after ${reason}`.slice(0, 300)
    : undefined;
}
