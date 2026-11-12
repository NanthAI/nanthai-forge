// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalMutation, internalQuery, type MutationCtx } from './server';
import type { Doc, Id } from './_generated/dataModel';
import { projectPurgeOrder, type ProjectPurgeTable } from './projectPurgeInventory';
import { putExpiry } from './r2';
import { projectRows } from './projectPurgeRows';
import { projectExecution } from './projectExecution';
import { invariant } from '../src/errors';

/** Owner decision 2026-11-05: deleted projects stay restorable for 90 days (GitHub parity). */
export const projectRetentionMs = 90 * 24 * 60 * 60 * 1000;
/** Signed R2 PUTs issued before deletion can finish for `putExpiry` seconds; the purge
 * keeps their receipts that long before it removes rows and lists the R2 prefix. */
export const purgeSettleMs = (putExpiry + 300) * 1000;
/** Grants and runner registrations revoked at deletion; restore never brings them back. */
export const revokedTables = [
  'projectReaders',
  'projectContributors',
  'projectInvites',
  'projectHostedDecisionMaintainers',
  'projectCheckRunners',
  'projectHostedCheckWorkers',
] as const satisfies readonly ProjectPurgeTable[];
const revokePageRows = 100;
const measurePageRows = 1000;
const fn = (name: string) => makeFunctionReference<'mutation'>(`projectRetention:${name}`);

async function stopTask(ctx: MutationCtx, id: Id<'_scheduled_functions'> | undefined) {
  if (!id) return;
  const task = await ctx.db.system.get(id);
  if (task?.state.kind === 'pending') await ctx.scheduler.cancel(id);
}
/** Cancel a project's expiry and measurement before restore or permanent deletion. */
export async function stopRetention(ctx: MutationCtx, project: Doc<'hostedProjects'>) {
  await stopTask(ctx, project.retention?.task);
  await stopTask(ctx, project.retention?.measure?.task);
}
/** One page of grant/runner removals per table; true when none remain. */
async function revokePage(ctx: MutationCtx, projectId: Id<'hostedProjects'>) {
  let done = true;
  for (const table of revokedTables) {
    const rows = await projectRows(ctx, table, projectId, revokePageRows);
    for (const row of rows) await ctx.db.delete(row._id as never);
    if (rows.length === revokePageRows) done = false;
  }
  return done;
}
/** Tombstone bookkeeping for a just-deleted project: revoke access now, schedule the one
 * expiry at the end of the window, and start a bounded retained-size measurement. */
export async function startRetention(ctx: MutationCtx, projectId: Id<'hostedProjects'>) {
  const project = (await ctx.db.get(projectId))!;
  await stopRetention(ctx, project);
  const removedAt = project.removedAt ?? Date.now(),
    purgeAt = removedAt + projectRetentionMs;
  const task = await ctx.scheduler.runAt(purgeAt, fn('expire'), { projectId, removedAt });
  const revoking = !(await revokePage(ctx, projectId));
  if (revoking) await ctx.scheduler.runAfter(0, fn('revoke'), { projectId });
  const measure = await ctx.scheduler.runAfter(0, fn('measure'), { projectId });
  await ctx.db.patch(projectId, {
    retention: {
      purgeAt,
      task,
      ...(revoking ? { revoking } : {}),
      measure: { stage: 0, cursor: null, task: measure },
      retainedBytes: 0,
      retainedObjects: 0,
      measured: false,
    },
  });
}
export const revoke = internalMutation({
  args: { projectId: v.id('hostedProjects') },
  returns: v.null(),
  handler: async (ctx, { projectId }) => {
    const project = await ctx.db.get(projectId);
    projectExecution(ctx, projectId, project?.name, project?.key);
    if (project?.removal !== 'trash' || !project.retention?.revoking) return null;
    if (await revokePage(ctx, projectId))
      await ctx.db.patch(projectId, { retention: { ...project.retention, revoking: undefined } });
    else await ctx.scheduler.runAfter(0, fn('revoke'), { projectId });
    return null;
  },
});
const measured = ['projectObjects', 'projectBackups', 'projectProposals'] as const;
/** Retained size: live object, backup and proposal bytes, one 1,000-row page per call. */
export const measure = internalMutation({
  args: { projectId: v.id('hostedProjects') },
  returns: v.null(),
  handler: async (ctx, { projectId }) => {
    const project = await ctx.db.get(projectId);
    projectExecution(ctx, projectId, project?.name, project?.key);
    const retention = project?.retention;
    if (project?.removal !== 'trash' || !retention?.measure) return null;
    const { stage, cursor } = retention.measure,
      table = measured[stage]!;
    const page =
      table === 'projectObjects'
        ? await ctx.db
            .query('projectObjects')
            .withIndex('by_project_and_removed', q => q.eq('projectId', projectId).eq('removed', false))
            .paginate({ cursor, numItems: measurePageRows })
        : await ctx.db
            .query(table === 'projectBackups' ? 'projectBackups' : 'projectProposals')
            .withIndex('by_project', q => q.eq('projectId', projectId))
            .paginate({ cursor, numItems: measurePageRows });
    const next = page.isDone ? stage + 1 : stage,
      done = next >= measured.length;
    const task = done ? undefined : await ctx.scheduler.runAfter(0, fn('measure'), { projectId });
    await ctx.db.patch(projectId, {
      retention: {
        ...retention,
        retainedBytes:
          retention.retainedBytes +
          page.page.reduce((n, row) => n + ((row as { size?: number }).size ?? 0), 0),
        retainedObjects: retention.retainedObjects + page.page.length,
        measured: done,
        measure: task ? { stage: next, cursor: page.isDone ? null : page.continueCursor, task } : undefined,
      },
    });
    return null;
  },
});
/** The single scheduled end of a deletion window: start the permanent purge. */
export const expire = internalMutation({
  args: { projectId: v.id('hostedProjects'), removedAt: v.number() },
  returns: v.null(),
  handler: async (ctx, { projectId, removedAt }) => {
    const project = await ctx.db.get(projectId);
    projectExecution(ctx, projectId, project?.name, project?.key);
    if (
      project?.removal !== 'trash' ||
      project.removedAt !== removedAt ||
      !project.retention ||
      Date.now() < project.retention.purgeAt
    )
      return null;
    await stopTask(ctx, project.retention.measure?.task);
    const task = await ctx.scheduler.runAfter(
      0,
      makeFunctionReference<'mutation'>('projectLifecycle:purge'),
      { projectId },
    );
    await ctx.db.patch(projectId, {
      removal: 'deleting',
      revision: project.revision + 1,
      retention: undefined,
      task,
      purge: {
        operationId: `retention:${projectId}:${removedAt}`,
        reason: 'retention',
        startedAt: Date.now(),
        rows: 0,
        bytes: 0,
        pages: 0,
      },
    });
    return null;
  },
});
/** Owner-only re-arm for projects deleted before the window existed. Bounded page; the lead runs it. */
export const armLegacyTrash = internalMutation({
  args: { owner: v.string(), cursor: v.union(v.string(), v.null()) },
  returns: v.object({ armed: v.number(), cursor: v.string(), isDone: v.boolean() }),
  handler: async (ctx, { owner, cursor }) => {
    const page = await ctx.db
      .query('hostedProjects')
      .withIndex('by_owner', q => q.eq('owner', owner))
      .paginate({ cursor, numItems: 50 });
    let armed = 0;
    for (const project of page.page)
      if (project.removal === 'trash' && !project.retention) {
        await startRetention(ctx, project._id);
        armed++;
      }
    return { armed, cursor: page.continueCursor, isDone: page.isDone };
  },
});
/** Lead-only, slug-confirmed purge of a pre-inventory tombstone (`deleted` with no purge
 * receipt). Older purges left project rows and R2 objects behind; this re-enters the
 * inventory-guarded purge as an owner-confirmed delete, which also grants its R2 prefix. */
export const repurgeLegacyTombstone = internalMutation({
  args: { projectId: v.id('hostedProjects'), operationId: v.string(), confirm: v.string() },
  returns: v.null(),
  handler: async (ctx, { projectId, operationId, confirm }) => {
    const project = await ctx.db.get(projectId);
    projectExecution(ctx, projectId, project?.name, project?.key);
    if (project?.purge?.operationId === operationId) return null;
    invariant(
      project?.removal === 'deleted' && !project.purge && !project.retention,
      'PROJECT_UNAVAILABLE',
      'Only a legacy tombstone without a purge receipt can be re-purged.',
    );
    invariant(
      operationId.trim() && !!project.slug && confirm.trim() === project.slug,
      'BAD_ARGUMENT',
      'Type the tombstone slug to confirm its permanent purge.',
    );
    await ctx.db.patch(projectId, {
      removal: 'deleting',
      removedAt: project.removedAt ?? Date.now(),
      revision: project.revision + 1,
      lifecycle: { operationId, action: 'delete', expectedRevision: project.revision },
      purge: { operationId, reason: 'owner', startedAt: Date.now(), rows: 0, bytes: 0, pages: 0 },
      r2PrefixPurged: undefined,
      r2Purge: undefined,
      purgeBlocked: undefined,
      task: await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectLifecycle:purge'), {
        projectId,
      }),
    });
    return null;
  },
});
/** Read-only purge proof: the inventory tables (and archive namespace) where a project
 * still owns a row. One indexed single-row read per table; no scans. */
export const residue = internalQuery({
  args: { projectId: v.id('hostedProjects') },
  returns: v.array(v.string()),
  handler: async (ctx, { projectId }) => {
    const left: string[] = [];
    for (const table of projectPurgeOrder)
      if ((await projectRows(ctx as unknown as MutationCtx, table, projectId, 1)).length) left.push(table);
    const blob = await ctx.db
      .query('artifactBlobs')
      .withIndex('by_namespace_and_digest', q =>
        q.gte('namespace', `v1/p/${projectId}/`).lt('namespace', `v1/p/${projectId}0`),
      )
      .take(1);
    if (blob.length) left.push('artifactBlobs');
    return left;
  },
});
