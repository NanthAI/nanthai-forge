// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { v } from 'convex/values';
import { internal } from './_generated/api';
import type { Id } from './_generated/dataModel';
import { internalAction, internalMutation, type ActionCtx } from './server';
import { accountAction } from './cliServer';
import { activeOwnedProject } from './projectAuthority';
import { requireOwnerPerson } from './ownerPerson';
import { record, recordPartition, selectedGeneration } from './projectWorkIndexStore';
import { isPlanningUuid } from '../src/planning-id';
import { invariant } from '../src/errors';
import { report } from './errors';
import { itemRetentionOperation, itemRetentionRetryAt, itemRetentionRow } from './projectItemRetentionStore';

const sweepLimit = 10;
const target = {
  projectId: v.id('hostedProjects'),
  itemId: v.string(),
  version: v.number(),
};

export const sweep = internalMutation({
  args: {},
  returns: v.number(),
  handler: async ctx => {
    const now = Date.now();
    const due = await ctx.db
      .query('projectItemRetention')
      .withIndex('by_attempt_at', q => q.gte('attemptAt', 0).lte('attemptAt', now))
      .take(sweepLimit);
    for (const row of due) {
      const attempts = (row.attempts ?? 0) + 1;
      await ctx.db.patch(row._id, { attemptAt: itemRetentionRetryAt(now, attempts), attempts });
      await ctx.scheduler.runAfter(0, internal.projectItemRetention.expire, {
        projectId: row.projectId,
        itemId: row.itemId,
        version: row.version!,
      });
    }
    return due.length;
  },
});

export const settle = internalMutation({
  args: { ...target, purgedAt: v.number() },
  returns: v.null(),
  handler: async (ctx, { projectId, itemId, version, purgedAt }) => {
    const row = await itemRetentionRow(ctx, projectId, itemId);
    if (row?.version === version && row.purgedAt === undefined)
      await ctx.db.patch(row._id, { purgedAt, attempts: undefined, attemptAt: undefined });
    return null;
  },
});

async function purge(
  ctx: ActionCtx,
  input: { projectId: Id<'hostedProjects'>; itemId: string; version: number },
): Promise<number | null> {
  const { projectId, itemId, version } = input;
  const entry = await ctx.runAction(internal.projectPlanningPurge.run, {
    projectId,
    itemId,
    operationId: itemRetentionOperation(projectId, itemId, version),
    expectedVersion: version,
  });
  const purgedAt: number | null = entry?.purgedAt ?? null;
  if (purgedAt !== null) await ctx.runMutation(internal.projectItemRetention.settle, { ...input, purgedAt });
  return purgedAt;
}

export const expire = internalAction({
  args: target,
  returns: v.union(v.number(), v.null()),
  handler: purge,
});

/** Checks the current person and Item before the first irreversible step. A confirmed attempt that fails can
 * resume through the sweep, even if the first step already hid the Item behind its tombstone. */
export const prepare = internalMutation({
  args: target,
  returns: v.union(v.number(), v.null()),
  handler: async (ctx, { projectId, itemId, version }) => {
    try {
      const user = await requireOwnerPerson(ctx, 'delete an Item forever');
      const project = await activeOwnedProject(ctx, projectId, user.subject);
      const row = await itemRetentionRow(ctx, projectId, itemId);
      if (row?.version === version && row.purgedAt !== undefined) return row.purgedAt;

      const generation = await selectedGeneration(ctx, project);
      invariant(generation, 'PROJECT_WORK_INDEX_MISSING', 'The Work index is unavailable.');
      const root = await record(ctx, recordPartition(generation), 'planningItems', itemId);
      const item = root ? JSON.parse(root.value) : null;
      const operationId = itemRetentionOperation(projectId, itemId, version);
      if (item?.purged?.operationId === operationId) return null;
      invariant(item?.status === 'deleted' && !item.purged, 'BAD_ARGUMENT', 'Select a Deleted Item.');
      invariant(item.version === version, 'ITEM_CHANGED', 'The Item changed. Read it again before deleting.');
      const attemptAt = itemRetentionRetryAt(Date.now(), 0);
      if (row) await ctx.db.patch(row._id, { attemptAt: Math.min(row.attemptAt ?? attemptAt, attemptAt) });
      else
        await ctx.db.insert('projectItemRetention', {
          projectId,
          itemId,
          kind: 'attempt',
          version,
          attemptAt,
        });
      return null;
    } catch (error) {
      return report(error);
    }
  },
});

export const deleteForever = accountAction('person')({
  args: { ...target, confirmation: v.string() },
  returns: v.number(),
  handler: async (ctx, { confirmation, ...input }): Promise<number> => {
    try {
      invariant(
        isPlanningUuid(input.itemId) &&
          Number.isSafeInteger(input.version) &&
          input.version > 0 &&
          confirmation === 'DELETE',
        'BAD_ARGUMENT',
        'Type DELETE to confirm permanent deletion of this Item.',
      );
      const completedAt = await ctx.runMutation(internal.projectItemRetention.prepare, input);
      if (completedAt !== null) return completedAt;
      const purgedAt = await purge(ctx, input);
      invariant(purgedAt !== null, 'WORK_STALE', 'Permanent deletion is still in progress. Retry this Item.');
      return purgedAt;
    } catch (error) {
      return report(error);
    }
  },
});
