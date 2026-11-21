// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './server';
import type { Id } from './_generated/dataModel';
import { saveObjects, saveStateSchema } from './projectHostedSaveStore';
import { signRecipeClosure } from './projectRecipeClosure';
import { presignGet, r2Config } from './r2';
import { findStoredObject as findObject, findStoredObjects, type ObjectView } from './projectObjectFind';
import { isStored } from './projectObjectFields';
import { packRange, packHeaders } from '../src/object-pack-range';
import { invariant } from '../src/errors';
import { smallSavePageBytes, smallSaveStateBytes } from '../src/hosted-source-small-save';
import type { WorkerObject, WorkerPin } from '../src/hosted-source-worker-format';
import type { ComposeState } from './projectHostedComposeStore';
import type { SyncState } from './projectHostedSyncStore';

/** One object's step location, marked for the step exactly as a `resolve` call would mark it. */
export async function sourceObjectLocation(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  pin: { sha256: string; size: number },
  selected?: ObjectView,
) {
  const known =
    selected &&
    process.env.FORGE_STATE_SOURCE_REUSE_LOCATION === '1' &&
    selected.projectId === projectId &&
    selected.digest === pin.sha256 &&
    !selected.removed &&
    isStored(selected)
      ? selected
      : undefined;
  const object = known ?? (await findObject(ctx, projectId, pin.sha256));
  invariant(object, 'SOURCE_UNAVAILABLE', 'Source input is absent.');
  const [descriptor] = await saveObjects(ctx, projectId, [pin], [object]);
  return signedSourceLocation(object, descriptor!);
}

async function signedSourceLocation(object: ObjectView, descriptor: WorkerObject) {
  const url =
    object.location === 'r2' && object.r2Key
      ? await presignGet(r2Config(), object.r2Key, packHeaders(packRange(object), object.size))
      : null;
  // The State's generation and parents, as resolve returns them: the step derives its output
  // State's generation from them (review 3aa618e2 F1).
  return {
    descriptor,
    ...(object.stateGeneration === undefined ? {} : { stateGeneration: object.stateGeneration }),
    ...(object.stateSize === undefined ? {} : { stateSize: object.stateSize }),
    ...(object.stateParents === undefined ? {} : { stateParents: object.stateParents }),
    ...(object.statePhysical === undefined ? {} : { statePhysical: object.statePhysical }),
    storageId: url ? null : (object.storageId ?? null),
    url,
    ...(object.recipeClosure ? { closure: await signRecipeClosure(object) } : {}),
    ...(object.pack ? { range: packRange(object)! } : {}),
  };
}

/** Reuse pins from the authorized, submitted operation during the first step. Missing
 * or oversized hints leave the normal page resolver responsible for the read. */
export async function mergeStepReads(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  state: ComposeState | SyncState,
) {
  let pins: WorkerPin[];
  if ('inputs' in state) {
    const { inputs, dependencies } = state.request;
    if (inputs.pages !== 1 || dependencies.pages !== 1) return [];
    pins = [inputs.root, dependencies.root];
    if (pins.some(pin => pin.size > smallSavePageBytes)) return [];
  } else {
    const work = state.work;
    if (work.mode !== 'sync' || work.stackBase) return [];
    pins = [work.left.object, work.right.object];
    if (pins.reduce((bytes, pin) => bytes + pin.size, 0) > 8 * 1024 * 1024) return [];
  }
  const distinct = [...new Map(pins.map(pin => [pin.sha256, pin])).values()];
  const rows = await findStoredObjects(
    ctx,
    projectId,
    distinct.map(pin => pin.sha256),
  );
  const found = distinct.flatMap((pin, i) => {
    const row = rows[i];
    return row && !row.removed && isStored(row) && row.size === pin.size ? [{ pin, row }] : [];
  });
  const descriptors = await saveObjects(
    ctx,
    projectId,
    found.map(({ pin }) => pin),
    found.map(({ row }) => row),
  );
  return Promise.all(found.map(({ row }, i) => signedSourceLocation(row, descriptors[i]!)));
}

/** What a save job's first step reads after its input: the baseline State and the first delta
 * page, both named by the save record this transaction already trusts (friction f15db544). Handing
 * them to `begin` saves the step a descriptor call and lets it read them beside the input. The
 * worker still checks them against the input it reads; nothing else changes. One indexed read. */
export async function saveStepReads(ctx: MutationCtx, projectId: Id<'hostedProjects'>, jobId: string) {
  const row = await ctx.db
    .query('projectHostedSaves')
    .withIndex('by_project_and_job', q => q.eq('projectId', projectId).eq('jobId', jobId))
    .unique();
  if (!row) return [];
  const state = saveStateSchema.parse(JSON.parse(row.value));
  // Only the shape the small save runs (one page of at most 128 KiB, a raw baseline of at most
  // 4 MiB); anything else goes to the resumable worker, which reads its own (review 3aa618e2 F3).
  const pages = state.request.pages;
  if (
    state.request.pageCount !== 1 ||
    !pages ||
    pages.size > smallSavePageBytes ||
    state.baseline.object.size > smallSaveStateBytes
  )
    return [];
  if (
    state.baseline.recipe &&
    !(await findObject(ctx, projectId, state.baseline.object.sha256))?.recipeClosure
  )
    return [];
  return [state.baseline.object, pages];
}
