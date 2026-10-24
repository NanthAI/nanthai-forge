import { hostedPaths } from '../src/hosted-paths';
// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { z } from 'zod';
import { mutation, query, internalMutation, type MutationCtx, type QueryCtx } from './cliServer';
import type { Id } from './_generated/dataModel';
import { activeOwnedProject, accessibleProject } from './projectAuthority';
import { selectedGeneration, record, recordPartition } from './projectWorkIndexStore';
import { acceptanceRequestDocument, ownerMachine } from './ownerAcceptanceFields';
import { acceptanceActor } from './projectAutonomy';
import { channelMoveSchema } from '../src/work-types';
import { invariant } from '../src/errors';
import { report } from './errors';
const scope = { projectId: v.id('hostedProjects') };
export async function owned(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>) {
  const user = await ctx.auth.getUserIdentity();
  invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to accept project work.');
  return { project: await activeOwnedProject(ctx, projectId, user.subject), requester: user.subject };
}
export async function isNativeOwner(ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>) {
  const project = await ctx.db.get(projectId);
  const backup = project?.currentBackup ? await ctx.db.get(project.currentBackup) : null;
  return Boolean(project?.hostingRequest && backup?.preview.format === 'native');
}
const machine = (ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>, ownerId: string) =>
  ctx.db
    .query('ownerAcceptanceMachines')
    .withIndex('by_project_owner', q => q.eq('projectId', projectId).eq('ownerId', ownerId))
    .unique();
export const find = (ctx: QueryCtx | MutationCtx, projectId: Id<'hostedProjects'>, operationId: string) =>
  ctx.db
    .query('ownerAcceptanceRequests')
    .withIndex('by_project_operation', q => q.eq('projectId', projectId).eq('operationId', operationId))
    .unique();
export const request = mutation({
  args: {
    ...scope,
    operationId: v.string(),
    agent: v.optional(v.literal(true)),
    recheck: v.optional(v.literal(true)),
    channel: v.optional(v.string()),
    viewId: v.string(),
    head: v.string(),
    expectedMain: v.union(v.string(), v.null()),
  },
  returns: acceptanceRequestDocument,
  handler: async (ctx, input) => {
    try {
      const { project, requester } = await owned(ctx, input.projectId);
      invariant(
        await isNativeOwner(ctx, input.projectId),
        'BAD_ARGUMENT',
        'This project uses hosted Channel acceptance.',
      );
      const actor = await acceptanceActor(ctx, input.agent),
        channel = input.recheck ? 'recheck' : (input.channel ?? 'main').trim();
      invariant(channel, 'BAD_ARGUMENT', 'Use a Channel name.');
      const old = await find(ctx, input.projectId, input.operationId);
      if (old) {
        invariant(
          old.channel === channel &&
            Boolean(old.recheck) === Boolean(input.recheck) &&
            old.actorKind === actor.kind &&
            old.viewId === input.viewId &&
            old.head === input.head &&
            old.expectedMain === input.expectedMain &&
            old.requester === requester,
          'WORK_OPERATION_CHANGED',
          'Replay the original acceptance request and exact source pins.',
        );
        return old;
      }
      invariant(
        z.uuid().safeParse(input.operationId).success,
        'BAD_ARGUMENT',
        'Use an original operation UUID.',
      );
      const generation = await selectedGeneration(ctx, project);
      invariant(generation, 'WORK_STALE', 'Load current Work before accepting.');
      const row = await record(ctx, recordPartition(generation), 'views', input.viewId);
      const view = row ? JSON.parse(row.value) : null;
      invariant(
        view?.head === input.head && view.status === 'clean',
        'VIEW_STALE',
        'Select the exact retained clean View.',
      );
      const id = await ctx.db.insert('ownerAcceptanceRequests', {
        ...input,
        channel,
        actorKind: actor.kind,
        ownerId: project.key,
        requester,
        createdAt: Date.now(),
        state: 'requested',
        receipt: null,
      });
      return (await ctx.db.get(id))!;
    } catch (error) {
      return report(error);
    }
  },
});
export const status = query({
  args: { ...scope, viewId: v.string(), channel: v.optional(v.string()) },
  returns: v.object({
    native: v.boolean(),
    machine: v.union(ownerMachine, v.null()),
    request: v.union(acceptanceRequestDocument, v.null()),
    mainHead: v.union(v.string(), v.null()),
  }),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read project acceptance.');
      const project = await accessibleProject(ctx, input.projectId, user.subject);
      const requests = await ctx.db
        .query('ownerAcceptanceRequests')
        .withIndex('by_project_view', q =>
          q
            .eq('projectId', input.projectId)
            .eq('viewId', input.viewId)
            .eq('channel', input.channel ?? 'main'),
        )
        .order('desc')
        .take(1);
      const request = requests[0] ?? null;
      const generation = await selectedGeneration(ctx, project);
      const main = generation
        ? await record(ctx, recordPartition(generation), 'channels', input.channel ?? 'main')
        : null;
      const observed = await machine(ctx, input.projectId, project.key);
      return {
        native: await isNativeOwner(ctx, input.projectId),
        machine: observed
          ? {
              ownerId: observed.ownerId,
              name: observed.name,
              lastSeen: observed.lastSeen,
              mainHead: observed.mainHead,
              command: 'nforge host ROOT --listen',
            }
          : null,
        request: hostedPaths(request),
        mainHead:
          ((input.channel ?? 'main') === 'main' ? observed?.mainHead : undefined) ??
          (main ? JSON.parse(main.value).head : null),
      };
    } catch (error) {
      return report(error);
    }
  },
});
export const poll = mutation({
  args: { ...scope, ...ownerMachine.fields },
  returns: v.union(acceptanceRequestDocument, v.null()),
  handler: async (ctx, input) => {
    try {
      const { project } = await owned(ctx, input.projectId);
      invariant(
        project.key === input.ownerId && (await isNativeOwner(ctx, input.projectId)),
        'PROJECT_UNAVAILABLE',
        'Connect this project’s original bound native owner.',
      );
      const { projectId, ...fields } = input;
      const old = await machine(ctx, projectId, input.ownerId);
      const observed = { ...fields, lastSeen: Date.now() };
      if (old) await ctx.db.patch(old._id, observed);
      else await ctx.db.insert('ownerAcceptanceMachines', { projectId, ...observed });
      const requests = await ctx.db
        .query('ownerAcceptanceRequests')
        .withIndex('by_project_state', q => q.eq('projectId', projectId).eq('state', 'requested'))
        .take(1);
      return requests[0] ?? null;
    } catch (error) {
      return report(error);
    }
  },
});
export const complete = mutation({
  args: { ...scope, ownerId: v.string(), operationId: v.string(), receipt: v.string() },
  returns: v.null(),
  handler: async (ctx, input) => {
    try {
      const { project } = await owned(ctx, input.projectId);
      const item = await find(ctx, input.projectId, input.operationId);
      invariant(
        project.key === input.ownerId && item?.ownerId === input.ownerId,
        'PROJECT_UNAVAILABLE',
        'Report to the original owner request.',
      );
      if (item.state !== 'requested') {
        invariant(
          item.receipt === input.receipt,
          'WORK_OPERATION_CHANGED',
          'Replay the original local receipt.',
        );
        return null;
      }
      const result = JSON.parse(input.receipt);
      invariant(
        result.status === 'accepted' || (result.status === 'rejected' && typeof result.reason === 'string'),
        'BAD_ARGUMENT',
        'Report a local acceptance or rejection reason.',
      );
      if (result.status === 'accepted' && item.recheck) {
        invariant(
          result.recheck?.operationId === item.operationId &&
            result.recheck.sourceViewId === item.viewId &&
            result.recheck.sourceHead === item.head &&
            typeof result.recheck.viewId === 'string' &&
            typeof result.recheck.runId === 'string',
          'EVIDENCE_CHANGED',
          'Report the original composed View and queued check receipt.',
        );
      } else if (result.status === 'accepted' && item.lifecycle) {
        invariant(
          result.lifecycle?.operationId === item.operationId &&
            result.lifecycle?.targetId === item.viewId &&
            result.command === item.lifecycle,
          'EVIDENCE_CHANGED',
          'Report the original lifecycle receipt.',
        );
      } else if (result.status === 'accepted') {
        const move = channelMoveSchema.parse(result.acceptance);
        invariant(
          move.id === item.operationId &&
            move.ownerRequest?.viewId === item.viewId &&
            move.ownerRequest.head === item.head &&
            move.ownerRequest.expectedMain === item.expectedMain &&
            move.channel === item.channel &&
            move.status === 'accepted',
          'EVIDENCE_CHANGED',
          'Report the exact requested local acceptance.',
        );
        const generation = await selectedGeneration(ctx, project);
        const main = generation ? await record(ctx, recordPartition(generation), 'channels', 'main') : null;
        const observed = await machine(ctx, input.projectId, input.ownerId);
        if (observed && item.channel === 'main')
          await ctx.db.patch(observed._id, {
            mainHead: main ? JSON.parse(main.value).head : move.head,
            lastSeen: Date.now(),
          });
      }
      await ctx.db.patch(item._id, { state: result.status, receipt: input.receipt });
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
/** Legacy acceptChannel callers route here rather than creating hosted moves. */
export const route = internalMutation({
  args: { ...scope, operationId: v.string(), channel: v.string(), viewId: v.string(), head: v.string() },
  returns: v.union(v.object({ expectedMain: v.union(v.string(), v.null()) }), v.null()),
  handler: async (ctx, input) => {
    const { project } = await owned(ctx, input.projectId);
    if (!(await isNativeOwner(ctx, input.projectId))) return null;
    const existing = await find(ctx, input.projectId, input.operationId);
    if (existing) return { expectedMain: existing.expectedMain };
    const generation = await selectedGeneration(ctx, project);
    const main = generation
      ? await record(ctx, recordPartition(generation), 'channels', input.channel)
      : null;
    const observed = await machine(ctx, input.projectId, project.key);
    return {
      expectedMain:
        (input.channel === 'main' ? observed?.mainHead : undefined) ??
        (main ? JSON.parse(main.value).head : null),
    };
  },
});
