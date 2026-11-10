// SPDX-License-Identifier: Apache-2.0
import { makeFunctionReference } from 'convex/server';
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';

export const exhaustRetentionMs = 7 * 86_400_000;
export const checkDetailRetentionMs = 30 * 86_400_000;

/** One wake per terminal transition/phase; never a project scan or idle cron. */
export async function scheduleCheckExpiry(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  runId: string,
  now: number,
) {
  for (const phase of ['callbacks', 'detail'] as const) {
    const dueAt = now + (phase === 'callbacks' ? exhaustRetentionMs : checkDetailRetentionMs);
    await ctx.scheduler.runAfter(
      Math.max(0, dueAt - Date.now()),
      makeFunctionReference<'mutation'>('projectOperationalExpiry:check'),
      { projectId, runId, phase, dueAt, operationId: `exhaust:${runId}:${phase}`, part: 0 },
    );
  }
}
export async function scheduleSourceExpiry(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  jobId: string,
  now: number,
) {
  const dueAt = now + exhaustRetentionMs;
  await ctx.scheduler.runAfter(
    Math.max(0, dueAt - Date.now()),
    makeFunctionReference<'mutation'>('projectOperationalExpiry:source'),
    { projectId, jobId, dueAt, operationId: `exhaust:${jobId}:source`, part: 0 },
  );
}
