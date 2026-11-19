// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './server';
import type { Doc, Id } from './_generated/dataModel';
import type { HostedLandingState } from '../src/hosted-landing';
import type { HostedAcceptance } from '../src/hosted-acceptance';
import { statsLanding } from './projectStats';
import { statsDaySchema } from '../src/stats-estimate';
import type { RunBucket, RunTally } from '../src/stats-runs';
import { utcDay } from './projectStatsClose';
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
    const resubmitted = contribution.resubmitted === true;
    closed.value = adjustClosedRunnerDay(
      closed.value,
      statsLanding(receipt, updated.before, updated.beforePending, resubmitted),
      statsLanding(receipt, updated.state, updated.pending, resubmitted),
      contribution.reruns,
    );
  }
  for (const { row, value } of days.values()) await ctx.db.patch(row._id, { value: canonicalPayload(value) });
}

/** A stopped run's minutes that arrive after its day closed (Item a61d3c91): add them, once, to that day's every-run
 * tally and to the tally its close put the run in (the day row's `lateRuns`), whether or not its work landed. The day
 * is the run's own start day, as the close counts runs. */
export async function adjustClosedRunCi(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  run: { id: string; startedAt: number },
  seconds: number,
) {
  const row = await ctx.db
    .query('projectStatsDays')
    .withIndex('by_project_and_day', q => q.eq('projectId', projectId).eq('day', utcDay(run.startedAt)))
    .unique();
  const late = row?.lateRuns?.find(r => r.runId === run.id);
  if (!row || !late) return;
  const day = statsDaySchema.parse(JSON.parse(row.value));
  if (day.schema !== 2 || !day.ci) return;
  const bucket = late.bucket as RunBucket;
  const known = (t: RunTally) => ({
    runs: t.runs,
    seconds: t.seconds + seconds,
    unknown: Math.max(0, t.unknown - 1),
  });
  const ci = { ...day.ci, all: known(day.ci.all) };
  if (bucket === 'accepted' || bucket === 'pending' || bucket === 'unlinked') ci[bucket] = known(ci[bucket]);
  else ci.discarded = { ...ci.discarded, [bucket]: known(ci.discarded[bucket]) };
  await ctx.db.patch(row._id, {
    value: canonicalPayload({ ...day, ci }),
    lateRuns: row.lateRuns!.filter(r => r.runId !== run.id),
  });
}
