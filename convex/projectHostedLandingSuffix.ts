// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { batchRow, batchSchema } from './projectHostedLandingBatchState';
import { hostedLandingStateSchema, type HostedLandingState } from '../src/hosted-landing';

/** Largest configurable pipeline (`checks.concurrency`), so the walk is bounded. */
const MAX_DEPTH = 16;
/** Never wait for work that waits for you (landing-queue model, `prequeue-suffix`).
 * True when `other` belongs to a cohort whose speculative predecessor chain reaches
 * `row`'s group: it can publish only after `row`, so its older place in the queue
 * must not hold `row` back. One batch read and one row read per pipeline step;
 * `other` outside a cohort costs nothing; callers consult it only for entries that
 * entered the queue after a pre-queue Lane check. */
export async function stackedBehind(
  ctx: QueryCtx | MutationCtx,
  row: Pick<Doc<'projectHostedLandingRequests'>, 'projectId'>,
  state: HostedLandingState,
  other: HostedLandingState,
) {
  let current = other;
  for (let depth = 0; depth < MAX_DEPTH && current.batchId; depth++) {
    const batch = await batchRow(ctx, { projectId: row.projectId, batchId: current.batchId });
    const predecessor = batch ? batchSchema.parse(JSON.parse(batch.value)).predecessor : undefined;
    if (!predecessor) return false;
    if (predecessor.submissionId === state.id) return true;
    const next = await ctx.db
      .query('projectHostedLandingRequests')
      .withIndex('by_project_and_submission', q =>
        q.eq('projectId', row.projectId).eq('submissionId', predecessor.submissionId),
      )
      .unique();
    if (!next) return false;
    current = hostedLandingStateSchema.parse(JSON.parse(next.value));
    if (state.batchId && current.batchId === state.batchId) return true;
  }
  return false;
}
