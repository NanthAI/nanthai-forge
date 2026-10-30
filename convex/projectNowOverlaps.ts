// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { channelRow } from './projectHostedChannels';
import { nowOverlapSignals } from '../src/now-overlap-signals';

/** Shared by the existing ack subscription. No per-Lane function calls or background work. */
export async function readNowOverlaps(ctx: QueryCtx, projectId: Id<'hostedProjects'>) {
  const [page, headers, latest, channel] = await Promise.all([
    ctx.db
      .query('projectHostedOverlapLanes')
      .withIndex('by_project_and_open', q => q.eq('projectId', projectId).eq('open', true))
      .paginate({ cursor: null, numItems: 100, maximumRowsRead: 100, maximumBytesRead: 1024 * 1024 }),
    Promise.all(
      ['active', 'paused', 'ready'].map(status =>
        ctx.db
          .query('projectHostedRecordHeads')
          .withIndex('by_project_and_kind_and_status', q =>
            q.eq('projectId', projectId).eq('kind', 'lane').eq('status', status),
          )
          .take(101),
      ),
    ).then(pages => pages.flat()),
    ctx.db
      .query('projectHostedOverlapMain')
      .withIndex('by_project', q => q.eq('projectId', projectId))
      .unique(),
    channelRow(ctx, projectId),
  ]);
  const versions = new Map(headers.map(row => [row.key, row.version]));
  const plans = new Map();
  for (const row of page.page)
    if (row.lifecyclePlanId && !plans.has(row.lifecyclePlanId))
      plans.set(row.lifecyclePlanId, await ctx.db.get(row.lifecyclePlanId));
  const lanes = page.page.filter(
    row =>
      versions.get(row.laneId) === row.recordVersion &&
      (!row.lifecyclePlanId ||
        (plans.get(row.lifecyclePlanId)?.projectId === projectId &&
          plans.get(row.lifecyclePlanId)?.status !== 'applied')),
  );
  const complete =
    page.isDone && headers.length <= 100 && headers.every(row => lanes.some(lane => lane.laneId === row.key));
  return nowOverlapSignals(lanes, latest, channel ? JSON.parse(channel.selection) : null, complete);
}
