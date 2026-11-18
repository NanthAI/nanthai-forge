// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { Contribution } from '../src/person-days';
import { utcDay } from './projectStatsClose';

/** Lanes one range read keeps (the newest if more). A gap busier than this counts its newest Lanes. */
export const STATS_LANES_READ = 1_000;
/** A project's first close, or one after a long idle gap, looks back at most this many days for Lanes. */
export const STATS_LANE_LOOKBACK_DAYS = 366;
export const DAY_MS = 86_400_000;

/** Account ids never contain whitespace or ':'; other actors are system actors and count for no one. */
export const isAccount = (actor: string | undefined): actor is string => !!actor && !/[\s:]/.test(actor);

export const dayStart = (day: string) => Date.parse(`${day}T00:00:00.000Z`);

/** Where a close for `day` starts counting Lanes: the day after the previous closed day (Item a9ad21c9), so a Lane
 * started on a day without a landing in this project (a weekend, a Lane that crossed midnight) is counted by the next
 * close rather than lost; never before the lookback. */
export function laneWindowStart(previousClosedDay: string | undefined, day: string) {
  const floor = dayStart(day) - STATS_LANE_LOOKBACK_DAYS * DAY_MS;
  return previousClosedDay === undefined ? floor : Math.max(floor, dayStart(previousClosedDay) + DAY_MS);
}

/** The Lanes (open or not) started in [from, to), each filed under its own UTC day: two index range reads. */
export async function lanesByDay(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<'hostedProjects'>,
  from: number,
  to: number,
) {
  const byDay = new Map<string, Contribution[]>();
  let read = 0;
  for (const open of [true, false]) {
    const lanes = await ctx.db
      .query('projectHostedOverlapLanes')
      .withIndex('by_project_and_open', q =>
        q.eq('projectId', projectId).eq('open', open).gte('_creationTime', from).lt('_creationTime', to),
      )
      .order('desc')
      .take(STATS_LANES_READ);
    read += lanes.length;
    for (const lane of lanes) {
      if (!isAccount(lane.actor)) continue;
      const day = utcDay(lane._creationTime);
      const list = byDay.get(day) ?? [];
      list.push({
        kind: 'lane',
        person: lane.actor,
        at: lane._creationTime,
        ...(lane.agent ? { run: lane.agent } : {}),
      });
      byDay.set(day, list);
    }
  }
  return { byDay, read };
}
