// SPDX-License-Identifier: Apache-2.0
import { slowestSourcePhase, sourceTimingMax, type SourcePhaseTiming } from './hosted-source-retry.js';
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
  /** R2 requests the step signed: class A (writes, listings), class B (reads, heads), bytes to put. */
  r2a?: number;
  r2b?: number;
  r2put?: number;
  summary?: SourcePhaseTiming;
};
/** Running R2 request totals of the isolate (convex/presign.ts); the step reports its own difference. */
export type R2Meter = () => { a: number; b: number; put: number };
// The existing source-step quantum starts no new work past this wall time.
const expectedStepMs = 20_000;
export function addSourcePhaseTiming(
  a: SourcePhaseTiming | undefined,
  b: SourcePhaseTiming | undefined,
): SourcePhaseTiming | undefined {
  if (!a || !b) return a ?? b;
  return Object.fromEntries(
    (Object.keys(a) as (keyof SourcePhaseTiming)[]).map(key => [
      key,
      Math.min(sourceTimingMax, a[key] + b[key]),
    ]),
  ) as SourcePhaseTiming;
}
export type SourceRequestCounter = (method: 'gets' | 'puts' | 'heads') => void;

function busy(now: () => number) {
  let active = 0,
    since = 0,
    total = 0;
  return {
    start() {
      if (active++ === 0) since = now();
    },
    end() {
      if (active > 0 && --active === 0) total += now() - since;
    },
    ms: () => total + (active ? now() - since : 0),
  };
}
export function sourceStepClock(delegatedAt?: number, r2?: R2Meter, now = () => performance.now()) {
  const startedAt = Date.now(),
    started = now(),
    startup = busy(now),
    read = busy(now),
    write = busy(now),
    call = busy(now),
    outsideCompute = busy(now),
    requests = { gets: 0, puts: 0, heads: 0 };
  let beforeEntry = delegatedAt === undefined ? 0 : Math.max(0, startedAt - delegatedAt);
  let r2From = r2?.();
  let calls = 0,
    reads = 0,
    writes = 0;
  const timed = async <T>(kind: ReturnType<typeof busy>, run: () => Promise<T>) => {
    kind.start();
    outsideCompute.start();
    try {
      return await run();
    } finally {
      kind.end();
      outsideCompute.end();
    }
  };
  const request: SourceRequestCounter = method => {
    requests[method]++;
  };
  const bounded = (value: number) => Math.min(sourceTimingMax, Math.max(0, Math.round(value)));
  const clock = {
    startup: <T>(run: () => Promise<T>) => timed(startup, run),
    dispatchedAt(at: number | undefined) {
      if (at !== undefined && delegatedAt === undefined) beforeEntry = Math.max(0, startedAt - at);
    },
    request,
    startSignedMeter(meter: R2Meter) {
      r2 = meter;
      r2From = meter();
    },
    summary(): SourcePhaseTiming {
      return {
        startupMs: bounded(beforeEntry + startup.ms()),
        readMs: bounded(read.ms()),
        computeMs: bounded(now() - started - outsideCompute.ms()),
        writeMs: bounded(write.ms()),
        convexMs: bounded(call.ms()),
        gets: bounded(requests.gets),
        puts: bounded(requests.puts),
        heads: bounded(requests.heads),
      };
    },
    call<T>(run: () => Promise<T>) {
      calls++;
      return timed(call, run);
    },
    write<T>(run: () => Promise<T>) {
      writes++;
      return timed(write, run);
    },
    readBytes<T>(run: () => Promise<T>) {
      reads++;
      return timed(read, run);
    },
    /** A read stays in flight until its body is consumed or abandoned. */
    async read(open: () => Promise<AsyncIterable<Uint8Array>>): Promise<AsyncIterable<Uint8Array>> {
      reads++;
      read.start();
      outsideCompute.start();
      const finish = () => {
        read.end();
        outsideCompute.end();
      };
      let stream: AsyncIterable<Uint8Array>;
      try {
        stream = await open();
      } catch (error) {
        finish();
        throw error;
      }
      return (async function* () {
        try {
          yield* stream;
        } finally {
          finish();
        }
      })();
    },
    value(): SourceStepTiming {
      const round = (ms: number) => Math.max(0, Math.round(ms));
      return {
        startedAt,
        runMs: round(now() - started),
        readMs: round(read.ms()),
        writeMs: round(write.ms()),
        callMs: round(call.ms()),
        calls,
        reads,
        writes,
        ...(delegatedAt === undefined ? {} : { bootMs: round(startedAt - delegatedAt) }),
        ...(r2 && r2From
          ? (({ a, b, put }) => ({
              r2a: round(a - r2From.a),
              r2b: round(b - r2From.b),
              r2put: round(put - r2From.put),
            }))(r2())
          : {}),
      };
    },
    slowPhase() {
      if (now() - started + beforeEntry > expectedStepMs) return slowestSourcePhase(clock.summary());
      return undefined;
    },
  };
  return clock;
}

export type SourceStepClock = ReturnType<typeof sourceStepClock>;
