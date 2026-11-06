// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { query } from './cliServer';
import { activeProject } from './projectAuthority';
import { finishReadReader } from './projectFinishReadReader';
import { boardWake } from './projectBoardDelivery';
import { canonicalPayload } from '../src/hosted-source-operation';
import { invariant } from '../src/errors';
import { report } from './errors';

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const prefix = /^[0-9a-f]{8}[0-9a-f-]{0,28}$/;

/**
 * Wait for a peer Lane (feature board-wait): the CLI holds this as its one live subscription for the
 * length of the wait. No polling: Convex re-runs it only when a row it read changes, which is the
 * peer's Lane head row, the peer's overlap row (its saves and its landing stamp) and, with `laneId`,
 * the caller's own inbox row. Members with write access only, as presence; people as handles.
 *
 * Reads per run: access (finish-read projection, 1-2 rows), ≤2 head rows (prefix range), 1 overlap
 * row, and with `laneId` 1 inbox row (+ the ≤2-note delivery only when a note is new).
 */
export const peer = query({
  args: {
    projectId: v.id('hostedProjects'),
    /** The peer Lane: full id or a unique prefix of 8+ characters. */
    peer: v.string(),
    /** The caller's own Lane: a note to it ends the wait early (reason "message"). */
    laneId: v.optional(v.string()),
    after: v.optional(v.number()),
  },
  returns: v.string(),
  handler: async (rawCtx, input) => {
    try {
      const ctx = finishReadReader(rawCtx);
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to wait for a peer Lane.');
      await activeProject(ctx, input.projectId, user.subject);
      const ref = input.peer.toLowerCase();
      invariant(prefix.test(ref), 'BAD_ARGUMENT', 'peer is a Lane id or an 8+ character prefix.');
      const heads = await rawCtx.db
        .query('projectHostedRecordHeads')
        .withIndex('by_project_and_kind_and_key', q =>
          uuid.test(ref)
            ? q.eq('projectId', input.projectId).eq('kind', 'lane').eq('key', ref)
            : q.eq('projectId', input.projectId).eq('kind', 'lane').gte('key', ref).lt('key', `${ref}￿`),
        )
        .take(2);
      invariant(
        heads.length === 1,
        heads.length ? 'BAD_ARGUMENT' : 'NOT_FOUND',
        heads.length
          ? `Lane prefix ${ref} is ambiguous (${heads.map(head => head.key.slice(0, 13)).join(', ')}); use more characters.`
          : `No Lane ${ref} in this project.`,
      );
      const head = heads[0]!;
      invariant(head.key !== input.laneId, 'BAD_ARGUMENT', 'peer is another Lane, not your own.');
      const row = await rawCtx.db
        .query('projectHostedOverlapLanes')
        .withIndex('by_project_and_lane', q => q.eq('projectId', input.projectId).eq('laneId', head.key))
        .unique();
      const landed = row?.landed && row.landed.laneHead === row.head ? row.landed : undefined;
      const state = landed
        ? 'accepted'
        : head.status === 'abandoned'
          ? 'abandoned'
          : head.status === 'completed'
            ? 'completed'
            : row && !row.open
              ? 'closed'
              : 'open';
      const board =
        input.laneId && input.after !== undefined
          ? await boardWake(ctx, {
              projectId: input.projectId,
              viewer: user.subject,
              laneId: input.laneId,
              after: input.after,
            }).catch(() => undefined)
          : undefined;
      return canonicalPayload({
        peer: {
          laneId: head.key,
          ...(head.parent ? { intentId: head.parent } : {}),
          state,
          terminal: state !== 'open',
          ...(row ? { actor: row.actor } : {}),
          ...(landed
            ? {
                receiptId: landed.receiptId,
                commit: landed.commit,
                at: landed.at,
              }
            : {}),
        },
        ...(board ? { board } : {}),
      });
    } catch (error) {
      return report(error);
    }
  },
});
