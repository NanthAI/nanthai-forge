// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { internalAction } from './server';
import { runWorkCommand } from './projectWorkCommandRun';
import { indexedCommand, NodeCommandRequired } from './projectWorkIndexedCommand';
import { speedBudgetIssueSchema } from '../src/landing-speed-alerts';

const ATTEMPTS = 3;
const retryable = (error: unknown) => /WORK_STALE|WORK_CONFLICT/.test(String(error));
const finished = (error: unknown) => /WORK_OPERATION_CHANGED/.test(String(error));

/** Write one budget transition to the board: open or reopen the budget's single P0 Issue (fixed id) on a
 * break, comment on it on a break and on recovery. Runs only when a budget breaks or recovers, as the
 * project owner, through the same Work command path as `put-planning-item`. Operation ids name the
 * transition, so a retry reconciles instead of repeating; a stale revision is re-read and retried. */
async function command(
  ctx: ActionCtx,
  projectId: Id<'hostedProjects'>,
  owner: string,
  build: (version: number) => ({ operationId: string } & Record<string, unknown>) | null,
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
    const version = row ? (JSON.parse(row.value) as { version: number }).version : 0;
    const body = build(version);
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

export const write = internalAction({
  args: { projectId: v.id('hostedProjects'), owner: v.string(), issue: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    const issue = speedBudgetIssueSchema.parse(JSON.parse(input.issue));
    if (issue.reopen)
      await command(
        ctx,
        input.projectId,
        input.owner,
        version => ({
          action: 'put-planning-item',
          operationId: issue.putOperationId,
          itemId: issue.itemId,
          expectedVersion: version,
          kind: 'issue',
          title: issue.title,
          // The alert owns the initial description; later transitions comment below.
          // Omission preserves the owner's complete body and acceptance checklist.
          ...(version === 0 ? { body: issue.body } : {}),
          status: 'open',
          reason: 'Speed budget broken',
        }),
        issue.itemId,
      );
    await command(
      ctx,
      input.projectId,
      input.owner,
      // A recovery has nothing to comment on when no Issue was ever opened.
      version =>
        version
          ? {
              action: 'comment-planning-item',
              operationId: issue.commentOperationId,
              itemId: issue.itemId,
              authorLabel: 'Forge speed budgets',
              text: issue.comment,
            }
          : null,
      issue.itemId,
    );
    return null;
  },
});
