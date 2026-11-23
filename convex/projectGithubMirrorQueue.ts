// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import type { HostedAcceptance } from '../src/hosted-acceptance';
import { effectivePolicy, globPattern } from '../src/autonomy-policy';
import type { HostedCheckRun } from '../src/hosted-check';
import { docsGate, fullGate } from '../src/main-audit';
import { settleInbound } from './projectGithubInboundQueue';
import { ensureMirrorRow } from './projectGithubMirrorRows';
import { mirrorAudit, startMirrorPublish, wakeHeldMirror } from './projectGithubMirrorCadence';
import { notifyMirrorCoverage } from './projectGithubMirrorVerify';
import { scheduleReleaseSign } from './projectReleaseSignDispatch';
export { ensureMirrorRow, mirrorJob, mirrorRow, scheduleMirror } from './projectGithubMirrorRows';
/** Publication and wake are one transaction. No watcher, timer or idle job. */
export async function enqueueGithubMirror(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  receipt: HostedAcceptance,
  evidence?: {
    run?: HostedCheckRun | null;
    revert?: boolean;
    paths?: readonly string[] | null;
    coverage?: boolean;
  },
) {
  const policy = effectivePolicy(project).githubMirror;
  if (project.sourceAuthority?.mode !== 'server' || !policy) return;
  const old = await ctx.db
    .query('projectGithubMirrorJobs')
    .withIndex('by_project_and_receipt', q => q.eq('projectId', project._id).eq('receiptId', receipt.id))
    .order('desc')
    .first();
  // Retarget can publish the same receipt to another repository. The newest job is this
  // receipt's latest target; a retry for that target reuses it, including case-only renames.
  if (old?.repository.toLowerCase() === policy.repo.toLowerCase())
    return { jobId: old._id, scheduled: false };
  // Release signing starts from the landing, before and whatever the mirror does: paused (no
  // auto-push), held, failing or refused (Item 17ce38ba). A retry of a queued publish returned above.
  await scheduleReleaseSign(ctx, project, receipt);
  if (!policy.autoPush) return;
  let queue = await ensureMirrorRow(ctx, project._id, policy.repo);
  if (queue.repositoryKey !== queue.repository.toLowerCase())
    await ctx.db.patch(queue._id, { repositoryKey: queue.repository.toLowerCase() });
  // Two-way sync: an inbound job holding the queue settles with the acceptance that landed it.
  if (queue.activeId && (await settleInbound(ctx, queue, receipt))) queue = (await ctx.db.get(queue._id))!;
  const matching = queue.repository === policy.repo;
  const acceptedAt = Date.parse(receipt.at);
  const sequence = receipt.snapshot.revision;
  const run = evidence?.run;
  const exact =
    run?.status === 'passed' &&
    run.request.expectedHead === receipt.candidate.head &&
    !receipt.crossHeadProof &&
    !evidence?.coverage &&
    fullGate(run) &&
    !docsGate(run);
  const flush = policy.pushNowPaths?.some(glob => {
    const pattern = globPattern(glob);
    return !evidence?.paths || evidence.paths.some(path => pattern.test(path));
  });
  const jobId = await ctx.db.insert('projectGithubMirrorJobs', {
    projectId: project._id,
    receiptId: receipt.id,
    sequence,
    repository: policy.repo,
    repositoryKey: policy.repo.toLowerCase(),
    authorityEpoch: receipt.authorityEpoch,
    status: matching ? 'queued' : 'failed',
    step: 0,
    cursor: null,
    state: receipt.candidate.head,
    ...(Number.isFinite(acceptedAt) ? { acceptedAt } : {}),
    ...(exact ? { exactCheck: true } : {}),
    ...(matching ? {} : { error: 'GITHUB_SYNC_BINDING' }),
  });
  const scheduled = !queue.activeId && matching;
  if (!matching) return { jobId, scheduled };
  if (exact && queue.pendingVerify && run.gate) {
    const audit = await mirrorAudit(ctx, project._id);
    if (audit?.lastGreen?.sequence === sequence && audit.lastGreen.head === receipt.candidate.head)
      queue = await notifyMirrorCoverage(ctx, queue, sequence);
  }
  const changes = {
    queuedPublishes: (queue.queuedPublishes ?? 0) + 1,
    newestPublish: sequence,
    ...(scheduled ? { activeId: jobId } : {}),
    ...(flush ? { flushThrough: sequence } : {}),
    ...(evidence?.revert ? { revertThrough: sequence } : {}),
  };
  await ctx.db.patch(queue._id, changes);
  queue = { ...queue, ...changes };
  if (scheduled) {
    await startMirrorPublish(ctx, project, queue, {
      _id: jobId,
      step: 0,
      sequence,
      cursor: null,
      ...(Number.isFinite(acceptedAt) ? { acceptedAt } : {}),
    });
  } else if (
    evidence?.revert ||
    (flush && !queue.hold?.red) ||
    (queue.hold?.red && exact && !(await mirrorAudit(ctx, project._id))?.red)
  ) {
    await wakeHeldMirror(ctx, queue, Date.now());
  } else if (queue.hold) {
    await wakeHeldMirror(ctx, queue, Date.now(), 'stage');
  }
  return { jobId, scheduled };
}
