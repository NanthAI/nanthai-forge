// SPDX-License-Identifier: Apache-2.0
// One log line per job: wall seconds and machine CPU busy share for each phase, so
// worker count and shard count are tuned from measurements on any CI, not guesses.
import { availableParallelism, cpus, totalmem } from 'node:os';

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
      log(
        `Check phases on ${availableParallelism()} CPUs, ${Math.round(totalmem() / 2 ** 30)} GiB: ${phases.join('; ')}`,
      );
    },
  };
}
