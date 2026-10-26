import { checkEvidenceLines } from './check-compact-output.js';
import { runOutputDirectory } from './work-run.js';
// SPDX-License-Identifier: Apache-2.0
import { runReceipt } from './agent-receipts.js';
import { runWork } from './work-run.js';
import type { WorkStore } from './work-store.js';
import type { CheckRun } from './work-types.js';
import { failedTestFiles } from './check-failure-files.js';

const CAP = 4096,
  MATCH = /✖|not ok|Error/;
function tail(store: WorkStore, run: CheckRun, stream: 'stdout' | 'stderr'): string[] {
  try {
    const response = runWork(
      store,
      { action: 'read-check-output', operationId: run.id, stream, offset: 0, bytes: 65536, tail: 65536 },
      store.revision(),
    ) as { result: { text: string } };
    return response.result.text.split('\n');
  } catch {
    return [];
  }
}
/** Short, bounded explanation of a failed run: last stderr lines plus failure markers from either stream. */
export function failureSummary(store: WorkStore, run: CheckRun): string {
  const err = tail(store, run, 'stderr'),
    out = tail(store, run, 'stdout');
  const last = err.filter(line => line.trim()).slice(-40);
  const seen = new Set(last);
  const marked = [...out, ...err].filter(line => MATCH.test(line) && !seen.has(line)).slice(-40);
  let reports: string[] = [];
  try {
    reports = [...checkEvidenceLines(runOutputDirectory(store, run.id))];
  } catch {
    /* Older runs may have no compact reports. */
  }
  const files = failedTestFiles([...out, ...err, ...reports].join('\n'));
  const names = files.length ? `Failing tests: ${files.join(', ')}\n`.slice(0, CAP / 2) : '';
  const text = [...marked, ...last].join('\n');
  const remaining = CAP - names.length;
  return names + (text.length > remaining ? `…${text.slice(-(remaining - 1))}` : text);
}
/** Run receipt, with a failure summary when the run failed. */
export function runReceiptWithFailure(store: WorkStore, run: CheckRun) {
  const receipt = runReceipt(run);
  return run.status === 'failed'
    ? { ...receipt, failureSummary: run.failureSummary ?? failureSummary(store, run) }
    : receipt;
}
