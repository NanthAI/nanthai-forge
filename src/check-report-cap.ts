// SPDX-License-Identifier: Apache-2.0
import type { z } from 'zod';
import type { semanticReportsSchema } from './intent-semantic-conflict.js';
import type { HostedCheckCallback } from './hosted-check-evidence.js';
import { canonicalPayload } from './hosted-source-operation.js';
type Reports = z.infer<typeof semanticReportsSchema>;
export const checkReportExcerptBytes = 64 * 1024;
const excerptFiles = 32;
const excerptBytes = checkReportExcerptBytes / excerptFiles;
const marker = '\n[excerpt truncated]';
const encoder = new TextEncoder();
// Reports are JSON inside the run document's string value. Count both levels
// of escaping so quotes/control characters cannot amplify the stored document.
export const encodedBytes = (text: string) => encoder.encode(JSON.stringify(JSON.stringify(text))).length - 6;
function excerpt(text: string) {
  if (encodedBytes(text) <= excerptBytes) return text;
  let prefix = '',
    bytes = 0;
  const available = excerptBytes - encodedBytes(marker);
  for (const character of text) {
    const size = encodedBytes(character);
    if (bytes + size > available) break;
    prefix += character;
    bytes += size;
  }
  return prefix + marker;
}
/** Stable file order, bounded UTF-8 excerpts, unchanged file identities and verdicts.
 * Missing excerpts count as truncated for failing/flaky files, so repeated capping
 * retains the omission count without keeping discarded text in another field. */
export function capCheckReports(input: Reports, retainReports = true) {
  const reports: Reports = {};
  let retained = 0,
    truncated = 0;
  const files = Object.keys(input).sort();
  // Failed-file diagnostics take precedence over recovered flakes.
  const ordered = [
    ...files.filter(file => input[file]!.failed),
    ...files.filter(file => !input[file]!.failed),
  ];
  for (const file of ordered) {
    const original = input[file]!,
      firstError = original.firstError;
    if (retainReports) {
      const { firstError: _error, ...report } = original;
      void _error;
      reports[file] = report;
    }
    if (firstError && retained < excerptFiles) {
      const text = excerpt(firstError);
      if (retainReports) reports[file] = { ...reports[file]!, firstError: text };
      retained++;
      if (text !== firstError || text.endsWith(marker)) truncated++;
    } else if (firstError || original.failed || original.flaky) truncated++;
  }
  return { reports, truncated };
}
/** Flaky passes beyond the shared run budget are failures, not ignored evidence.
 * Already failed files stay failed as later shards arrive. */
export function applyCheckRetryBudget(input: Reports) {
  const reports = { ...input };
  let retries = 0;
  for (const file of Object.keys(reports).sort()) {
    const report = reports[file]!;
    if (!report.failed && report.flaky && ++retries > 3)
      reports[file] = {
        ...report,
        failed: true,
        firstError: 'RETRY_BUDGET_EXCEEDED: shared run retry budget is 3.',
      };
  }
  return reports;
}

/** Callback rows only reconcile event identity: the row's digest covers the complete
 * authenticated callback. Outcome, reports and provider pins live on the run/shard.
 * Keep no second transport payload (including signed machine lease tokens). */
export const checkCallbackReceiptBytes = 128;
export function callbackReceipt(callback: HostedCheckCallback) {
  return canonicalPayload({ eventId: callback.eventId, kind: callback.result.kind });
}

/** Issue 75cb5074: a shard row stores each passing file that has only a duration as
 * `{file: durationMs}`, so the final replay reads names and numbers instead of one JSON
 * object per file. Everything else stays verbatim; rows written in the old shape still parse. */
type SavedShard = { reports: Reports; durations?: Record<string, number>; yielded: string[] };
export function packShardReports(reports: Reports) {
  const kept: Reports = {},
    durations: Record<string, number> = {};
  for (const [file, report] of Object.entries(reports))
    if (
      report.failed === false &&
      typeof report.durationMs === 'number' &&
      Object.keys(report).every(key => key === 'failed' || key === 'durationMs')
    )
      durations[file] = report.durationMs;
    else kept[file] = report;
  return { reports: kept, durations };
}
export function unpackShardReports(saved: SavedShard): Reports {
  const reports: Reports = {};
  for (const [file, durationMs] of Object.entries(saved.durations ?? {}))
    reports[file] = { durationMs, failed: false };
  return Object.assign(reports, saved.reports);
}
