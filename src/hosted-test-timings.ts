// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { parseTimingHistory, updateTimingHistory, timingHistoryLimits } from '../scripts/test-shards.mjs';
import type { HostedCheckRun } from './hosted-check.js';
export { parseTimingHistory } from '../scripts/test-shards.mjs';

const staleTimingMs = 30 * 86_400_000;

/** Same advisory EWMA as .forge/work/test-timings.json. Hosted results carry
 * observations, not an inventory. Drop stale observations on final write, after
 * all this run's pages could refresh their files. No source or history scan. */
export function updateHostedTimingHistory(
  previous: string,
  run: HostedCheckRun,
  supplied?: Record<string, number>,
  sourceRun?: number,
  final = true,
) {
  const history = parseTimingHistory(previous);
  if (history.runs.includes(run.id)) return previous;
  const durations =
    supplied ??
    Object.fromEntries(
      Object.entries(run.contractReports ?? {}).flatMap(([file, report]) =>
        report.durationMs === undefined ? [] : [[file, report.durationMs]],
      ),
    );
  const next = updateTimingHistory(history, {
    runId: run.id,
    endedAt: run.endedAt!,
    files: [...Object.keys(history.files), ...Object.keys(durations)],
    durations,
    ...(sourceRun ? { sourceRun } : {}),
  });
  if (!final) next.runs = history.runs;
  else {
    const cutoff = Date.parse(run.endedAt!) - staleTimingMs;
    for (const [file, sample] of Object.entries(next.files))
      if (Date.parse(sample.updatedAt) < cutoff) delete next.files[file];
  }
  const encoder = new TextEncoder();
  let text = JSON.stringify(next);
  const oldest = Object.keys(next.files).reverse();
  // Convex counts the containing string/document too, including escaped quotes.
  // Leave room for projectId, _id and _creationTime beneath its 1 MiB limit.
  while (
    encoder.encode(JSON.stringify({ history: text })).length > timingHistoryLimits.bytes - 2048 &&
    oldest.length
  ) {
    delete next.files[oldest.shift()!];
    text = JSON.stringify(next);
  }
  return text;
}
