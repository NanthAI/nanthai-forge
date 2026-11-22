// SPDX-License-Identifier: Apache-2.0
import { totalmem } from 'node:os';
import { getHeapStatistics } from 'node:v8';

export function logImportMetric(fields: { phase: string; [key: string]: string | number }) {
  const { rss, heapUsed, external, arrayBuffers } = process.memoryUsage();
  const constrainedBytes = process.constrainedMemory();
  console.log(
    `FORGE_IMPORT_METRIC ${JSON.stringify({
      ...fields,
      rssBytes: rss,
      peakRssBytes: process.resourceUsage().maxRSS * 1024,
      heapUsed,
      external,
      arrayBuffers,
      heapLimitBytes: getHeapStatistics().heap_size_limit,
      memoryLimitBytes: constrainedBytes || totalmem(),
      memoryLimitSource: constrainedBytes ? 'process' : 'os',
    })}`,
  );
}
