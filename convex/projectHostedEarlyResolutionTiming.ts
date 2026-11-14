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
) {
  if (!early.resolvedAt) return;
  const parent = await earlyPredecessor(ctx, projectId, early.predecessor);
  if (!parent.landed) return; // Its settlement will measure the still-live dependent.
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
