// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { EarlyResolution } from '../src/early-resolution';
import { earlyResolutionSamplesSchema } from '../src/early-resolution';
import { earlyPredecessor } from './projectHostedEarlyResolution';
import { landingQueue } from './projectHostedLandingEvents';
import { canonicalPayload } from '../src/hosted-source-operation';

/** Resolution can finish after its predecessor landed. Fill that receipt's unknown cost;
 * never add another outcome or move an old receipt into the newest position. */
export async function recordEarlyResolutionTiming(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  early: EarlyResolution,
  laneId: string,
) {
  if (!early.resolvedAt) return;
  const parent = await earlyPredecessor(ctx, projectId, early.predecessor);
  if (!parent.landed) return; // Its settlement will measure the still-live dependent.
  // A late resolve rewrites its stack projection after the parent's settlement. Its timing
  // is filled below without reattaching an event link to a predecessor that already ended.
  const dependent = await ctx.db
    .query('projectHostedStackDependents')
    .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', laneId))
    .unique();
  if (dependent?.predecessorId === early.predecessor.submissionId)
    await ctx.db.patch(dependent._id, { predecessorId: undefined });
  const queue = await landingQueue(ctx, { projectId, channel: 'main' });
  if (!queue?.earlyResolveSamples) return;
  const samples = earlyResolutionSamplesSchema.parse(JSON.parse(queue.earlyResolveSamples));
  const index = samples.findIndex(sample => sample[0] === early.predecessor.receiptId);
  if (index < 0 || samples[index]![2] !== null) return;
  const started = Date.parse(early.startedAt),
    resolved = Date.parse(early.resolvedAt);
  const settled = Date.parse(parent.state.timing?.settledAt ?? '');
  if (!Number.isFinite(settled)) return;
  samples[index] = [
    early.predecessor.receiptId,
    true,
    Math.max(0, resolved - started),
    Math.max(0, settled - started),
  ];
  await ctx.db.patch(queue._id, { earlyResolveSamples: canonicalPayload(samples) });
}
