// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { HostedCheckRun } from './hosted-check.js';
import { canonicalPayload } from './hosted-source-operation.js';
import { digest } from './state/hash.js';
import { capCheckReports, encodedBytes } from './check-report-cap.js';
import { semanticReportsSchema } from './intent-semantic-conflict.js';
const file = z.object({ file: z.string(), report: semanticReportsSchema.valueType }).strict();
export const checkFileSummarySchema = z
  .object({
    counts: z
      .object({
        total: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative(),
        flaky: z.number().int().nonnegative(),
      })
      .strict(),
    omitted: z
      .object({ failed: z.number().int().nonnegative(), flaky: z.number().int().nonnegative() })
      .strict()
      .optional(),
    truncated: z.number().int().nonnegative().optional(),
    failed: z.array(file),
    flaky: z.array(file),
  })
  .strict();
const flakyErrors = 5;
const flakyErrorChars = 240;
/** Failed files that keep their first error in the compact summary (the receipt lists each, then "N more"),
 * the characters kept per error, and a total budget counted like the report cap (JSON-escaped twice, since the
 * run document stores this summary as a string): about 5 KB for ordinary text, never more than failedErrorBytes. */
export const failedErrors = 20;
export const failedErrorChars = 240;
export const failedErrorBytes = 6 * 1024;
/** Derived from the existing result; no log fetch or additional result mutation. */
export function checkFileSummary(reports: z.infer<typeof semanticReportsSchema>, budget = 8 * 1024) {
  const names = Object.keys(reports);
  const counts = { total: names.length, failed: 0, flaky: 0 };
  for (const file of names) {
    if (reports[file]!.failed) counts.failed++;
    else if (reports[file]!.flaky) counts.flaky++;
  }
  // Count the existing cap without allocating another full report set.
  const { truncated } = capCheckReports(reports, false);
  const summary: z.infer<typeof checkFileSummarySchema> = {
    counts,
    ...(truncated ? { truncated } : {}),
    failed: [],
    flaky: [],
    omitted: { failed: counts.failed, flaky: counts.flaky },
  };
  const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(JSON.stringify(value))).length;
  let used = size(summary),
    failedNamed = 0,
    failedBytes = 0,
    flakyNamed = 0;
  // Only the bounded prefix is materialized or serialized. A mass failure must not
  // allocate/encode all failed records merely to discard them during binary search.
  for (const kind of ['failed', 'flaky'] as const) {
    for (const file of names) {
      const original = reports[file]!;
      if (kind === 'failed' ? !original.failed : original.failed || !original.flaky) continue;
      const { firstError, ...report } = original;
      const error = firstError?.replace(/\s+/g, ' ');
      if (error && kind === 'failed') {
        const text = error.slice(0, failedErrorChars);
        if (failedNamed < failedErrors && failedBytes + encodedBytes(text) <= failedErrorBytes) {
          failedNamed++;
          failedBytes += encodedBytes(text);
          (report as { firstError?: string }).firstError = text;
        }
      } else if (error && flakyNamed++ < flakyErrors)
        (report as { firstError?: string }).firstError = error.slice(0, flakyErrorChars);
      const item = { file, report };
      const added = size([item]) - size([]) + (summary[kind].length ? 1 : 0);
      if (used + added > budget) return summary;
      used += added;
      summary[kind].push(item);
      summary.omitted![kind]--;
    }
  }
  delete summary.omitted;
  return summary;
}

/** Transaction readers need only the reports named by the pinned semantic plan. */
export function checkReportHeader(run: HostedCheckRun, summaryBudget = 8 * 1024) {
  const reports = run.contractReports;
  if (!reports) return;
  run.testFiles = checkFileSummary(reports, summaryBudget);
  const named = new Set([
    ...(run.semanticPlan?.members.flatMap(member => member.tests.map(test => test.path)) ?? []),
    ...(run.gate?.tests ?? []),
  ]);
  run.reportSummary = {
    slowest: Object.entries(reports)
      .flatMap(([file, report]) =>
        report.durationMs === undefined ? [] : [{ file, durationMs: report.durationMs }],
      )
      .sort((a, b) => b.durationMs - a.durationMs || a.file.localeCompare(b.file))
      .slice(0, 5),
    semantic: Object.fromEntries(
      [...named]
        .filter(file => reports[file])
        .map(file => {
          const { failed, durationMs, flaky } = reports[file]!;
          return [
            file,
            { failed, ...(durationMs === undefined ? {} : { durationMs }), ...(flaky ? { flaky } : {}) },
          ];
        }),
    ),
  };
}
export function checkReportPointer(reports: NonNullable<HostedCheckRun['contractReports']>) {
  const body = canonicalPayload(reports);
  return {
    digest: digest(body),
    size: new TextEncoder().encode(body).length,
    files: Object.keys(reports).length,
  };
}
