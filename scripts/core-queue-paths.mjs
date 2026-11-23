// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Guard 4 (Item 6abdde40, incident 5e3c3a3c): a change to queue, admission, acceptance, check,
// wake or scheduler code is core, whatever it claims to do. The 2026-11-17 wake cut was a small
// cost saving that cost hours of landing time. The landing check classifies these paths by path
// alone (it never reads a change's stated intent) and always runs the queue simulation and the
// registered incident replays for them. Rule: the builder decision rules in the agent briefings.

const CORE = [
  /^convex\/projectHosted(?:Landing|Finish|Acceptance|Queue|Compose|Gate|Check|Batch|ScopedRecheck|LandGates|Reuse|EarlyResolution|MainAudit|ActionsWake|ActionsDirect|ActionsReports|ActionsVerdict|Holders|Superseded|LaneFinish|OwnerReview|OwnerGrant|Keep)[^/]*\.ts$/,
  /^convex\/(?:projectAcceptance|projectLandingProof|schedulerCancel)[^/]*\.ts$/,
  /^convex\/projectHostedSyncPublish\.ts$/,
  /^convex\/projectMetric(?:AliasWriter|ComposeMembership)\.ts$/,
  // The source step repair wake (incident e62d834b, review 308f217c): its arm, move, expiry and terminal
  // cancel. The source store, pool and fan-out only call these at their own scheduling points; their
  // scheduling is covered by the source worker tests, and a change to the wake itself lands here.
  /^convex\/(?:projectConvexSourceLease|projectConvexSourceActive|projectSourceJobs)\.ts$/,
  /^src\/(?:landing-(?!capsule|accepted-by|message|preview-records)|hosted-landing|hosted-finish|hosted-acceptance|hosted-batch|hosted-compose|hosted-cross-head|hosted-would-conflict|hosted-land-gates|hosted-queue-status|scoped-recheck|check-reuse|queue-|first-check-risk)[^/]*\.ts$/,
  /^src\/hosted-check(?:-evidence|-verdict|-controller|-only-compose)?\.ts$/,
  /^src\/(?:package-placement(?:-pin|-js)?|js-inbound-(?:imports|specifiers)|hosted-actions-job-(?:plan|client))\.ts$/,
  /^convex\/projectHostedActionsSession\.ts$/,
];
/** True for a core queue path. */
export const coreQueuePath = path => CORE.some(pattern => pattern.test(path));

export const REGISTRY = 'tests/fixtures/incident-replays.json';
export const queueProofPath = path => /^\.nforge\/queue-proofs\/[^/]+\.json$/.test(path);

/** Pin only the paths Guard 1 needs, in the existing standard check plan. */
export function queueProofPaths(paths) {
  if (!Array.isArray(paths)) return;
  const source = paths.filter(coreQueuePath);
  if (source.length) return { source, receipts: paths.filter(queueProofPath) };
}

export function registeredQueueReplays(text) {
  try {
    const { replays } = JSON.parse(text);
    if (Array.isArray(replays)) return replays;
  } catch {
    // Missing or malformed registry fails tests/incident-replays.test.mjs.
  }
  return [];
}

const FIXED = [
  // Its drift check: a new import in core code must be core or a listed exception.
  'tests/core-queue-paths.test.mjs',
  'tests/hosted-landing-queue-sim.test.mjs',
  'tests/incident-replays.test.mjs',
  'tests/landing-cost-guard.test.mjs',
];
/** The guard set every core queue change runs: the queue simulation, the cost guard and each test
 * file the incident replay registry names, as present in this Candidate. */
export function coreQueueTests(files) {
  const replays = registeredQueueReplays(files.get(REGISTRY)).map(entry => entry?.file);
  return [...new Set([...FIXED, ...replays])]
    .filter(file => typeof file === 'string' && /^tests\/[^/]+\.test\.mjs$/.test(file) && files.has(file))
    .sort();
}
export const coreQueueReason =
  'Core queue path (Guard 4, 6abdde40): its importers plus the queue simulation and incident replays, whatever the change claims';
