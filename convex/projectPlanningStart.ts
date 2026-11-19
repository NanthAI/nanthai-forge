// SPDX-License-Identifier: Apache-2.0
// A start shows its Item as in progress for every member (Item d3357f40, lead 2026-11-19). Planning writes are the
// project owner's, so a member's own status write after a start is refused. The start schedules this action instead
// when the starter is not the owner, and the server moves the Item, as the owner, from open (or proposed) to in
// progress. It runs once per such start, after the start committed, so a planning failure never fails the start.
// Cost: one Work generation read, one planning-item lookup, and one Work command only when the status moves. The
// owner's own start writes nothing here: their client already sets the status, and claims the Item, in one write.
import { v } from 'convex/values';
import { internalAction } from './server';
import { ownerPlanningCommand } from './projectOwnerPlanning';
import { digest } from '../src/state/hash';

/** The server's own operation id for a start's status move: stable across retries of the same start. */
export const startMoveOperationId = (startOperationId: string) => {
  const h = digest(`${startOperationId}:planning-start-server`);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20, 32)}`;
};

export const move = internalAction({
  args: {
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    itemId: v.string(),
    startOperationId: v.string(),
  },
  returns: v.null(),
  handler: async (ctx, { projectId, owner, itemId, startOperationId }) => {
    await ownerPlanningCommand(
      ctx,
      projectId,
      owner,
      item =>
        // A stored item without a status is open (the planning schema's default).
        item && ['open', 'proposed'].includes(item.status ?? 'open')
          ? {
              action: 'put-planning-item',
              operationId: startMoveOperationId(startOperationId),
              itemId,
              expectedVersion: item.version,
              status: 'in-progress',
            }
          : null,
      itemId,
    );
    return null;
  },
});
