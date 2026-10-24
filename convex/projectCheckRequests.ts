// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { z } from 'zod';
import { paginationOptsValidator, paginationResultValidator } from 'convex/server';
import { mutation, query } from './cliServer';
import { authority, ownedRunner, selectedRequest, editableRequest } from './projectCheckAuthority';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { runnerDocument, requestDocument, requestPins, checkReport } from './projectCheckFields';
import { invariant } from '../src/errors';
import { report } from './errors';

const scope = { projectId: v.id('hostedProjects') },
  runnerScope = { ...scope, runnerId: v.string() },
  requestScope = { ...scope, operationId: v.string() };

export const connect = mutation({
  args: { ...runnerScope, name: v.string(), listening: v.boolean() },
  returns: runnerDocument,
  handler: async (ctx, input) => {
    try {
      const { actor } = await authority(ctx, input.projectId, true);
      invariant(input.runnerId.trim() && input.name.trim(), 'BAD_ARGUMENT', 'Use a named local runner.');
      const old = await ctx.db
        .query('projectCheckRunners')
        .withIndex('by_project_and_runner', q =>
          q.eq('projectId', input.projectId).eq('runnerId', input.runnerId),
        )
        .unique();
      invariant(
        !old || old.actor === actor,
        'PROJECT_UNAVAILABLE',
        'This runner belongs to another account.',
      );
      const value = { ...input, name: input.name.trim(), actor, lastSeen: Date.now() };
      if (old) {
        await ctx.db.patch(old._id, value);
        return (await ctx.db.get(old._id))!;
      }
      return (await ctx.db.get(await ctx.db.insert('projectCheckRunners', value)))!;
    } catch (error) {
      return report(error);
    }
  },
});
export const runners = query({
  args: { ...scope, paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(runnerDocument),
  handler: async (ctx, input) => {
    try {
      await authority(ctx, input.projectId);
      return await ctx.db
        .query('projectCheckRunners')
        .withIndex('by_project', q => q.eq('projectId', input.projectId))
        .paginate(input.paginationOpts);
    } catch (error) {
      return report(error);
    }
  },
});
export const list = query({
  args: { ...scope, viewId: v.string(), paginationOpts: paginationOptsValidator },
  returns: paginationResultValidator(requestDocument),
  handler: async (ctx, input) => {
    try {
      await authority(ctx, input.projectId);
      return await ctx.db
        .query('projectCheckRequests')
        .withIndex('by_project_and_view', q => q.eq('projectId', input.projectId).eq('viewId', input.viewId))
        .order('desc')
        .paginate(input.paginationOpts);
    } catch (error) {
      return report(error);
    }
  },
});
export const request = mutation({
  args: { ...scope, ...requestPins },
  returns: requestDocument,
  handler: async (ctx, input) => {
    try {
      const { actor, project } = await authority(ctx, input.projectId, true),
        runner = await ownedRunner(ctx, input.projectId, input.runnerId),
        old = await selectedRequest(ctx, input.projectId, input.operationId);
      if (old) {
        invariant(
          old.actor === actor &&
            Object.keys(requestPins).every(
              key => old[key as keyof typeof requestPins] === input[key as keyof typeof requestPins],
            ),
          'WORK_OPERATION_CHANGED',
          'Reconcile the original check request and source pins.',
        );
        return old;
      }
      invariant(
        z.uuid().safeParse(input.operationId).success,
        'BAD_ARGUMENT',
        'Retain an original check operation UUID.',
      );
      const generation = await selectedGeneration(ctx, project);
      invariant(generation, 'WORK_STALE', 'Load the current project source before requesting a check.');
      const partition = recordPartition(generation),
        viewRow = await record(ctx, partition, 'views', input.viewId),
        checkRow = await record(ctx, partition, 'checks', input.checkId);
      const view = viewRow ? JSON.parse(viewRow.value) : null,
        check = checkRow ? JSON.parse(checkRow.value) : null;
      invariant(
        view?.status === 'clean' && view.head === input.head && check?.definition === input.definition,
        'EVIDENCE_CHANGED',
        'This View or check changed. Select its current source and definition.',
      );
      const now = Date.now();
      const id = await ctx.db.insert('projectCheckRequests', {
        ...input,
        actor,
        intentId: view.intentId,
        checkName: check.name,
        runnerName: runner.name,
        state: 'queued',
        cancelRequested: false,
        createdAt: now,
        updatedAt: now,
        report: null,
      });
      return (await ctx.db.get(id))!;
    } catch (error) {
      return report(error);
    }
  },
});
export const next = query({
  args: runnerScope,
  returns: v.union(requestDocument, v.null()),
  handler: async (ctx, input) => {
    try {
      const runner = await ownedRunner(ctx, input.projectId, input.runnerId);
      for (const state of ['claimed', 'queued'] as const) {
        const rows = await ctx.db
          .query('projectCheckRequests')
          .withIndex('by_project_and_runner_and_state_and_actor', q =>
            q
              .eq('projectId', input.projectId)
              .eq('runnerId', input.runnerId)
              .eq('state', state)
              .eq('actor', runner.actor),
          )
          .take(1);
        if (rows[0]) return rows[0];
      }
      return null;
    } catch (error) {
      return report(error);
    }
  },
});
export const claim = mutation({
  args: { ...runnerScope, operationId: v.string() },
  returns: requestDocument,
  handler: async (ctx, input) => {
    try {
      const runner = await ownedRunner(ctx, input.projectId, input.runnerId);
      const item = await selectedRequest(ctx, input.projectId, input.operationId);
      invariant(
        item?.runnerId === input.runnerId,
        'NOT_FOUND',
        'Select this runner’s original check request.',
      );
      invariant(
        item.actor === runner.actor,
        'PROJECT_UNAVAILABLE',
        'Only checks queued by the runner owner can execute on this computer.',
      );
      if (item.state === 'queued') await ctx.db.patch(item._id, { state: 'claimed', updatedAt: Date.now() });
      return (await ctx.db.get(item._id))!;
    } catch (error) {
      return report(error);
    }
  },
});
export const observe = query({
  args: { ...runnerScope, operationId: v.string() },
  returns: requestDocument,
  handler: async (ctx, input) => {
    try {
      await ownedRunner(ctx, input.projectId, input.runnerId);
      const item = await selectedRequest(ctx, input.projectId, input.operationId);
      invariant(
        item?.runnerId === input.runnerId,
        'NOT_FOUND',
        'Select this runner’s original check request.',
      );
      return item;
    } catch (error) {
      return report(error);
    }
  },
});
export const update = mutation({
  args: { ...runnerScope, operationId: v.string(), report: checkReport },
  returns: requestDocument,
  handler: async (ctx, input) => {
    try {
      const item = await editableRequest(ctx, input.projectId, input.operationId);
      invariant(
        item.runnerId === input.runnerId && item.state !== 'queued',
        'NOT_FOUND',
        'Claim this runner’s original request first.',
      );
      const running = ['queued', 'preparing', 'running'].includes(input.report.status);
      if (item.state === 'finished') {
        invariant(
          running ||
            Object.keys(checkReport.fields).every(
              key =>
                item.report?.[key as keyof typeof checkReport.fields] ===
                input.report[key as keyof typeof checkReport.fields],
            ),
          'WORK_OPERATION_CHANGED',
          'The original terminal result is retained.',
        );
        return item;
      }
      invariant(
        input.report.runId === input.operationId ||
          (input.report.runId === null && ['error', 'cancelled'].includes(input.report.status)),
        'EVIDENCE_CHANGED',
        'Report the original local run identity.',
      );
      await ctx.db.patch(item._id, {
        state: running ? 'claimed' : 'finished',
        report: input.report,
        updatedAt: Date.now(),
      });
      return (await ctx.db.get(item._id))!;
    } catch (error) {
      return report(error);
    }
  },
});
export const cancel = mutation({
  args: requestScope,
  returns: requestDocument,
  handler: async (ctx, input) => {
    try {
      const item = await editableRequest(ctx, input.projectId, input.operationId);
      if (item.state !== 'finished' && !item.cancelRequested)
        await ctx.db.patch(item._id, {
          cancelRequested: true,
          updatedAt: Date.now(),
          ...(item.state === 'queued'
            ? {
                state: 'finished' as const,
                report: {
                  status: 'cancelled' as const,
                  runId: null,
                  environmentFingerprint: null,
                  startedAt: null,
                  endedAt: new Date().toISOString(),
                  exitCode: null,
                  message: 'Cancelled before execution.',
                },
              }
            : {}),
        });
      return (await ctx.db.get(item._id))!;
    } catch (error) {
      return report(error);
    }
  },
});
