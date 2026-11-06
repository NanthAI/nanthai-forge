// SPDX-License-Identifier: Apache-2.0
import type { Doc, Id } from './_generated/dataModel';
import type { QueryCtx } from './server';
import { effectiveAgentDefaults } from '../src/agent-parallel-defaults';
import { effectivePolicy } from '../src/autonomy-policy';

const DAY_MS = 24 * 3_600_000;
/** Peer window of every overlap read; one more row says the window is full. */
export const PEER_WINDOW = 51;
type Project = { autonomyPolicy?: unknown };

/** Epoch ms before which an open Lane is dormant, or null when the project turned dormancy off
 * (agentDefaults.dormantAfterDays 0). The project row is already read by the caller's access check. */
export function dormantCutoff(project: Project, now = Date.now()): number | null {
  const days = effectiveAgentDefaults(
    effectivePolicy(project as Parameters<typeof effectivePolicy>[0]).agentDefaults,
  ).dormantAfterDays;
  return days > 0 ? now - days * DAY_MS : null;
}

/** Last time a Lane's record was written: the overlap row's own field, else the presence time it
 * carried before the field existed. A row with neither is unknown, and unknown counts as live: missing
 * evidence never hides a Lane. `abandon-dormant` stamps such rows from the Lane record. */
export const rowActivity = (row: Pick<Doc<'projectHostedOverlapLanes'>, 'lastActivityAt' | 'presenceRow'>) =>
  row.lastActivityAt ?? row.presenceRow?.at ?? Infinity;

/** Newest live open Lanes, at most `PEER_WINDOW`, from one indexed range on last activity. Dormant Lanes
 * are never read. Rows written before `lastActivityAt` existed sit in their own small range and are
 * filtered by the presence time they already hold, so a deployment needs no backfill; each leaves that
 * range at its Lane's next record write. With dormancy off this is the plain open-Lane read. */
export async function liveOpenOverlapLanes(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  cutoff: number | null,
) {
  if (cutoff === null)
    return ctx.db
      .query('projectHostedOverlapLanes')
      .withIndex('by_project_and_open', q => q.eq('projectId', projectId).eq('open', true))
      .order('desc')
      .take(PEER_WINDOW);
  const [live, legacy] = await Promise.all([
    ctx.db
      .query('projectHostedOverlapLanes')
      .withIndex('by_project_and_open_and_activity', q =>
        q.eq('projectId', projectId).eq('open', true).gt('lastActivityAt', cutoff),
      )
      .order('desc')
      .take(PEER_WINDOW),
    ctx.db
      .query('projectHostedOverlapLanes')
      .withIndex('by_project_and_open_and_activity', q =>
        q.eq('projectId', projectId).eq('open', true).eq('lastActivityAt', undefined),
      )
      .order('desc')
      .take(PEER_WINDOW),
  ]);
  return [...live, ...legacy.filter(row => rowActivity(row) > cutoff)]
    .sort((a, b) => (rowActivity(a) === rowActivity(b) ? 0 : rowActivity(b) > rowActivity(a) ? 1 : -1))
    .slice(0, PEER_WINDOW);
}

/** Why a dormant open Lane can be abandoned without losing saved work, or null when it cannot:
 * `empty` nothing was ever saved (head is still its base); `landed` an accepted receipt landed this
 * exact saved head (the overlap row's landing stamp). Any other saved head may hold unlanded work. */
export function abandonClass(
  lane: { head: string; base: { head: string } },
  overlap: Pick<Doc<'projectHostedOverlapLanes'>, 'landed' | 'head'> | null,
): 'empty' | 'landed' | null {
  if (lane.head === lane.base.head) return 'empty';
  return overlap && overlap.head === lane.head && overlap.landed?.laneHead === lane.head ? 'landed' : null;
}
