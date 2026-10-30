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
const encodedBytes = (text: string) => encoder.encode(JSON.stringify(JSON.stringify(text))).length - 6;
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
export function capCheckReports(input: Reports) {
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
    const { firstError, ...report } = input[file]!;
    reports[file] = report;
    if (firstError && retained < excerptFiles) {
      const text = excerpt(firstError);
      reports[file] = { ...report, firstError: text };
      retained++;
      if (text !== firstError || text.endsWith(marker)) truncated++;
    } else if (firstError || report.failed || report.flaky) truncated++;
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

/** The stored callback receipt is only a replay record (its digest, taken over the full callback, decides
 * retries), so it must stay far below the 1 MiB document limit however many test files a callback reports.
 * Small callbacks are kept verbatim; larger ones keep capped excerpts, then only the file count. */
export const checkCallbackReceiptBytes = 256 * 1024;
export function callbackReceipt(callback: HostedCheckCallback) {
  const fits = (text: string) => encoder.encode(text).length <= checkCallbackReceiptBytes;
  const full = canonicalPayload(callback);
  const result = callback.result;
  if (fits(full) || result.kind !== 'complete' || !result.contractReports) return full;
  const capped = canonicalPayload({
    ...callback,
    result: { ...result, contractReports: capCheckReports(result.contractReports).reports },
  });
  if (fits(capped)) return capped;
  const { contractReports, ...rest } = result;
  return canonicalPayload({
    ...callback,
    result: { ...rest, contractReportsOmitted: Object.keys(contractReports).length },
  });
}
