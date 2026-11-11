// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './server';
import type { Id } from './_generated/dataModel';
import type { HostedLandingState } from '../src/hosted-landing';
import { discardedRunnerSeconds } from '../src/cost-budgets';
import { landingSpeedStateSchema } from '../src/landing-speed-alerts';

/** One retained sample per maintenance page: <= 40 pages/project, one speed row, one receipt and
 * one operation row read, at most one speed-row patch. No landing-path call or idle timer. */
export async function repairLandingSpeedPage(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  after: string,
  cutoff: number,
) {
  const row = await ctx.db
    .query('projectLandingSpeed')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .unique();
  if (!row) return { after, done: true, readBytes: 1024 };
  let value: unknown;
  try {
    value = JSON.parse(row.value);
  } catch {
    return { after, done: true, readBytes: row.value.length };
  }
  const parsed = landingSpeedStateSchema.safeParse(value);
  if (!parsed.success) return { after, done: true, readBytes: row.value.length };
  const state = parsed.data;
  // Seek by immutable receipt id, rather than offsets that shift as new samples arrive.
  const sample = state.samples
    .filter(s => s[0] <= cutoff && s[3] > after)
    .sort((a, b) => (a[3] < b[3] ? -1 : 1))[0];
  if (!sample) return { after, done: true, readBytes: row.value.length };
  let readBytes = row.value.length;
  if (sample[7]?.[4] == null) {
    const receipt = await ctx.db
      .query('projectHostedAcceptances')
      .withIndex('by_project_and_receipt', q => q.eq('projectId', projectId).eq('receiptId', sample[3]))
      .unique();
    const operation = receipt
      ? await ctx.db
          .query('projectHostedLandingRequests')
          .withIndex('by_project_and_submission', q =>
            q.eq('projectId', projectId).eq('submissionId', receipt.submissionId),
          )
          .unique()
      : null;
    readBytes += (receipt?.value.length ?? 0) + (operation?.value.length ?? 0);
    const seconds = operation
      ? discardedRunnerSeconds(JSON.parse(operation.value) as HostedLandingState)
      : null;
    if (seconds !== null) {
      sample[7] ??= [null, null, null, null, null, null];
      sample[7][4] = seconds;
      await ctx.db.patch(row._id, { value: JSON.stringify(state) });
    }
  }
  return { after: sample[3], done: false, readBytes };
}
