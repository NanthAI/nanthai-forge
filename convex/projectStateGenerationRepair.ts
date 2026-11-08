// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation } from './server';
import { findObject } from './projectObjectFind';
import { nextStateGeneration, validStateGeneration, validStateParents } from '../src/state-generation';
import { invariant } from '../src/errors';

/** Operator repair, one page of 100 published States per call (review 3aa618e2 F1): a hosted State
 * published since `since` whose object row has no generation gets one from the parents the trusted
 * worker recorded on that row, in publication order, so a repaired parent serves its children in the
 * same page. A State keeps none while any parent has none; a recorded generation never changes.
 * No source bytes are read. `apply: false` only counts. Idempotent: rerun from `cursor: null`. */
export const fromParents = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    since: v.number(),
    cursor: v.union(v.string(), v.null()),
    apply: v.boolean(),
  },
  returns: v.object({
    scanned: v.number(),
    missing: v.number(),
    assigned: v.number(),
    unresolved: v.number(),
    cursor: v.union(v.string(), v.null()),
    done: v.boolean(),
  }),
  handler: async (ctx, input) => {
    invariant(Number.isFinite(input.since), 'BAD_ARGUMENT', 'Name the first publication time.');
    const page = await ctx.db
      .query('projectHostedStates')
      .withIndex('by_project', q => q.eq('projectId', input.projectId).gte('_creationTime', input.since))
      .paginate({ cursor: input.cursor, numItems: 100 });
    const known = new Map<string, number>();
    const level = async (id: string) => {
      if (known.has(id)) return known.get(id);
      const row = await findObject(ctx, input.projectId, id);
      const value =
        row && !row.removed && validStateGeneration(row.stateGeneration) ? row.stateGeneration : undefined;
      if (value !== undefined) known.set(id, value);
      return value;
    };
    let missing = 0,
      assigned = 0;
    for (const state of page.page) {
      const row = await findObject(ctx, input.projectId, state.head);
      if (!row || row.removed || row.stateGeneration !== undefined) continue;
      missing++;
      if (!row._id || !validStateParents(row.stateParents)) continue;
      const levels = new Map<string, number | undefined>();
      for (const parent of row.stateParents) levels.set(parent, await level(parent));
      const generation = nextStateGeneration(row.stateParents, id => levels.get(id));
      if (generation === undefined) continue;
      known.set(state.head, generation);
      if (input.apply) await ctx.db.patch(row._id, { stateGeneration: generation });
      assigned++;
    }
    return {
      scanned: page.page.length,
      missing,
      assigned,
      unresolved: missing - assigned,
      cursor: page.isDone ? null : page.continueCursor,
      done: page.isDone,
    };
  },
});
