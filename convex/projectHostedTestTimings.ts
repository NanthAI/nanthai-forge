// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalMutation } from './server';
import { reportsDetached, detachCheckReports, hydrateCheckReports } from './projectHostedCheckReports';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { HostedCheckRun } from '../src/hosted-check';
import { hostedCheckRunSchema } from '../src/hosted-check';
import { parseTimingHistory, updateHostedTimingHistory } from '../src/hosted-test-timings';

/** Same advisory JSON/EWMA as the native owner's .forge/work/test-timings.json.
 * One indexed document, read/written inside existing authorized transactions.
 * Serialization reserves room for the document fields. */
export async function hostedTimingHistory(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  excludeRunId?: string,
) {
  const row = await ctx.db
    .query('projectHostedTestTimings')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .unique();
  let history = parseTimingHistory(row?.history ?? '');
  if (!row) {
    // Bootstrap from already retained fixed-runner reports. At most one latest
    // run per terminal status, never a run-history scan or an extra function call.
    const recent: HostedCheckRun[] = [];
    for (const status of ['passed', 'failed']) {
      const latest = await ctx.db
        .query('projectHostedCheckRuns')
        .withIndex('by_project_and_status', q => q.eq('projectId', projectId).eq('status', status))
        .order('desc')
        .take(1);
      for (const item of latest) {
        if (item.runId === excludeRunId) continue;
        try {
          const parsed = hostedCheckRunSchema.safeParse(JSON.parse(item.value));
          if (parsed.success) {
            if (item.reportParts !== undefined) {
              detachCheckReports(parsed.data, item.reportParts, item.reportDigest ?? '');
              await hydrateCheckReports(ctx, parsed.data);
            }
            if (parsed.data.contractReports) recent.push(parsed.data);
          }
        } catch {
          /* Advisory, malformed old metadata supplies no weights. */
        }
      }
    }
    for (const run of recent.sort((a, b) => (a.endedAt ?? '').localeCompare(b.endedAt ?? '')))
      history = parseTimingHistory(updateHostedTimingHistory(JSON.stringify(history), run));
  }
  return { row, history };
}

export async function recordHostedTestTimings(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  run: HostedCheckRun,
) {
  if (!['passed', 'failed'].includes(run.status)) return;
  if (!run.contractReports) {
    if (reportsDetached(run))
      await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectHostedTestTimings:record'), {
        projectId,
        runId: run.id,
      });
    return;
  }
  const { row, history } = await hostedTimingHistory(ctx, projectId, run.id);
  if (history.runs.includes(run.id)) return;
  const value = { projectId, history: updateHostedTimingHistory(JSON.stringify(history), run) };
  if (row) await ctx.db.replace(row._id, value);
  else await ctx.db.insert('projectHostedTestTimings', value);
}

/** Provider completion keeps the webhook slim; timing metadata is read once after that event. */
export const record = internalMutation({
  args: { projectId: v.id('hostedProjects'), runId: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    const row = await ctx.db
      .query('projectHostedCheckRuns')
      .withIndex('by_project_and_run', q => q.eq('projectId', input.projectId).eq('runId', input.runId))
      .unique();
    if (!row) return null;
    const run = hostedCheckRunSchema.parse(JSON.parse(row.value));
    if (row.reportParts !== undefined) {
      detachCheckReports(run, row.reportParts, row.reportDigest ?? '');
      await hydrateCheckReports(ctx, run);
    }
    await recordHostedTestTimings(ctx, input.projectId, run);
    return null;
  },
});
