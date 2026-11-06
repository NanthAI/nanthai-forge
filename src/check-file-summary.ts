// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
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
  return {
    counts: { total: files.length, failed: failed.length, flaky: flaky.length },
    ...(truncated ? { truncated } : {}),
    failed,
    flaky,
  };
}
