// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { writableHostedCheck, writeHostedCheck } from './projectHostedCheckStore';
import { invariant } from '../src/errors';
import { checkPin } from '../src/hosted-check';
import { z } from 'zod';
import { internalMutation } from './server';
import {
  reportsDetached,
  detachCheckReports,
  hydrateCheckReports,
  objectReportTransport,
} from './projectHostedCheckReports';
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
  durations?: Record<string, number>,
  final = true,
) {
  if (!['passed', 'failed'].includes(run.status)) return;
  const transport = objectReportTransport(run);
  if (transport && durations === undefined) return;
  if (!run.contractReports && durations === undefined) {
    if (reportsDetached(run))
      await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectHostedTestTimings:record'), {
        projectId,
        runId: run.id,
      });
    return;
  }
  const part = durations === undefined ? undefined : checkPin({ durations, final });
  if (transport && part) {
    if (transport.timingParts?.includes(part)) return;
    invariant(!transport.timingComplete, 'EVIDENCE_CHANGED', 'Final timing arguments are immutable.');
  }
  const { row, history } = await hostedTimingHistory(ctx, projectId, run.id);
  if (history.runs.includes(run.id)) return;
  let stamp = transport?.timingStamp;
  if (transport) {
    if (
      !history.generation ||
      !Number.isSafeInteger(history.sample) ||
      history.sample! >= Number.MAX_SAFE_INTEGER
    ) {
      history.generation = crypto.randomUUID();
      history.sample = 0;
    }
    if (!stamp) {
      stamp = { generation: history.generation, sequence: ++history.sample! };
      transport.timingStamp = stamp;
    }
    invariant(
      stamp.generation === history.generation,
      'EVIDENCE_CHANGED',
      'Timing history changed during its argument pages.',
    );
  }
  const value = {
    projectId,
    history: updateHostedTimingHistory(JSON.stringify(history), run, durations, stamp?.sequence, final),
  };
  if (transport && part) {
    transport.timingParts = [...(transport.timingParts ?? []), part];
    if (final) transport.timingComplete = true;
  }
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
    if (!row || row.reportStorage === 'r2') return null;
    const run = hostedCheckRunSchema.parse(JSON.parse(row.value));
    if (row.reportParts !== undefined) {
      detachCheckReports(run, row.reportParts, row.reportDigest ?? '');
      await hydrateCheckReports(ctx, run);
    }
    await recordHostedTestTimings(ctx, input.projectId, run);
    return null;
  },
});

/** Only oversized duration arguments need continuation pages; the ordinary collector still settles once. */
export const argumentsPage = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    runId: v.string(),
    reportDigest: v.string(),
    durations: v.string(),
    final: v.boolean(),
  },
  returns: v.null(),
  handler: async (ctx, input) => {
    invariant(
      new TextEncoder().encode(input.durations).length <= 768 * 1024,
      'BAD_ARGUMENT',
      'Page timing arguments.',
    );
    const { run, row } = await writableHostedCheck(ctx, input);
    const transport = objectReportTransport(run);
    invariant(
      transport && run.reportPointer?.digest === input.reportDigest,
      'EVIDENCE_CHANGED',
      'Record timing arguments for their original report pin.',
    );
    if (transport.conclusion === undefined || transport.conclusion === 'cancelled' || run.cancelRequested)
      return null;
    await recordHostedTestTimings(
      ctx,
      input.projectId,
      run,
      z.record(z.string(), z.number().finite().nonnegative()).parse(JSON.parse(input.durations)),
      input.final,
    );
    await writeHostedCheck(ctx, row._id, run);
    return null;
  },
});
