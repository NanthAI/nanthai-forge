// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import type { HostedAcceptance } from '../src/hosted-acceptance';
import { effectivePolicy } from '../src/autonomy-policy';
import { settleInbound } from './projectGithubInboundQueue';
import { ensureMirrorRow, scheduleMirror } from './projectGithubMirrorRows';
export { ensureMirrorRow, mirrorJob, mirrorRow, scheduleMirror } from './projectGithubMirrorRows';
/** Publication and wake are one transaction. No watcher, timer or idle job. */
export async function enqueueGithubMirror(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  receipt: HostedAcceptance,
) {
  const policy = effectivePolicy(project).githubMirror;
  if (project.sourceAuthority?.mode !== 'server' || !policy?.autoPush) return;
  const old = await ctx.db
    .query('projectGithubMirrorJobs')
    .withIndex('by_project_and_receipt', q => q.eq('projectId', project._id).eq('receiptId', receipt.id))
    .unique();
  if (old) return;
  let queue = await ensureMirrorRow(ctx, project._id, policy.repo);
  if (queue.repositoryKey !== queue.repository.toLowerCase())
    await ctx.db.patch(queue._id, { repositoryKey: queue.repository.toLowerCase() });
  // Two-way sync: an inbound job holding the queue settles with the acceptance that landed it.
  if (queue.activeId && (await settleInbound(ctx, queue, receipt))) queue = (await ctx.db.get(queue._id))!;
  const jobId = await ctx.db.insert('projectGithubMirrorJobs', {
    projectId: project._id,
    receiptId: receipt.id,
    sequence: receipt.snapshot.revision,
    repository: policy.repo,
    authorityEpoch: receipt.authorityEpoch,
    status: queue.repository === policy.repo ? 'queued' : 'failed',
    step: 0,
    cursor: null,
    state: receipt.candidate.head,
    ...(queue.repository === policy.repo ? {} : { error: 'GITHUB_SYNC_BINDING' }),
  });
  if (!queue.activeId && queue.repository === policy.repo) {
    await ctx.db.patch(queue._id, { activeId: jobId });
    await scheduleMirror(ctx, { _id: jobId, step: 0 });
  }
}
