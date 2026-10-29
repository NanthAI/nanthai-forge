// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx } from './_generated/server';
import type { Id } from './_generated/dataModel';
import { sourcePackSchema } from '../src/source-pack';
import { presignGet, r2Config, r2Enabled } from './r2';
export const selectedSourcePacks = (ctx: MutationCtx, projectId: Id<'hostedProjects'>) =>
  ctx.db
    .query('projectSourcePacks')
    .withIndex('by_project', q => q.eq('projectId', projectId))
    .unique();
export async function latestSourcePack(ctx: MutationCtx, projectId: Id<'hostedProjects'>) {
  if (!r2Enabled()) return null;
  const row = await selectedSourcePacks(ctx, projectId);
  if (!row?.latest) return null;
  const pack = sourcePackSchema.strip().parse(row.latest);
  return { ...pack, url: await presignGet(r2Config(), pack.objectKey) };
}
