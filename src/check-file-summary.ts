// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
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
    failed: z.array(file),
    flaky: z.array(file),
  })
  .strict();
/** Derived from the existing result; no log fetch or additional result mutation. */
export function checkFileSummary(reports: z.infer<typeof semanticReportsSchema>) {
  const files = Object.entries(reports).map(([file, report]) => ({ file, report }));
  const failed = files.filter(item => item.report.failed);
  const flaky = files.filter(item => item.report.flaky && !item.report.failed);
  return { counts: { total: files.length, failed: failed.length, flaky: flaky.length }, failed, flaky };
}
