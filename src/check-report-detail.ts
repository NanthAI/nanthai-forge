// SPDX-License-Identifier: Apache-2.0
import type { HostedCheckRun } from './hosted-check.js';
import { checkPin } from './hosted-check.js';
import { invariant } from './errors.js';
import { canonicalPayload } from './hosted-source-operation.js';
export type ReportSelection = { failed?: boolean; files?: string[] };
const bytes = (value: unknown) => new TextEncoder().encode(canonicalPayload(value)).length;
/** Cursor binds both the immutable reports and selector; replies count the complete JSON body. */
export function pageCheckReports(
  reports: NonNullable<HostedCheckRun['contractReports']>,
  selection: ReportSelection = {},
  cursor?: string | null,
) {
  invariant(
    !selection.files || selection.files.length <= 256,
    'BAD_ARGUMENT',
    'Select at most 256 named files.',
  );
  const digest = checkPin(reports),
    selector = checkPin(selection);
  let offset = 0;
  if (cursor) {
    const match = /^([a-f0-9]{64}):([a-f0-9]{64}):(\d+)$/.exec(cursor);
    invariant(
      match && match[1] === digest && match[2] === selector,
      'EVIDENCE_CHANGED',
      'Continue the original report selection.',
    );
    offset = Number(match[3]);
    invariant(Number.isSafeInteger(offset), 'BAD_ARGUMENT', 'Use the returned report cursor.');
  }
  const names = selection.files ? new Set(selection.files) : null;
  const entries = Object.keys(reports)
    .sort()
    .map(file => [file, reports[file]!] as const)
    .filter(
      ([file, report]) => (!names || names.has(file)) && (!selection.failed || report.failed || report.flaky),
    );
  invariant(offset <= entries.length, 'BAD_ARGUMENT', 'Use the returned report cursor.');
  const page: typeof reports = {};
  let end = offset;
  const next = (index: number) => (index < entries.length ? `${digest}:${selector}:${index}` : null);
  // Add encoded entry sizes once rather than serializing a growing page for each file.
  let used = bytes({ contractReports: {}, nextCursor: next(offset) });
  for (; end < entries.length; end++) {
    const [file, report] = entries[end]!;
    const size = bytes({ [file]: report }) - 2 + (end > offset ? 1 : 0);
    if (used + size > 256 * 1024) break;
    page[file] = report;
    used += size;
  }
  invariant(
    end > offset || offset === entries.length,
    'SOURCE_UNAVAILABLE',
    'A retained report exceeds the detail reply window.',
  );
  return { contractReports: page, nextCursor: next(end) };
}
