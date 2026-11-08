// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation } from './server';
import { loadSave, writeSaveState } from './projectHostedSaveStore';
import { prepareHostedSync } from './projectHostedSync';
import { submitHostedSync } from './projectHostedSyncJobs';
import { storeSourceOutputs } from './projectConvexSourceOutput';
import { r2Key } from './r2';
import { resolveSyncRequest } from '../src/hosted-resolve-chain';
import { canonicalPayload } from '../src/hosted-source-operation';
import { report } from './errors';
import type { Id } from './_generated/dataModel';

// The save-then-resolve chain's transactions (projectHostedResolveChain:run), all for the save's own
// actor, each a full transaction: a refused step rolls back alone and is recorded on the save.
const save = { projectId: v.id('hostedProjects'), actor: v.string(), operationId: v.string() };

/** Prepare the resolve exactly as the CLI would from the completed save. Null when there is
 * nothing to chain (no `then`, the save did not complete, or the sync is already submitted). */
export const prepare = internalMutation({
  args: save,
  returns: v.union(v.string(), v.null()),
  handler: async (ctx, args) => {
    try {
      const { state, operation } = await loadSave(ctx, args);
      // The publication's delayed fallback of this chain is not needed once the chain runs here;
      // when this IS that fallback, its own run is in progress, not pending, and stays.
      if (state.chainFallbackId) {
        const fallback = await ctx.db.system.get(state.chainFallbackId as Id<'_scheduled_functions'>);
        if (fallback?.state.kind === 'pending') await ctx.scheduler.cancel(fallback._id);
      }
      const then = state.request.then;
      if (!then || operation.terminal?.outcome.status !== 'completed') return null;
      const request = resolveSyncRequest(then, state.request.laneId, operation.terminal.outcome.result);
      const prepared = JSON.parse(
        await prepareHostedSync(
          ctx,
          { projectId: args.projectId, actor: args.actor, operationId: then.operationId },
          request,
        ),
      );
      if (prepared.terminal || prepared.state.status !== 'ready') return null;
      return canonicalPayload({ operationId: then.operationId, input: prepared.input });
    } catch (error) {
      return report(error);
    }
  },
});

/** Record the chain's own R2 write of the sync input (checksum-bound PUT and HEAD done), then
 * submit with the dispatch inline, as projectSourceRunStore:submit does for the CLI. */
export const submit = internalMutation({
  args: { ...save, input: v.object({ sha256: v.string(), size: v.number() }) },
  returns: v.string(),
  handler: async (ctx, { input, ...auth }) => {
    try {
      await storeSourceOutputs(ctx, auth.projectId, `resolve-chain:${auth.operationId}`, [
        { ...input, r2Key: r2Key(auth.projectId, input.sha256) },
      ]);
      return JSON.stringify(await submitHostedSync(ctx, auth, true));
    } catch (error) {
      return report(error);
    }
  },
});

/** The chain stopped before its submit: the CLI waiting on the save stops waiting and resolves
 * itself, replaying the identical request. */
export const failed = internalMutation({
  args: { ...save, code: v.string() },
  returns: v.null(),
  handler: async (ctx, { code, ...args }) => {
    const { row, state } = await loadSave(ctx, args);
    if (!state.chainFailure)
      await writeSaveState(ctx, row._id, { ...state, chainFailure: code.slice(0, 64) });
    return null;
  },
});
