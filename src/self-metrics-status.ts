// SPDX-License-Identifier: Apache-2.0
import { openSync, closeSync, fstatSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { nativeSelfMetricsReader } from './self-metrics-native.js';
import { metricPeriod, metricTotals } from './self-metrics-surface.js';
import { metricsHeadline } from './self-metrics-format.js';
import type { WorkData } from './work-types.js';
import type { SelfMetricReceipt } from './self-metrics-journal.js';
/** Headline reads reuse already selected Work rows and at most 256 KiB of receipts.
 * It never reads source trees, walks disk, writes caches or starts owner workers. */
export function statusMetrics(owner: string, data: Partial<WorkData>, now = new Date().toISOString()) {
  let fd: number | undefined;
  let receipts: SelfMetricReceipt[] = [],
    truncated = false,
    incompleteTrailingRecords = 0;
  try {
    fd = openSync(join(owner, '.forge/work/self-metrics.jsonl'), 'r');
    const size = fstatSync(fd).size,
      start = Math.max(0, size - 256 * 1024),
      buffer = Buffer.alloc(size - start);
    const length = readSync(fd, buffer, 0, buffer.length, start);
    let text = buffer.subarray(0, length).toString('utf8');
    truncated = start > 0;
    if (truncated) text = text.slice(text.indexOf('\n') + 1);
    incompleteTrailingRecords = text && !text.endsWith('\n') ? 1 : 0;
    if (incompleteTrailingRecords) text = text.slice(0, text.lastIndexOf('\n') + 1);
    receipts = text
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as SelfMetricReceipt);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
  const records = nativeSelfMetricsReader(owner, {
    data,
    fast: true,
    journal: { receipts, incompleteTrailingRecords },
  }).read();
  // This reader is synchronous; the public reader interface also admits hosted promises.
  if (records instanceof Promise) throw new Error('Native metrics reader must be synchronous.');
  if (truncated)
    records.surfaceGaps = [
      'Status read the last 256 KiB of metric receipts; older receipts require nforge metrics.',
    ];
  return {
    period: metricPeriod(undefined, undefined, now),
    ...metricsHeadline(metricTotals(records, metricPeriod(undefined, undefined, now), { headline: true })),
  };
}
