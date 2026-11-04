// SPDX-License-Identifier: Apache-2.0
import assert from 'node:assert/strict';
import { readHostedMetricPages } from '../dist/self-metrics-hosted-pages.js';
import { metricsSurface } from '../dist/self-metrics-surface.js';
import { calculateSelfMetrics } from '../dist/self-metrics.js';
import { cpuMilliseconds, retainedBytes } from './resource-budget.mjs';

export default async function measure({ pages, objects, report, plant = null }) {
  const baseline = retainedBytes();
  const start = process.cpuUsage();
  let calls = 0,
    objectCalls = 0;
  const leaks = [];
  const read = async () => {
    let page = 0,
      object = 0;
    const query = async (name, args) => {
      calls++;
      const next = pages[page++];
      assert.deepEqual({ name, args }, { name: next.name, args: next.args });
      return next.value;
    };
    query.objects = async pins => {
      objectCalls++;
      const next = objects[object++];
      assert.deepEqual(pins, next.pins);
      return next.values.map(value => Buffer.from(value, 'base64'));
    };
    const { records } = await readHostedMetricPages(query, report);
    const surface = metricsSurface(records, report);
    const result = calculateSelfMetrics(records, report, { headline: true });
    assert.equal(surface.totals['5.1'].landings, 6000);
    assert.equal(result.landings, 6000);
    assert.equal(
      result.metric1.days.reduce((n, day) => n + day.firstTry, 0),
      6000,
    );
    assert.equal(page, pages.length);
    assert.equal(object, objects.length);
    // Synthetic leak stays reachable through GC, like a forgotten report cache.
    if (plant === 'leak') leaks.push(Buffer.alloc(80 * 1024 * 1024, 1));
  };
  await read();
  const cpuMs = cpuMilliseconds(start);
  const first = retainedBytes();
  const rssMiB = process.memoryUsage().rss / 1024 ** 2;
  const firstCalls = calls,
    firstObjects = objectCalls;
  await read();
  const retainedGrowthBytes = retainedBytes() - first;
  assert.equal(leaks.length, plant === 'leak' ? 2 : 0);
  return {
    calls: plant === 'double-work' ? calls : firstCalls,
    objectCalls: plant === 'double-work' ? objectCalls : firstObjects,
    rssMiB,
    cpuMs,
    retainedBytes: first - baseline,
    retainedGrowthBytes,
    peakRssMiB: process.resourceUsage().maxRSS / 1024,
  };
}
