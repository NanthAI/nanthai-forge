// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { channelRow } from './projectHostedChannels';
import { mirrorRow } from './projectGithubMirrorQueue';
import { effectivePolicy } from '../src/autonomy-policy';
import { githubSyncCommitSchema } from '../src/github-sync-types';
import type { HostedMirrorStatus } from '../src/hosted-github-mirror-status';
import { missingObjectDelays } from '../src/hosted-github-retry';
import { inboundJobSchema } from '../src/github-inbound-job';
import { inboundLanding, inboundOutcomeSchema } from './projectGithubInboundQueue';

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
  const mapping = queue?.mapping ? githubSyncCommitSchema.parse(JSON.parse(queue.mapping)) : null;
  // Two-way sync: one more indexed read only while an inbound landing holds the queue.
  const inbound = job?.inbound ? inboundJobSchema.parse(JSON.parse(job.inbound)) : null;
  const settled =
    inbound?.phase === 'landing' && inbound.submissionId
      ? await inboundLanding(ctx, project._id, inbound.submissionId)
      : null;
  const last = queue?.inbound ? inboundOutcomeSchema.parse(JSON.parse(queue.inbound)) : null;
  const inboundDetail = inbound
    ? settled?.phase === 'terminal-failed'
      ? `GitHub ${inbound.commit!.slice(0, 12)} did not land on Forge (Lane ${inbound.laneId!.slice(0, 8)}; ${settled.error ?? 'failed'}). The next Forge landing publishes Forge main over it on GitHub; fix and land that Lane to keep the change.`
      : inbound.commit
        ? `Bringing in GitHub ${inbound.commit.slice(0, 12)} as Lane ${inbound.laneId!.slice(0, 8)} (${inbound.changes ?? 0} changed paths).`
        : 'Reading GitHub main for two-way sync.'
    : last?.note
      ? `GitHub ${last.commit.slice(0, 12)} did not land on Forge (Lane ${last.laneId.slice(0, 8)}${last.error ? `; ${last.error}` : ''}); the next publish takes it out on GitHub.`
      : null;
  const targetHead: string | null = main ? JSON.parse(main.selection).head : (job?.state ?? null);
  const lagging = targetHead === null ? null : targetHead !== mapping?.state;
  return {
    repository: queue?.repository ?? policy.repo,
    status: !policy?.autoPush
      ? 'disabled'
      : job?.status === 'failed' || settled?.phase === 'terminal-failed'
        ? 'failed'
        : job?.status === 'retrying'
          ? 'retrying'
          : job
            ? 'syncing'
            : lagging === false
              ? 'synced'
              : 'unknown',
    targetHead,
    mirroredHead: mapping?.state ?? null,
    gitHead: mapping?.commit ?? null,
    lagging,
    pendingSince: job?._creationTime ?? null,
    mirroredAt: queue?.mirroredAt ?? null,
    failures: job?.failures ?? 0,
    // Only lag 422s retry (others are terminal at once); 429/5xx and transient codes get 5 tries (projectGithubMirrorStore:failed).
    attemptLimit:
      job?.status !== 'retrying' ? null : job.httpStatus === 422 ? missingObjectDelays.length + 1 : 5,
    nextAttemptAt: job?.nextAttemptAt ?? null,
    error: job?.error ?? (settled?.phase === 'terminal-failed' ? 'GITHUB_INBOUND_FAILED' : null),
    // targetHead is current main; name the State this failing job publishes.
    detail: job?.detail
      ? inbound
        ? `Inbound job: ${job.detail}`
        : `Job for State ${job.state.slice(0, 8)}: ${job.detail}`
      : inboundDetail,
    jobId: job?._id ?? null,
  };
}
