// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { infraWaitSince } from './landing-state.js';
import { failedBeforeJobPlan } from './ci-status.js';
export { infraWaitSince };
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

/** The run reason every platform retry shows while its landing waits (`pending-infra`, Item
 * 0d8a85a3); the landing word adds since when. A provider outage keeps its own words. */
export const infraWaitPrefix = 'provider-delayed: waiting for check infrastructure';
/** A later retry keeps the first wait's start when the failed run's reason carries it. */
export function providerRetryDelay(reason: string | undefined, now = Date.now()): string {
  const since = infraWaitSince(reason) ?? `${new Date(now).toISOString().slice(11, 16)}Z`;
  return (
    reason?.startsWith('Provider outage:')
      ? `provider-delayed: retrying after ${reason}`
      : `${infraWaitPrefix} since ${since}; retrying after ${reason ?? 'a check that ended without a verdict'}`
  ).slice(0, 300);
}
/** Managed-run failures and retries share one reason, including the original wait time. */
export function prePlanFailureReason(
  end: { failed: boolean; conclusion: string | null; checkFailed?: boolean },
  plan: { recorded: boolean; previousReason?: string | undefined },
) {
  return failedBeforeJobPlan(end, plan.recorded)
    ? jobApiReason(end.conclusion, infraWaitSince(plan.previousReason))
    : undefined;
}

/** The run reason when a provider run ended and shard evidence is incomplete, built from what Forge
 * recorded (Item 0d14c456, friction 061c0461: job-API timeouts after the source-pack download look the
 * same from here). A shard that reported a failing test is a verdict, so the reason never says the code
 * was not judged then. Kept under the 200 characters a check summary shows, marker first. */
export function noJobEvidenceReason(facts: {
  conclusion?: string | null | undefined;
  reported?: number | undefined;
  shardCount?: number | null | undefined;
  /** A shard reported a failing test (a verdict). */
  failed?: boolean | undefined;
}) {
  const head = `Actions completed${facts.conclusion ? ` (${facts.conclusion})` : ''} without complete job evidence`;
  const reported = facts.shardCount
    ? `${facts.reported ?? 0} of ${facts.shardCount} shards reported`
    : 'no shard plan was recorded';
  return facts.failed
    ? `${head}: ${reported}; one reported a failing test, the others never reported.`
    : `${head}: ${reported}, code not judged. A job-log line "Forge job API" names Forge's side; else source download or the runner.`;
}
/** The failure text carries forward an earlier retry's wait start. */
export function jobApiReason(conclusion: string | null | undefined, waitingSince?: string) {
  return `Check infrastructure: the runner ended (${conclusion ?? 'unknown'}) before Forge recorded its plan (runner setup, OIDC or Forge's job API); the code was not judged.${
    waitingSince ? ` Waiting for check infrastructure since ${waitingSince}.` : ''
  }`;
}
