// SPDX-License-Identifier: Apache-2.0
// On-demand health report over the failure log (Item 2c420916): `nforge metrics ROOT --failures`. One bounded
// indexed read per run, never a subscription or a timer; the lead check-in runs it (docs/agents/lead.md).
import { v } from 'convex/values';
import { query } from './cliServer';
import { metricsReader } from './projectSelfMetrics';
import { report as reportError } from './errors';
import { invariant } from '../src/errors';
import type { FailureRecord } from './projectFailureLog';

/** Most rows one report reads: about 300 bytes each, so at most about 150 KB. */
export const FAILURE_REPORT_ROWS = 500;

type Row = { _creationTime: number; operationId: string; value: string };
const median = (values: number[]) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = sorted.length >> 1;
  return sorted.length % 2 ? sorted[middle]! : Math.round((sorted[middle - 1]! + sorted[middle]!) / 2);
};

/** Counts by code and kind, and by UTC day, from rows already read (newest first). No reads. */
export function failureReport(rows: Row[], window: { from: string; to: string }, complete: boolean) {
  const codes = new Map<
    string,
    {
      code: string;
      kind: FailureRecord['kind'];
      count: number;
      firstAt: string;
      lastAt: string;
      elapsed: number[];
      last: { operationId: string; message: string };
    }
  >();
  const days = new Map<string, number>();
  for (const row of rows) {
    const record = JSON.parse(row.value) as FailureRecord;
    const at = new Date(row._creationTime).toISOString();
    const key = `${record.kind}:${record.code}`;
    const entry = codes.get(key) ?? {
      code: record.code,
      kind: record.kind,
      count: 0,
      firstAt: at,
      lastAt: at,
      elapsed: [],
      last: { operationId: row.operationId, message: record.message },
    };
    entry.count++;
    entry.firstAt = at < entry.firstAt ? at : entry.firstAt;
    if (at > entry.lastAt) {
      entry.lastAt = at;
      entry.last = { operationId: row.operationId, message: record.message };
    }
    if (record.elapsedMs !== null) entry.elapsed.push(record.elapsedMs);
    codes.set(key, entry);
    days.set(at.slice(0, 10), (days.get(at.slice(0, 10)) ?? 0) + 1);
  }
  return {
    schema: 1,
    window,
    complete,
    failures: rows.length,
    codes: [...codes.values()]
      .sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt))
      .map(({ elapsed, ...entry }) => ({ ...entry, medianElapsedMs: median(elapsed) })),
    days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, count]) => ({ day, count })),
  };
}

/**
 * The health report for [from, to): one bounded indexed read of at most FAILURE_REPORT_ROWS rows, newest
 * first. `complete` is false when the window held more; narrow the window then. Owner or maintainer only.
 */
export const report = query({
  args: { projectId: v.id('hostedProjects'), from: v.string(), to: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    try {
      await metricsReader(ctx, input.projectId);
      const from = Date.parse(input.from),
        to = Date.parse(input.to);
      invariant(
        Number.isFinite(from) && Number.isFinite(to) && from < to,
        'BAD_ARGUMENT',
        'Use a finite failure window [from,to).',
      );
      const rows = await ctx.db
        .query('projectFailures')
        .withIndex('by_project', q =>
          q.eq('projectId', input.projectId).gte('_creationTime', from).lt('_creationTime', to),
        )
        .order('desc')
        .take(FAILURE_REPORT_ROWS + 1);
      return JSON.stringify(
        failureReport(
          rows.slice(0, FAILURE_REPORT_ROWS),
          { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
          rows.length <= FAILURE_REPORT_ROWS,
        ),
      );
    } catch (error) {
      return reportError(error);
    }
  },
});
