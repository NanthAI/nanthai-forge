// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { findObject } from './projectObjectFind';
import { hostedWriteProject } from './projectHostedRecords';
import { finishHostedOperation } from './projectHostedOperations';
import { hostedLaneSelectionSchema, type HostedLaneSelection } from '../src/hosted-lane';
import { syncResultSchema } from '../src/hosted-sync';
import { sourceAuthority } from '../src/hosted-source-authority';
import type { HostedTerminalReceipt } from '../src/hosted-source-operation';
import type { SyncState } from './projectHostedSyncStore';

/** Object rows an up-to-date proof may read before the sync falls back to its source job. */
export const upToDateProofRows = 16;
type Lane = NonNullable<SyncState['lane']>;

/** Whether `ancestor` is `head` or one of its ancestors, proven only from the exact parents the
 * trusted worker recorded on State object rows from hash-verified manifests (the same edges the
 * source step's ancestry walk uses). Reads at most `budget` rows; a row without recorded parents,
 * or a walk past the budget, is "not proven" (false), never "not an ancestor". */
export async function provenAncestor(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  head: string,
  ancestor: string,
  budget = upToDateProofRows,
): Promise<boolean> {
  if (head === ancestor) return true;
  const target = await findObject(ctx, projectId, ancestor);
  const floor = target?.stateGeneration;
  const seen = new Set<string>([head]),
    frontier = [head];
  for (let reads = 1; frontier.length; reads++) {
    if (reads >= budget) return false;
    const row = await findObject(ctx, projectId, frontier.shift()!);
    if (!row || row.removed) return false;
    // A State whose generation is not above the target's cannot contain it (both recorded).
    if (floor !== undefined && row.stateGeneration !== undefined && row.stateGeneration <= floor) continue;
    if (!row.stateParents) return false;
    for (const parent of row.stateParents) {
      if (parent === ancestor) return true;
      if (seen.has(parent)) continue;
      seen.add(parent);
      frontier.push(parent);
    }
  }
  return false;
}

/** A Lane sync onto main whose result is already known: the Lane's base is exactly the target main
 * (head and receipt), its head provably contains that main, and publication would not rewrite the
 * Lane record (no stack, restore, revert or resolution, no owner-provenance change, State already
 * registered). The source job would return `up-to-date` and change nothing, so prepare settles it. */
export async function upToDateSync(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  lane: Lane,
  target: { head: string; receiptId: string },
  clearsOwnerProvenance: boolean,
): Promise<boolean> {
  if (
    lane.stack ||
    lane.restoreBase ||
    lane.revert ||
    lane.resolution ||
    clearsOwnerProvenance ||
    lane.base.head !== target.head ||
    lane.base.receiptId !== target.receiptId
  )
    return false;
  const registered = await ctx.db
    .query('projectHostedStates')
    .withIndex('by_project_and_head', q => q.eq('projectId', projectId).eq('head', lane.head))
    .unique();
  return Boolean(registered) && (await provenAncestor(ctx, projectId, lane.head, target.head));
}

/** The selection a completed sync names for its resulting Lane. */
export async function syncLaneSelection(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  lane: Lane,
): Promise<HostedLaneSelection> {
  return hostedLaneSelectionSchema.parse({
    schema: 2,
    projectId,
    laneId: lane.id,
    intentId: lane.intentId,
    head: lane.head,
    version: lane.version,
    sourceVersion: lane.sourceVersion,
    lifecycleVersion: lane.lifecycleVersion,
    state: lane.state,
    ...(lane.stack ? { stack: lane.stack } : {}),
    base: lane.base,
    authority: sourceAuthority((await ctx.db.get(projectId))!),
  });
}

/** Finish an up-to-date sync in its prepare transaction with the same terminal receipt its
 * source job's publication would write. */
export async function finishUpToDateSync(
  ctx: MutationCtx,
  auth: { projectId: Id<'hostedProjects'>; operationId: string; actor: string },
  state: SyncState,
  first: { id: string; at: string },
): Promise<HostedTerminalReceipt> {
  const lane = state.lane!;
  await hostedWriteProject(ctx, auth.projectId, auth.actor, state.request.authorityEpoch);
  const terminal: HostedTerminalReceipt = {
    attemptId: first.id,
    at: first.at,
    outcome: {
      status: 'completed',
      result: syncResultSchema.parse({
        schema: 1,
        operationId: auth.operationId,
        status: 'up-to-date',
        lane: await syncLaneSelection(ctx, auth.projectId, lane),
        from: { laneId: lane.id, head: lane.head, version: lane.version, sourceVersion: lane.sourceVersion },
        resolution: null,
        at: first.at,
      }),
    },
  };
  await finishHostedOperation(ctx, { ...auth, receipt: terminal });
  return terminal;
}
