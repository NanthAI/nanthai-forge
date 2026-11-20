// SPDX-License-Identifier: Apache-2.0
import type { Id } from './_generated/dataModel';
import type { MutationCtx, QueryCtx } from './server';
import {
  PRESENCE_GOAL_CHARS,
  PRESENCE_SAME_ISSUE,
  PRESENCE_WINDOW,
  presencePaths,
  rankPresence,
  type Presence,
  type PresenceMe,
  type PresenceRow,
} from '../src/hosted-presence';
import { samePark, type LanePark } from '../src/hosted-records';

type PresenceValue = {
  intentId: string;
  actor: string;
  agent?: string;
  session?: import('zod').infer<typeof import('../src/hosted-lane').sessionMetadataSchema>;
  goal: string;
  changes: string;
  at: number;
  /** The Lane record's park (Item e1633718). */
  park?: LanePark;
};
type Pointer = { id: Id<'projectHostedPresence'>; at: number };
/** A Lane whose presence data is unchanged rewrites its row at most this often (activity time only). */
export const PRESENCE_REFRESH_MS = 10 * 60_000;
const same = (a: string[], b: string[]) => a.length === b.length && a.every((path, i) => path === b[i]);

/** Written inside the Lane record write that already runs (no added call, no added read: the
 * overlap row it already read holds the pointer). Writes slim metadata plus a 512-character path
 * filter (only for truncated paths) when the Issue, goal, actor, saved paths or park change, or activity
 * moved by 10 minutes. A closed Lane's row is deleted, so the
 * table only holds open Lanes. Returns the pointer to keep on the overlap row. */
export async function trackHostedPresence(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  laneId: string,
  old: {
    pointer?: Pointer;
    intentId: string;
    actor: string;
    agent?: string;
    session?: import('zod').infer<typeof import('../src/hosted-lane').sessionMetadataSchema>;
    goal: string;
    changes: string;
    park?: LanePark;
  } | null,
  value: PresenceValue | null,
): Promise<Pointer | undefined> {
  const pointer = old?.pointer;
  if (!value) {
    if (pointer) await ctx.db.delete(pointer.id);
    return undefined;
  }
  const row = {
    projectId,
    laneId,
    intentId: value.intentId,
    actor: value.actor,
    ...(value.agent ? { agent: value.agent } : {}),
    ...(value.session ? { session: value.session } : {}),
    goal: value.goal.slice(0, PRESENCE_GOAL_CHARS),
    ...presencePaths(value.changes),
    at: value.at,
    ...(value.park ? { park: value.park } : {}),
  };
  if (pointer) {
    const before = presencePaths(old.changes);
    if (
      old.intentId === row.intentId &&
      old.actor === row.actor &&
      old.agent === value.agent &&
      JSON.stringify(old.session) === JSON.stringify(value.session) &&
      old.goal.slice(0, PRESENCE_GOAL_CHARS) === row.goal &&
      before.pathCount === row.pathCount &&
      same(before.paths, row.paths) &&
      before.pathBloom === row.pathBloom &&
      samePark(old.park, value.park) &&
      row.at - pointer.at < PRESENCE_REFRESH_MS
    )
      return pointer;
    await ctx.db.replace(pointer.id, row);
    return { id: pointer.id, at: row.at };
  }
  return { id: await ctx.db.insert('projectHostedPresence', row), at: row.at };
}

/** Keeps a Lane's projectHostedParks row (Item e1633718) in step with its park: the account whose Needs me lists it,
 * or none. The row exists exactly while the Lane is parked and has a presence row, so every place that deletes a
 * presence row of a parked Lane calls dropLanePark. Touches the table only when that account changes (park, re-park
 * to someone else, clear, Lane closed or superseded, superseded Lane saved again), so an unparked Lane and an
 * unchanged park cost nothing. It reads the Lane's rows before writing and keeps at most one, so a missed drop can
 * never leave two rows for one Lane. */
export async function routeLanePark(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  laneId: string,
  before: string | undefined,
  after: string | undefined,
) {
  if (before === after) return;
  const rows = await ctx.db
    .query('projectHostedParks')
    .withIndex('by_project_and_lane', q => q.eq('projectId', projectId).eq('laneId', laneId))
    .take(PARK_ROUTE_ROWS);
  // Cleared: every row goes. Parked: the first row is kept (re-pointed when the account changed), any extra goes.
  const keep = after ? rows[0] : undefined;
  for (const row of keep ? rows.slice(1) : rows) await ctx.db.delete(row._id);
  if (keep && after) {
    if (keep.parkedFor !== after) await ctx.db.patch(keep._id, { parkedFor: after });
  } else if (after) await ctx.db.insert('projectHostedParks', { projectId, laneId, parkedFor: after });
}
/** At most this many routing rows are read for one Lane: one is the rule; more only repairs a past missed drop. */
const PARK_ROUTE_ROWS = 4;

/** A parked Lane's presence row is being deleted without a record write (superseded, or closed by an Intent
 * cascade): its routing row goes too, so the holder's Needs me never spends a slot on it. A later save that makes the
 * Lane live again routes it afresh. Reads nothing for an unparked Lane. */
export async function dropLanePark(
  ctx: MutationCtx,
  row: { projectId: Id<'hostedProjects'>; laneId: string; presenceRow?: unknown; park?: unknown },
) {
  if (row.presenceRow && row.park) await routeLanePark(ctx, row.projectId, row.laneId, 'parked', undefined);
}

/** Related open Lanes for the caller's Lane, from at most 25 + 6 slim rows. `since` (a previous
 * reply's `at`) narrows the read to Lanes active since then; the client drops Lanes it has shown.
 * Callers must already hold write access: readers never get presence. */
export async function readHostedPresence(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  me: PresenceMe,
  since?: number,
  /** Dormant Lanes (no record write since this epoch ms) are not read. */
  cutoff: number | null = null,
): Promise<Presence> {
  const now = Date.now();
  const from = Math.max(since ?? -Infinity, cutoff ?? -Infinity);
  const [recent, sameIssue] = await Promise.all([
    ctx.db
      .query('projectHostedPresence')
      .withIndex('by_project_and_at', q =>
        from === -Infinity ? q.eq('projectId', projectId) : q.eq('projectId', projectId).gt('at', from),
      )
      .order('desc')
      .take(PRESENCE_WINDOW),
    since === undefined
      ? ctx.db
          .query('projectHostedPresence')
          .withIndex('by_project_and_intent_and_at', q =>
            cutoff === null
              ? q.eq('projectId', projectId).eq('intentId', me.intentId)
              : q.eq('projectId', projectId).eq('intentId', me.intentId).gt('at', cutoff),
          )
          .order('desc')
          .take(PRESENCE_SAME_ISSUE)
      : Promise.resolve([]),
  ]);
  const rows: PresenceRow[] = [...sameIssue, ...recent].map(row => ({
    laneId: row.laneId,
    intentId: row.intentId,
    actor: row.actor,
    ...(row.agent ? { agent: row.agent } : {}),
    goal: row.goal,
    paths: row.paths,
    pathCount: row.pathCount,
    at: row.at,
  }));
  return {
    at: now,
    ...rankPresence(me, rows, now),
    coverage: `same-issue-newest-${PRESENCE_SAME_ISSUE},active-newest-${PRESENCE_WINDOW}`,
  };
}

/** Ids of the open Lanes known dormant: slim presence rows idle since `cutoff`, newest first, at most 101.
 * A completeness check excuses these active heads: dormant Lanes are left out of peer reads on purpose. */
export const dormantHostedPresence = async (ctx: QueryCtx, projectId: Id<'hostedProjects'>, cutoff: number) =>
  new Set(
    (
      await ctx.db
        .query('projectHostedPresence')
        .withIndex('by_project_and_at', q => q.eq('projectId', projectId).lte('at', cutoff))
        .order('desc')
        .take(101)
    ).map(row => row.laneId),
  );
