// SPDX-License-Identifier: Apache-2.0
// Measure the client separately from the test's TypeScript compiler and fake DB:
// Convex runs remotely; its document/call counts are checked in the parent test.
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
import { readHostedMetricPages } from '../dist/self-metrics-hosted-pages.js';
import { metricsSurface } from '../dist/self-metrics-surface.js';
const { pages, period } = JSON.parse(readFileSync(0, 'utf8'));
let calls = 0;
const start = performance.now();
const { records } = await readHostedMetricPages(async () => pages[calls++], period);
const result = metricsSurface(records, period);
process.stdout.write(
  JSON.stringify({
    calls,
    landings: result.totals['5.1'].landings,
    runs: result.totals['5.6'].runs,
    elapsedMs: performance.now() - start,
    rssMiB: process.resourceUsage().maxRSS / 1024,
  }),
);
