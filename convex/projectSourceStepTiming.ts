// SPDX-License-Identifier: Apache-2.0
import { v, type Infer } from 'convex/values';
import { z } from 'zod';
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';

/** Which cursor phases a step ran (`from>to`), why it stopped (`done`, or a yield/budget reason from
 * src/hosted-source-step-verify.ts) and how many State manifests, other Forge JSON pages and file
 * blobs it read (friction 09c0b7cd). Steps from older workers report none of these. */
const stepDetail = {
  phase: v.optional(v.string()),
  stop: v.optional(v.string()),
  states: v.optional(v.number()),
  pages: v.optional(v.number()),
  blobs: v.optional(v.number()),
  /** R2 requests the step signed (convex/presign.ts): class A, class B, bytes to put. */
  r2a: v.optional(v.number()),
  r2b: v.optional(v.number()),
  r2put: v.optional(v.number()),
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
/** A sync or save state's copy of its execution split, written once at publication. */
export const sourceServerTimingSchema = z
  .object({
    queuedAt: z.number(),
    scheduledAt: z.number(),
    steps: z.array(z.record(z.string(), z.union([z.number(), z.string().max(40)]))).max(16),
    doneAt: z.number().optional(),
    publishedAt: z.number(),
  })
  .strict();
/** The execution's split for a publication: one indexed read of its existing step row. */
export async function sourceServerTiming(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  jobId: string,
): Promise<z.infer<typeof sourceServerTimingSchema> | undefined> {
  const timing = (
    await ctx.db
      .query('projectSourceSteps')
      .withIndex('by_project_and_job', q => q.eq('projectId', projectId).eq('jobId', jobId))
      .unique()
  )?.timing;
  return timing ? { ...timing, publishedAt: Date.now() } : undefined;
}

/** R2 requests a whole execution signed (class A, class B, bytes put), summed over its recorded steps. */
export function sourceR2Counts(timing: { steps: readonly Record<string, number | string>[] } | undefined) {
  const sum = (key: string) =>
    (timing?.steps ?? []).reduce((total, step) => total + (typeof step[key] === 'number' ? step[key] : 0), 0);
  return [sum('r2a'), sum('r2b'), sum('r2put')] as [number, number, number];
}
