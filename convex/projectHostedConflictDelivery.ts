// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';

/** A notice is already retained; advance the existing Lane inbox so its running wait sees it.
 * Only a changed real conflict reaches here. No message copy, scheduler work or extra call.
 * Share the board's logical clock so a cursor that consumed project notes cannot skip this notice. */
export async function wakeConflictLane(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  laneId: string,
  now: number,
) {
  const counter = await ctx.db
    .query('projectBoardProjects')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .unique();
  const key = `lane:${laneId}`;
  const inbox = await ctx.db
    .query('projectBoardInboxes')
    .withIndex('by_project_and_key', q => q.eq('projectId', projectId).eq('key', key))
    .unique();
  const at = Math.max(now, (counter?.lastAt ?? 0) + 1, (inbox?.latestAt ?? 0) + 1);
  if (counter) await ctx.db.patch(counter._id, { lastAt: at });
  else await ctx.db.insert('projectBoardProjects', { projectId, live: 0, firstPostAt: now, lastAt: at });
  if (inbox) await ctx.db.patch(inbox._id, { latestAt: at });
  else await ctx.db.insert('projectBoardInboxes', { projectId, key, latestAt: at, count: 0 });
  return at;
}
