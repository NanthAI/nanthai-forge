// SPDX-License-Identifier: Apache-2.0
import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import type { HostedLandingState } from '../src/hosted-landing';
import { checkCause, type CheckCause, type HostedCheckRun } from '../src/hosted-check';
import { recordFeedEvent, type FeedWrite } from './projectFeedStore';

type Project = Id<'hostedProjects'>;
type FeedLane = { laneId: string; actor: string };

async function* composeLanes(
  ctx: MutationCtx,
  projectId: Project,
  compose: { actor: string; operationId: string },
) {
  let after = '';
  for (;;) {
    const rows = await ctx.db
      .query('projectHostedComposeSelections')
      .withIndex('by_project_and_actor_and_operation_and_kind_and_key', q =>
        q
          .eq('projectId', projectId)
          .eq('actor', compose.actor)
          .eq('operationId', compose.operationId)
          .eq('kind', 'inputs')
          .gt('key', after),
      )
      .take(100);
    yield rows.map(row => ({ laneId: row.key, actor: row.laneActor ?? row.actor }));
    if (rows.length < 100) break;
    after = rows.at(-1)!.key;
  }
}

async function candidateCompose(ctx: MutationCtx, projectId: Project, candidateId: string) {
  let selected: string | undefined = candidateId;
  while (selected) {
    const row = await ctx.db
      .query('projectHostedComposes')
      .withIndex('by_project_and_candidate', q => q.eq('projectId', projectId).eq('candidateId', selected))
      .unique();
    if (!row?.selectionCandidateId) return row;
    selected = row.selectionCandidateId;
  }
  return null;
}

async function landingLanes(
  ctx: MutationCtx,
  projectId: Project,
  state: HostedLandingState,
): Promise<AsyncIterable<FeedLane[]> | undefined> {
  const composeOperationId = state.request.finish?.composeOperationId;
  const compose = composeOperationId
    ? { actor: state.actor, operationId: composeOperationId }
    : await candidateCompose(ctx, projectId, state.request.candidateId);
  if (compose) return composeLanes(ctx, projectId, compose);
  return undefined;
}

type PlanLanes = readonly { laneId: string; actor?: string }[];

export async function recordLandedFeedPage(
  ctx: MutationCtx,
  input: {
    projectId: Project;
    receiptId: string;
    submissionId: string;
    operationId: string;
    runId?: string;
    actor: string;
  },
  lanes: PlanLanes,
) {
  await recordFeedEvent(
    ctx,
    ...lanes.map<FeedWrite>(lane => ({
      ...input,
      kind: 'landing.landed',
      laneId: lane.laneId,
      actor: lane.actor ?? input.actor,
    })),
  );
}

export async function recordLandingFeed(
  ctx: MutationCtx,
  state: HostedLandingState,
  runId?: string | null,
  plannedLanes?: PlanLanes,
) {
  const projectId = state.projectId as Project;
  if (state.phase === 'landed') {
    if (state.acceptance && plannedLanes)
      await recordLandedFeedPage(
        ctx,
        {
          projectId,
          submissionId: state.id,
          operationId: state.operationId,
          receiptId: state.acceptance.receiptId,
          actor: state.actor,
          ...(runId ? { runId } : {}),
        },
        plannedLanes,
      );
    return;
  }
  const code = state.error?.code;
  const kind =
    code === 'LANDING_CANCELLED' || code === 'LANDING_SUPERSEDED' ? 'landing.cancelled' : 'landing.failed';
  const lanes = await landingLanes(ctx, projectId, state);
  if (!lanes) return;
  for await (const page of lanes)
    await recordFeedEvent(
      ctx,
      ...page.map<FeedWrite>(lane => ({
        projectId,
        ...lane,
        kind,
        operationId: state.operationId,
        submissionId: state.id,
        ...(code && /^[A-Z][A-Z0-9_]{0,63}$/.test(code) ? { code } : {}),
        ...(runId ? { runId } : {}),
      })),
    );
}

export async function recordCheckFeed(ctx: MutationCtx, run: HostedCheckRun, cause?: CheckCause) {
  if (cause !== checkCause.manual && cause !== checkCause.proof && cause !== checkCause.pull) return;
  const projectId = run.projectId as Project;
  const kind = run.status === 'passed' ? 'check.passed' : 'check.failed';
  const compose = await candidateCompose(ctx, projectId, run.request.candidateId);
  if (!compose) return;
  for await (const page of composeLanes(ctx, projectId, compose))
    await recordFeedEvent(
      ctx,
      ...page.map<FeedWrite>(lane => ({
        projectId,
        ...lane,
        kind,
        operationId: run.request.operationId,
        runId: run.id,
      })),
    );
}
