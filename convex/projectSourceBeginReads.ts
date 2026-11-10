// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './server';
import type { Id } from './_generated/dataModel';
import { saveObject, saveStateSchema } from './projectHostedSaveStore';
import { signRecipeClosure } from './projectRecipeClosure';
import { presignGet, r2Config } from './r2';
import { findObject } from './projectObjectFind';
import { packRange, packHeaders } from '../src/object-pack-range';
import { invariant } from '../src/errors';
import { smallSavePageBytes, smallSaveStateBytes } from '../src/hosted-source-small-save';

/** One object's step location, marked for the step exactly as a `resolve` call would mark it. */
export async function sourceObjectLocation(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  pin: { sha256: string; size: number },
) {
  const descriptor = await saveObject(ctx, projectId, pin);
  const object = await findObject(ctx, projectId, pin.sha256);
  invariant(object, 'SOURCE_UNAVAILABLE', 'Source input is absent.');
  const url =
    object.location === 'r2' && object.r2Key
      ? await presignGet(r2Config(), object.r2Key, packHeaders(packRange(object), object.size))
      : null;
  // The State's generation and parents, as resolve returns them: the step derives its output
  // State's generation from them (review 3aa618e2 F1).
  return {
    descriptor,
    ...(object.stateGeneration === undefined ? {} : { stateGeneration: object.stateGeneration }),
    ...(object.stateParents === undefined ? {} : { stateParents: object.stateParents }),
    storageId: url ? null : (object.storageId ?? null),
    url,
    ...(object.recipeClosure ? { closure: await signRecipeClosure(object) } : {}),
    ...(object.pack ? { range: packRange(object)! } : {}),
  };
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
    state.baseline.recipe ||
    state.baseline.object.size > smallSaveStateBytes
  )
    return [];
  return [state.baseline.object, pages];
}
