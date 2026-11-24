// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { invariant } from '../src/errors';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import type { ActionCtx } from './_generated/server';
import { purgeSteps, type ItemPurge } from './projectPlanningPurgeRedact';

export const purgeWalk = v.object({
  phase: v.union(v.literal('redact'), v.literal('sweep'), v.literal('check')),
  round: v.number(),
  step: v.number(),
  after: v.union(v.string(), v.null()),
  dirty: v.number(),
  generationId: v.optional(v.string()),
  partitions: v.optional(v.string()),
  discussionChecked: v.optional(v.literal(true)),
});
type Walk = typeof purgeWalk.type;

function start(round: number, phase: Walk['phase']): Walk {
  return { phase, round, step: 0, after: null, dirty: 0 };
}

function advance(walk: Walk, after: Walk['after']) {
  walk.after = after;
  if (after === null) walk.step++;
}

/** Redact every store, then check the exact generation and partitions before finishing. */
export async function walkPurge(
  ctx: ActionCtx,
  id: { projectId: Id<'hostedProjects'>; operationId: string },
  purge: ItemPurge,
  deadline: number,
  saved?: Walk,
): Promise<{ done: true } | { done: false; walk: Walk }> {
  const ref = internal.projectPlanningPurge;
  let walk = saved ?? start(0, purge.segmentSweep?.after ? 'sweep' : 'redact');
  // A checkpoint written before attachment cleanup may already have passed the heads check.
  if (walk.phase === 'check' && walk.step === purgeSteps.length && !walk.discussionChecked)
    walk = { ...walk, step: purgeSteps.length - 1 };
  while (walk.round < 3) {
    if (Date.now() >= deadline) return { done: false, walk };
    if (walk.phase === 'sweep') {
      if (purge.segmentSweep && !purge.segmentSweep.done) {
        const done = await ctx.runAction(internal.projectPlanningPurgeSegmentRun.run, { ...id, deadline });
        if (!done) return { done: false, walk };
      }
      // A base Item's words in the stored base checkpoint (Item b6588425 line 2e): one scrub, a fixed point once done.
      if (purge.baseScrub && !purge.baseScrub.done)
        await ctx.runAction(internal.projectCommentPurgeBase.scrubItem, { ...id, itemId: purge.itemId });
      walk = start(walk.round, 'check');
      continue;
    }
    const step = purgeSteps[walk.step];
    if (walk.phase === 'redact') {
      if (step === undefined) walk = start(walk.round, 'sweep');
      else advance(walk, (await ctx.runMutation(ref.redact, { ...id, step, after: walk.after })).after);
      continue;
    }
    if (step !== undefined) {
      const page = await ctx.runQuery(ref.check, { ...id, step, after: walk.after });
      invariant(
        !walk.generationId || walk.generationId === page.generationId,
        'WORK_STALE',
        'The Work index changed.',
      );
      invariant(
        !walk.partitions || walk.partitions === page.partitions,
        'WORK_STALE',
        'The Work index changed.',
      );
      walk.dirty += page.changes;
      walk.generationId = page.generationId;
      walk.partitions = page.partitions;
      advance(walk, page.after);
      if (walk.step === purgeSteps.length) walk.discussionChecked = true;
      continue;
    }
    if (walk.dirty === 0) {
      await ctx.runMutation(ref.finish, {
        ...id,
        generationId: walk.generationId!,
        partitions: walk.partitions!,
      });
      return { done: true };
    }
    // A rebuild left work after the first pass. Keep the existing number of repair rounds.
    walk = start(walk.round + 1, 'redact');
  }
  invariant(false, 'WORK_STALE', 'The Item purge still has unverified rows. Run the same purge to resume.');
}
