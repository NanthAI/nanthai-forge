// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './server';
import type { Id } from './_generated/dataModel';
import { saveObject, saveStateSchema } from './projectHostedSaveStore';
import { presignGet, r2Config } from './r2';
import { findObject } from './projectObjectFind';
import { packRange, packHeaders } from '../src/object-pack-range';
import { invariant } from '../src/errors';

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
  return {
    descriptor,
    storageId: url ? null : (object.storageId ?? null),
    url,
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
  // Only the single-page shape the small save runs; the resumable worker reads its own.
  if (state.request.pageCount !== 1) return [];
  return [
    ...(state.baseline.recipe ? [] : [state.baseline.object]),
    ...(state.request.pages ? [state.request.pages] : []),
  ];
}
