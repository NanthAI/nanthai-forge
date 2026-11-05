// SPDX-License-Identifier: Apache-2.0
// Weekly flaky-file list (G4). Derived from the check run rows the runs projection already
// reads: no extra call, and a recovered flake is listed, never counted as a clean pass.
import type { MetricPeriod, MetricRun } from './self-metrics-types.js';

export type FlakyFile = {
  file: string;
  attempts?: { durationMs: number; failed: boolean }[] | undefined;
  /** Capped first-attempt error, when the run retained one. */
  firstError?: string | undefined;
};
/** Per-run projection: at most `flakyFilesPerRun` files; `total` keeps the true count. */
export type RunFlakes = { total: number; executionId?: string | null | undefined; files: FlakyFile[] };
export const flakyFilesPerRun = 8,
  flakyErrorChars = 512,
  flakeListFiles = 50,
  flakeRunIds = 5;
type Report = {
  failed: boolean;
  flaky?: boolean | undefined;
  firstError?: string | undefined;
  attempts?: { durationMs: number; failed: boolean }[] | undefined;
};
/** Files that failed once and passed on the single retry. A failed file is a failure, not a flake. */
export function runFlakes(run: {
  executionId?: string | null | undefined;
  contractReports?: Record<string, Report> | undefined;
  testFiles?: { flaky: { file: string; report: Report }[] } | undefined;
}): RunFlakes | undefined {
  // contractReports keep a capped first error; testFiles keep only the compact verdicts.
  const found: [string, Report][] = run.contractReports
    ? Object.entries(run.contractReports).filter(([, report]) => report.flaky && !report.failed)
    : (run.testFiles?.flaky ?? []).map(item => [item.file, item.report]);
  if (!found.length) return undefined;
  found.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return {
    total: found.length,
    ...(run.executionId ? { executionId: run.executionId } : {}),
    files: found.slice(0, flakyFilesPerRun).map(([file, report]) => ({
      file,
      ...(report.attempts?.length
        ? { attempts: report.attempts.map(a => ({ durationMs: a.durationMs, failed: a.failed })) }
        : {}),
      ...(report.firstError ? { firstError: report.firstError.slice(0, flakyErrorChars) } : {}),
    })),
  };
}
export type FlakeRow = {
  file: string;
  runs: number;
  runIds: string[];
  firstAt: string;
  lastAt: string;
  lastExecutionId?: string | undefined;
  lastAttempts?: FlakyFile['attempts'];
  lastError?: string | undefined;
  /** Planning search for the existing Issue (search first, then file). */
  search: string;
  /** Present only after an explicit `--flake-issues` lookup. */
  issue?:
    | { id: string; title: string; status: string }
    | { possible: { id: string; title: string }[] }
    | null;
};
export const flakeSearchText = (file: string) => file.split('/').at(-1)!;
const during = (at: string, p: MetricPeriod) => at >= p.from && at < p.to;
/** Files that recovered on retry in [from,to), most frequent then most recent first. */
export function flakeList(runs: (MetricRun & { flaky?: RunFlakes | undefined })[], period: MetricPeriod) {
  const byFile = new Map<string, FlakeRow>();
  let flakyRuns = 0,
    omittedPerRun = 0;
  const flaky = runs
    .filter(run => run.flaky && during(run.endedAt ?? run.at, period))
    .sort((a, b) => (a.endedAt ?? a.at).localeCompare(b.endedAt ?? b.at));
  for (const run of flaky) {
    flakyRuns++;
    const at = run.endedAt ?? run.at;
    omittedPerRun += run.flaky!.total - run.flaky!.files.length;
    for (const item of run.flaky!.files) {
      const row =
        byFile.get(item.file) ??
        ({
          file: item.file,
          runs: 0,
          runIds: [],
          firstAt: at,
          lastAt: at,
          search: flakeSearchText(item.file),
        } satisfies FlakeRow);
      byFile.set(item.file, row);
      row.runs++;
      row.lastAt = at;
      row.runIds = [...row.runIds, run.id].slice(-flakeRunIds);
      row.lastExecutionId = run.flaky!.executionId ?? undefined;
      row.lastAttempts = item.attempts;
      // Keep the latest retained error; a later run without one does not erase it.
      if (item.firstError) row.lastError = item.firstError;
    }
  }
  const all = [...byFile.values()].sort(
    (a, b) => b.runs - a.runs || b.lastAt.localeCompare(a.lastAt) || (a.file < b.file ? -1 : 1),
  );
  return {
    files: all.slice(0, flakeListFiles),
    filesTotal: all.length,
    flakyRuns,
    omittedPerRun,
  };
}
export type FlakeList = ReturnType<typeof flakeList>;
