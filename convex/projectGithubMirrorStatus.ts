// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { channelRow } from './projectHostedChannels';
import { mirrorRow } from './projectGithubMirrorQueue';
import { effectivePolicy } from '../src/autonomy-policy';
import { githubSyncCommitSchema } from '../src/github-sync-types';
import type { HostedMirrorStatus } from '../src/hosted-github-mirror-status';

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
  const targetHead: string | null = main ? JSON.parse(main.selection).head : (job?.state ?? null);
  const lagging = targetHead === null ? null : targetHead !== mapping?.state;
  return {
    repository: queue?.repository ?? policy.repo,
    status: !policy?.autoPush
      ? 'disabled'
      : job?.status === 'failed'
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
    nextAttemptAt: job?.nextAttemptAt ?? null,
    error: job?.error ?? null,
    detail: job?.detail ?? null,
    jobId: job?._id ?? null,
  };
}
