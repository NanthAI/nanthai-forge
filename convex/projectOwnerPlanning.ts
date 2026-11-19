// SPDX-License-Identifier: Apache-2.0
import type { ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { internal } from './_generated/api';
import { runWorkCommand } from './projectWorkCommandRun';
import { indexedCommand, NodeCommandRequired } from './projectWorkIndexedCommand';

const ATTEMPTS = 3;
// ITEM_CHANGED: the item moved between the lookup and the write (a person edited it); the loop reads it again.
const retryable = (error: unknown) => /WORK_STALE|WORK_CONFLICT|ITEM_CHANGED/.test(String(error));
const finished = (error: unknown) => /WORK_OPERATION_CHANGED/.test(String(error));

/** The stored planning item a server write builds on, or null when it does not exist yet. */
export type StoredPlanningItem = {
  version: number;
  kind?: string;
  status?: string;
  owner?: string | null;
};

/** One planning write by the server as the project owner, through the same Work command path as
 * `put-planning-item` (speed-budget Issues, a member's start). `build` sees the stored item and returns the
 * command, or null to write nothing. Operation ids name the transition, so a retry reconciles instead of
 * repeating; a stale revision, or an item changed meanwhile, is re-read and retried. */
export async function ownerPlanningCommand(
  ctx: ActionCtx,
  projectId: Id<'hostedProjects'>,
  owner: string,
  build: (item: StoredPlanningItem | null) => ({ operationId: string } & Record<string, unknown>) | null,
  itemId: string,
) {
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const generation = await ctx.runQuery(internal.projectWorkIndexStore.current, { projectId, owner });
    if (!generation) return false;
    const [row] = await ctx.runQuery(internal.projectWorkIndexStore.lookups, {
      projectId,
      owner,
      generationId: generation._id,
      keys: [{ collection: 'planningItems', key: itemId }],
    });
    const body = build(row ? (JSON.parse(row.value) as StoredPlanningItem) : null);
    if (!body) return false;
    const input = {
      projectId,
      operationId: body.operationId,
      revision: generation.revision,
      command: JSON.stringify(body),
    };
    try {
      try {
        await runWorkCommand(ctx, input, owner, (parsed, request) =>
          indexedCommand(ctx, input, owner, parsed, request),
        );
      } catch (error) {
        if (!(error instanceof NodeCommandRequired)) throw error;
        await ctx.runAction(internal.projectWorkActions.commandNode, { ...input, owner });
      }
      return true;
    } catch (error) {
      if (finished(error)) return true;
      if (!retryable(error) || attempt === ATTEMPTS - 1) throw error;
    }
  }
  return false;
}
