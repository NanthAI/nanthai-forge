// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { HostedCheckRun } from '../src/hosted-check';
import { hostedCheckRunSchema } from '../src/hosted-check';
import { parseTimingHistory, updateHostedTimingHistory } from '../src/hosted-test-timings';

/** Same advisory JSON/EWMA as the native owner's .forge/work/test-timings.json.
 * One indexed document, read/written inside existing authorized transactions.
 * Serialization reserves room for the document fields. */
export async function hostedTimingHistory(ctx: MutationCtx, projectId: Id<'hostedProjects'>) {
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
        try {
          const parsed = hostedCheckRunSchema.safeParse(JSON.parse(item.value));
          if (parsed.success && parsed.data.contractReports) recent.push(parsed.data);
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
  if (!['passed', 'failed'].includes(run.status) || !run.contractReports) return;
  const { row, history } = await hostedTimingHistory(ctx, projectId);
  if (history.runs.includes(run.id)) return;
  const value = { projectId, history: updateHostedTimingHistory(JSON.stringify(history), run) };
  if (row) await ctx.db.replace(row._id, value);
  else await ctx.db.insert('projectHostedTestTimings', value);
}
