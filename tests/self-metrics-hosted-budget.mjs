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
// The reader runs its streams side by side, so replay by call, not by position.
const replay = new Map();
for (const next of pages) {
  const key = JSON.stringify([next.name, next.args]);
  replay.set(key, [...(replay.get(key) ?? []), next.value]);
}
const { records } = await readHostedMetricPages(async (name, args) => {
  calls++;
  const queued = replay.get(JSON.stringify([name, args]));
  if (!queued?.length) throw new Error(`unrecorded call ${name}`);
  return queued.shift();
}, period);
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
