// SPDX-License-Identifier: Apache-2.0
// Pure: runs in the CLI and in the Convex non-Node runtime.
import type { HostedCheckRun } from './hosted-check.js';
import { checkLogsField } from './runner-visibility.js';

/** The whole summary reply stays under this many JSON bytes (Issue 12d2c89f: the full run is about 80 KB). */
export const CHECK_SUMMARY_BYTES = 8 * 1024;
const NAMES = 40;
const ERROR_CHARS = 160;
const SLOWEST = 5;
const clip = (text: string, length: number) => (text.length > length ? `${text.slice(0, length)}…` : text);
const bytes = (value: unknown) => JSON.stringify(value).length;
const seconds = (from: string, to: string | null) =>
  to === null ? null : Math.max(0, Math.round((Date.parse(to) - Date.parse(from)) / 100) / 10);

/** Counts, failed and flaky file names (failed ones with a clipped first error), timings and the
 * selection scope of one check run, from fields the run row already holds. No logs, no shard rows,
 * no second read. Name lists shrink until the reply fits CHECK_SUMMARY_BYTES; `more` counts the rest. */
export function summarizeCheckRun(run: HostedCheckRun) {
  const reports = run.contractReports ?? {};
  const reported = Object.entries(reports);
  const summary = run.testFiles;
  const failedAll = summary
    ? summary.failed.map(item => ({ file: item.file, error: item.report.firstError }))
    : reported.filter(([, r]) => r.failed).map(([file, r]) => ({ file, error: r.firstError }));
  const flakyAll = summary
    ? summary.flaky.map(item => item.file)
    : reported.filter(([, r]) => r.flaky && !r.failed).map(([file]) => file);
  const slowest = reported
    .flatMap(([file, r]) =>
      r.durationMs === undefined ? [] : [{ file, durationMs: Math.round(r.durationMs) }],
    )
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, SLOWEST);
  const planned = run.semanticPlan?.members.reduce((sum, member) => sum + member.tests.length, 0);
  const build = (names: number) => ({
    runId: run.id,
    status: run.status,
    candidateId: run.request.candidateId,
    head: run.request.expectedHead,
    counts: run.counts,
    files: {
      total: summary?.counts.total ?? reported.length,
      failed: summary?.counts.failed ?? failedAll.length,
      flaky: summary?.counts.flaky ?? flakyAll.length,
      ...(summary?.truncated ? { truncated: summary.truncated } : {}),
    },
    failed: failedAll.slice(0, names).map(item => ({
      file: item.file,
      ...(item.error ? { firstError: clip(item.error.replace(/\s+/g, ' '), ERROR_CHARS) } : {}),
    })),
    flaky: flakyAll.slice(0, names),
    ...(failedAll.length > names || flakyAll.length > names
      ? {
          more: {
            failed: Math.max(0, failedAll.length - names),
            flaky: Math.max(0, flakyAll.length - names),
          },
        }
      : {}),
    timings: {
      at: run.at,
      endedAt: run.endedAt,
      wallSeconds: seconds(run.at, run.endedAt),
      executionSeconds: run.execution ? Math.round(run.execution.seconds * 10) / 10 : null,
      shards: run.execution?.shards ?? run.plan?.shardCount ?? null,
      slowest,
    },
    selection: {
      mode: run.gate?.mode ?? null,
      effective: run.gate?.effective ?? null,
      ...(run.gate?.reason ? { reason: clip(run.gate.reason, 200) } : {}),
      requestedTests: run.gate?.tests?.length ?? null,
      reportedFiles: reported.length,
      plannedTests: planned ?? null,
      shardCount: run.plan?.shardCount ?? null,
    },
    exitCode: run.exitCode,
    ...(run.failureReason ? { failureReason: clip(run.failureReason, 200) } : {}),
    cost:
      run.cost.status === 'observed' ? { seconds: run.cost.seconds, usd: run.cost.estimatedCostUsd } : null,
    // The run's pinned runner configuration: its owner accepted public check logs.
    ...checkLogsField(run.configuration?.provider === 'github-actions' ? run.configuration : null),
  });
  let names = NAMES;
  let out = build(names);
  while (bytes(out) > CHECK_SUMMARY_BYTES && names > 0) out = build((names = Math.floor(names / 2)));
  return out;
}
