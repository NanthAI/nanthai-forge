// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalAction, internalQuery, internalMutation } from './_generated/server';
import type { Id } from './_generated/dataModel';
import type { Pin } from './r2BackfillRows';
import { backfillKind } from './r2BackfillFields';
import { verifiedPass, maintenanceEnabled } from './r2Maintenance';
import { r2Config, r2Key, headObject, checksumOf } from './r2';
import { deleteR2Object, listR2Prefix, projectPrefix } from './r2Operations';
import { invariant } from '../src/errors';

const ref = (name: string) => makeFunctionReference<'query'>(name);
const mutation = (name: string) => makeFunctionReference<'mutation'>(name);
const result = v.object({
  scanned: v.number(),
  eligible: v.number(),
  deleted: v.number(),
  skipped: v.number(),
  cursor: v.string(),
  isDone: v.boolean(),
  dryRun: v.boolean(),
});
export const purgePage = internalAction({
  args: {
    projectId: v.id('hostedProjects'),
    pass: verifiedPass,
    kind: backfillKind,
    cursor: v.union(v.string(), v.null()),
    dryRun: v.optional(v.boolean()),
  },
  returns: result,
  handler: async (
    ctx,
    { dryRun = true, ...args },
  ): Promise<{
    scanned: number;
    eligible: number;
    deleted: number;
    skipped: number;
    cursor: string;
    isDone: boolean;
    dryRun: boolean;
  }> => {
    if (!dryRun) maintenanceEnabled();
    const page: { pins: Pin[]; scanned: number; cursor: string; isDone: boolean } = await ctx.runQuery(
      ref('projectR2Purge:page'),
      args,
    );
    if (page.pins.length) {
      const config = r2Config();
      // Check the complete page before any deletes. Missing, failed, size/checksum mismatch all refuse.
      const heads = await Promise.all(
        page.pins.map(pin => headObject(config, r2Key(args.projectId, pin.digest))),
      );
      invariant(
        heads.every(
          (head, i) =>
            head.status === 'ok' &&
            head.size === page.pins[i]!.size &&
            head.checksum === checksumOf(page.pins[i]!.digest),
        ),
        'R2_PURGE_HEAD_FAILED',
        'An R2 object could not be verified; no Convex copy in this page was deleted.',
      );
    }
    const counts: { deleted: number; skipped: number } =
      dryRun || !page.pins.length
        ? { deleted: 0, skipped: 0 }
        : await ctx.runMutation(mutation('projectR2Purge:removeCopies'), {
            projectId: args.projectId,
            pass: args.pass,
            pins: page.pins,
          });
    return {
      scanned: page.scanned,
      eligible: page.pins.length,
      ...counts,
      cursor: page.cursor,
      isDone: page.isDone,
      dryRun,
    };
  },
});
export const sweepPage = internalAction({
  args: {
    projectId: v.id('hostedProjects'),
    cursor: v.union(v.string(), v.null()),
    dryRun: v.optional(v.boolean()),
  },
  returns: result,
  handler: async (
    ctx,
    { dryRun = true, ...args },
  ): Promise<{
    scanned: number;
    eligible: number;
    deleted: number;
    skipped: number;
    cursor: string;
    isDone: boolean;
    dryRun: boolean;
  }> => {
    if (!dryRun) maintenanceEnabled();
    const page: { ids: Id<'projectObjects'>[]; scanned: number; cursor: string; isDone: boolean } =
      await ctx.runQuery(ref('projectR2Sweep:page'), args);
    const jobs: { id: Id<'projectObjects'>; key: string }[] = await ctx.runMutation(
      mutation('projectR2Sweep:claim'),
      { projectId: args.projectId, ids: page.ids, dryRun },
    );
    if (!dryRun && jobs.length) {
      const config = r2Config();
      await Promise.all(jobs.map(job => deleteR2Object(config, job.key)));
      await ctx.runMutation(mutation('projectR2Sweep:complete'), { projectId: args.projectId, jobs });
    }
    return {
      scanned: page.scanned,
      eligible: jobs.length,
      deleted: dryRun ? 0 : jobs.length,
      skipped: 0,
      cursor: page.cursor,
      isDone: page.isDone,
      dryRun,
    };
  },
});
export const deletingProject = internalQuery({
  args: { projectId: v.id('hostedProjects') },
  returns: v.boolean(),
  handler: async (ctx, { projectId }) =>
    ['deleting', 'deleted'].includes((await ctx.db.get(projectId))?.removal ?? ''),
});
export const prefixComplete = internalMutation({
  args: { projectId: v.id('hostedProjects') },
  returns: v.null(),
  handler: async (ctx, { projectId }) => {
    const project = await ctx.db.get(projectId);
    if (project?.removal === 'deleting') {
      await ctx.db.patch(projectId, { r2PrefixPurged: true, task: undefined });
      await ctx.scheduler.runAfter(0, makeFunctionReference<'mutation'>('projectLifecycle:purge'), {
        projectId,
      });
    }
    return null;
  },
});
/** Existing explicit permanent project deletion reaches this action only after the lead enables maintenance. */
export const purgeDeletedProjectPage = internalAction({
  args: { projectId: v.id('hostedProjects'), cursor: v.optional(v.union(v.string(), v.null())) },
  returns: v.null(),
  handler: async (ctx, { projectId, cursor = null }): Promise<null> => {
    if (!(await ctx.runQuery(ref('projectR2Maintenance:deletingProject'), { projectId }))) return null;
    const action = makeFunctionReference<'action'>('projectR2Maintenance:purgeDeletedProjectPage');
    try {
      maintenanceEnabled();
      const config = r2Config(),
        page = await listR2Prefix(config, projectPrefix(projectId), cursor);
      await Promise.all(page.keys.map(key => deleteR2Object(config, key)));
      if (!page.isDone) await ctx.scheduler.runAfter(0, action, { projectId, cursor: page.cursor });
      else await ctx.runMutation(mutation('projectR2Maintenance:prefixComplete'), { projectId });
    } catch (error) {
      // Scheduled actions do not retry automatically. Replay this exact page:
      // acknowledged DELETEs are idempotent and completion remains gated on success.
      await ctx.scheduler.runAfter(60_000, action, { projectId, cursor });
      throw error;
    }
    return null;
  },
});
