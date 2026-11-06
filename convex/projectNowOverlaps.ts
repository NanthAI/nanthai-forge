// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { channelRow } from './projectHostedChannels';
import { dormantCutoff, rowActivity } from './projectHostedDormancy';
import { dormantHostedPresence } from './projectHostedPresence';
import { nowOverlapSignals } from '../src/now-overlap-signals';

const OPEN_LANE_ROWS = 100;
const OPEN_LANE_BYTES = 1024 * 1024;

/**
 * At most 100 open Lanes and 1 MiB, read lazily. Not paginate(): the caller already runs one
 * paginated query, and Convex rejects a second one in the same query function (2026-11-05).
 */
async function openLanePage(ctx: QueryCtx, projectId: Id<'hostedProjects'>, cutoff: number | null) {
  const page = [];
  let bytes = 0;
  let isDone = true;
  // Dormant Lanes are never read: the live range first, then rows from before lastActivityAt existed.
  const rows = async function* () {
    if (cutoff === null) {
      yield* ctx.db
        .query('projectHostedOverlapLanes')
        .withIndex('by_project_and_open', q => q.eq('projectId', projectId).eq('open', true));
      return;
    }
    yield* ctx.db
      .query('projectHostedOverlapLanes')
      .withIndex('by_project_and_open_and_activity', q =>
        q.eq('projectId', projectId).eq('open', true).gt('lastActivityAt', cutoff),
      )
      .order('desc');
    for await (const row of ctx.db
      .query('projectHostedOverlapLanes')
      .withIndex('by_project_and_open_and_activity', q =>
        q.eq('projectId', projectId).eq('open', true).eq('lastActivityAt', undefined),
      ))
      if (rowActivity(row) > cutoff) yield row;
  };
  for await (const row of rows()) {
    const size = JSON.stringify(row).length;
    if (page.length >= OPEN_LANE_ROWS || (page.length && bytes + size > OPEN_LANE_BYTES)) {
      isDone = false;
      break;
    }
    page.push(row);
    bytes += size;
  }
  return { page, isDone };
}

/** Shared by the existing ack subscription. No per-Lane function calls or background work. */
export async function readNowOverlaps(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  /** The project row the caller already read for its access check. */
  project: { autonomyPolicy?: unknown },
) {
  const cutoff = dormantCutoff(project);
  const [page, headers, latest, channel] = await Promise.all([
    openLanePage(ctx, projectId, cutoff),
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
  const unmatched = headers.filter(row => !lanes.some(lane => lane.laneId === row.key));
  // Dormant Lanes stay active heads but are left out on purpose; their slim presence rows excuse them.
  const dormantLanes =
    cutoff !== null && unmatched.length ? await dormantHostedPresence(ctx, projectId, cutoff) : null;
  const complete = page.isDone && headers.length <= 100 && unmatched.every(row => dormantLanes?.has(row.key));
  return nowOverlapSignals(lanes, latest, channel ? JSON.parse(channel.selection) : null, complete);
}
