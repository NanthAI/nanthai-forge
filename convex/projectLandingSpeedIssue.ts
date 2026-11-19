// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import type { ActionCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { internalAction } from './server';
import { ownerPlanningCommand } from './projectOwnerPlanning';
import { speedBudgetIssueSchema } from '../src/landing-speed-alerts';

/** Write one budget transition to the board: open or reopen the budget's single P0 Issue (fixed id) on a
 * break, comment on it on a break and on recovery. Runs only when a budget breaks or recovers, as the
 * project owner (projectOwnerPlanning.ts). */
const command = (
  ctx: ActionCtx,
  projectId: Id<'hostedProjects'>,
  owner: string,
  build: (version: number) => ({ operationId: string } & Record<string, unknown>) | null,
  itemId: string,
) => ownerPlanningCommand(ctx, projectId, owner, item => build(item?.version ?? 0), itemId);

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
