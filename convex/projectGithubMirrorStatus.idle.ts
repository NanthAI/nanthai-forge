// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { channelRow } from './projectHostedChannels';
import { mirrorRow } from './projectGithubMirrorQueue';
import { effectivePolicy } from '../src/autonomy-policy';
import { githubSyncCommitSchema } from '../src/github-sync-types';
import { hostedMirrorNextStep, type HostedMirrorStatus } from '../src/hosted-github-mirror-status';
import { missingObjectDelays, transientAttempts } from '../src/hosted-github-retry';
import { inboundJobSchema } from '../src/github-inbound-job';
import { strandedMirrorJobs } from './projectGithubMirrorRetarget';
import { inboundLanding, inboundOutcomeSchema } from './projectGithubInboundQueue';
import { mirrorCadenceRead } from './projectGithubMirrorCadence';
import { mirrorCadence } from '../src/hosted-github-mirror-status';

/** Called only after project authorization. Three selected rows, no history scan,
 * timer or additional client request; retry/job writes invalidate existing reads. */
export async function githubMirrorStatus(
  ctx: QueryCtx,
  project: Doc<'hostedProjects'>,
): Promise<HostedMirrorStatus | null> {
  if (project.sourceAuthority?.mode !== 'server') return null;
  const policy = effectivePolicy(project).githubMirror;
  if (!policy) return null;
  const queue = await mirrorRow(ctx, project._id);
  const [main, job] = await Promise.all([
    channelRow(ctx, project._id),
    queue?.activeId ? ctx.db.get(queue.activeId) : null,
  ]);
  const checked = queue?.checkWalls;
  const push = mirrorCadence(policy, checked?.map(wall => wall.milliseconds) ?? []);
  const mapping = queue?.mapping ? githubSyncCommitSchema.parse(JSON.parse(queue.mapping)) : null;
  // Two-way sync: one more indexed read only while an inbound landing holds the queue.
  const inbound = job?.inbound ? inboundJobSchema.parse(JSON.parse(job.inbound)) : null;
  const settled =
    inbound?.phase === 'landing' && inbound.submissionId
      ? await inboundLanding(ctx, project._id, inbound.submissionId)
      : null;
  const last = queue?.inbound ? inboundOutcomeSchema.parse(JSON.parse(queue.inbound)) : null;
  const inboundDetail = inbound?.pull
    ? `Checking GitHub PR #${inbound.pull.number} at ${inbound.pull.head.slice(0, 12)} for forge/verify.`
    : inbound
      ? settled?.phase === 'terminal-failed' && inbound.requested
        ? `GitHub ${inbound.commit!.slice(0, 12)} did not land on Forge (Lane ${inbound.laneId!.slice(0, 8)}; ${settled.error ?? 'failed'}). GitHub main keeps it and the mirror stays stopped; fix and land that Lane to keep the change, then reset GitHub main to the commit Forge pushed last and resume.`
        : settled?.phase === 'terminal-failed'
          ? `GitHub ${inbound.commit!.slice(0, 12)} did not land on Forge (Lane ${inbound.laneId!.slice(0, 8)}; ${settled.error ?? 'failed'}). The next Forge landing publishes Forge main over it on GitHub; fix and land that Lane to keep the change.`
          : inbound.commit
            ? `Bringing in GitHub ${inbound.commit.slice(0, 12)} as Lane ${inbound.laneId!.slice(0, 8)} (${inbound.changes ?? 0} changed paths).`
            : 'Reading GitHub main for two-way sync.'
      : last?.note
        ? `GitHub ${last.commit.slice(0, 12)} did not land on Forge (Lane ${last.laneId.slice(0, 8)}${last.error ? `; ${last.error}` : ''}); the next publish takes it out on GitHub.`
        : null;
  const targetHead: string | null = main ? JSON.parse(main.selection).head : (job?.state ?? null);
  const lagging = targetHead === null ? null : targetHead !== mapping?.state;
  const base: HostedMirrorStatus['status'] = !policy?.autoPush
    ? 'disabled'
    : job?.status === 'failed' || settled?.phase === 'terminal-failed'
      ? 'failed'
      : job?.status === 'retrying'
        ? 'retrying'
        : job
          ? 'syncing'
          : lagging === false
            ? 'synced'
            : 'unknown';
  // Recorded failures that no active job shows (SM-E). Both reads happen only off the healthy path:
  // the verify pointer exists only after a failed post; stranded jobs are read only while no job
  // is active and the mirror is not caught up (`unknown`), never while a publish is syncing.
  const verify = policy?.autoPush && queue?.verifyFailedId ? await ctx.db.get(queue.verifyFailedId) : null;
  const verifyPost = verify?.inbound ? inboundJobSchema.parse(JSON.parse(verify.inbound)).pull : null;
  const stranded =
    policy?.autoPush && base === 'unknown'
      ? await strandedMirrorJobs(ctx, project._id, queue?.activeId ?? null)
      : [];
  const hold = base === 'failed' || base === 'disabled' ? null : (stranded[0] ?? null);
  const verifyFailed = base === 'failed' || base === 'disabled' || hold ? null : verifyPost?.statusPost;
  const failedStatus: HostedMirrorStatus['status'] = hold || verifyFailed ? 'failed' : base;
  const failedError = hold
    ? (hold.error ?? 'GITHUB_SYNC_FAILED')
    : verifyFailed
      ? 'GITHUB_VERIFY_POST_FAILED'
      : null;
  const result = {
    repository: queue?.repository ?? policy.repo,
    status: failedStatus,
    targetHead,
    mirroredHead: mapping?.state ?? null,
    gitHead: mapping?.commit ?? null,
    lagging,
    pendingSince: job?._creationTime ?? null,
    mirroredAt: queue?.mirroredAt ?? null,
    failures: job?.failures ?? 0,
    // Only lag 422s retry (others are terminal at once); 429/5xx and transient codes get transientAttempts tries (projectGithubMirrorStore:failed).
    attemptLimit:
      job?.status !== 'retrying'
        ? null
        : job.httpStatus === 422
          ? missingObjectDelays.length + 1
          : transientAttempts,
    nextAttemptAt: job?.nextAttemptAt ?? null,
    error:
      failedError ?? job?.error ?? (settled?.phase === 'terminal-failed' ? 'GITHUB_INBOUND_FAILED' : null),
    // targetHead is current main; name the State this failing job publishes.
    detail: hold
      ? `Job for State ${hold.state.slice(0, 8)} (receipt ${hold.receiptId.slice(0, 8)}): ${hold.detail ?? 'did not run'}${stranded.length > 1 ? ` (+${stranded.length - 1} more failed publishes)` : ''}`
      : verifyFailed
        ? `forge/verify could not be posted to GitHub for PR #${verifyPost!.number} at ${verifyPost!.head.slice(0, 12)} (${verifyFailed.error}); GitHub keeps blocking the merge.`
        : job?.detail
          ? inbound
            ? `Inbound job: ${job.detail}`
            : `Job for State ${job.state.slice(0, 8)} (receipt ${job.receiptId.slice(0, 8)}): ${job.detail}`
          : inboundDetail,
    jobId: hold?._id ?? job?._id ?? null,
    // The receipt whose publish holds the mirror, from the job row already read (incident 67771ca6).
    receiptId: hold?.receiptId ?? (job && !inbound ? job.receiptId : null),
    push,
    ...(queue?.hold && policy.autoPush
      ? { held: { count: queue.queuedPublishes ?? 1, until: queue.hold.until, red: queue.hold.red } }
      : {}),
    ...(queue?.verifyError ? { verifyError: queue.verifyError } : {}),
    ...(stranded.length ? { failedJobs: stranded.length } : {}),
    // Item c63c2171: the owner's chosen GitHub commit failed to land; Forge leaves it on GitHub (no extra read).
    ...(inbound?.requested && settled?.phase === 'terminal-failed' ? { kept: true as const } : {}),
  };
  return { ...result, nextStep: hostedMirrorNextStep(result) };
}

/** Only an explicit receipt read selects its mirror job. Reading a landing window stays batched. */
export async function mirrorReceipt(ctx: QueryCtx, project: Doc<'hostedProjects'>, receiptId: string) {
  const policy = effectivePolicy(project).githubMirror;
  if (!policy) return;
  const job = await ctx.db
    .query('projectGithubMirrorJobs')
    .withIndex('by_project_and_receipt', q => q.eq('projectId', project._id).eq('receiptId', receiptId))
    .order('desc')
    .first();
  if (!job) return;
  const queue = await mirrorRow(ctx, project._id);
  const push = await mirrorCadenceRead(ctx, project, queue);
  const burst = job.burstJobId ? await ctx.db.get(job.burstJobId) : null;
  const mapping = job.mapping ? githubSyncCommitSchema.parse(JSON.parse(job.mapping)) : null;
  const pushed = !!mapping && (job.burstJobId === undefined || burst?.burstPublished === true);
  const held =
    !pushed &&
    queue?.repository.toLowerCase() === job.repository.toLowerCase() &&
    (queue.hold || (queue.batchThrough !== undefined && job.sequence <= queue.batchThrough))
      ? { count: queue.queuedPublishes ?? 1, until: queue.hold?.until ?? null, red: queue.hold?.red ?? false }
      : null;
  return {
    status: pushed ? 'pushed' : job.status === 'failed' ? 'failed' : held ? 'held' : job.status,
    repository: job.repository,
    commit: pushed ? mapping.commit : null,
    refTip: pushed && job.burstJobId === undefined,
    verification: job.verify ?? null,
    verificationError: job.verifyError ?? null,
    postedVerification: job.verifySent ?? null,
    held,
    push,
  };
}
