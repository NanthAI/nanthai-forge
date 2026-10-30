// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { readHostedRecord } from './projectHostedRecords';
import { loadLanding } from './projectHostedLandingStore';
import { hostedRecordSchema } from '../src/hosted-records';
import { canonicalPayload } from '../src/hosted-source-operation';
import { digest } from '../src/portable-hash';
import { invariant } from '../src/errors';
import type { HostedLandingRequest } from '../src/hosted-landing';

export const landingAlias = (
  ctx: QueryCtx | MutationCtx,
  input: { projectId: Id<'hostedProjects'>; actor: string; operationId: string },
) =>
  ctx.db
    .query('projectHostedLandingAliases')
    .withIndex('by_project_and_actor_and_operation', q =>
      q.eq('projectId', input.projectId).eq('actor', input.actor).eq('operationId', input.operationId),
    )
    .unique();

/** Client operation aliases refer to one desired state. Index lookups inspect
 * only canonical metadata roots, never source pages or the owner's writer lock. */
export async function reuseHostedLanding(
  ctx: MutationCtx,
  input: { projectId: Id<'hostedProjects'>; actor: string; request: HostedLandingRequest },
) {
  const identity = { projectId: input.projectId, actor: input.actor, operationId: input.request.operationId };
  const requestHash = digest(canonicalPayload(input.request));
  const alias = await landingAlias(ctx, identity);
  if (alias) {
    invariant(
      alias.requestHash === requestHash,
      'WORK_OPERATION_CHANGED',
      'Replay the original landing request.',
    );
    return {
      state: (await loadLanding(ctx, { projectId: input.projectId, submissionId: alias.submissionId })).state,
    };
  }
  // Reviewed API Candidates retain independent person selections. The agent
  // finish/land protocol describes a desired set of saved Lane heads.
  if (!input.request.agent || !input.request.finish) return {};
  const original = await ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_actor_and_operation', q =>
      q
        .eq('projectId', input.projectId)
        .eq('actor', input.actor)
        .eq('operationId', input.request.operationId),
    )
    .unique();
  if (original) return {}; // beginHostedOperation validates the immutable replay.
  const row = await readHostedRecord(ctx, {
    projectId: input.projectId,
    actor: input.actor,
    kind: 'candidate',
    key: input.request.candidateId,
  });
  invariant(row, 'NOT_FOUND', 'Select a canonical hosted Candidate.');
  const candidate = hostedRecordSchema.parse(JSON.parse(row.value));
  invariant(
    candidate.kind === 'candidate' &&
      (candidate.result.status === 'clean'
        ? candidate.result.head === input.request.expectedHead
        : input.request.expectedHead === null),
    'VIEW_STALE',
    'Select the exact Candidate head.',
  );
  const selectionKey = digest(
    canonicalPayload({
      channel: input.request.channel,
      ...(input.request.priority === 'urgent' ? { priority: 'urgent' } : {}),
      inputs: candidate.inputs,
      dependencies: candidate.dependencies,
      agent: input.request.agent,
      check: input.request.check,
      after: input.request.finish.after,
    }),
  );
  const [existing] = await ctx.db
    .query('projectHostedLandingRequests')
    .withIndex('by_project_and_selection', q =>
      q.eq('projectId', input.projectId).eq('selectionKey', selectionKey),
    )
    .take(1);
  if (!existing) return { selectionKey };
  await ctx.db.insert('projectHostedLandingAliases', {
    ...identity,
    requestHash,
    submissionId: existing.submissionId,
  });
  return {
    state: (await loadLanding(ctx, { projectId: input.projectId, submissionId: existing.submissionId }))
      .state,
  };
}
