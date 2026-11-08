// SPDX-License-Identifier: Apache-2.0
import { v, type Infer } from 'convex/values';

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
  const { startedAt, bootMs, ...rest } = reported;
  const entry: Infer<typeof recorded> = {
    waitMs: ms(startedAt - prior.scheduledAt),
    ...(Object.fromEntries(Object.entries(rest).map(([k, value]) => [k, ms(value)])) as Omit<
      Infer<typeof recorded>,
      'waitMs' | 'bootMs'
    >),
    ...(bootMs === undefined ? {} : { bootMs: ms(bootMs) }),
  };
  let steps = [...prior.steps, entry];
  if (steps.length > MAX_STEPS) {
    const [last, next] = steps.slice(-2) as [Infer<typeof recorded>, Infer<typeof recorded>];
    const merged = Object.fromEntries(
      Object.keys(next).map(key => [
        key,
        ((last as Record<string, number>)[key] ?? 0) + ((next as Record<string, number>)[key] ?? 0),
      ]),
    ) as Infer<typeof recorded>;
    steps = [...steps.slice(0, -2), merged];
  }
  return {
    queuedAt: prior.queuedAt,
    scheduledAt: done ? prior.scheduledAt : now,
    steps,
    ...(done ? { doneAt: now } : {}),
  };
}
