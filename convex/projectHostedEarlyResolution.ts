// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { EarlyResolution } from '../src/early-resolution';
import type { HostedLandingState } from '../src/hosted-landing';
import { loadLanding, loadLandingAttempt } from './projectHostedLandingStore';
import { loadFinish } from './projectHostedFinishStore';
import { invariant } from '../src/errors';

export async function earlyPredecessor(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  pin: EarlyResolution['predecessor'],
) {
  const { row, state } = await loadLanding(ctx, { projectId, submissionId: pin.submissionId });
  const attempt = await loadLandingAttempt(ctx, { projectId, attemptId: state.attemptId });
  const landed =
    state.phase === 'landed' &&
    state.acceptance?.head === pin.head &&
    state.acceptance.receiptId === pin.receiptId;
  const pending =
    ['checking', 'ready', 'queued'].includes(state.phase) &&
    row.pipelineRetiredAttemptId !== state.attemptId &&
    state.observation.pendingReason !== 'waiting-for-review' &&
    attempt.candidate.head === pin.head &&
    attempt.operations.accept === pin.receiptId;
  invariant(
    landed || pending,
    'STACK_PARENT_CHANGED',
    'The exact early-resolution predecessor changed or did not land. Sync onto main and resolve again.',
  );
  return { row, state, attempt, landed };
}
export async function predecessorLane(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  submissionId: string,
  knownState?: HostedLandingState,
) {
  const finish = await loadFinish(ctx, { projectId, submissionId });
  const state = knownState ?? (await loadLanding(ctx, { projectId, submissionId })).state;
  const selections = await ctx.db
    .query('projectHostedComposeSelections')
    .withIndex('by_project_and_actor_and_operation_and_kind_and_key', q =>
      q
        .eq('projectId', projectId)
        .eq('actor', state.actor)
        .eq('operationId', finish.value.source.operationId)
        .eq('kind', 'inputs'),
    )
    .take(1);
  invariant(selections[0], 'SOURCE_UNAVAILABLE', 'The exact predecessor Lane selection is unavailable.');
  return selections[0].key;
}
