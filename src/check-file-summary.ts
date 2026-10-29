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
/** Derived from the existing result; no log fetch or additional result mutation. */
export function checkFileSummary(reports: z.infer<typeof semanticReportsSchema>) {
  const files = Object.entries(reports).map(([file, { firstError: _excerpt, ...report }]) => {
    void _excerpt;
    return { file, report };
  });
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
