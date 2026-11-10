// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { boardStopped, BOARD_PROJECT_LIVE_CAP, BOARD_RETENTION_MS } from './projectBoardLimits';
import { boardTextProblem } from '../src/board-text';
import { digest } from '../src/state/hash';

/**
 * A system-written note to one Lane (Issue dc62b120): the same board row a member's `board --post`
 * writes, so it arrives on that Lane's next action as `board.notices` and ends a blocked `wait`
 * through the Lane's inbox row. The author is the public identity of the Lane whose change caused it
 * (its actor and agent slug), so it reads as `from @handle/slug (Lane xxxxxxxx)`.
 *
 * Reads: the id replay (1), the two operator switches (2), the project counter (1), the Lane inbox (1).
 * Writes: message, inbox, counter. It is not rate limited: callers bound the fan-out and send one note
 * per event. It is skipped, never thrown, when the board is off, full, or the text would be refused:
 * a notice must not fail the parent's save, abandon or landing transaction.
 */
export async function postSystemLaneNote(
  ctx: MutationCtx,
  input: {
    projectId: Id<'hostedProjects'>;
    /** Deterministic per event, so a replay of the event returns the first note. */
    id: string;
    /** The Lane whose inbox gets it; 'project' posts to the whole project (no Lane inbox wakes). */
    toLaneId: string | 'project';
    fromLaneId: string;
    author: string;
    agent?: string;
    text: string;
    now?: number;
  },
): Promise<'posted' | 'duplicate' | 'skipped'> {
  const { projectId } = input;
  const old = await ctx.db
    .query('projectBoardMessages')
    .withIndex('by_project_and_id', q => q.eq('projectId', projectId).eq('id', input.id))
    .unique();
  if (old) return 'duplicate';
  if (boardTextProblem(input.text) || (await boardStopped(ctx, projectId))) return 'skipped';
  const counter = await ctx.db
    .query('projectBoardProjects')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .unique();
  if ((counter?.live ?? 0) >= BOARD_PROJECT_LIVE_CAP) return 'skipped';
  const now = input.now ?? Date.now();
  const targetKey = input.toLaneId === 'project' ? 'project' : `lane:${input.toLaneId}`;
  // Each note gets a later time than the project's last one, so a client cursor never skips a note.
  const at = Math.max(now, (counter?.lastAt ?? 0) + 1);
  await ctx.db.insert('projectBoardMessages', {
    projectId,
    id: input.id,
    author: input.author,
    ...(input.agent ? { agent: input.agent } : {}),
    fromLaneId: input.fromLaneId,
    targetKey,
    body: input.text,
    bytes: new TextEncoder().encode(input.text).length,
    bodyHash: digest(JSON.stringify([targetKey, input.text, []])),
    at,
    expiresAt: now + BOARD_RETENTION_MS,
  });
  const inbox = await ctx.db
    .query('projectBoardInboxes')
    .withIndex('by_project_and_key', q => q.eq('projectId', projectId).eq('key', targetKey))
    .unique();
  if (inbox) await ctx.db.patch(inbox._id, { latestAt: at, count: inbox.count + 1 });
  else await ctx.db.insert('projectBoardInboxes', { projectId, key: targetKey, latestAt: at, count: 1 });
  if (counter) await ctx.db.patch(counter._id, { live: counter.live + 1, lastAt: at });
  else await ctx.db.insert('projectBoardProjects', { projectId, live: 1, firstPostAt: now, lastAt: at });
  return 'posted';
}
