// SPDX-License-Identifier: Apache-2.0
import { scrubText } from './client-error-text.js';

type FailedRun = {
  testFiles?: { counts?: { failed: number }; failed: { file: string }[] } | undefined;
  contractReports?: Record<string, { failed: boolean; firstError?: string | undefined }> | undefined;
};
const line = (text: string, max: number) => scrubText(text.replace(/\s+/g, ' ').trim(), max);

/** What a settled failed check names, in one bounded, secret-safe sentence: the
 * first failing files with their first error, else the failing job and its most
 * specific line. Reads only what the run already retained; never a log fetch. */
export function checkFailureDetail(
  run: FailedRun,
  step?: { job: string; excerpt: string } | null,
  files = 3,
): string {
  const reports = run.contractReports ?? {};
  const failed = [
    ...new Set([
      ...(run.testFiles?.failed.map(item => item.file) ?? []),
      ...Object.keys(reports).filter(file => reports[file]!.failed),
    ]),
  ];
  if (failed.length) {
    const shown = failed.slice(0, files).map(file => {
      const error = reports[file]?.firstError;
      return `${line(file, 200)}${error ? ` (${line(error, 240)})` : ''}`;
    });
    const total = Math.max(failed.length, run.testFiles?.counts?.failed ?? 0);
    return `Failing: ${shown.join('; ')}${total > shown.length ? `; +${total - shown.length} more` : ''}.`;
  }
  if (step) return `Failing ${line(step.job, 60)}: ${line(step.excerpt, 240)}`;
  return 'No failing test file or job step was reported; open the check run log.';
}

/** The exact next step after a failed check of this Lane's change. */
export const CHECK_FAILED_NEXT =
  'Fix it in this Lane, save, then run land --save again; do not abandon or re-create the Lane.';
