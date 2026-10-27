// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
export const testReportSchema = z.object({
  file: z.string(),
  complete: z.boolean(),
  durationMs: z.number().positive().finite().optional().catch(undefined),
  results: z.array(z.object({ name: z.string(), passed: z.boolean() })),
  retry: z
    .object({ complete: z.boolean(), results: z.array(z.object({ name: z.string(), passed: z.boolean() })) })
    .optional(),
});
export function testReports(lines: Iterable<string>) {
  const reports: Record<string, z.infer<typeof testReportSchema>> = {};
  for (const raw of lines) {
    const line = raw.replace(/^\d{4}-\d\d-\d\dT[\d:.]+Z\s+/, '').trim();
    if (!line.startsWith('__FORGE_TESTS__')) continue;
    try {
      const report = testReportSchema.parse(JSON.parse(line.slice('__FORGE_TESTS__'.length)));
      if (reports[report.file]) report.complete = false;
      reports[report.file] = report;
    } catch {
      reports['invalid-report'] = { file: 'invalid-report', complete: false, results: [] };
    }
  }
  return reports;
}
