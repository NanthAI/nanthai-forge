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
  type PresenceRow,
} from '../src/hosted-presence';

type PresenceValue = { intentId: string; actor: string; goal: string; changes: string; at: number };
type Pointer = { id: Id<'projectHostedPresence'>; at: number };
/** A Lane whose presence data is unchanged rewrites its row at most this often (activity time only). */
export const PRESENCE_REFRESH_MS = 10 * 60_000;
const same = (a: string[], b: string[]) => a.length === b.length && a.every((path, i) => path === b[i]);

/** Written inside the Lane record write that already runs (no added call, no added read: the
 * overlap row it already read holds the pointer). Writes ~0.4 KB only when the Issue, goal, actor
 * or saved paths change, or activity moved by 10 minutes. A closed Lane's row is deleted, so the
 * table only holds open Lanes. Returns the pointer to keep on the overlap row. */
export async function trackHostedPresence(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  laneId: string,
  old: { pointer?: Pointer; intentId: string; actor: string; goal: string; changes: string } | null,
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
    goal: value.goal.slice(0, PRESENCE_GOAL_CHARS),
    ...presencePaths(value.changes),
    at: value.at,
  };
  if (pointer) {
    const before = presencePaths(old.changes);
    if (
      old.intentId === row.intentId &&
      old.actor === row.actor &&
      old.goal.slice(0, PRESENCE_GOAL_CHARS) === row.goal &&
      before.pathCount === row.pathCount &&
      same(before.paths, row.paths) &&
      row.at - pointer.at < PRESENCE_REFRESH_MS
    )
      return pointer;
    await ctx.db.replace(pointer.id, row);
    return { id: pointer.id, at: row.at };
  }
  return { id: await ctx.db.insert('projectHostedPresence', row), at: row.at };
}

/** Related open Lanes for the caller's Lane, from at most 25 + 6 slim rows. `since` (a previous
 * reply's `at`) narrows the read to Lanes active since then; the client drops Lanes it has shown.
 * Callers must already hold write access: readers never get presence. */
export async function readHostedPresence(
  ctx: QueryCtx,
  projectId: Id<'hostedProjects'>,
  me: { laneId: string; intentId: string; goal: string; paths: string[]; actor: string },
  since?: number,
): Promise<Presence> {
  const now = Date.now();
  const [recent, sameIssue] = await Promise.all([
    ctx.db
      .query('projectHostedPresence')
      .withIndex('by_project_and_at', q =>
        since === undefined ? q.eq('projectId', projectId) : q.eq('projectId', projectId).gt('at', since),
      )
      .order('desc')
      .take(PRESENCE_WINDOW),
    since === undefined
      ? ctx.db
          .query('projectHostedPresence')
          .withIndex('by_project_and_intent_and_at', q =>
            q.eq('projectId', projectId).eq('intentId', me.intentId),
          )
          .order('desc')
          .take(PRESENCE_SAME_ISSUE)
      : Promise.resolve([]),
  ]);
  const rows: PresenceRow[] = [...sameIssue, ...recent].map(row => ({
    laneId: row.laneId,
    intentId: row.intentId,
    actor: row.actor,
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
