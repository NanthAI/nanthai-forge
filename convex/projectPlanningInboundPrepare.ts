// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { internalMutation } from './server';
import { accessibleProject } from './projectAuthority';
import { recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { changePlanningInbound, planningInbound } from './projectPlanningInboundStore';
import { invariant } from '../src/errors';

/** Prepare a fresh epoch in the selected partition. Writes maintain it from
 * the start fence, but readers only select it after the full root pass. */
export const page = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    owner: v.string(),
    partition: v.id('projectWorkGenerations'),
    operationId: v.string(),
    after: v.union(v.string(), v.null()),
    rebuild: v.optional(v.string()),
  },
  returns: v.object({ after: v.union(v.string(), v.null()), processed: v.number(), complete: v.boolean() }),
  handler: async (ctx, { projectId, owner, partition, operationId, after, rebuild }) => {
    const project = await accessibleProject(ctx, projectId, owner);
    invariant(project.owner === owner, 'PROJECT_UNAVAILABLE', 'Only the owner prepares related work.');
    invariant(
      /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(operationId),
      'BAD_ARGUMENT',
      'Use an original operation UUID.',
    );
    const generation = await selectedGeneration(ctx, project);
    invariant(
      generation && recordPartition(generation) === partition,
      'WORK_STALE',
      'Select the current Work partition.',
    );
    const scope = generation._id === partition ? generation : await ctx.db.get(partition);
    invariant(scope?.projectId === projectId, 'WORK_STALE', 'Select the current Work partition.');
    const active = scope.planningInboundPreparation;
    if (!active) {
      const retired = scope.planningInboundVersion;
      if (retired === operationId || (retired !== undefined && rebuild === undefined))
        return { after: null, processed: 0, complete: true };
      invariant(rebuild === retired, 'WORK_STALE', 'Pin the current Related coverage when rebuilding.');
      invariant(after === null, 'WORK_STALE', 'Start preparation with no cursor.');
      await ctx.db.patch(partition, {
        planningInboundVersion: undefined,
        planningInboundPreparation: {
          id: operationId,
          phase: 'paused',
          after: 'roots:',
          previous: null,
          ...(retired === undefined ? {} : { retired }),
        },
      });
      return { after: 'roots:', processed: 0, complete: false };
    }
    if (active.id === operationId && after === active.previous)
      return { after: active.after, processed: 0, complete: false };
    invariant(
      active.id === operationId && after === active.after,
      'WORK_STALE',
      'Use the original preparation operation and its returned position.',
    );
    if (active.phase === 'retire') {
      invariant(active.retired !== undefined, 'WORK_STALE', 'The retiring Related coverage is unavailable.');
      const retired = active.retired;
      const rows = await ctx.db
        .query('projectWorkDataRecords')
        .withIndex('by_generation_and_collection_and_key', q =>
          q.eq('generationId', partition).eq('collection', planningInbound(retired)),
        )
        .take(101);
      for (const row of rows.slice(0, 100)) await ctx.db.delete(row._id);
      const next = rows.length > 100 ? `retire:${rows[99]!.key}` : null;
      await ctx.db.patch(partition, {
        planningInboundPreparation: next === null ? undefined : { ...active, after: next, previous: after },
      });
      return { after: next, processed: Math.min(rows.length, 100), complete: next === null };
    }
    const from = after.slice('roots:'.length);
    const batch = await ctx.db
      .query('projectPlanningRecords')
      .withIndex('by_generation_and_collection_and_key', q => {
        const roots = q.eq('generationId', partition).eq('collection', 'planningSearch');
        return from ? roots.gt('key', from) : roots;
      })
      .paginate({ cursor: null, numItems: 20, maximumRowsRead: 20, maximumBytesRead: 512 * 1024 });
    for (const root of batch.page) await changePlanningInbound(ctx.db, null, root, async () => operationId);
    const last = batch.page.at(-1)?.key;
    let next: string | null;
    if (batch.isDone) {
      next = active.retired === undefined ? null : 'retire:';
      await ctx.db.patch(partition, {
        planningInboundVersion: operationId,
        planningInboundPreparation:
          next === null ? undefined : { ...active, phase: 'retire', after: next, previous: after },
      });
    } else {
      invariant(last !== undefined, 'WORK_STALE', 'Related work preparation did not advance.');
      next = `roots:${last}`;
      await ctx.db.patch(partition, {
        planningInboundPreparation: { ...active, phase: 'roots', after: next, previous: after },
      });
    }
    return { after: next, processed: batch.page.length, complete: next === null };
  },
});
