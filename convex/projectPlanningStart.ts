// SPDX-License-Identifier: Apache-2.0
// A start shows its Item as in progress for every member (Item d3357f40, lead 2026-11-19). Planning writes are the
// project owner's, so a member's own status write after a start is refused. The start schedules this action instead
// when the starter is not the owner, and the server moves the Issue, as the owner, from open to in progress. A proposed
// Issue stays proposed: approving a proposal is the owner's call (lead 2026-11-19, as maintainers triage on GitHub).
// Only an Issue moves; an Initiative or any other kind never does, whatever id the start names. It runs once per such
// start, after the start committed, so a planning failure never fails the start.
// Cost: one Work generation read, one planning-item lookup, and one Work command only when the status moves. The
// owner's own start writes nothing here: their client already sets the status, and claims the Item, in one write.
import { v } from 'convex/values';
import { internalAction } from './server';
import { ownerPlanningCommand } from './projectOwnerPlanning';
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
    await ownerPlanningCommand(
      ctx,
      projectId,
      owner,
      item =>
        // An Issue only (a stored item names its kind), and only when open: a stored item without a status is open (the
        // planning schema's default); proposed waits for the owner; closed, abandoned and in progress stay as they are.
        item && item.kind === 'issue' && (item.status ?? 'open') === 'open'
          ? {
              action: 'put-planning-item',
              operationId: startMoveOperationId({ projectId, itemId, actor, startOperationId }),
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
