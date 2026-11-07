// SPDX-License-Identifier: Apache-2.0
// Peak live memory of this process: V8 heap plus external Buffers/ArrayBuffers. Unlike RSS it does
// not depend on allocator slack, thread arenas or young-generation sizing. A raw sample still counts
// old-space garbage until the next major GC, and concurrent marking falls behind on a loaded runner,
// so the raw figure rises with CPU load (hosted Linux 55.3-71.6 MiB over 10 identical runs).
// Under --expose-gc each sample above the confirmed peak is re-measured after a full GC, so the
// peak counts retained data only, whatever the load. Without the flag the raw peak is reported.
export function liveMemorySampler({ intervalMs = 2 } = {}) {
  const collect = globalThis.gc;
  let peak = 0,
    sampledPeak = 0,
    baseline,
    collections = 0;
  const live = () => {
    const { heapUsed, external } = process.memoryUsage();
    return heapUsed + external;
  };
  const sample = () => {
    const sampled = live();
    if (sampled > sampledPeak) sampledPeak = sampled;
    if (sampled <= peak) return;
    if (!collect) return void (peak = sampled);
    collect();
    collections++;
    peak = Math.max(peak, live());
  };
  setInterval(sample, intervalMs).unref();
  return {
    sample,
    /** Record the retained memory before the measured work starts (diagnostic only). */
    baseline() {
      if (baseline !== undefined || !collect) return;
      collect();
      collections++;
      baseline = live();
    },
    report: () => ({
      peakLiveMiB: peak / 1048576,
      baselineLiveMiB: baseline === undefined ? undefined : baseline / 1048576,
      peakSampledLiveMiB: sampledPeak / 1048576,
      collections,
      confirmed: !!collect,
    }),
  };
}
