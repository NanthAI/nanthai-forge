// SPDX-License-Identifier: Apache-2.0
import { v } from 'convex/values';
import { internalMutation, type MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { activeOwnedProject } from './projectAuthority';
import { isStored } from './projectObjectFields';
import { storageDigest, removeExclusive } from './projectStorage';
import { r2Config, r2Key, r2Enabled } from './r2';
import { invariant } from '../src/errors';
import { importPageFiles } from '../src/github-import-pages';
export const objectPin = v.object({ digest: v.string(), size: v.number() });
export const completion = v.object({
  id: v.id('projectObjects'),
  storageId: v.optional(v.id('_storage')),
  key: v.optional(v.string()),
});
export const recipePin = v.object({ ...objectPin.fields, recipeDigest: v.string(), recipeSize: v.number() });
const identity = { projectId: v.id('hostedProjects'), actor: v.string() };
export const prepare = internalMutation({
  args: { ...identity, objects: v.array(objectPin) },
  returns: v.array(
    v.object({
      id: v.id('projectObjects'),
      stored: v.boolean(),
      contentType: v.string(),
      key: v.optional(v.string()),
    }),
  ),
  handler: async (ctx, input) => {
    const project = await activeOwnedProject(ctx, input.projectId, input.actor);
    invariant(
      input.objects.length <= importPageFiles,
      'INVALID_WORK_BACKUP',
      'Split physical objects into bounded pages.',
    );
    // Placement is pinned at creation, never silently changed by a later switch.
    const r2 = r2Enabled();
    if (r2) r2Config();
    const result = [];
    for (const pin of input.objects) {
      invariant(
        /^[0-9a-f]{64}$/.test(pin.digest) && Number.isSafeInteger(pin.size) && pin.size >= 0,
        'INVALID_WORK_BACKUP',
        'Use verified object pins.',
      );
      let row = await ctx.db
        .query('projectObjects')
        .withIndex('by_project_and_digest', q => q.eq('projectId', project._id).eq('digest', pin.digest))
        .unique();
      invariant(
        !row || (row.size === pin.size && !row.removed),
        'INVALID_WORK_BACKUP',
        'Original object binding changed.',
      );
      if (!row) {
        let storageId: Id<'_storage'> | undefined;
        if (!r2) {
          // Bounded candidate search, not a source/existence oracle. Larger sets
          // can miss reuse and upload identical bytes without changing content.
          const shared = await ctx.db
            .query('projectObjects')
            .withIndex('by_digest_and_removed', q => q.eq('digest', pin.digest).eq('removed', false))
            .take(5);
          for (const candidate of shared) {
            if (!candidate.storageId || candidate.size !== pin.size) continue;
            const stored = await ctx.db.system.get(candidate.storageId);
            if (stored && stored.size === pin.size && storageDigest(stored.sha256) === pin.digest) {
              storageId = candidate.storageId;
              break;
            }
          }
        }
        const id = await ctx.db.insert('projectObjects', {
          projectId: project._id,
          ...pin,
          nonce: crypto.randomUUID(),
          removed: false,
          ...(storageId ? { storageId } : {}),
          ...(r2 ? { location: 'r2' as const, r2Key: r2Key(project._id, pin.digest) } : {}),
        });
        row = (await ctx.db.get(id))!;
      }
      result.push({
        id: row._id,
        stored: isStored(row),
        contentType: `application/x-forge-object-${row.nonce}`,
        ...(row.location === 'r2' ? { key: row.r2Key } : {}),
      });
    }
    return result;
  },
});
export async function completeObjects(
  ctx: MutationCtx,
  projectId: Id<'hostedProjects'>,
  objects: { id: Id<'projectObjects'>; storageId?: Id<'_storage'>; key?: string }[],
  recipes: { digest: string; size: number; recipeDigest: string; recipeSize: number }[],
) {
  invariant(
    objects.length <= importPageFiles && recipes.length <= importPageFiles,
    'INVALID_WORK_BACKUP',
    'Split completion into bounded pages.',
  );
  for (const object of objects) {
    const row = await ctx.db.get(object.id);
    invariant(
      row && row.projectId === projectId && !row.removed,
      'INVALID_WORK_BACKUP',
      'Original object binding changed.',
    );
    if (object.key) {
      invariant(
        row.location === 'r2' && row.r2Key === object.key && !object.storageId,
        'INVALID_WORK_BACKUP',
        'R2 binding changed.',
      );
      if (!isStored(row)) await ctx.db.patch(row._id, { r2Committed: true });
    } else {
      const stored = object.storageId && (await ctx.db.system.get(object.storageId));
      invariant(
        stored &&
          stored.size === row.size &&
          storageDigest(stored.sha256) === row.digest &&
          stored.contentType === `application/x-forge-object-${row.nonce}`,
        'INVALID_WORK_BACKUP',
        'Imported bytes differ from their reserved identity.',
      );
      if (isStored(row)) {
        if (row.storageId !== object.storageId) await removeExclusive(ctx, object.storageId!);
      } else await ctx.db.patch(row._id, { storageId: object.storageId! });
    }
  }
  for (const pin of recipes) {
    const recipe = await ctx.db
      .query('projectObjects')
      .withIndex('by_project_and_digest', q => q.eq('projectId', projectId).eq('digest', pin.recipeDigest))
      .unique();
    invariant(
      recipe && isStored(recipe) && !recipe.removed && recipe.size === pin.recipeSize,
      'INVALID_WORK_BACKUP',
      'Verified recipe is unavailable.',
    );
    const row = await ctx.db
      .query('projectObjects')
      .withIndex('by_project_and_digest', q => q.eq('projectId', projectId).eq('digest', pin.digest))
      .unique();
    invariant(
      !row || (!row.removed && row.size === pin.size),
      'INVALID_WORK_BACKUP',
      'Logical binding changed.',
    );
    if (row && isStored(row)) continue;
    const value = { recipe: { digest: pin.recipeDigest, size: pin.recipeSize } };
    if (row) await ctx.db.patch(row._id, value);
    else
      await ctx.db.insert('projectObjects', {
        projectId,
        digest: pin.digest,
        size: pin.size,
        nonce: crypto.randomUUID(),
        removed: false,
        ...value,
      });
  }
}
export const complete = internalMutation({
  args: { ...identity, objects: v.array(completion), recipes: v.array(recipePin) },
  returns: v.null(),
  handler: async (ctx, input) => {
    await activeOwnedProject(ctx, input.projectId, input.actor);
    await completeObjects(ctx, input.projectId, input.objects, input.recipes);
    return null;
  },
});
