// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { capCheckReports } from './check-report-cap.js';
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
/** Derived from the existing result; no log fetch or additional result mutation. */
export function checkFileSummary(reports: z.infer<typeof semanticReportsSchema>) {
  const files = Object.entries(reports).map(([file, { firstError: _excerpt, ...report }]) => {
    void _excerpt;
    return { file, report };
  });
  // A flaky file names its test and first error (the failed first attempt), bounded like the
  // failing-file detail: at most flakyErrors files of flakyErrorChars each. Failed files keep
  // their first error in the retained contractReports instead.
  let named = 0;
  for (const item of files) {
    const error = reports[item.file]?.firstError;
    if (item.report.flaky && !item.report.failed && error && named++ < flakyErrors)
      (item.report as { firstError?: string }).firstError = error
        .replace(/\s+/g, ' ')
        .slice(0, flakyErrorChars);
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
