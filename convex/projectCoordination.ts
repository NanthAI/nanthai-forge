// SPDX-License-Identifier: Apache-2.0
import { wakeJournal } from './projectJournalWake';
import { JournalNeeded, journalReadReply } from './projectJournalStore';
import type { QueryCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { PaginationOptions } from 'convex/server';
import { v } from 'convex/values';
import { canReadConversation, coordinationFeed, coordinationRecent, feedPageSize } from './coordinationFeed';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { coordinationMutation as mutation, coordinationQuery as query } from './cliServer';
import { activeProject, accessibleProject } from './projectAuthority';
import { command, eventDocument } from './coordinationFields';
import { applyCommand, canonical, denormalized, eventByOperation, session } from './coordinationWrite';
import { invariant } from '../src/errors';
import { COORDINATION_TOUCH_MIN_MS, coordinationCommandSchema } from '../src/coordination-types';
import { report } from './errors';
import { sessionStructure, sessionView, sessionTree } from './coordinationSessions';
import { ask, handBack } from './coordinationConversation';
export { counts, publicCounts } from './coordinationCounts';

const feedResult = v.object({
  journalHistory: v.optional(v.literal(true)),
  viewVersion: v.optional(v.string()),
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
  args: {
    projectId: v.id('hostedProjects'),
    operationId: v.string(),
    command,
    replayOnly: v.optional(v.literal(true)),
    holderSessionId: v.optional(v.string()),
  },
  returns: eventDocument,
  handler: async (ctx, input) => {
    try {
      const actor = await signedIn(ctx, 'coordinate this project');
      const project = await activeProject(ctx, input.projectId, actor);
      if (input.command.kind === 'handoff' && input.command.handBack)
        invariant(
          ctx.forgeDevice?.scope !== 'coordination',
          'AUTH_SCOPE_DENIED',
          'This credential grants coordination only.',
        );
      const old = await eventByOperation(ctx, input.projectId, input.operationId, input.command);
      if (old) {
        // Replays compare stored payloads without re-applying newer input limits to existing rows.
        invariant(
          old.actor === actor && canonical(old.command) === canonical(input.command),
          'WORK_OPERATION_CHANGED',
          'Use the original coordination operation and payload.',
        );
        return old;
      }
      invariant(
        !input.replayOnly,
        'HOSTED_ACTION_UNSUPPORTED',
        'Use ask or hand-back to start a new conversation.',
      );
      const validated = coordinationCommandSchema.safeParse(input.command);
      invariant(validated.success, 'BAD_ARGUMENT', 'Use valid coordination fields and message choices.');
      const parsed = validated.data;
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
        if (parsed.kind === 'message' && parsed.question) fields = await ask(ctx, project, actor, parsed);
        else if (parsed.kind === 'handoff' && parsed.handBack)
          fields = await handBack(ctx, project, actor, parsed, input.holderSessionId);
        else fields = await applyCommand(ctx, project, actor, input.operationId, parsed, at);
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
      if (['activity', 'change', 'claim', 'release'].includes(parsed.kind))
        await wakeJournal(
          ctx,
          { projectId: input.projectId, operationId: input.operationId, phase: 4 },
          Date.now() + 14 * 86_400_000 + 1,
        );
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
    planningItemId: v.optional(v.string()),
  },
  returns: feedResult,
  handler: journalCoordinationFeed,
});

export const recent = query({
  args: { projectId: v.id('hostedProjects'), paginationOpts: paginationOptsValidator },
  returns: v.object({
    ...paginationResultValidator(eventDocument).fields,
    journalHistory: v.optional(v.literal(true)),
    viewVersion: v.optional(v.string()),
  }),
  handler: journalCoordinationRecent,
});

export async function journalCoordinationFeed(
  ctx: QueryCtx,
  {
    projectId,
    paginationOpts,
    intentId,
    laneId,
    planningItemId,
  }: {
    projectId: Id<'hostedProjects'>;
    paginationOpts: PaginationOptions;
    intentId?: string;
    laneId?: string;
    planningItemId?: string;
  },
) {
  try {
    const actor = await signedIn(ctx, 'read project coordination');
    const project = await accessibleProject(ctx, projectId, actor);
    invariant(
      [intentId, laneId, planningItemId].filter(Boolean).length <= 1,
      'BAD_ARGUMENT',
      'Select one Intent, Lane or Item for the feed.',
    );
    const result = await coordinationFeed(
      ctx,
      projectId,
      paginationOpts.cursor,
      paginationOpts.numItems,
      laneId
        ? { field: 'laneId', value: laneId }
        : intentId
          ? { field: 'intentId', value: intentId }
          : planningItemId
            ? { field: 'planningItemId', value: planningItemId }
            : undefined,
    );
    if (!(await canReadConversation(ctx, project, actor, result.page)))
      result.page = result.page.filter(row => !row.conversation);
    return result;
  } catch (error) {
    if (error instanceof JournalNeeded)
      return {
        ...JSON.parse(await journalReadReply(ctx, error, projectId)),
        page: [],
        isDone: false,
        continueCursor: paginationOpts.cursor ?? '',
        cursorReset: false,
      };
    return report(error);
  }
}

export async function journalCoordinationRecent(
  ctx: QueryCtx,
  { projectId, paginationOpts }: { projectId: Id<'hostedProjects'>; paginationOpts: PaginationOptions },
) {
  try {
    const actor = await signedIn(ctx, 'read project coordination');
    const project = await accessibleProject(ctx, projectId, actor);
    const result = await coordinationRecent(ctx, projectId, paginationOpts.cursor, paginationOpts.numItems);
    if (!(await canReadConversation(ctx, project, actor, result.page)))
      result.page = result.page.filter(row => !row.conversation);
    return result;
  } catch (error) {
    if (error instanceof JournalNeeded)
      return {
        ...JSON.parse(await journalReadReply(ctx, error, projectId)),
        page: [],
        isDone: false,
        continueCursor: paginationOpts.cursor ?? '',
      };
    return report(error);
  }
}
