// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { internalMutation, internalQuery } from './server';
import { recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { readHostedRecord, recordHead } from './projectHostedRecords';
import { hostedLaneSchema } from '../src/hosted-lane';
import { itemIntentChain } from './projectIntentLandingNotes';
import { addPlanLane, changePlanLaneCascade, planLaneItem, removePlanLanes } from './projectPlanLaneMarks';
import { landedAtLaneHead, laneOverlapHead } from './projectHostedOpenLaneEvidence';
import { verifiedItemMembership, verifiedRollupMembership } from './projectItemMembershipVersion';
import { invariant } from '../src/errors';

const phase = v.union(v.literal('items'), v.literal('lanes'));
const cursor = v.union(v.string(), v.null());
const onlyDev = () =>
  invariant(
    process.env.CONVEX_CLOUD_URL === 'https://benevolent-wildebeest-974.convex.cloud',
    'PROJECT_UNAVAILABLE',
    'Plan Lane-mark verification runs only on Forge dev.',
  );

/** Refuse until both the membership repair and a complete, generation-bound mark pass are visible. */
export const verify = internalQuery({
  args: { projectId: v.id('hostedProjects') },
  returns: v.literal(true),
  handler: async (ctx, { projectId }) => {
    onlyDev();
    const project = await ctx.db.get(projectId);
    const generation = project && !project.removal && (await selectedGeneration(ctx, project));
    invariant(
      project && generation && verifiedRollupMembership(project, generation._id),
      'WORK_STALE',
      'Complete Item membership and Plan Lane-mark backfill before verifying roll-up coverage.',
    );
    return true as const;
  },
});

/** Scan active heads, not open overlap rows: an already-pinned landing can have retired its overlap. */
async function coverMarks(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  generation: Doc<'projectWorkGenerations'>,
  from: string | null,
) {
  onlyDev();
  const projectId = project._id;
  const saved = project.planLaneMarkCoverage;
  const reply = (scanned: number, marked: number, next: string | null) => ({
    scanned,
    marked,
    next: next === null ? null : { phase: 'lanes' as const, cursor: next },
  });
  if (verifiedRollupMembership(project, generation._id)) return reply(0, 0, null);
  const previous = saved?.generationId === generation._id ? saved.cursor : null;
  if (from !== previous) {
    invariant(previous !== null, 'WORK_STALE', 'Restart the mark backfill without a cursor.');
    return reply(0, 0, previous);
  }
  const page = await ctx.db
    .query('projectHostedRecordHeads')
    .withIndex('by_project_and_kind_and_status', q =>
      q.eq('projectId', projectId).eq('kind', 'lane').eq('status', 'active'),
    )
    .paginate({ cursor: from, numItems: 8, maximumRowsRead: 8, maximumBytesRead: 1024 * 1024 });
  invariant(page.isDone || page.continueCursor !== from, 'WORK_STALE', 'The mark backfill did not advance.');
  const placement = new Map<string, Awaited<ReturnType<typeof planLaneItem>>>();
  let marked = 0;
  for (const head of page.page) {
    if (!head.planningItemId) continue;
    const itemId = head.planningItemId;
    if (!placement.has(itemId))
      placement.set(itemId, await planLaneItem(ctx, project, itemId, false, recordPartition(generation)));
    const item = placement.get(itemId);
    if (!item) continue;
    const row = await laneOverlapHead(ctx, projectId, head.key);
    invariant(
      row && row.intentId === head.parent,
      'WORK_STALE',
      'Repair the active Lane overlap before certifying its tally.',
    );
    const cascade = row.lifecyclePlanId ? await ctx.db.get(row.lifecyclePlanId) : null;
    const running = cascade?.status !== 'applied' && (head.pinned || !landedAtLaneHead(row));
    if (!running) {
      if (row.planLaneMark && cascade?.status !== 'applied') {
        await removePlanLanes(ctx, row.planLaneMark, [row.lifecyclePlanId]);
        await ctx.db.patch(row._id, { planLaneMark: undefined, planLanePin: undefined });
      }
      continue;
    }
    if (row.planLaneMark && row.planLanePin) {
      const tally = await ctx.db.get(row.planLaneMark);
      invariant(
        tally?.kind === `plan-item-lanes:${item.status}` &&
          tally.sourceId === `${projectId}:${itemId}` &&
          JSON.parse(tally.value).open > 0,
        'WORK_STALE',
        'Repair the retained Lane tally before certifying roll-up coverage.',
      );
      if (Boolean(head.pinned) !== Boolean(row.planLanePin.pinned))
        await ctx.db.patch(row._id, {
          planLanePin: { ...row.planLanePin, pinned: head.pinned ? true : undefined },
        });
      continue;
    }
    const current = await readHostedRecord(ctx, {
      projectId,
      actor: project.owner,
      kind: 'lane',
      key: head.key,
      selectedHead: head,
    });
    invariant(current, 'WORK_STALE', 'Repair the active Lane record before certifying its tally.');
    const lane = hostedLaneSchema.parse(JSON.parse(current.value));
    invariant(lane.state === 'active' && lane.head === row.head, 'WORK_STALE', 'Lane and overlap disagree.');
    const id = row.planLaneMark ?? (await addPlanLane(ctx, projectId, item));
    await ctx.db.patch(row._id, {
      planningItemId: itemId,
      planLaneMark: id,
      planLanePin: {
        sourceVersion: lane.sourceVersion,
        lifecycleVersion: lane.lifecycleVersion,
        ...(head.pinned ? { pinned: true as const } : {}),
      },
    });
    if (cascade?.status === 'pending' && !row.planLaneMark) {
      await changePlanLaneCascade(ctx, id, cascade._id, 1);
      if (!cascade.planLaneMark) await ctx.db.patch(cascade._id, { planLaneMark: id });
    }
    marked++;
  }
  const next = page.isDone ? null : page.continueCursor;
  await ctx.db.patch(projectId, { planLaneMarkCoverage: { generationId: generation._id, cursor: next } });
  return reply(page.page.length, marked, next);
}

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
    if (project.itemLaneMembership === verifiedItemMembership) {
      invariant(
        input.phase === 'lanes' || input.cursor === null,
        'WORK_STALE',
        'Restart verified mark backfill without a cursor.',
      );
      return coverMarks(ctx, project, generation, input.cursor);
    }
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
