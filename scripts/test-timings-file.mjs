// SPDX-License-Identifier: Apache-2.0
import { readFileSync, statSync } from 'node:fs';
import { emptyHistory, parseTimingHistory, timingHistoryLimits } from './test-shards.mjs';

/** Advisory owner-local data; missing, corrupt or oversized history means round-robin. */
export function readTimingHistory(
  path = process.env.FORGE_TEST_TIMINGS_HISTORY ?? '.forge/work/test-timings.json',
) {
  try {
    if (statSync(path).size > timingHistoryLimits.bytes) return emptyHistory();
    return parseTimingHistory(readFileSync(path, 'utf8'));
  } catch {
    return emptyHistory();
  }
}
