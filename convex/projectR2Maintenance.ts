// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { projectExecution } from './projectExecution';
import { v, type Infer } from 'convex/values';
import { makeFunctionReference } from 'convex/server';
import { internalMutation, internalAction, internalQuery, type MutationCtx } from './server';
import type { Doc, Id } from './_generated/dataModel';
import { maintenanceEnabled } from './r2Maintenance';
import { r2Config } from './r2';
import { deleteR2Object, listR2Prefix, projectPrefix } from './r2Operations';
import { ForgeError, invariant } from '../src/errors';
import { scheduleR2Purge } from './projectPurgeScheduling';
import { scanR2References } from './projectPurgeReferences';
import { authorizedKeys, purgeAuthority, type PurgeAuthority } from './projectPurgeAuthority';
import { noteDeleteOutcome } from './projectDeleteRequestOutcome';

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
const purgeState = v.object({
  authority: v.union(v.null(), authority),
  cursor: v.union(v.string(), v.null()),
  referencesReady: v.boolean(),
  artifactInventoryIntact: v.boolean(),
});
function referenceProof(project: Doc<'hostedProjects'>, grant: PurgeAuthority | null) {
  const proof = project.r2Purge?.references;
  return proof && proof.operationId === grant?.operationId ? proof : undefined;
}
/** A fenced delivery for a deleting project, with its scoped R2 grant (or none). */
export const deletingProject = internalQuery({
  args: { projectId: v.id('hostedProjects'), generation: v.optional(v.number()) },
  returns: v.union(v.null(), purgeState),
  handler: async (ctx, { projectId, generation }) => {
    const project = await ctx.db.get(projectId);
    projectExecution(ctx, projectId, project?.name, project?.key);
    if (
      project?.removal !== 'deleting' ||
      project.r2PrefixPurged ||
      project.purgeBlocked ||
      (generation !== undefined && project.r2Purge?.generation !== generation)
    )
      return null;
    const grant = purgeAuthority(project);
    return {
      authority: grant,
      cursor: project.r2Purge?.cursor ?? null,
      referencesReady: referenceProof(project, grant)?.next === null,
      artifactInventoryIntact: project.purge?.artifactInventoryIntact === true,
    };
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
    await noteDeleteOutcome(ctx, project, 'failed');
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
      referenceProof(project, purgeAuthority(project))?.next === null &&
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
    outcome: v.union(
      v.literal('references'),
      v.literal('page'),
      v.literal('unauthorized'),
      v.literal('failed'),
    ),
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
    const grant = purgeAuthority(project);
    const proof = referenceProof(project, grant);
    if (outcome === 'references' && grant) {
      if (proof?.next === null) return null;
      const scan = await scanR2References(ctx, projectId, proof?.next);
      if (scan.references.length) {
        await ctx.db.patch(projectId, { task: undefined, purgeBlocked: 'R2_PURGE_SHARED' });
        await noteDeleteOutcome(ctx, project, 'failed');
      } else {
        await scheduleR2Purge(ctx, project, {
          failures: project.r2Purge.failures,
          references: { operationId: grant.operationId, next: scan.next },
        });
      }
    } else if (outcome === 'page' && proof?.next === null && page) {
      if (await counted(ctx, project, page))
        await scheduleR2Purge(ctx, project, { cursor: cursor ?? null, references: proof });
    } else {
      const unauthorized = outcome !== 'failed' || !grant;
      const failures = project.r2Purge.failures + 1;
      if (unauthorized || failures >= 8) {
        await ctx.db.patch(projectId, {
          task: undefined,
          purgeBlocked: unauthorized ? 'R2_PURGE_UNAUTHORIZED' : 'R2_PURGE_RETRY_EXHAUSTED',
          r2Purge: { ...project.r2Purge, failures },
        });
        await noteDeleteOutcome(ctx, project, 'failed');
      } else
        await scheduleR2Purge(ctx, project, {
          failures,
          delay: Math.min(60_000 * 2 ** (failures - 1), 15 * 60_000),
          // Retry an incomplete reference page at the same cursor. A failed
          // physical page needs a fresh full scan before another DELETE.
          references: proof?.next ? proof : undefined,
        });
    }
    return null;
  },
});
/** Each delivery scans one reference range or processes one R2 page. Deletes need the
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
    const state: Infer<typeof purgeState> | null = await ctx.runQuery(
      ref('projectR2Maintenance:deletingProject'),
      { projectId, generation },
    );
    if (!state || state.cursor !== cursor) return null;
    try {
      const grant = state.authority;
      invariant(grant, 'R2_PURGE_UNAUTHORIZED', 'This project has no confirmed or expired purge.');
      if (!state.referencesReady) {
        await ctx.runMutation(mutation('projectR2Maintenance:pageResult'), {
          projectId,
          generation,
          outcome: 'references',
        });
        return null;
      }
      const config = r2Config();
      const page = await listR2Prefix(config, grant.prefix, cursor);
      // Old row-first purges can leave an import alias without its artifact
      // binding. Preserve keys that could belong to that missing inventory.
      const keys = authorizedKeys(grant, projectId, page.keys);
      let bytes = page.bytes;
      const deletable = state.artifactInventoryIntact
        ? keys
        : keys.filter((key, index) => {
            if (!/\/a\/[a-f0-9]{64}$/.test(key)) return true;
            invariant(page.sizes.length === keys.length, 'R2_LIST_FAILED', 'R2 omitted an object size.');
            bytes -= page.sizes[index]!;
            return false;
          });
      await Promise.all(deletable.map(key => deleteR2Object(config, key)));
      const done = { operationId: grant.operationId, objects: deletable.length, bytes };
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
