// SPDX-License-Identifier: Apache-2.0
import { z } from 'zod';
import type { HostedCheckRun } from './hosted-check.js';
import { digest } from './portable-hash.js';
import { canonicalPayload } from './hosted-source-operation.js';
const checkPin = (value: unknown) => digest(canonicalPayload(value));

/** Deterministic UUIDs keep every recovery stage in the existing operation journal. */
export function culpritId(value: unknown): string {
  const h = checkPin({ domain: 'forge-hosted-culprit-v1', value });
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}
export const culpritProbeBudget = (count: number) => 1 + Math.ceil(Math.log2(count + 1));
export const needsFixSchema = z
  .object({
    state: z.enum(['reverted', 'needs-fix']),
    auditRunId: z.uuid(),
    receiptId: z.uuid().optional(),
    sequence: z.number().safe().nonnegative().optional(),
    head: z.string().regex(/^[0-9a-f]{64}$/),
    previousHead: z.string().regex(/^[0-9a-f]{64}$/),
    failed: z.array(z.object({ file: z.string(), excerpt: z.string().optional() }).strict()),
    summary: z.string(),
    undo: z.string(),
    revertReceiptId: z.uuid().optional(),
  })
  .strict();
export type NeedsFix = z.infer<typeof needsFixSchema>;

/** B2.4a's excerpt limits, also enforced here for legacy retained reports. */
export function culpritFailures(run: HostedCheckRun): NeedsFix['failed'] {
  const reports =
    run.contractReports ??
    Object.fromEntries((run.testFiles?.failed ?? []).map(item => [item.file, item.report]));
  let excerpts = 0;
  const encoder = new TextEncoder(),
    decoder = new TextDecoder();
  return Object.entries(reports)
    .filter(([, r]) => r.failed)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([file, r]) => {
      if (!r.firstError || excerpts++ >= 32) return { file };
      const bytes = encoder.encode(r.firstError);
      // Drop an incomplete terminal UTF-8 code point instead of growing the cap.
      let end = Math.min(2048, bytes.length);
      while (end < bytes.length && end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
      return { file, excerpt: decoder.decode(bytes.subarray(0, end)) };
    });
}
export function probeVerdict(run: HostedCheckRun, tests: string[]): 'pass' | 'fail' | 'unclear' {
  if (!['passed', 'failed'].includes(run.status) || !run.terminalDigest || !run.endedAt) return 'unclear';
  const reports = run.contractReports;
  if (!reports || !tests.length || tests.some(file => !reports[file])) return 'unclear';
  const failed = tests.filter(file => reports[file]!.failed);
  if (!failed.length && run.status === 'passed') return 'pass';
  if (failed.length === tests.length && run.status === 'failed') return 'fail';
  return 'unclear';
}
export function bisectStep(low: number, high: number): number | null {
  return high - low <= 1 ? null : Math.floor((low + high) / 2);
}
export function fixBrief(notice: NeedsFix): string {
  return `${notice.summary}\n${notice.receiptId ? `Acceptance receipt ${notice.receiptId}.` : 'No complete acceptance receipt retained.'} Change ${notice.previousHead} -> ${notice.head}.\nDiff: nforge agent ROOT diff '${JSON.stringify({ from: notice.previousHead, to: notice.head })}'.\n${notice.failed.map(f => `${f.file}${f.excerpt ? `\n${f.excerpt}` : ''}`).join('\n')}\nUndo: ${notice.undo}\nRestore the original change plus the fix; finish through the full gate.`;
}

export const needsFix = (project: { needsFix?: Record<string, string> }) =>
  Object.entries(project.needsFix ?? {}).map(([intentId, value]) => ({ intentId, ...JSON.parse(value) }));
export function fixGate(intent: { needsFix?: unknown } | null) {
  return intent?.needsFix ? { mode: 'full' as const, reason: 'reverted Intent fix' } : undefined;
}
