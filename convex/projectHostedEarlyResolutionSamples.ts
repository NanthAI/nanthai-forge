// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import {
  earlyResolutionSamplesSchema,
  AUTOMATIC_CI_OUTCOME_WINDOW,
  type EarlyResolutionSamples,
} from '../src/early-resolution';
import { canonicalPayload } from '../src/hosted-source-operation';

// Invocation-local staging, flushed by the existing queue-status write in this same transaction.
// No persistent cache, deferred service, extra queue read or disjoint-path work.
const pending = new WeakMap<MutationCtx, Map<string, EarlyResolutionSamples>>();
export function stageEarlyResolutionSample(
  ctx: MutationCtx,
  projectId: string,
  sample: EarlyResolutionSamples[number],
) {
  let projects = pending.get(ctx);
  if (!projects) pending.set(ctx, (projects = new Map()));
  projects.set(projectId, [...(projects.get(projectId) ?? []), sample]);
}
export function consumeEarlyResolutionSamples(ctx: MutationCtx, projectId: string, stored?: string) {
  const projects = pending.get(ctx),
    samples = projects?.get(projectId);
  if (!samples?.length) return {};
  projects!.delete(projectId);
  const previous = stored ? earlyResolutionSamplesSchema.parse(JSON.parse(stored)) : [];
  const merged = new Map(previous.map(sample => [sample[0], sample]));
  for (const sample of samples) merged.set(sample[0], sample);
  return { earlyResolveSamples: canonicalPayload([...merged.values()].slice(-AUTOMATIC_CI_OUTCOME_WINDOW)) };
}
