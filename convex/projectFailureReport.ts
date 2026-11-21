// SPDX-License-Identifier: Apache-2.0
// On-demand health report over the failure log and accepted receipts (Item 2c420916).
// Bounded indexed reads only; the lead check-in runs it (docs/agents/lead.md).
import { v } from 'convex/values';
import { query } from './cliServer';
import { metricsReader } from './projectSelfMetrics';
import { report as reportError } from './errors';
import { invariant } from '../src/errors';
import type { FailureRecord } from './projectFailureLog';
import {
  checkFailureCodes,
  failureNoise,
  failureNoises,
  messageDetail,
  stripAnsi,
} from '../src/failure-noise';

/** Most rows one report reads: about 300 bytes each (a failed check up to about 1 KB), so at most about 500 KB. */
export const FAILURE_REPORT_ROWS = 500;
const ACCEPTANCE_REPORT_BYTES = 512 * 1024;

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
  const failedLandings = { count: 0, retryCountReported: 0, retries: 0 };
  for (const row of rows) {
    const record = JSON.parse(row.value) as FailureRecord;
    if (record.kind === 'landing') {
      failedLandings.count++;
      if (record.retryCount !== undefined) {
        failedLandings.retryCountReported++;
        failedLandings.retries += record.retryCount;
      }
    }
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
    failedLandings,
    codes: [...codes.values()]
      .sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt))
      .map(({ elapsed, ...entry }) => ({ ...entry, medianElapsedMs: median(elapsed) })),
    days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([day, count]) => ({ day, count })),
  };
}

function acceptedLandings(rows: { retryCount?: number; checkReused?: boolean }[], complete: boolean) {
  let retryCountReported = 0,
    retries = 0,
    checkReuseReported = 0,
    checksReused = 0;
  for (const row of rows) {
    if (row.retryCount !== undefined) {
      retryCountReported++;
      retries += row.retryCount;
    }
    if (row.checkReused !== undefined) {
      checkReuseReported++;
      if (row.checkReused) checksReused++;
    }
  }
  return { count: rows.length, complete, retryCountReported, retries, checkReuseReported, checksReused };
}

/** Most failed checks one read returns (about 500 bytes each). */
export const FAILED_CHECKS_MAX = 100;

/**
 * Failed checks (Item 44f2b109) from rows already read, newest first: each with its code, failing files or
 * static step, first error and noise tag, plus the tag counts and the files that failed more than once on
 * this page. `nextCursor` is the creation time to continue from (`to` of the next call), or null when the
 * window is read. No reads.
 */
export function failedChecks(
  rows: (Row & { _creationTime: number })[],
  options: { limit: number; noise?: string | undefined; more: boolean },
) {
  const listed: NonNullable<ReturnType<typeof checkRow>>[] = [];
  let next: number | null = null;
  for (const [index, row] of rows.entries()) {
    const entry = checkRow(row);
    if (!entry || (options.noise && entry.noise !== options.noise)) continue;
    if (listed.length === options.limit) {
      next = rows[index - 1]!._creationTime;
      break;
    }
    listed.push(entry);
  }
  // Rows scanned without filling the page: continue after the last one scanned.
  if (next === null && options.more) next = rows[rows.length - 1]!._creationTime;
  const noise = Object.fromEntries(failureNoises.map(tag => [tag, 0])) as Record<string, number>;
  const byFile = new Map<string, number>();
  for (const entry of listed) {
    noise[entry.noise]!++;
    for (const file of entry.files ?? []) byFile.set(file, (byFile.get(file) ?? 0) + 1);
  }
  return {
    checks: listed,
    noise,
    repeatedFiles: [...byFile]
      .filter(([, count]) => count > 1)
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .slice(0, 10)
      .map(([file, count]) => ({ file, count })),
    nextCursor: next === null ? null : String(next),
  };
}
function checkRow(row: Row) {
  const record = JSON.parse(row.value) as FailureRecord;
  if (record.kind !== 'landing' || !checkFailureCodes.has(record.code)) return null;
  // Rows from before the detail fields carry it only in their clipped message, and a static step stored before
  // its first error line was kept (the 11-17.. smoke:package rows) is re-read from that message too.
  const old = !record.files && (!record.step || !record.error);
  const detail = old ? { ...record, ...messageDetail(record.message) } : record;
  const { files, more } = detail;
  const step = detail.step && stripAnsi(detail.step);
  const error = detail.error && stripAnsi(detail.error);
  return {
    at: new Date(row._creationTime).toISOString(),
    operationId: row.operationId,
    code: record.code,
    noise: failureNoise({ code: record.code, files, step, error }),
    elapsedMs: record.elapsedMs,
    ...(record.retryCount === undefined ? {} : { retryCount: record.retryCount }),
    ...(files?.length ? { files } : {}),
    ...(more ? { more } : {}),
    ...(step ? { step } : {}),
    ...(error ? { error } : {}),
  };
}

/**
 * The health report for [from, to), newest first. Each stream reports its own coverage.
 * Owner or maintainer only.
 */
export const report = query({
  args: {
    projectId: v.id('hostedProjects'),
    from: v.string(),
    to: v.string(),
    /** List failed checks (newest first) instead of counting by code. */
    checks: v.optional(
      v.object({ limit: v.number(), cursor: v.optional(v.string()), noise: v.optional(v.string()) }),
    ),
  },
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
      const checks = input.checks;
      const cursor = checks?.cursor === undefined ? undefined : Number(checks.cursor);
      invariant(
        !checks ||
          (Number.isInteger(checks.limit) &&
            checks.limit >= 1 &&
            checks.limit <= FAILED_CHECKS_MAX &&
            (cursor === undefined || (Number.isFinite(cursor) && cursor >= from)) &&
            (checks.noise === undefined || (failureNoises as readonly string[]).includes(checks.noise))),
        'BAD_ARGUMENT',
        `Use a limit from 1 to ${FAILED_CHECKS_MAX}, a cursor this report returned and a noise tag of ${failureNoises.join(', ')}.`,
      );
      // A cursor is the creation time of the last row already read: continue strictly before it.
      const end = cursor === undefined ? to : Math.min(to, cursor);
      const rows = await ctx.db
        .query('projectFailures')
        .withIndex('by_project', q =>
          q.eq('projectId', input.projectId).gte('_creationTime', from).lt('_creationTime', end),
        )
        .order('desc')
        .take(FAILURE_REPORT_ROWS + 1);
      if (checks) {
        const window = { from: new Date(from).toISOString(), to: new Date(to).toISOString() };
        return JSON.stringify({
          schema: 1,
          window,
          ...failedChecks(rows.slice(0, FAILURE_REPORT_ROWS), {
            limit: checks.limit,
            noise: checks.noise,
            more: rows.length > FAILURE_REPORT_ROWS,
          }),
        });
      }
      const accepted = await ctx.db
        .query('projectHostedAcceptances')
        .withIndex('by_project', q =>
          q.eq('projectId', input.projectId).gte('_creationTime', from).lt('_creationTime', end),
        )
        .order('desc')
        .paginate({
          cursor: null,
          numItems: FAILURE_REPORT_ROWS,
          maximumRowsRead: FAILURE_REPORT_ROWS,
          maximumBytesRead: ACCEPTANCE_REPORT_BYTES,
        });
      return JSON.stringify({
        ...failureReport(
          rows.slice(0, FAILURE_REPORT_ROWS),
          { from: new Date(from).toISOString(), to: new Date(to).toISOString() },
          rows.length <= FAILURE_REPORT_ROWS,
        ),
        acceptedLandings: acceptedLandings(
          accepted.page,
          accepted.isDone && accepted.pageStatus !== 'SplitRequired',
        ),
      });
    } catch (error) {
      return reportError(error);
    }
  },
});
