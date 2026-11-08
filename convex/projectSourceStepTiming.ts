// SPDX-License-Identifier: Apache-2.0
import { v, type Infer } from 'convex/values';

/** Which cursor phases a step ran (`from>to`), why it stopped (`done`, or a yield/budget reason from
 * src/hosted-source-step-verify.ts) and how many State manifests, other Forge JSON pages and file
 * blobs it read (friction 09c0b7cd). Steps from older workers report none of these. */
const stepDetail = {
  phase: v.optional(v.string()),
  stop: v.optional(v.string()),
  states: v.optional(v.number()),
  pages: v.optional(v.number()),
  blobs: v.optional(v.number()),
};
/** What one step reports with its commit or fork (src/source-step-clock.ts). */
export const sourceStepTiming = v.object({
  startedAt: v.number(),
  runMs: v.number(),
  readMs: v.number(),
  writeMs: v.number(),
  callMs: v.number(),
  calls: v.number(),
  reads: v.number(),
  writes: v.number(),
  bootMs: v.optional(v.number()),
  ...stepDetail,
});
const recorded = v.object({
  /** From the step's scheduling (or the fan-out join) to its handler start. */
  waitMs: v.number(),
  runMs: v.number(),
  readMs: v.number(),
  writeMs: v.number(),
  callMs: v.number(),
  calls: v.number(),
  reads: v.number(),
  writes: v.number(),
  bootMs: v.optional(v.number()),
  ...stepDetail,
});
/** Kept on the execution's existing step row, written by the commits it already makes. */
export const sourceExecutionTiming = v.object({
  /** When the execution's first step was scheduled. */
  queuedAt: v.number(),
  /** When the next step (or the first) was scheduled. */
  scheduledAt: v.number(),
  steps: v.array(recorded),
  /** When the terminal commit ran. */
  doneAt: v.optional(v.number()),
});
export type SourceExecutionTiming = Infer<typeof sourceExecutionTiming>;
type Recorded = Infer<typeof recorded>;
const MAX_STEPS = 16;
const ms = (value: number) => (Number.isFinite(value) && value > 0 ? Math.round(value) : 0);
/** Append one step; past 16 steps the last entry accumulates, so the row stays small. */
export function recordSourceStep(
  prior: SourceExecutionTiming | undefined,
  reported: Infer<typeof sourceStepTiming> | undefined,
  now: number,
  done: boolean,
): SourceExecutionTiming | undefined {
  if (!prior || !reported) return prior && !done ? { ...prior, scheduledAt: now } : prior;
  const { startedAt, bootMs, phase, stop, ...rest } = reported;
  const counts = Object.fromEntries(Object.entries(rest).map(([k, value]) => [k, ms(value)]));
  const entry = {
    waitMs: ms(startedAt - prior.scheduledAt),
    ...counts,
    ...(bootMs === undefined ? {} : { bootMs: ms(bootMs) }),
    ...(phase === undefined ? {} : { phase: phase.slice(0, 40) }),
    ...(stop === undefined ? {} : { stop: stop.slice(0, 20) }),
  } as Recorded;
  let steps = [...prior.steps, entry];
  if (steps.length > MAX_STEPS) {
    const [last, next] = steps.slice(-2) as [Recorded, Recorded];
    const merged: Record<string, number | string> = {};
    for (const key of new Set([...Object.keys(last), ...Object.keys(next)])) {
      const a = (last as Record<string, number | string | undefined>)[key],
        b = (next as Record<string, number | string | undefined>)[key];
      if (key === 'phase')
        merged.phase = `${String(a ?? b).split('>')[0]}>${String(b ?? a)
          .split('>')
          .pop()}`;
      else if (key === 'stop') merged.stop = (b ?? a) as string;
      else merged[key] = ((a as number | undefined) ?? 0) + ((b as number | undefined) ?? 0);
    }
    steps = [...steps.slice(0, -2), merged as Recorded];
  }
  return {
    queuedAt: prior.queuedAt,
    scheduledAt: done ? prior.scheduledAt : now,
    steps,
    ...(done ? { doneAt: now } : {}),
  };
}
