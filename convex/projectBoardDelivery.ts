// SPDX-License-Identifier: Apache-2.0
import type { QueryCtx, MutationCtx } from './_generated/server';
import type { Doc, Id } from './_generated/dataModel';
import { boardStopped } from './projectBoardLimits';

type Ctx = QueryCtx | MutationCtx;
/** A message as returned. `author` is an auth subject here; the public function wrapper maps it to
 * a Forge handle for members with write access and removes it for anyone else. */
export function boardMessageView(row: Doc<'projectBoardMessages'>) {
  return {
    id: row.id,
    author: row.author,
    ...(row.fromLaneId ? { fromLaneId: row.fromLaneId } : {}),
    target: row.targetKey,
    text: row.body,
    ...(row.paths?.length ? { paths: row.paths } : {}),
    ...(row.replyTo ? { replyTo: row.replyTo } : {}),
    at: row.at,
  };
}

/** Board content is for members with write access only (owner and contributors). Hosted projects
 * have no path-scoped read grants: every such member reads all source, so paths need no masking. */
export async function boardWriter(ctx: Ctx, projectId: Id<'hostedProjects'>, viewer: string) {
  const project = await ctx.db.get(projectId);
  if (!project || project.removal) return false;
  if (project.owner === viewer) return true;
  const contributor = await ctx.db
    .query('projectContributors')
    .withIndex('by_project_and_contributor', q => q.eq('projectId', projectId).eq('contributor', viewer))
    .unique();
  return contributor !== null;
}

/** Unread notes for one Lane: its own inbox, its Issue's and the project's. Three point reads;
 * message rows are read only for a target whose latestAt moved past the cursor. Oldest first, so
 * a cursor at the last delivered note never skips one. The caller's own Lane's notes are left out. */
export async function boardInbox(
  ctx: Ctx,
  input: {
    projectId: Id<'hostedProjects'>;
    laneId?: string;
    intentId?: string;
    after: number;
    limit: number;
    order: 'asc' | 'desc';
  },
) {
  const keys = [
    ...(input.laneId ? [`lane:${input.laneId}`] : []),
    ...(input.intentId ? [`issue:${input.intentId}`] : []),
    'project',
  ];
  const inboxes = await Promise.all(
    keys.map(key =>
      ctx.db
        .query('projectBoardInboxes')
        .withIndex('by_project_and_key', q => q.eq('projectId', input.projectId).eq('key', key))
        .unique(),
    ),
  );
  const hot = inboxes.filter(row => row !== null && row.latestAt > input.after);
  const pages = await Promise.all(
    hot.map(row =>
      ctx.db
        .query('projectBoardMessages')
        .withIndex('by_project_and_target_and_at', q =>
          q.eq('projectId', input.projectId).eq('targetKey', row!.key).gt('at', input.after),
        )
        .order(input.order)
        .take(input.limit + 1),
    ),
  );
  const sign = input.order === 'asc' ? 1 : -1;
  const rows = pages
    .flat()
    .filter(row => !input.laneId || row.fromLaneId !== input.laneId)
    .sort((a, b) => sign * (a.at - b.at));
  const shown = rows.slice(0, input.limit);
  return {
    messages: shown.map(boardMessageView),
    /** At least this many more unread notes (a lower bound: each target reads limit + 1 rows). */
    more: Math.max(0, rows.length - shown.length),
    /** Where the caller's cursor goes: the last note shown oldest-first, else the newest seen. */
    cursor:
      input.order === 'asc' && rows.length > shown.length
        ? (shown.at(-1)?.at ?? input.after)
        : Math.max(input.after, ...inboxes.map(row => row?.latestAt ?? 0)),
  };
}

/** The overlap read's board field (Lane actions): at most 2 notes, absent when nothing is new.
 * No access, board off or no new note all return undefined: nothing is added to the reply. */
export async function boardDelivery(
  ctx: Ctx,
  input: { projectId: Id<'hostedProjects'>; viewer: string; laneId: string; intentId: string; after: number },
) {
  if (!(await boardWriter(ctx, input.projectId, input.viewer))) return undefined;
  if (await boardStopped(ctx, input.projectId)) return undefined;
  const inbox = await boardInbox(ctx, { ...input, limit: 2, order: 'asc' });
  return inbox.messages.length ? inbox : undefined;
}
