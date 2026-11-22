// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { MutationCtx } from './server';
import type { Doc, Id } from './_generated/dataModel';
import type { HostedLandingState } from '../src/hosted-landing';
import { hostedAcceptanceSchema } from '../src/hosted-acceptance';
import { statsLanding } from './projectStats';
import { statsDaySchema, type StatsDay } from '../src/stats-estimate';
import { DISCARD_CAUSES, type RunTally } from '../src/stats-runs';
import { utcDay } from './projectStatsClose';
import { adjustClosedRunnerDay } from './cancelledRunUsage';
import { canonicalPayload } from '../src/hosted-source-operation';
type StatsBaseline = NonNullable<Doc<'projectHostedLandingRequests'>['runnerAccounting']>['statsBaseline'];
export type CancelledOwnerChange = {
  before: HostedLandingState;
  state: HostedLandingState;
  beforePending: number;
  pending: number;
  statsBaseline?: StatsBaseline;
};
// Closed days are derived. Missing or unreadable data cannot block the canonical
// check and landing usage, including when the terminal mutation is still cancelling the run.
async function readClosedDay(ctx: MutationCtx, projectId: Id<'hostedProjects'>, day: string) {
  try {
    const row = await ctx.db
      .query('projectStatsDays')
      .withIndex('by_project_and_day', q => q.eq('projectId', projectId).eq('day', day))
      .unique();
    if (!row) return undefined;
    const parsed = statsDaySchema.safeParse(JSON.parse(row.value));
    // Today so far (Item 580b1a1a) is not closed: its real close reads the corrected counts itself.
    if (parsed.success && parsed.data.schema === 2 && parsed.data.provisional !== undefined) return undefined;
    return parsed.success ? { row, value: parsed.data } : null;
  } catch {
    return null;
  }
}

async function patchClosedDay(
  ctx: MutationCtx,
  id: Id<'projectStatsDays'>,
  value: StatsDay,
  lateRuns?: Doc<'projectStatsDays'>['lateRuns'],
) {
  try {
    const parsed = statsDaySchema.safeParse(value);
    if (!parsed.success) return false;
    await ctx.db.patch(id, {
      value: canonicalPayload(parsed.data),
      ...(lateRuns ? { lateRuns } : {}),
    });
    return true;
  } catch {
    return false;
  }
}

const { id, at, agentRun, actor } = hostedAcceptanceSchema.shape;
const statsReceipt = z.object({ id, at, agentRun, actor });

async function readReceipt(ctx: MutationCtx, projectId: Id<'hostedProjects'>, receiptId: string) {
  try {
    const row = await ctx.db
      .query('projectHostedAcceptances')
      .withIndex('by_project_and_receipt', q => q.eq('projectId', projectId).eq('receiptId', receiptId))
      .unique();
    if (!row) return null;
    const parsed = statsReceipt.safeParse(JSON.parse(row.value));
    return parsed.success ? { at: row._creationTime, receipt: parsed.data } : null;
  } catch {
    return null;
  }
}

/** Pending and completed usage apply deltas only to the day close's exact membership.
 * If a derived read or write failed, retain its last applied input on the owner.
 * A later correction then starts from that input, rather than from the newer canonical counts. */
export async function adjustCancelledRunDays(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  changes: CancelledOwnerChange[],
) {
  const days = new Map<string, Awaited<ReturnType<typeof readClosedDay>>>();
  const adjusted = new Map<string, CancelledOwnerChange[]>();
  const missed = new Map<string, NonNullable<StatsBaseline>>();
  const remember = (change: CancelledOwnerChange, baseline = change.statsBaseline) => {
    const now = Date.now();
    missed.set(
      change.state.id,
      baseline
        ? { ...baseline, lastMissedAt: now }
        : {
            at: now,
            lastMissedAt: now,
            pending: change.beforePending > 0,
            discardedSeconds: change.before.counts?.discardedRunnerSeconds ?? null,
            unknown: Boolean(change.before.counts?.discardedRunnerUnknown),
          },
    );
  };
  for (const change of changes) {
    if (!change.state.acceptance || change.state.phase !== 'landed') continue;
    const source = await readReceipt(ctx, projectId, change.state.acceptance.receiptId);
    if (!source) {
      remember(change);
      continue;
    }
    // closeDay assigns receipt membership by this indexed system timestamp.
    const day = utcDay(source.at);
    if (!days.has(day)) days.set(day, await readClosedDay(ctx, projectId, day));
    const closed = days.get(day);
    if (closed === null) remember(change);
    const contribution = closed?.row.runnerContributions?.find(r => r.submissionId === change.state.id);
    if (!closed || !contribution) continue;
    const baseline = change.statsBaseline;
    const created = Math.floor(closed.row._creationTime);
    // If the day closed between failed attempts, its input could be any of the
    // intervening states. Keep the day intact rather than guessing a delta.
    if (baseline && created > baseline.at && created <= baseline.lastMissedAt) {
      remember(change);
      continue;
    }
    const prior = baseline && created <= baseline.at ? baseline : undefined;
    const before = prior
      ? {
          ...change.before,
          counts: {
            ...change.before.counts,
            discardedRunnerSeconds: prior.discardedSeconds ?? undefined,
            discardedRunnerUnknown: prior.unknown
              ? ('superseded-check-execution-unreported' as const)
              : undefined,
          },
        }
      : change.before;
    const resubmitted = contribution.resubmitted === true;
    closed.value = adjustClosedRunnerDay(
      closed.value,
      statsLanding(source.receipt, before, prior ? Number(prior.pending) : change.beforePending, resubmitted),
      statsLanding(source.receipt, change.state, change.pending, resubmitted),
      contribution.reruns,
    );
    const affected = adjusted.get(day) ?? [];
    affected.push({ ...change, statsBaseline: prior });
    adjusted.set(day, affected);
  }
  for (const [day, affected] of adjusted) {
    const closed = days.get(day)!;
    if (!(await patchClosedDay(ctx, closed.row._id, closed.value)))
      for (const change of affected) remember(change);
  }
  return missed;
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
  const closed = await readClosedDay(ctx, projectId, utcDay(run.startedAt));
  const bucket = closed?.row.lateRuns?.find(r => r.runId === run.id)?.bucket;
  if (!closed || !bucket) return;
  const { row, value: day } = closed;
  if (day.schema !== 2 || !day.ci) return;
  const known = (t: RunTally) => ({
    runs: t.runs,
    seconds: t.seconds + seconds,
    unknown: Math.max(0, t.unknown - 1),
  });
  const ci = { ...day.ci, all: known(day.ci.all) };
  if (bucket === 'accepted' || bucket === 'pending' || bucket === 'unlinked') ci[bucket] = known(ci[bucket]);
  else {
    const cause = DISCARD_CAUSES.find(cause => cause === bucket);
    if (!cause) return;
    ci.discarded = { ...ci.discarded, [cause]: known(ci.discarded[cause]) };
  }
  await patchClosedDay(
    ctx,
    row._id,
    { ...day, ci },
    row.lateRuns!.filter(r => r.runId !== run.id),
  );
}
