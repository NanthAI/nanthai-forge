// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction, internalMutation } from './server';
import { deleteR2Object, listR2Prefix } from './r2Operations';
import { putExpiry, r2Config } from './r2';
import { laneRow } from './projectLaneSnapshots';
import { mapExchange } from '../src/exchange-parallel';
import { laneSnapshotPrefix } from '../src/lane-snapshot-contract';

/**
 * Expiry and owner purge of one Lane's snapshots (Issue 7ac4e32f). The Lane's first snapshot
 * schedules one job at its expiry; a job that wakes before the latest snapshot's expiry moves
 * itself to that time, so a Lane costs one wake per retention window and an idle project costs
 * nothing. Dropping deletes the Lane's R2 snapshot prefix (bounded LIST pages, 100 DELETEs each),
 * then its entry rows (500 per transaction), then holds new snapshots off until every PUT URL
 * signed before the drop has expired, sweeps the prefix once more and removes the Lane row.
 */
const self = makeFunctionReference<'action'>('projectLaneSnapshotDrop:run');
const reason = v.union(v.literal('expiry'), v.literal('purge'));
const args = { projectId: v.id('hostedProjects'), laneId: v.string() };
/** Signed PUT URLs live `putExpiry` seconds; the final sweep waits that long plus a minute. */
const sweepMs = (putExpiry + 60) * 1000;
const listPages = 10;
const rowPage = 500;
const lane = (input: { projectId: string; laneId: string }) => ({
  projectId: input.projectId,
  laneId: input.laneId,
});

export const begin = internalMutation({
  args: { ...args, reason },
  returns: v.union(v.literal('none'), v.literal('rescheduled'), v.object({ sweepAt: v.number() })),
  handler: async (ctx, input) => {
    const row = await laneRow(ctx, input.projectId, input.laneId);
    if (!row) return 'none' as const;
    const now = Date.now();
    if (row.state !== 'purging') {
      if (input.reason === 'expiry' && now < (row.expiresAt ?? 0)) {
        const job = await ctx.scheduler.runAt(row.expiresAt!, self, { ...lane(input), reason: 'expiry' });
        await ctx.db.patch(row._id, { job });
        return 'rescheduled' as const;
      }
      await ctx.db.patch(row._id, { state: 'purging', expiresAt: now + sweepMs });
      return { sweepAt: now + sweepMs };
    }
    return { sweepAt: row.expiresAt ?? now };
  },
});

/** Deletes up to one page of entry rows; with `lane`, the Lane row too once no entry is left. */
export const deleteRows = internalMutation({
  args: { ...args, lane: v.boolean() },
  returns: v.object({ deleted: v.number(), done: v.boolean() }),
  handler: async (ctx, input) => {
    const rows = await ctx.db
      .query('projectLaneSnapshots')
      .withIndex('by_project_and_lane_and_seq', q =>
        q.eq('projectId', input.projectId).eq('laneId', input.laneId).gt('seq', 0),
      )
      .take(rowPage);
    for (const row of rows) await ctx.db.delete(row._id);
    if (rows.length === rowPage) return { deleted: rows.length, done: false };
    if (input.lane) {
      const row = await laneRow(ctx, input.projectId, input.laneId);
      if (row?.state === 'purging') await ctx.db.delete(row._id);
    }
    return { deleted: rows.length, done: true };
  },
});

/** Deletes the prefix in bounded LIST pages; true when it is empty. */
async function dropObjects(prefix: string) {
  const config = r2Config();
  let objects = 0,
    bytes = 0;
  for (let page = 0; page < listPages; page++) {
    const listed = await listR2Prefix(config, prefix, null);
    if (!listed.keys.length) return { empty: true, objects, bytes };
    await mapExchange(listed.keys, 8, key => deleteR2Object(config, key));
    objects += listed.keys.length;
    bytes += listed.bytes;
  }
  return { empty: false, objects, bytes };
}

export const run = internalAction({
  args: { ...args, reason },
  returns: v.null(),
  handler: async (ctx, input) => {
    const step = await ctx.runMutation(
      makeFunctionReference<'mutation'>('projectLaneSnapshotDrop:begin'),
      input,
    );
    if (step === 'none' || step === 'rescheduled') return null;
    const continueLater = (at?: number) =>
      at === undefined ? ctx.scheduler.runAfter(0, self, input) : ctx.scheduler.runAt(at, self, input);
    const objects = await dropObjects(laneSnapshotPrefix(input.projectId, input.laneId));
    console.log('lane snapshot drop', {
      reason: input.reason,
      objects: objects.objects,
      bytes: objects.bytes,
    });
    if (!objects.empty) return (await continueLater(), null);
    const sweep = Date.now() >= step.sweepAt;
    for (let page = 0; page < listPages; page++) {
      const rows = await ctx.runMutation(
        makeFunctionReference<'mutation'>('projectLaneSnapshotDrop:deleteRows'),
        {
          ...lane(input),
          lane: sweep,
        },
      );
      if (rows.done) return sweep ? null : (await continueLater(step.sweepAt), null);
    }
    await continueLater();
    return null;
  },
});
