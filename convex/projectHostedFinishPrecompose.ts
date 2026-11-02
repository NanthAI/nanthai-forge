// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { hostedFinishSchema } from '../src/hosted-finish';
import { canonicalPayload } from '../src/hosted-source-operation';

/** The useful queue claim owns source preparation in this same transaction.
 * Detach the advisory job and its IO wake before forming a train or retry. Its
 * immutable operation remains available only as an exact-main source cache;
 * completion can no longer find this finish through the compose index. */
export async function claimFinishPrecompose(ctx: MutationCtx, row: Doc<'projectHostedFinishes'>) {
  const value = hostedFinishSchema.parse(JSON.parse(row.value));
  const pending = value.pending;
  if (!pending?.precompose) return;
  if (row.wake) await ctx.scheduler.cancel(row.wake.taskId);
  const claimed = {
    ...value,
    pending: null,
    precomposed: {
      operationId: pending.operations.compose,
      parentAttemptId: pending.parentAttemptId,
      main: pending.main,
    },
  };
  await ctx.db.patch(row._id, {
    wake: null,
    reuseLease: undefined,
    composeOperationId: null,
    value: canonicalPayload(claimed),
  });
}
