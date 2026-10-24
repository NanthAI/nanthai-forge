// SPDX-License-Identifier: Apache-2.0
'use node';
import { v } from 'convex/values';
import { action } from './cliServer';
import { internal } from './_generated/api';
import type { Doc } from './_generated/dataModel';
import { invariant } from '../src/errors';
import { objectRecipeSchema, readObjectRecipe, objectChunkPageBytes } from '../src/object-chunks';
import { objectContent } from './projectObjectContent';
import { report } from './errors';
const pin = { projectId: v.id('hostedProjects'), digest: v.string(), size: v.number() };
const valid = (digest: string, size: number) =>
  /^[0-9a-f]{64}$/.test(digest) && Number.isSafeInteger(size) && size >= 0;
export const complete = action({
  args: { ...pin, recipeDigest: v.string(), recipeSize: v.number() },
  returns: v.null(),
  handler: async (ctx, input): Promise<null> => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to exchange project source.');
      await ctx.runQuery(internal.projectObjects.authorize, {
        projectId: input.projectId,
        actor: user.subject,
      });
      invariant(
        valid(input.digest, input.size) &&
          valid(input.recipeDigest, input.recipeSize) &&
          input.recipeSize <= objectChunkPageBytes,
        'BAD_ARGUMENT',
        'Use exact logical content and recipe pins.',
      );
      if (
        await ctx.runQuery(internal.projectObjectRecipeStore.stored, {
          projectId: input.projectId,
          actor: user.subject,
          digest: input.digest,
          size: input.size,
        })
      )
        return null;
      const read = async (pin: { sha256: string; size: number }) => {
        const args = { projectId: input.projectId, actor: user.subject, digests: [pin.sha256] };
        const rows: Doc<'projectObjects'>[] = await ctx.runQuery(internal.projectObjects.resolve, args);
        const bytes = await objectContent(ctx, rows[0]!, pin, user.subject);
        await ctx.runQuery(internal.projectObjects.resolve, args);
        return bytes;
      };
      const bytes = await read({ sha256: input.recipeDigest, size: input.recipeSize });
      const recipe = objectRecipeSchema.parse(JSON.parse(bytes.toString('utf8')));
      invariant(
        recipe.object.sha256 === input.digest && recipe.object.size === input.size,
        'INVALID_WORK_BACKUP',
        'Recipe differs from the original logical content pin.',
      );
      for await (const part of readObjectRecipe(recipe, read)) void part;
      return await ctx.runMutation(internal.projectObjectRecipeStore.bind, { ...input, actor: user.subject });
    } catch (error) {
      return report(error);
    }
  },
});
export const representation = action({
  args: pin,
  returns: v.object({ recipe: v.union(v.object({ digest: v.string(), size: v.number() }), v.null()) }),
  handler: async (ctx, input) => {
    try {
      const user = await ctx.auth.getUserIdentity();
      invariant(user, 'PROJECT_UNAVAILABLE', 'Sign in to read project source.');
      const rows: Doc<'projectObjects'>[] = await ctx.runQuery(internal.projectObjects.resolve, {
        projectId: input.projectId,
        actor: user.subject,
        digests: [input.digest],
      });
      invariant(
        rows[0]?.size === input.size,
        'INVALID_WORK_BACKUP',
        'Content size differs from its original pin.',
      );
      return { recipe: rows[0].storageId ? null : (rows[0].recipe ?? null) };
    } catch (error) {
      return report(error);
    }
  },
});
