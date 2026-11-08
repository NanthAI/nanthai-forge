// SPDX-License-Identifier: Apache-2.0
/** Wall time one source step spends with at least one R2 read, R2 write or Convex call in
 * flight (friction 84c1497f). Concurrent operations of one kind count once, so each value is
 * at most the step's own run time; the rest of the run is merge/hash/parse work. Local clock
 * reads only: no I/O, no calls. Portable across the V8 and Node Convex runtimes. */
export type SourceStepTiming = {
  /** Epoch ms when this step's handler began. */
  startedAt: number;
  runMs: number;
  readMs: number;
  writeMs: number;
  callMs: number;
  calls: number;
  reads: number;
  writes: number;
  /** Node step only: from the V8 step's hand-off to this handler (runtime start and module load). */
  bootMs?: number;
};
function busy() {
  let active = 0,
    since = 0,
    total = 0;
  return {
    start() {
      if (active++ === 0) since = performance.now();
    },
    end() {
      if (active > 0 && --active === 0) total += performance.now() - since;
    },
    ms: () => total + (active ? performance.now() - since : 0),
  };
}
export function sourceStepClock(delegatedAt?: number) {
  const startedAt = Date.now(),
    started = performance.now(),
    read = busy(),
    write = busy(),
    call = busy();
  let calls = 0,
    reads = 0,
    writes = 0;
  const timed = async <T>(kind: ReturnType<typeof busy>, run: () => Promise<T>) => {
    kind.start();
    try {
      return await run();
    } finally {
      kind.end();
    }
  };
  return {
    call<T>(run: () => Promise<T>) {
      calls++;
      return timed(call, run);
    },
    write<T>(run: () => Promise<T>) {
      writes++;
      return timed(write, run);
    },
    /** A read stays in flight until its body is consumed or abandoned. */
    async read(open: () => Promise<AsyncIterable<Uint8Array>>): Promise<AsyncIterable<Uint8Array>> {
      reads++;
      read.start();
      let stream: AsyncIterable<Uint8Array>;
      try {
        stream = await open();
      } catch (error) {
        read.end();
        throw error;
      }
      return (async function* () {
        try {
          yield* stream;
        } finally {
          read.end();
        }
      })();
    },
    value(): SourceStepTiming {
      const round = (ms: number) => Math.max(0, Math.round(ms));
      return {
        startedAt,
        runMs: round(performance.now() - started),
        readMs: round(read.ms()),
        writeMs: round(write.ms()),
        callMs: round(call.ms()),
        calls,
        reads,
        writes,
        ...(delegatedAt === undefined ? {} : { bootMs: round(startedAt - delegatedAt) }),
      };
    },
  };
}
export type SourceStepClock = ReturnType<typeof sourceStepClock>;
