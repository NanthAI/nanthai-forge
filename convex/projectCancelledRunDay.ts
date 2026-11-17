// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './server';
import type { Doc, Id } from './_generated/dataModel';
import type { HostedLandingState } from '../src/hosted-landing';
import type { HostedAcceptance } from '../src/hosted-acceptance';
import { statsLanding } from './projectStats';
import { statsDaySchema } from '../src/stats-estimate';
import { adjustClosedRunnerDay } from './cancelledRunUsage';
import { canonicalPayload } from '../src/hosted-source-operation';
export type CancelledOwnerChange = {
  before: HostedLandingState;
  state: HostedLandingState;
  beforePending: number;
  pending: number;
};
/** The day close retains each included landing's price contribution. Pending and
 * completed usage apply inverse/additive deltas to that exact membership only.
 * An older/partial day with no contribution cannot invent coverage. */
export async function adjustCancelledRunDays(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  changes: CancelledOwnerChange[],
) {
  const days = new Map<
    string,
    { row: Doc<'projectStatsDays'>; value: ReturnType<typeof statsDaySchema.parse> }
  >();
  for (const updated of changes) {
    if (!updated.state.acceptance || updated.state.phase !== 'landed') continue;
    const receiptRow = await ctx.db
      .query('projectHostedAcceptances')
      .withIndex('by_project_and_receipt', q =>
        q.eq('projectId', projectId).eq('receiptId', updated.state.acceptance!.receiptId),
      )
      .unique();
    if (!receiptRow) continue;
    const receipt = JSON.parse(receiptRow.value) as HostedAcceptance;
    // closeDay assigns receipt membership by this indexed system timestamp.
    const day = new Date(receiptRow._creationTime).toISOString().slice(0, 10);
    if (!days.has(day)) {
      const row = await ctx.db
        .query('projectStatsDays')
        .withIndex('by_project_and_day', q => q.eq('projectId', projectId).eq('day', day))
        .unique();
      if (row) days.set(day, { row, value: statsDaySchema.parse(JSON.parse(row.value)) });
    }
    const closed = days.get(day);
    const contribution = closed?.row.runnerContributions?.find(r => r.submissionId === updated.state.id);
    if (!closed || !contribution) continue;
    closed.value = adjustClosedRunnerDay(
      closed.value,
      statsLanding(receipt, updated.before, updated.beforePending),
      statsLanding(receipt, updated.state, updated.pending),
      contribution.reruns,
    );
  }
  for (const { row, value } of days.values()) await ctx.db.patch(row._id, { value: canonicalPayload(value) });
}
