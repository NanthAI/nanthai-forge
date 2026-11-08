// SPDX-License-Identifier: Apache-2.0
import { syncInputSchema } from './hosted-sync.js';
import { invariant } from './errors.js';
import { sourceValidation } from './hosted-source-validation.js';
import type { SourceStepCursor, StepTransport } from './hosted-source-step.js';

/** A stacked sync merges against its explicit stack base, never a base found by ancestry search.
 * Searching from the tips and the base made the generation walk see a subset-common State and fall
 * back to breadth-first search through every State under the base, and a parent that synced with
 * main adds a side lineage the walk must also prove (Issue 1eef1b43). Returns the sync's tips and
 * stack base, or null for every other job. */
export function stackedSync(c: SourceStepCursor) {
  if ((c.plan as { kind: string }).kind !== 'forge-hosted-sync-input') return null;
  const work = sourceValidation('SOURCE_JOB_INVALID', () => syncInputSchema.parse(c.plan)).work;
  return work.mode === 'sync' && work.stackBase
    ? { tips: [work.left.object.sha256, work.right.object.sha256], base: work.stackBase.object.sha256 }
    : null;
}

/** Describe the two tips in one descriptor page, the page the ancestry search began with, and cut
 * the graph at the stack base. The tips give the merged State its generation and parents; the base
 * is read once for the merge itself, so its own parents are never needed. */
export async function describeStackTips(
  c: SourceStepCursor,
  io: StepTransport,
  stack: NonNullable<ReturnType<typeof stackedSync>>,
) {
  const tips = [...new Set(stack.tips)];
  invariant(io.describeBatch, 'SOURCE_WORKER_UNAVAILABLE', 'Describe the stacked sync tips.');
  if (io.probeStates) await io.probeStates(tips);
  else await io.describeBatch(tips);
  for (const id of tips) {
    const generation = io.stateGeneration?.(id),
      edges = io.stateParents?.(id);
    if (generation !== undefined) (c.generations ??= {})[id] = generation;
    else c.generationFallback = true;
    if (edges) c.parents[id] = [...edges];
  }
  c.ancestryBoundary = stack.base;
  c.states = [];
  c.phase = 'compute';
}
