// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { composeRow, composeStateSchema } from './projectHostedComposeStore';
import { landingRow } from './projectHostedLandingStore';
import { hostedLandingStateSchema } from '../src/hosted-landing';
import { invariant } from '../src/errors';

/** Newest compositions of one Lane that can still hold a live finish. */
const RECENT_COMPOSITIONS = 8;
const LIVE = new Set(['composing', 'queued', 'checking', 'ready']);

/** The live finish that a new head for this Lane would silently supersede, or
 * null. Reverse lookup rides the compose selections (no backfill): at most
 * RECENT_COMPOSITIONS selections, each one compose row, one landing query and
 * one desired-landing query. A finish composed before the Lane's current head
 * was written is already doomed, so it does not count. */
export async function liveLaneFinish(
  ctx: QueryCtx | MutationCtx,
  input: { projectId: Id<'hostedProjects'>; laneId: string; headWrittenAt: string },
) {
  const selections = await ctx.db
    .query('projectHostedComposeSelections')
    .withIndex('by_project_and_kind_and_key', q =>
      q.eq('projectId', input.projectId).eq('kind', 'inputs').eq('key', input.laneId),
    )
    .order('desc')
    .take(RECENT_COMPOSITIONS);
  for (const selection of selections) {
    const compose = await composeRow(ctx, selection);
    if (!compose) continue;
    const { candidateId } = composeStateSchema.parse(JSON.parse(compose.value));
    const requests = await ctx.db
      .query('projectHostedLandingRequests')
      .withIndex('by_project_and_candidate_and_sequence', q =>
        q.eq('projectId', input.projectId).eq('candidateId', candidateId),
      )
      .order('desc')
      .take(3);
    const [desired] = requests.length
      ? []
      : await ctx.db
          .query('projectHostedLandingDesired')
          .withIndex('by_project_and_compose', q =>
            q.eq('projectId', input.projectId).eq('composeOperationId', selection.operationId),
          )
          .take(1);
    const rows = [
      ...requests.map(row => row.value),
      ...(desired && !(await landingRow(ctx, desired)) ? [desired.value] : []),
    ];
    for (const value of rows) {
      const state = hostedLandingStateSchema.parse(JSON.parse(value));
      const composedAt = state.timing?.composeStartedAt ?? state.at;
      if (LIVE.has(state.phase) && composedAt >= input.headWrittenAt)
        return { submissionId: state.id, phase: state.phase };
    }
  }
  return null;
}

export const laneFinishActiveMessage = (laneId: string, finish: { submissionId: string; phase: string }) =>
  `Lane ${laneId} has an active finish (submission ${finish.submissionId}, ${finish.phase}). ` +
  'Saving new changes now would supersede it and throw away its checks. Wait for it to land or fail, ' +
  'then save again. To replace it on purpose, save with supersedeFinish:true.';

export async function refuseLiveLaneFinish(
  ctx: QueryCtx | MutationCtx,
  input: { projectId: Id<'hostedProjects'>; laneId: string; headWrittenAt: string },
) {
  const finish = await liveLaneFinish(ctx, input);
  invariant(!finish, 'LANE_FINISH_ACTIVE', finish ? laneFinishActiveMessage(input.laneId, finish) : '');
}
