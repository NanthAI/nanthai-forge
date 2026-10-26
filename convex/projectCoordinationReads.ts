// SPDX-License-Identifier: Apache-2.0
import { withActorName } from './projectActorNames';
import { v } from 'convex/values';
import { paginationOptsValidator } from 'convex/server';
import { coordinationQuery as query, type QueryCtx } from './cliServer';
import type { Doc, Id } from './_generated/dataModel';
import { accessibleProject } from './projectAuthority';
import { claimDocument, eventDocument } from './coordinationFields';
import { feedCursor, feedPageSize, feedPosition, feedRows } from './coordinationFeed';
import { canAcknowledge, receipt, session } from './coordinationWrite';
import { invariant } from '../src/errors';
import { COORDINATION_LIMITS } from '../src/coordination-types';
import { inCoordinationScope, overlappingPaths } from '../src/coordination-paths';
import { report } from './errors';

const ackedEvent = v.object({ ...eventDocument.fields, acked: v.boolean() });
const RELATED_SCAN = 200,
  UNACKED_SCAN = 100,
  CLAIM_SCAN = 500;

async function reader(ctx: QueryCtx, projectId: Id<'hostedProjects'>, sessionId?: string) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read project coordination.');
  await accessibleProject(ctx, projectId, user.subject);
  const own = sessionId ? await session(ctx, projectId, sessionId) : null;
  invariant(
    !sessionId || own?.actor === user.subject,
    'PROJECT_UNAVAILABLE',
    'Select one of your own sessions in this project.',
  );
  return { actor: user.subject, own };
}
/** Session-directed rows for another of your sessions are left out when a session is selected. */
const forSession = (row: Doc<'projectCoordinationEvents'>, sessionId?: string) =>
  !sessionId || !row.recipientSession || row.recipientSession === sessionId;
async function activeClaims(ctx: QueryCtx, projectId: Id<'hostedProjects'>, actor?: string) {
  const now = Date.now();
  const rows = actor
    ? await ctx.db
        .query('projectCoordinationClaims')
        .withIndex('by_project_and_actor_and_expiresAt', q =>
          q.eq('projectId', projectId).eq('actor', actor).gt('expiresAt', now),
        )
        .take(CLAIM_SCAN)
    : await ctx.db
        .query('projectCoordinationClaims')
        .withIndex('by_project_and_expiresAt', q => q.eq('projectId', projectId).gt('expiresAt', now))
        .take(CLAIM_SCAN);
  return {
    claims: await Promise.all(
      rows.filter(row => !row.releasedAt).map(row => withActorName(ctx, projectId, row)),
    ),
    complete: rows.length < CLAIM_SCAN,
  };
}

/** Messages and handoffs addressed to the caller (directly or through one of their sessions), oldest first. */
export const inbox = query({
  args: {
    projectId: v.id('hostedProjects'),
    paginationOpts: paginationOptsValidator,
    sessionId: v.optional(v.string()),
  },
  returns: v.object({
    page: v.array(ackedEvent),
    isDone: v.boolean(),
    continueCursor: v.string(),
    cursorReset: v.boolean(),
  }),
  handler: async (ctx, { projectId, paginationOpts, sessionId }) => {
    try {
      const { actor } = await reader(ctx, projectId, sessionId);
      const size = feedPageSize(paginationOpts.numItems);
      const { position, cursorReset } = feedPosition(ctx, projectId, paginationOpts.cursor);
      const result = await feedRows(ctx, projectId, position, size, {
        field: 'recipientActor',
        value: actor,
      });
      const page = [];
      for (const row of result.rows)
        if (forSession(row, sessionId))
          page.push({ ...row, acked: !!(await receipt(ctx, projectId, row.operationId, actor)) });
      return {
        page,
        isDone: !result.hasMore,
        continueCursor: feedCursor(projectId, result.positions.at(-1) ?? position),
        cursorReset,
      };
    } catch (error) {
      return report(error);
    }
  },
});

/** Recent directed messages/handoffs and broadcasts by others that the caller has not acknowledged. */
export const unacked = query({
  args: { projectId: v.id('hostedProjects'), sessionId: v.optional(v.string()), limit: v.number() },
  returns: v.object({ items: v.array(ackedEvent), complete: v.boolean() }),
  handler: async (ctx, { projectId, sessionId, limit }) => {
    try {
      const { actor } = await reader(ctx, projectId, sessionId);
      feedPageSize(limit);
      const directed = await ctx.db
        .query('projectCoordinationEvents')
        .withIndex('by_project_and_recipientActor', q =>
          q.eq('projectId', projectId).eq('recipientActor', actor),
        )
        .order('desc')
        .take(UNACKED_SCAN);
      const broadcast = await ctx.db
        .query('projectCoordinationEvents')
        .withIndex('by_project_and_kind_and_recipientActor', q =>
          q.eq('projectId', projectId).eq('kind', 'message').eq('recipientActor', undefined),
        )
        .order('desc')
        .take(UNACKED_SCAN);
      const items = [];
      for (const row of [...directed, ...broadcast].sort(
        (a, b) => a.at - b.at || a._creationTime - b._creationTime,
      ))
        if (
          (row.recipientActor || row.actor !== actor) &&
          (await canAcknowledge(ctx, row, actor, sessionId)) &&
          !(await receipt(ctx, projectId, row.operationId, actor))
        )
          items.push({ ...(await withActorName(ctx, projectId, row)), acked: false });
      return {
        items: items.slice(-limit),
        complete: directed.length < UNACKED_SCAN && broadcast.length < UNACKED_SCAN && items.length <= limit,
      };
    } catch (error) {
      return report(error);
    }
  },
});

/** Active (unexpired, unreleased) advisory claims. Expiry is evaluated when the query runs. */
export const claims = query({
  args: { projectId: v.id('hostedProjects') },
  returns: v.object({ claims: v.array(claimDocument), complete: v.boolean() }),
  handler: async (ctx, { projectId }) => {
    try {
      await reader(ctx, projectId);
      return await activeClaims(ctx, projectId);
    } catch (error) {
      return report(error);
    }
  },
});

/** Active claims by others whose paths overlap yours (same file, or one is a directory of the other). */
export const overlaps = query({
  args: {
    projectId: v.id('hostedProjects'),
    paths: v.array(v.string()),
    includeMine: v.optional(v.boolean()),
  },
  returns: v.object({
    overlaps: v.array(v.object({ ...claimDocument.fields, overlapping: v.array(v.string()) })),
    complete: v.boolean(),
  }),
  handler: async (ctx, { projectId, paths, includeMine }) => {
    try {
      const { actor } = await reader(ctx, projectId);
      invariant(
        paths.length > 0 && paths.length <= COORDINATION_LIMITS.paths,
        'BAD_ARGUMENT',
        `Use 1 to ${COORDINATION_LIMITS.paths} paths.`,
      );
      const { claims, complete } = await activeClaims(ctx, projectId);
      return {
        overlaps: claims
          .filter(claim => includeMine || claim.actor !== actor)
          .map(claim => ({ ...claim, overlapping: overlappingPaths(paths, claim.paths) }))
          .filter(claim => claim.overlapping.length > 0),
        complete,
      };
    } catch (error) {
      return report(error);
    }
  },
});

/**
 * Feed events related to the caller: their active claims, a selected session's scope, explicit
 * Intents/Lanes/paths, or addressed to them. Scans at most 200 events per call; the cursor is the
 * ordinary feed cursor, so an empty page with isDone=false means "keep reading".
 */
export const related = query({
  args: {
    projectId: v.id('hostedProjects'),
    paginationOpts: paginationOptsValidator,
    sessionId: v.optional(v.string()),
    intentIds: v.optional(v.array(v.string())),
    laneIds: v.optional(v.array(v.string())),
    paths: v.optional(v.array(v.string())),
    includeMine: v.optional(v.boolean()),
  },
  returns: v.object({
    page: v.array(eventDocument),
    isDone: v.boolean(),
    continueCursor: v.string(),
    cursorReset: v.boolean(),
    scope: v.object({
      intentIds: v.array(v.string()),
      laneIds: v.array(v.string()),
      paths: v.array(v.string()),
    }),
  }),
  handler: async (ctx, input) => {
    try {
      const { actor, own } = await reader(ctx, input.projectId, input.sessionId);
      const size = feedPageSize(input.paginationOpts.numItems);
      invariant(
        (input.intentIds?.length ?? 0) <= 20 &&
          (input.laneIds?.length ?? 0) <= 20 &&
          (input.paths?.length ?? 0) <= COORDINATION_LIMITS.paths,
        'BAD_ARGUMENT',
        'Use at most 20 Intents, 20 Lanes and 100 paths.',
      );
      const mine = (await activeClaims(ctx, input.projectId, actor)).claims;
      const ids = (values: (string | undefined)[]) => values.filter((x): x is string => !!x);
      const scope = {
        intentIds: new Set(
          ids([...(input.intentIds ?? []), own?.context.intentId, ...mine.map(c => c.intentId)]),
        ),
        laneIds: new Set(ids([...(input.laneIds ?? []), own?.context.laneId, ...mine.map(c => c.laneId)])),
        paths: [
          ...new Set([...(input.paths ?? []), ...(own?.context.paths ?? []), ...mine.flatMap(c => c.paths)]),
        ],
      };
      const { position, cursorReset } = feedPosition(ctx, input.projectId, input.paginationOpts.cursor);
      const scanned = await feedRows(ctx, input.projectId, position, RELATED_SCAN);
      const page: Doc<'projectCoordinationEvents'>[] = [];
      let last = position,
        stoppedEarly = false;
      for (let i = 0; i < scanned.rows.length; i++) {
        const row = scanned.rows[i]!;
        last = scanned.positions[i]!;
        if (
          (input.includeMine || row.actor !== actor) &&
          (row.recipientActor === actor || inCoordinationScope(row.command, scope))
        )
          page.push(row);
        if (page.length >= size) {
          stoppedEarly = i < scanned.rows.length - 1;
          break;
        }
      }
      return {
        page,
        isDone: !scanned.hasMore && !stoppedEarly,
        continueCursor: feedCursor(input.projectId, last),
        cursorReset,
        scope: { intentIds: [...scope.intentIds], laneIds: [...scope.laneIds], paths: scope.paths },
      };
    } catch (error) {
      return report(error);
    }
  },
});
