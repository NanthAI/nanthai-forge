// SPDX-License-Identifier: Apache-2.0
import { rememberActor, withActorName } from './projectActorNames';
import { v } from 'convex/values';
import { coordinationFeed, feedPageSize } from './coordinationFeed';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { coordinationMutation as mutation, coordinationQuery as query } from './cliServer';
import { activeProject, accessibleProject } from './projectAuthority';
import { command, eventDocument } from './coordinationFields';
import { applyCommand, canonical, denormalized, eventByOperation, session } from './coordinationWrite';
import { invariant } from '../src/errors';
import { COORDINATION_TOUCH_MIN_MS, coordinationCommandSchema } from '../src/coordination-types';
import { report } from './errors';
import { sessionStructure, sessionView, sessionTree } from './coordinationSessions';
export { counts, publicCounts } from './coordinationCounts';

const feedResult = v.object({
  page: v.array(eventDocument),
  isDone: v.boolean(),
  continueCursor: v.string(),
  cursorReset: v.boolean(),
});
async function signedIn(
  ctx: { auth: { getUserIdentity(): Promise<{ subject: string } | null> } },
  what: string,
) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', `Sign in to ${what}.`);
  return user.subject;
}

/** Live operational observations stay separate from archived source and Work revision. */
export const publish = mutation({
  args: { projectId: v.id('hostedProjects'), operationId: v.string(), command },
  returns: eventDocument,
  handler: async (ctx, input) => {
    try {
      const actor = await signedIn(ctx, 'coordinate this project');
      const project = await activeProject(ctx, input.projectId, actor);
      const old = await eventByOperation(ctx, input.projectId, input.operationId);
      if (old) {
        // Replays compare stored payloads without re-applying newer input limits to existing rows.
        invariant(
          old.actor === actor && canonical(old.command) === canonical(input.command),
          'WORK_OPERATION_CHANGED',
          'Use the original coordination operation and payload.',
        );
        return old;
      }
      const parsed = coordinationCommandSchema.parse(input.command);
      invariant(
        /^[0-9a-f-]{36}$/i.test(input.operationId),
        'BAD_ARGUMENT',
        'Use an original operation UUID.',
      );
      const sessionId = parsed.sessionId;
      const current = sessionId ? await session(ctx, input.projectId, sessionId) : null;
      invariant(
        !current || current.actor === actor,
        'PROJECT_UNAVAILABLE',
        'This session belongs to another principal.',
      );
      await rememberActor(ctx, input.projectId, actor, (await ctx.auth.getUserIdentity())?.name);
      const at = Date.now();
      let fields = {};
      if (parsed.kind === 'activity') {
        invariant(
          !current || parsed.sequence > current.sequence,
          'COORDINATION_STALE',
          'A newer session observation exists. Read it and publish a higher sequence; nothing was overwritten.',
        );
        const value = {
          projectId: input.projectId,
          actor,
          lastSeen: at,
          lastActivity: Math.min(at, parsed.activityAt ?? at),
          activityKind: parsed.activityKind ?? 'reported work',
          operationId: input.operationId,
          sessionId: parsed.sessionId,
          sequence: parsed.sequence,
          name: parsed.name,
          environment: parsed.environment,
          status: parsed.status,
          summary: parsed.summary,
          context: parsed.context,
          ...(await sessionStructure(
            ctx,
            input.projectId,
            actor,
            (await ctx.auth.getUserIdentity())?.forgeCredential as string | undefined,
            current,
            parsed,
            at,
          )),
        };
        if (current) await ctx.db.patch(current._id, value);
        else await ctx.db.insert('projectCoordinationSessions', value);
      } else {
        invariant(
          !sessionId || current,
          'BAD_ARGUMENT',
          'Announce this session before sending its messages.',
        );
        fields = await applyCommand(ctx, project, actor, input.operationId, parsed, at);
      }
      const id = await ctx.db.insert('projectCoordinationEvents', {
        projectId: input.projectId,
        operationId: input.operationId,
        actor,
        at,
        command: parsed,
        ...denormalized(parsed),
        ...fields,
      });
      return (await ctx.db.get(id))!;
    } catch (error) {
      return report(error);
    }
  },
});

/** Heartbeat: patches only last-seen on your own session. No event, no sequence; frequent touches are skipped. */
export const touch = mutation({
  args: { projectId: v.id('hostedProjects'), sessionId: v.string(), activityKind: v.optional(v.string()) },
  returns: v.object({ sessionId: v.string(), lastSeen: v.number(), touched: v.boolean() }),
  handler: async (ctx, input) => {
    try {
      const actor = await signedIn(ctx, 'coordinate this project');
      await activeProject(ctx, input.projectId, actor);
      const current = await session(ctx, input.projectId, input.sessionId);
      invariant(current, 'BAD_ARGUMENT', 'Announce this session before touching it.');
      invariant(current.actor === actor, 'PROJECT_UNAVAILABLE', 'This session belongs to another principal.');
      const now = Date.now();
      if (!input.activityKind && now - current.lastSeen < COORDINATION_TOUCH_MIN_MS)
        return { sessionId: current.sessionId, lastSeen: current.lastSeen, touched: false };
      await ctx.db.patch(current._id, {
        lastSeen: now,
        lastActivity: input.activityKind ? now : (current.lastActivity ?? current.lastSeen),
        ...(input.activityKind ? { activityKind: input.activityKind.slice(0, 120) } : {}),
      });
      return { sessionId: current.sessionId, lastSeen: now, touched: true };
    } catch (error) {
      return report(error);
    }
  },
});

/** `stale` is computed when the query runs; clients that stay subscribed should compare `lastActivity` (legacy: `lastSeen`) themselves. */
export const sessions = query({
  args: {
    projectId: v.id('hostedProjects'),
    paginationOpts: paginationOptsValidator,
    parentSessionId: v.optional(v.string()),
    all: v.optional(v.boolean()),
  },
  returns: paginationResultValidator(sessionView),
  handler: async (ctx, { projectId, paginationOpts, parentSessionId, all }) => {
    try {
      const actor = await signedIn(ctx, 'read project activity');
      await accessibleProject(ctx, projectId, actor);
      feedPageSize(paginationOpts.numItems);
      const rows = ctx.db.query('projectCoordinationSessions');
      const scoped = all
        ? rows.withIndex('by_project', q => q.eq('projectId', projectId))
        : rows.withIndex('by_project_and_parent', q =>
            q.eq('projectId', projectId).eq('parentSessionId', parentSessionId),
          );
      const result = await scoped.order('desc').paginate(paginationOpts);
      const now = Date.now();
      return {
        ...result,
        page: await Promise.all(result.page.map(row => sessionTree(ctx, projectId, row, now))),
      };
    } catch (error) {
      return report(error);
    }
  },
});

/** Append-only pages: retain continueCursor and operation IDs across reconnects. Optional Intent or Lane scope uses an index. */
export const feed = query({
  args: {
    projectId: v.id('hostedProjects'),
    paginationOpts: paginationOptsValidator,
    intentId: v.optional(v.string()),
    laneId: v.optional(v.string()),
  },
  returns: feedResult,
  handler: async (ctx, { projectId, paginationOpts, intentId, laneId }) => {
    try {
      const actor = await signedIn(ctx, 'read project coordination');
      await accessibleProject(ctx, projectId, actor);
      invariant(!(intentId && laneId), 'BAD_ARGUMENT', 'Scope the feed by an Intent or a Lane, not both.');
      return await coordinationFeed(
        ctx,
        projectId,
        paginationOpts.cursor,
        paginationOpts.numItems,
        laneId
          ? { field: 'laneId', value: laneId }
          : intentId
            ? { field: 'intentId', value: intentId }
            : undefined,
      );
    } catch (error) {
      return report(error);
    }
  },
});

export const recent = query({
  args: { projectId: v.id('hostedProjects'), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(eventDocument),
  handler: async (ctx, { projectId, paginationOpts }) => {
    try {
      const actor = await signedIn(ctx, 'read project coordination');
      await accessibleProject(ctx, projectId, actor);
      feedPageSize(paginationOpts.numItems);
      const result = await ctx.db
        .query('projectCoordinationEvents')
        .withIndex('by_project', q => q.eq('projectId', projectId))
        .order('desc')
        .paginate(paginationOpts);
      return {
        ...result,
        page: await Promise.all(result.page.map(row => withActorName(ctx, projectId, row))),
      };
    } catch (error) {
      return report(error);
    }
  },
});
