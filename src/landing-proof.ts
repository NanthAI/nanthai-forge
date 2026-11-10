// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import { contractTestPath, standardTestPath } from './intent-test-contract.js';
import type { NativeState } from './state/format.js';
import type { HostedCheckRun } from './hosted-check.js';

const outcome = z.enum(['failed', 'passed', 'error']);
/** Optional evidence from any CI. Head is supplied by external CI; Forge's runner joins its normal reports. */
export const proofReportSchema = z
  .object({
    kind: z.literal('proof'),
    reports: z
      .array(z.object({ file: contractTestPath, base: outcome, head: outcome.optional() }).strict())
      .max(20),
  })
  .strict()
  .refine(
    report => new Set(report.reports.map(r => r.file)).size === report.reports.length,
    'A proof names each file once.',
  );
export const proofSummarySchema = z
  .object({
    proven: z.number().int().nonnegative(),
    passedOnBase: z.number().int().nonnegative(),
    inconclusive: z.number().int().nonnegative(),
  })
  .strict();
export function proofSummary(
  proof: z.infer<typeof proofReportSchema>,
  run: Pick<HostedCheckRun, 'contractReports'>,
) {
  let proven = 0,
    passedOnBase = 0,
    inconclusive = 0;
  for (const report of proof.reports) {
    const head = run.contractReports?.[report.file];
    const passed = head ? !head.failed && !head.flaky : report.head === 'passed';
    if (report.base === 'failed' && passed) proven++;
    else if (report.base === 'passed' && passed) passedOnBase++;
    else inconclusive++;
  }
  return { proven, passedOnBase, inconclusive };
}
export function proofLine(proof: z.infer<typeof proofSummarySchema>) {
  return (
    `proof: ${proof.proven} tests fail on base and pass on head` +
    (proof.passedOnBase ? `; ${proof.passedOnBase} pass on base too` : '') +
    (proof.inconclusive ? `; ${proof.inconclusive} inconclusive` : '')
  );
}
/** Planning data only, outside the immutable check recipe. Off does no work. */
export function proofTests(
  enabled: boolean | undefined,
  standard: boolean,
  base: NativeState,
  head: NativeState,
) {
  if (!enabled || !standard) return [];
  const old = new Map(base.files.map(f => [f.path, f]));
  return head.files
    .filter(f => f.mode !== 'symlink' && standardTestPath(f.path) && old.get(f.path)?.blob !== f.blob)
    .map(f => f.path)
    .sort()
    .slice(0, 20);
}
