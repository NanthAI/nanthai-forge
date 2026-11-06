// SPDX-License-Identifier: Apache-2.0
import { scrubText } from './client-error-text.js';
import { stepExcerptChars } from './hosted-landing-suspect.js';

type FailedRun = {
  testFiles?: { counts?: { failed: number }; failed: { file: string }[] } | undefined;
  contractReports?:
    | Record<
        string,
        {
          failed: boolean;
          flaky?: boolean | undefined;
          firstError?: string | undefined;
        }
      >
    | undefined;
};
const line = (text: string, max: number) => scrubText(text.replace(/\s+/g, ' ').trim(), max);

/** What a settled failed check names, in one bounded, secret-safe sentence: the
 * first failing file with its first error and a count of the rest (the land output and
 * `status --detail` list each file with its first error), else the failing job and its most
 * specific line. Reads only what the run already retained; never a log fetch. */
export function checkFailureDetail(
  run: FailedRun,
  step?: { job: string; excerpt: string } | null,
  files = 1,
): string {
  const reports = run.contractReports ?? {};
  const failed = [
    ...new Set([
      ...(run.testFiles?.failed.map(item => item.file) ?? []),
      ...Object.keys(reports).filter(file => reports[file]!.failed),
    ]),
  ];
  // A file that failed then passed on retry is not the cause, but its first failed attempt
  // (test name and message) is the lead when the failure is hard to reproduce.
  const flaky = Object.keys(reports).filter(file => reports[file]!.flaky && !reports[file]!.failed);
  const flakyNote = flaky.length
    ? ` Flaky, passed on retry: ${flaky
        .slice(0, 2)
        .map(
          file =>
            `${line(file, 200)}${reports[file]!.firstError ? ` (${line(reports[file]!.firstError!, 240)})` : ''}`,
        )
        .join('; ')}${flaky.length > 2 ? `; +${flaky.length - 2} more` : ''}.`
    : '';
  if (failed.length) {
    const shown = failed.slice(0, files).map(file => {
      const error = reports[file]?.firstError;
      return `${line(file, 200)}${error ? ` (${line(error, 240)})` : ''}`;
    });
    const total = Math.max(failed.length, run.testFiles?.counts?.failed ?? 0);
    return `Failing: ${shown.join('; ')}${total > shown.length ? `; +${total - shown.length} more failed file${total - shown.length === 1 ? '' : 's'}` : ''}.${flakyNote}`;
  }
  if (step) return `Failing ${line(step.job, 60)}: ${line(step.excerpt, stepExcerptChars)}${flakyNote}`;
  return 'No failing test file or job step was reported; open the check run log.';
}

/** The exact next step after a failed check of this Lane's change. */
export const CHECK_FAILED_NEXT =
  'Fix it in this Lane, save, then run land --save again; do not abandon or re-create the Lane.';
