// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync, linkSync, unlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { nativeSelfMetricsReader } from './self-metrics-native.js';
import {
  failMetricWeek,
  metricWeekPaths,
  previousMetricWeek,
  releaseMetricWeek,
  weeklyMetricBytes,
} from './self-metrics-weekly.js';
import type { SelfMetricsReader } from './self-metrics-types.js';

/** Finite, read-only record collection in its own process; no owner writer lock. */
export async function writeMetricWeek(owner: string, at: string, token: string, reader?: SelfMetricsReader) {
  const directory = join(owner, '.forge', 'work');
  const { name, period } = previousMetricWeek(at);
  const { metrics, target, failed } = metricWeekPaths(directory, name);
  const temporary = join(metrics, `.${name}-${randomUUID()}`);
  try {
    if (existsSync(target)) return true;
    const records = await (reader ?? nativeSelfMetricsReader(owner)).read();
    // Do not manufacture snapshots for projects with no evidence preceding this week.
    if (
      ![...records.moves, ...records.runs, ...records.receipts].some(
        r => Date.parse(r.at) < Date.parse(period.to),
      )
    )
      return true;
    writeFileSync(temporary, weeklyMetricBytes(records, period), { flag: 'wx', mode: 0o600 });
    try {
      linkSync(temporary, target);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (existsSync(failed)) unlinkSync(failed);
    return true;
  } catch {
    failMetricWeek(directory, name);
    return false;
  } finally {
    if (existsSync(temporary)) unlinkSync(temporary);
    releaseMetricWeek(directory, name, token);
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [owner, at, token] = process.argv.slice(2);
  if (!owner || !at || !token) process.exitCode = 1;
  else process.exitCode = (await writeMetricWeek(owner, at, token)) ? 0 : 1;
}
