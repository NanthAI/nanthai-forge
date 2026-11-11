// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from './server';
import type { Id } from './_generated/dataModel';
import { sessionArgs, actionsSession } from './projectHostedActionsSession';
import { scopedRecheckBase, scopedRecheckPairs } from '../src/scoped-recheck-policy';
import { selectedSourcePacks } from './projectSourcePackStore';
import { findObject } from './projectObjectFind';
import { isStored } from './projectObjectFields';
import { readableProject, describeObjects } from './projectObjectDownloads';
import { blobStore } from './blobStore';
import { sourceObjectLocation } from './projectSourceBeginReads';
import { invariant } from '../src/errors';
import type { HostedCheckRun } from '../src/hosted-check';
export async function actionsSourceStates(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  run: HostedCheckRun,
) {
  const base = scopedRecheckBase(run.gate),
    pairs = scopedRecheckPairs(run.gate),
    pack = await selectedSourcePacks(ctx, projectId);
  return {
    allowed: new Set([
      run.request.expectedHead,
      run.candidate.base.head,
      ...(base ? [base] : []),
      ...(pairs?.flatMap(pair => [pair.base, pair.checked]) ?? []),
      ...(pack?.latest ? [pack.latest.stateRef] : []),
    ]),
    packState: pack?.latest?.stateRef,
  };
}
async function selection(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  state: string,
  registered = false,
) {
  invariant(/^[a-f0-9]{64}$/.test(state), 'SOURCE_UNAVAILABLE', 'Select one readable State.');
  const row = await findObject(ctx, projectId, state);
  invariant(row && !row.removed && isStored(row), 'SOURCE_UNAVAILABLE', 'Selected State is unavailable.');
  if (registered && !row.statePhysical && row.stateGeneration === undefined) {
    const known = await ctx.db
      .query('projectHostedStates')
      .withIndex('by_project_and_head', q => q.eq('projectId', projectId).eq('head', state))
      .unique();
    invariant(known, 'SOURCE_UNAVAILABLE', 'Select a registered source State.');
  }
  const value = await sourceObjectLocation(ctx, projectId, { sha256: state, size: row.size });
  if (!value.url && value.storageId) value.url = await blobStore(ctx).getUrl(value.storageId);
  return JSON.stringify(value);
}
export const runner = internalMutation({
  args: { ...sessionArgs, state: v.string() },
  returns: v.string(),
  handler: async (ctx, input) => {
    const { run } = await actionsSession(ctx, input, false);
    invariant(
      (await actionsSourceStates(ctx, input.projectId, run)).allowed.has(input.state),
      'SOURCE_UNAVAILABLE',
      'State is outside this run.',
    );
    return selection(ctx, input.projectId, input.state);
  },
});
export const client = internalMutation({
  args: { projectId: v.id('hostedProjects'), state: v.string(), recheck: v.optional(v.boolean()) },
  returns: v.string(),
  handler: async (ctx, input) => {
    await readableProject(ctx, input.projectId, !input.recheck);
    return selection(ctx, input.projectId, input.state, true);
  },
});

export const catalog = internalMutation({
  args: { projectId: v.id('hostedProjects'), digests: v.array(v.string()), runs: v.optional(v.boolean()) },
  returns: v.any(),
  handler: (ctx, input) => describeObjects(ctx, { ...input, signed: true }, 500, false),
});
