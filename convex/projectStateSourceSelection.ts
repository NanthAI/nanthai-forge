// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { requireSourceProtocol } from './projectSourceProtocol';
import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from './server';
import type { Id } from './_generated/dataModel';
import { sessionArgs, actionsSession } from './projectHostedActionsSession';
import { scopedRecheckBase, scopedRecheckPairs } from '../src/scoped-recheck-policy';
import { findStoredObject as findObject, isRegisteredState, readablePhysical } from './projectObjectFind';
import { isStored } from './projectObjectFields';
import { describeObjects } from './projectObjectDownloads';
import { downloadProject } from './projectDownloadAccess';
import { blobStore } from './blobStore';
import { sourceObjectLocation } from './projectSourceBeginReads';
import { invariant } from '../src/errors';
import type { HostedCheckRun } from '../src/hosted-check';
export function actionsSourceStates(run: HostedCheckRun) {
  const base = scopedRecheckBase(run.gate),
    pairs = scopedRecheckPairs(run.gate);
  return new Set([
    run.request.expectedHead,
    run.candidate.base.head,
    ...(base ? [base] : []),
    ...(pairs?.flatMap(pair => [pair.base, pair.checked]) ?? []),
  ]);
}
async function selection(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  state: string,
  registered = false,
  recheck?: { size: number; physical?: { sha256: string; size: number } },
) {
  invariant(/^[a-f0-9]{64}$/.test(state), 'SOURCE_UNAVAILABLE', 'Select one readable State.');
  const row = await findObject(ctx, projectId, state);
  invariant(row && !row.removed && isStored(row), 'SOURCE_UNAVAILABLE', 'Selected State is unavailable.');
  if (registered)
    invariant(await isRegisteredState(ctx, row), 'SOURCE_UNAVAILABLE', 'Select a registered source State.');
  const object = { sha256: state, size: row.size };
  const physical = await readablePhysical(ctx, row);
  // The first selection already marked the State as a source. Keep the normal
  // marking and signing path if that fact or the exact physical pin changed.
  if (
    recheck &&
    row.sourceReferenced &&
    recheck.size === row.size &&
    recheck.physical?.sha256 === physical?.sha256 &&
    recheck.physical?.size === physical?.size
  )
    return JSON.stringify({
      descriptor: { object, recipe: null },
      ...(physical ? { statePhysical: physical } : {}),
      storageId: null,
      url: null,
    } satisfies Awaited<ReturnType<typeof sourceObjectLocation>>);
  const value = await sourceObjectLocation(
    ctx,
    projectId,
    object,
    physical ? row : { ...row, statePhysical: undefined },
  );
  if (!value.url && value.storageId) value.url = await blobStore(ctx).getUrl(value.storageId);
  return JSON.stringify(value);
}
export const runner = internalMutation({
  args: {
    ...sessionArgs,
    state: v.string(),
    version: v.optional(v.literal(2)),
    recheck: v.optional(
      v.object({
        size: v.number(),
        physical: v.optional(v.object({ sha256: v.string(), size: v.number() })),
      }),
    ),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    const { run, project } = await actionsSession(ctx, input, false);
    requireSourceProtocol(project, input.version);
    invariant(actionsSourceStates(run).has(input.state), 'SOURCE_UNAVAILABLE', 'State is outside this run.');
    return selection(ctx, input.projectId, input.state, false, input.recheck);
  },
});
export const client = internalMutation({
  args: {
    projectId: v.id('hostedProjects'),
    state: v.string(),
    version: v.optional(v.literal(2)),
    recheck: v.optional(v.boolean()),
  },
  returns: v.string(),
  handler: async (ctx, input) => {
    const project = await downloadProject(ctx, input.projectId);
    requireSourceProtocol(project, input.version);
    return selection(ctx, input.projectId, input.state, true);
  },
});

export const catalog = internalMutation({
  args: { projectId: v.id('hostedProjects'), digests: v.array(v.string()), runs: v.optional(v.boolean()) },
  returns: v.any(),
  handler: (ctx, input) => describeObjects(ctx, { ...input, signed: true }, 500),
});
