// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import { internalMutation } from './server';
import { recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { readHostedRecord, recordHead } from './projectHostedRecords';
import { hostedLaneSchema } from '../src/hosted-lane';
import { itemIntentChain } from './projectIntentLandingNotes';
import { addPlanLane, changePlanLaneCascade, planLaneItem } from './projectPlanLaneMarks';

const phase = v.union(v.literal('items'), v.literal('lanes'));
const cursor = v.union(v.string(), v.null());

/** One finite transaction per page. First attach the root Item to legacy execution Intents,
 * then count currently open overlap rows. The normal start and lifecycle writers share those
 * rows, so a replay or a Lane that moves while the backfill runs cannot double-count. */
export const run = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    phase,
    cursor,
  },
  returns: v.object({
    scanned: v.number(),
    marked: v.number(),
    next: v.union(v.object({ phase, cursor }), v.null()),
  }),
  handler: async (ctx, input) => {
    const { projectId } = input;
    const project = await ctx.db.get(projectId);
    const generation = project && (await selectedGeneration(ctx, project));
    if (!generation || project.removal) return { scanned: 0, marked: 0, next: null };
    const bounds = { cursor: input.cursor, numItems: 20, maximumRowsRead: 20, maximumBytesRead: 1_000_000 };
    let marked = 0;
    if (input.phase === 'items') {
      const page = await ctx.db
        .query('projectPlanningRecords')
        .withIndex('by_generation_and_collection_and_key', q =>
          q.eq('generationId', recordPartition(generation)).eq('collection', 'planningSearch'),
        )
        .paginate(bounds);
      for (const row of page.page) {
        const item = JSON.parse(row.value);
        if (item.kind !== 'issue' || item.purged) continue;
        const { intents } = await itemIntentChain(ctx, projectId, row.key);
        for (const intentId of intents.slice(1)) {
          const head = await recordHead(ctx, projectId, 'intent', intentId);
          if (head && !head.planningItemId) await ctx.db.patch(head._id, { planningItemId: row.key });
        }
      }
      return {
        scanned: page.page.length,
        marked,
        next: page.isDone
          ? { phase: 'lanes' as const, cursor: null }
          : { phase: 'items' as const, cursor: page.continueCursor },
      };
    }
    const page = await ctx.db
      .query('projectHostedOverlapLanes')
      .withIndex('by_project_and_open', q => q.eq('projectId', projectId).eq('open', true))
      .paginate(bounds);
    const placements = new Map<string, Awaited<ReturnType<typeof planLaneItem>>>();
    const heads = new Map<string, Doc<'projectHostedRecordHeads'> | null>();
    for (const row of page.page) {
      if (row.planLaneMark || row.landed?.laneHead === row.head) continue;
      const cascade = row.lifecyclePlanId ? await ctx.db.get(row.lifecyclePlanId) : null;
      if (cascade?.status === 'applied') continue;
      if (!heads.has(row.intentId))
        heads.set(row.intentId, await recordHead(ctx, projectId, 'intent', row.intentId));
      const head = heads.get(row.intentId);
      if (!head) continue;
      const itemId = row.planningItemId ?? head.planningItemId ?? row.intentId;
      if (!placements.has(itemId)) placements.set(itemId, await planLaneItem(ctx, project, itemId));
      const item = placements.get(itemId);
      if (!item) continue;
      const current = await readHostedRecord(ctx, {
        projectId,
        actor: project.owner,
        kind: 'lane',
        key: row.laneId,
      });
      if (!current) continue;
      const lane = hostedLaneSchema.parse(JSON.parse(current.value));
      if (lane.state !== 'active' || lane.head !== row.head) continue;
      const id = await addPlanLane(ctx, projectId, item);
      await ctx.db.patch(row._id, {
        planningItemId: itemId,
        planLaneMark: id,
        planLanePin: { sourceVersion: lane.sourceVersion, lifecycleVersion: lane.lifecycleVersion },
      });
      if (cascade?.status === 'pending') {
        await changePlanLaneCascade(ctx, id, cascade._id, 1);
        if (!cascade.planLaneMark) await ctx.db.patch(cascade._id, { planLaneMark: id });
      }
      marked++;
    }
    return {
      scanned: page.page.length,
      marked,
      next: page.isDone ? null : { phase: 'lanes' as const, cursor: page.continueCursor },
    };
  },
});
