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
export function checkFileSummary(reports: z.infer<typeof semanticReportsSchema>) {
  const files = Object.entries(reports).map(([file, { firstError: _excerpt, ...report }]) => {
    void _excerpt;
    return { file, report };
  });
  // A flaky file names its test and first error (the failed first attempt), at most flakyErrors files of
  // flakyErrorChars each. The first failedErrors failed files keep theirs too (failedErrorChars each), so a
  // failed landing lists every failing file with its error without a log fetch; the rest are names only.
  let named = 0,
    failedNamed = 0,
    failedBytes = 0;
  for (const item of files) {
    const error = reports[item.file]?.firstError?.replace(/\s+/g, ' ');
    if (!error) continue;
    const report = item.report as { firstError?: string };
    if (item.report.failed) {
      const text = error.slice(0, failedErrorChars);
      if (failedNamed < failedErrors && failedBytes + encodedBytes(text) <= failedErrorBytes) {
        failedNamed++;
        failedBytes += encodedBytes(text);
        report.firstError = text;
      }
    } else if (item.report.flaky && named++ < flakyErrors)
      report.firstError = error.slice(0, flakyErrorChars);
  }
  const { truncated } = capCheckReports(reports);
  const failed = files.filter(item => item.report.failed);
  const flaky = files.filter(item => item.report.flaky && !item.report.failed);
  const summary = {
    counts: { total: files.length, failed: failed.length, flaky: flaky.length },
    ...(truncated ? { truncated } : {}),
    failed,
    flaky,
  };
  // Count the stored string's escaping as well. Names and excerpts cannot grow the hot row
  // with repository size; counts retain every report even when the lists are shortened.
  const build = (length: number) => ({
    ...summary,
    failed: failed.slice(0, length),
    flaky: flaky.slice(0, Math.max(0, length - failed.length)),
    omitted: {
      failed: Math.max(0, failed.length - length),
      flaky: Math.min(flaky.length, Math.max(0, failed.length + flaky.length - length)),
    },
  });
  const size = (value: unknown) => new TextEncoder().encode(JSON.stringify(JSON.stringify(value))).length;
  if (size(summary) <= 8 * 1024) return summary;
  let low = 0,
    high = files.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (size(build(mid)) <= 8 * 1024) low = mid;
    else high = mid - 1;
  }
  return build(low);
}

/** Transaction readers need only the reports named by the pinned semantic plan. */
export function checkReportHeader(run: HostedCheckRun) {
  const reports = run.contractReports;
  if (!reports) return;
  run.testFiles = checkFileSummary(reports);
  const named = new Set(
    run.semanticPlan?.members.flatMap(member => member.tests.map(test => test.path)) ?? [],
  );
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
    digest: digest(canonicalPayload(reports)),
    size: new TextEncoder().encode(body).length,
    files: Object.keys(reports).length,
  };
}
