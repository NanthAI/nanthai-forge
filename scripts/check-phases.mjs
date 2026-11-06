// SPDX-License-Identifier: Apache-2.0
// One log line per job: wall seconds and machine CPU busy share for each phase, so
// worker count and shard count are tuned from measurements on any CI, not guesses.
// The line also names the CPU model: runner speed varies between jobs of one check
// (the same test file ran 98 s on one runner and 183 s on another), which sets the
// slowest shard's time, so a report can tie slow shards to hardware.
import { availableParallelism, cpus, totalmem } from 'node:os';

const cpuModel = () =>
  (cpus()[0]?.model ?? '')
    .replace(/\((?:R|TM)\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 48);

const sample = () => {
  let total = 0,
    idle = 0;
  for (const { times } of cpus()) {
    total += times.user + times.nice + times.sys + times.idle + times.irq;
    idle += times.idle;
  }
  return { total, idle };
};

export function checkPhases(log = console.log) {
  const phases = [];
  return {
    time(label, run) {
      const begin = performance.now(),
        before = sample();
      try {
        return run();
      } finally {
        const after = sample(),
          span = after.total - before.total;
        const busy = span > 0 ? Math.round((1 - (after.idle - before.idle) / span) * 100) : 0;
        phases.push(`${label} ${((performance.now() - begin) / 1000).toFixed(1)}s (cpu ${busy}%)`);
      }
    },
    report() {
      const model = cpuModel();
      log(
        `Check phases on ${availableParallelism()} CPUs${model ? ` (${model})` : ''}, ${Math.round(totalmem() / 2 ** 30)} GiB: ${phases.join('; ')}`,
      );
    },
  };
}
