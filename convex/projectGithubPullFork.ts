// SPDX-License-Identifier: Apache-2.0
// Fork pull request heads (Issue f7793473, GitHub's approve-and-run norm). A fork head is read and
// composed like any PR head, so the owner can review its Lane; its check-only run starts only after
// a project owner grants it through the Lane approval request (fe5bea80 request/decide path, the
// projectHostedApprovals row of the PR's Lane, never `live`). Event-driven: one request, one pending
// status, one scheduled expiry; a grant, decline, withdrawal or newer head ends it. Idle zero.
import { makeFunctionReference } from 'convex/server';
import type { MutationCtx } from './server';
import type { Doc } from './_generated/dataModel';
import { saveLane } from './projectHostedSaveStore';
import { approvalRow, fitNote, writeApproval } from './projectHostedApprovalStore';
import { laneApproveUrl } from './projectHostedApprovals';
import { postSystemLaneNote } from './projectBoardSystem';
import { parseInbound } from './projectGithubInboundQueue';
import { endForkApproval, projectLink } from './projectGithubPullQueue';
import { canonicalPayload } from '../src/hosted-source-operation';
import { forkApprovalReason, forkApprovalTtlMs, forkStatus, pullOperationId } from '../src/github-pull-check';
import type { InboundJob } from '../src/github-inbound-job';

type Job = Doc<'projectGithubMirrorJobs'>;
const pending = (ctx: MutationCtx, job: Job, sha: string, description: string, link: string | null) =>
  ctx.scheduler.runAfter(0, makeFunctionReference<'action'>('projectGithubPullStatus:post'), {
    projectId: job.projectId,
    repository: job.repository,
    sha,
    state: 'pending',
    description,
    link,
  });

/** Whether this fork head's check-only run may start now. The first time: open the approval
 * request on its Lane (one indexed read, one write, one board note), post forge/verify pending with
 * the approve link, schedule its expiry and wait on the request. After the owner's grant: close the
 * request, say the run started, and run. Any other wake while it waits changes nothing. */
export async function forkGate(ctx: MutationCtx, job: Job, project: Doc<'hostedProjects'>) {
  const inbound = parseInbound(job),
    pull = inbound.pull!,
    laneId = inbound.laneId!;
  const row = await approvalRow(ctx, project._id, laneId);
  if (pull.approval) {
    const granted =
      row?.operationId === pull.approval &&
      row.pullRequest !== undefined &&
      !row.ended &&
      row.status === 'granted' &&
      row.decision?.head === row.head;
    if (!granted) return false;
    await endForkApproval(ctx, project._id, laneId, pull.approval);
    await pending(ctx, job, pull.head, forkStatus.started, await projectLink(ctx, project, laneId));
    return true;
  }
  const lane = await saveLane(ctx, { projectId: project._id, actor: project.owner, laneId });
  const operationId = pullOperationId(),
    reason = forkApprovalReason(pull.number, pull.head),
    now = Date.now();
  const fields = {
    operationId,
    requester: project.owner,
    reason,
    head: lane.head,
    at: now,
    status: 'requested' as const,
    // A PR Lane never lands: the request holds no landing and costs other landings nothing.
    live: false,
    pullRequest: pull.number,
    decision: undefined,
    ended: undefined,
  };
  if (row) await writeApproval(ctx, row, fields);
  else
    await ctx.db.insert('projectHostedApprovals', { projectId: project._id, laneId, ...fields, version: 1 });
  await ctx.db.patch(job._id, {
    waitKey: operationId,
    inbound: canonicalPayload({ ...inbound, pull: { ...pull, approval: operationId } } satisfies InboundJob),
  });
  const url = laneApproveUrl(project._id, laneId);
  await pending(ctx, job, pull.head, forkStatus.pending, url);
  await postSystemLaneNote(ctx, {
    projectId: project._id,
    id: operationId,
    toLaneId: 'project',
    fromLaneId: laneId,
    author: project.owner,
    text: fitNote(
      `Fork PR run waits for the owner on Lane ${laneId.slice(0, 8)}: `,
      reason,
      url ? ` Owner: ${url}` : '',
    ),
    now,
  });
  await ctx.scheduler.runAfter(
    forkApprovalTtlMs,
    makeFunctionReference<'mutation'>('projectGithubPullQueue:expire'),
    { jobId: job._id, key: operationId },
  );
  return false;
}
