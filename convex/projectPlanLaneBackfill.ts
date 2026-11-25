// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import type { Doc } from './_generated/dataModel';
import type { MutationCtx } from './_generated/server';
import { internalMutation, internalQuery } from './server';
import { recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { readHostedRecord } from './projectHostedRecords';
import { hostedLaneSchema } from '../src/hosted-lane';
import { addPlanLane, changePlanLaneCascade, planLaneItem, removePlanLanes } from './projectPlanLaneMarks';
import { landedAtLaneHead, laneOverlapHead } from './projectHostedOpenLaneEvidence';
import { verifiedRollupMembership } from './projectItemMembershipVersion';
import { invariant } from '../src/errors';

const phase = v.literal('lanes');
const cursor = v.union(v.string(), v.null());
const onlyDev = () =>
  invariant(
    process.env.CONVEX_CLOUD_URL === 'https://benevolent-wildebeest-974.convex.cloud',
    'PROJECT_UNAVAILABLE',
    'Plan Lane-mark verification runs only on Forge dev.',
  );

/** Refuse until a complete, generation-bound mark pass is visible. */
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
      'Complete the Plan Lane-mark backfill before verifying roll-up coverage.',
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

/** One finite transaction per page: count the active Lanes' running work against their Items.
 * The normal start and lifecycle writers share those rows, so a replay or a Lane that moves
 * while the backfill runs cannot double-count. */
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
    const project = await ctx.db.get(input.projectId);
    const generation = project && (await selectedGeneration(ctx, project));
    if (!generation || project.removal) return { scanned: 0, marked: 0, next: null };
    return coverMarks(ctx, project, generation, input.cursor);
  },
});
