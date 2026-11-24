// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
// One hook after any planned start commits. Keep the member's direct move; always forward the work signal,
// including when a Proposed or pinned Item keeps its status.
import { v } from 'convex/values';
import { internalAction } from './server';
import { ownerPlanningCommand } from './projectOwnerPlanning';
import { rollupWake } from './projectPlanRollupWake';
import { digest } from '../src/state/hash';

/** The server's own operation id for a start's status move: stable across retries of the same start, and distinct per
 * project, Item and caller (hosted operations are keyed per actor, so two callers' start ids may coincide). */
export const startMoveOperationId = (input: {
  projectId: string;
  itemId: string;
  actor: string;
  startOperationId: string;
}) => {
  const h = digest(
    JSON.stringify([
      input.projectId,
      input.itemId,
      input.actor,
      input.startOperationId,
      'planning-start-server',
    ]),
  );
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export const move = internalAction({
  args: {
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    itemId: v.string(),
    // Optional: a move scheduled by a server deployed before the actor was passed still runs after the deploy.
    actor: v.optional(v.string()),
    startOperationId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { projectId, owner, itemId, actor = '', startOperationId }) => {
    const cause = startMoveOperationId({ projectId, itemId, actor, startOperationId });
    let moved = false;
    try {
      if (actor !== owner)
        moved = await ownerPlanningCommand(
          ctx,
          projectId,
          owner,
          item =>
            item && item.kind === 'issue' && (item.status ?? 'open') === 'open' && !item.statusPin
              ? {
                  action: 'put-planning-item',
                  operationId: cause,
                  itemId,
                  expectedVersion: item.version,
                  status: 'in-progress',
                  reason: 'Lane started',
                }
              : null,
          itemId,
        );
    } finally {
      // A member move already wakes from the shared Plan write in the same transaction.
      if (!moved) await ctx.scheduler.runAfter(0, rollupWake, { projectId, itemId, cause, source: 'start' });
    }
    return null;
  },
});
