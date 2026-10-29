// SPDX-License-Identifier: Apache-2.0
import { parseTimingHistory, updateTimingHistory, timingHistoryLimits } from '../scripts/test-shards.mjs';
import type { HostedCheckRun } from './hosted-check.js';
export { parseTimingHistory } from '../scripts/test-shards.mjs';

/** Same advisory history/EWMA as .forge/work/test-timings.json. Hosted results
 * carry observed files, not a source inventory; retain unselected samples until
 * the shared caps age them out. No source bytes or run-history scan is needed. */
export function updateHostedTimingHistory(previous: string, run: HostedCheckRun) {
  const history = parseTimingHistory(previous);
  const durations = Object.fromEntries(
    Object.entries(run.contractReports ?? {}).flatMap(([file, report]) =>
      report.durationMs === undefined ? [] : [[file, report.durationMs]],
    ),
  );
  const next = updateTimingHistory(history, {
    runId: run.id,
    endedAt: run.endedAt!,
    files: [...Object.keys(history.files), ...Object.keys(durations)],
    durations,
  });
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
