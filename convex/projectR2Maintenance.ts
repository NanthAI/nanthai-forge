import { projectExecution } from './projectExecution';
// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalMutation, internalAction, internalQuery, type MutationCtx } from './server';
import type { Doc, Id } from './_generated/dataModel';
import type { Pin } from './r2BackfillRows';
import { backfillKind } from './r2BackfillFields';
import { verifiedPass, maintenanceEnabled } from './r2Maintenance';
import { r2Config, r2Key, headObject, checksumOf } from './r2';
import { deleteR2Object, listR2Prefix, projectPrefix } from './r2Operations';
import { ForgeError, invariant } from '../src/errors';
import { scheduleR2Purge } from './projectPurgeScheduling';
import { authorizedKeys, purgeAuthority, type PurgeAuthority } from './projectPurgeAuthority';

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
const authority = v.object({ prefix: v.string(), operationId: v.string() });
/** A fenced delivery for a deleting project, with its scoped R2 grant (or none). */
export const deletingProject = internalQuery({
  args: { projectId: v.id('hostedProjects'), generation: v.optional(v.number()) },
  returns: v.union(v.null(), v.object({ authority: v.union(v.null(), authority) })),
  handler: async (ctx, { projectId, generation }) => {
    const project = await ctx.db.get(projectId);
    projectExecution(ctx, projectId, project?.name, project?.key);
    return project?.removal === 'deleting' &&
      !project.r2PrefixPurged &&
      !project.purgeBlocked &&
      (generation === undefined || project.r2Purge?.generation === generation)
      ? { authority: purgeAuthority(project) }
      : null;
  },
});
const progress = { operationId: v.string(), objects: v.number(), bytes: v.number() };
/** Count one deleted page into the purge receipt; a changed grant blocks instead. */
async function counted(
  ctx: MutationCtx,
  project: Doc<'hostedProjects'>,
  page: { operationId: string; objects: number; bytes: number },
) {
  if (purgeAuthority(project)?.operationId !== page.operationId) {
    await ctx.db.patch(project._id, { task: undefined, purgeBlocked: 'R2_PURGE_UNAUTHORIZED' });
    return false;
  }
  const purge = project.purge!;
  await ctx.db.patch(project._id, {
    purge: {
      ...purge,
      r2Objects: (purge.r2Objects ?? 0) + page.objects,
      r2Bytes: (purge.r2Bytes ?? 0) + page.bytes,
    },
  });
  return true;
}
export const prefixComplete = internalMutation({
  args: { projectId: v.id('hostedProjects'), generation: v.number(), ...progress },
  returns: v.null(),
  handler: async (ctx, { projectId, generation, ...page }) => {
    const project = await ctx.db.get(projectId);
    projectExecution(ctx, projectId, project?.name, project?.key);
    if (
      project?.removal === 'deleting' &&
      project.r2Purge?.generation === generation &&
      !project.r2PrefixPurged &&
      !project.purgeBlocked &&
      (await counted(ctx, project, page))
    ) {
      const task = await ctx.scheduler.runAfter(0, mutation('projectLifecycle:purge'), { projectId });
      await ctx.db.patch(projectId, { r2PrefixPurged: true, task });
    }
    return null;
  },
});
/** A finite retry budget per page; an explicit owner retry resumes the saved cursor. */
export const pageResult = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    generation: v.number(),
    outcome: v.union(v.literal('page'), v.literal('unauthorized'), v.literal('failed')),
    cursor: v.optional(v.union(v.string(), v.null())),
    page: v.optional(v.object(progress)),
  },
  returns: v.null(),
  handler: async (ctx, { projectId, generation, outcome, cursor, page }) => {
    const project = await ctx.db.get(projectId);
    projectExecution(ctx, projectId, project?.name, project?.key);
    if (
      project?.removal !== 'deleting' ||
      project.r2PrefixPurged ||
      project.purgeBlocked ||
      project.r2Purge?.generation !== generation
    )
      return null;
    if (outcome === 'page') {
      if (page && (await counted(ctx, project, page)))
        await scheduleR2Purge(ctx, (await ctx.db.get(projectId))!, cursor ?? null);
      else if (!page)
        await ctx.db.patch(projectId, { task: undefined, purgeBlocked: 'R2_PURGE_UNAUTHORIZED' });
    } else {
      const failures = project.r2Purge.failures + 1;
      if (outcome === 'unauthorized' || failures >= 8)
        await ctx.db.patch(projectId, {
          task: undefined,
          purgeBlocked: outcome === 'unauthorized' ? 'R2_PURGE_UNAUTHORIZED' : 'R2_PURGE_RETRY_EXHAUSTED',
          r2Purge: { ...project.r2Purge, failures },
        });
      else
        await scheduleR2Purge(
          ctx,
          project,
          project.r2Purge.cursor,
          failures,
          Math.min(60_000 * 2 ** (failures - 1), 15 * 60_000),
        );
    }
    return null;
  },
});
/** One prefix page per delivery: 1 query, 1 LIST, <= 100 DELETEs, 1 mutation. Deletes need the
 * project's own scoped purge grant (projectPurgeAuthority), never the global maintenance flag.
 * Legacy unfenced deliveries stop; an owner retry starts or resumes the tracked chain. */
export const purgeDeletedProjectPage = internalAction({
  args: {
    projectId: v.id('hostedProjects'),
    cursor: v.optional(v.union(v.string(), v.null())),
    generation: v.optional(v.number()),
  },
  returns: v.null(),
  handler: async (ctx, { projectId, generation, cursor = null }): Promise<null> => {
    if (generation === undefined) return null;
    const state: { authority: PurgeAuthority | null } | null = await ctx.runQuery(
      ref('projectR2Maintenance:deletingProject'),
      { projectId, generation },
    );
    if (!state) return null;
    try {
      const grant = state.authority;
      invariant(grant, 'R2_PURGE_UNAUTHORIZED', 'This project has no confirmed or expired purge.');
      const config = r2Config(),
        page = await listR2Prefix(config, grant.prefix, cursor);
      await Promise.all(authorizedKeys(grant, projectId, page.keys).map(key => deleteR2Object(config, key)));
      const done = { operationId: grant.operationId, objects: page.keys.length, bytes: page.bytes };
      if (!page.isDone)
        await ctx.runMutation(mutation('projectR2Maintenance:pageResult'), {
          projectId,
          generation,
          outcome: 'page',
          cursor: page.cursor,
          page: done,
        });
      else
        await ctx.runMutation(mutation('projectR2Maintenance:prefixComplete'), {
          projectId,
          generation,
          ...done,
        });
    } catch (error) {
      const unauthorized = error instanceof ForgeError && error.code === 'R2_PURGE_UNAUTHORIZED';
      // Keep the failed page until every DELETE succeeds; replays are idempotent.
      await ctx.runMutation(mutation('projectR2Maintenance:pageResult'), {
        projectId,
        generation,
        outcome: unauthorized ? 'unauthorized' : 'failed',
      });
      if (!unauthorized) throw error;
    }
    return null;
  },
});
/** Read-only purge proof: keys and bytes on the first 100-key page of a project prefix. */
export const prefixCount = internalAction({
  args: { projectId: v.id('hostedProjects') },
  returns: v.object({ keys: v.number(), bytes: v.number(), more: v.boolean() }),
  handler: async (_ctx, { projectId }) => {
    const page = await listR2Prefix(r2Config(), projectPrefix(projectId), null);
    return { keys: page.keys.length, bytes: page.bytes, more: !page.isDone };
  },
});
