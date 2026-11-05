// SPDX-License-Identifier: Apache-2.0
import type { Id } from './_generated/dataModel';
import type { MutationCtx } from './server';
import { hostedLaneSchema } from '../src/hosted-lane';
import { hostedRecordBody } from './projectHostedRecords';

/** At most this many other open Lanes are shown; at most `SCANNED` newest Lane heads are read. */
export const START_OPEN_LANES = 5;
const SCANNED = 8;
export type StartOpenLane = { laneId: string; owner: string | null; yours: boolean; lastActivityAt: string };

/** Other open Lanes on the Intent a start just joined, newest first, so a second agent sees who
 * already works on it (issue b6ba9219). Bounded indexed reads inside the start mutation: no extra
 * call, no scan of a large sibling set. Owners are public handles, never account ids. */
export async function openSiblingLanes(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  intentId: string,
  exclude: string,
  caller: string,
): Promise<StartOpenLane[]> {
  const heads = await ctx.db
    .query('projectHostedRecordHeads')
    .withIndex('by_project_and_kind_and_parent', q =>
      q.eq('projectId', projectId).eq('kind', 'lane').eq('parent', intentId),
    )
    .order('desc')
    .take(SCANNED);
  const handles = new Map<string, string | null>(),
    lanes: StartOpenLane[] = [];
  for (const head of heads) {
    if (lanes.length >= START_OPEN_LANES) break;
    if (head.key === exclude || head.status !== 'active') continue;
    const row = await ctx.db.get(head.recordId);
    if (!row) continue;
    let lane;
    try {
      lane = hostedLaneSchema.parse(JSON.parse(await hostedRecordBody(ctx, row)));
    } catch {
      continue; // Advisory: an unreadable record is left out, never fails the start.
    }
    if (lane.state !== 'active') continue;
    if (!handles.has(lane.actor))
      handles.set(
        lane.actor,
        (
          await ctx.db
            .query('forgeAccounts')
            .withIndex('by_owner', q => q.eq('owner', lane.actor))
            .first()
        )?.handle ?? null,
      );
    lanes.push({
      laneId: lane.id,
      owner: handles.get(lane.actor) ?? null,
      yours: lane.actor === caller,
      lastActivityAt: lane.at,
    });
  }
  return lanes;
}
