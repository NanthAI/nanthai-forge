// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// Item 0d14c456 (from bf111983 line 4): under isolation=user every scoped check exited 126 with the same
// environment error, and the queue kept dispatching new runs of it. An environment end is a failed check
// that named no failing test and whose sealed failure summary carries the runner's own attribution to
// Forge or the runner: a check input Forge wrote that the Candidate user could not use, or Candidate
// isolation unavailable. A shell's own "Permission denied" or "not found" is not enough: a Lane can
// cause that itself (review of 0d14c456: a script that lost its execute bit exits 126 too). Its
// identity is the check's pins (same command, runner configuration and environment) plus that
// normalized line, so the CI-down hold (convex/projectHostedLandingCiDown.ts) counts identical ends.
import { digest } from './state/hash.js';

/** The check pins every dispatch carries: a changed command or runner configuration changes the key. */
type CheckPins = {
  checkId: string;
  expectedDefinition: string;
  expectedConfiguration: string;
  expectedEnvironment: string;
};
export const checkCommandKey = (pins: CheckPins) =>
  digest(
    `check-command\0${pins.checkId}\0${pins.expectedDefinition}\0${pins.expectedConfiguration}\0${pins.expectedEnvironment}`,
  ).slice(0, 32);

/** The supervisor's own lines that put the fault on Forge or the runner, never on the change
 * (src/candidate-user.ts: candidateAccessNotes for a Forge-written input, and the isolation refusal). */
const ENVIRONMENT_LINE =
  /^Forge: .* is a check input Forge wrote for the Candidate user\b|^CANDIDATE_ISOLATION_UNAVAILABLE: /;

/** Run-specific noise out of a failing line: temp-folder names, ids, digests, counts and times.
 * First the shape every Forge-made mkdtemp folder has, `forge-<what>-` plus six random [A-Za-z0-9]
 * characters (about 35% of them hold no digit, which the generic id rule below cannot tell from a
 * word: the hold missed a third of real identical failures, Item 0d14c456). Then the generic rule. */
export const normalizeFailureLine = (text: string) =>
  text
    .replace(/\s+/g, ' ')
    // The whole name becomes `#`, as the generic rule already made it for a mixed suffix, so a hold
    // stored before this rule existed keeps matching (review of the fix).
    .replace(/\bforge-[a-z]+(?:-[a-z]+)*-[A-Za-z0-9]{6}(?![\w-])/g, '#')
    .replace(/\b(?=[\w-]*\d)(?=[\w-]*[A-Za-z])[\w-]{6,}\b/g, '#')
    .replace(/\d+/g, '0')
    .trim();

export type EnvironmentEnd = { command: string; signature: string; excerpt: string };

/** An environment end, or null: a failed run with no failing test file or contract report whose jobs'
 * failure summaries carry environment evidence. Reads only what the caller already loaded on the
 * failure path (the sealed summaries the failing-step line also comes from). */
export function environmentEnd(
  run: {
    status: string;
    cancelRequested: boolean;
    request: CheckPins;
    testFiles?: { failed: readonly unknown[]; counts?: { failed: number } | undefined } | undefined;
    contractReports?: Record<string, { failed: boolean }> | undefined;
  },
  summaries: readonly string[],
): EnvironmentEnd | null {
  if (run.status !== 'failed' || run.cancelRequested) return null;
  if (run.testFiles?.failed.length || run.testFiles?.counts?.failed) return null;
  if (Object.values(run.contractReports ?? {}).some(report => report.failed)) return null;
  const line = summaries
    .flatMap(summary => summary.split(/\r?\n/))
    .map(text => text.replace(/\p{Cc}/gu, '').trim())
    .find(text => ENVIRONMENT_LINE.test(text));
  if (!line) return null;
  return {
    command: checkCommandKey(run.request),
    signature: digest(`environment-end\0${normalizeFailureLine(line)}`).slice(0, 32),
    excerpt: line.replace(/\s+/g, ' ').slice(0, 300),
  };
}
