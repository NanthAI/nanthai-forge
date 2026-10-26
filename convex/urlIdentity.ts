// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { handleBase, uniqueUrlName } from '../src/readable-urls';
import { slug } from '../src/project-routes';
type Ctx = QueryCtx | MutationCtx;
export const accountFor = (ctx: Ctx, owner: string) =>
  ctx.db
    .query('forgeAccounts')
    .withIndex('by_owner', q => q.eq('owner', owner))
    .unique();
export const handleTaken = async (ctx: Ctx, handle: string, owner?: string) => {
  const alias = await ctx.db
    .query('accountHandles')
    .withIndex('by_handle', q => q.eq('handle', handle))
    .unique();
  return !!alias && alias.owner !== owner;
};
export async function ensureAccount(
  ctx: MutationCtx,
  owner: string,
  profile: { username?: string | null; firstName?: string | null; lastName?: string | null } = {},
) {
  const existing = await accountFor(ctx, owner);
  if (existing) return existing;
  const handle = await uniqueUrlName(
    handleBase(profile, crypto.randomUUID()),
    value => handleTaken(ctx, value),
    39,
  );
  const id = await ctx.db.insert('forgeAccounts', { owner, handle });
  await ctx.db.insert('accountHandles', { owner, handle });
  return (await ctx.db.get(id))!;
}
export async function slugTaken(ctx: Ctx, owner: string, value: string, projectId?: string) {
  const alias = await ctx.db
    .query('projectSlugs')
    .withIndex('by_owner_and_slug', q => q.eq('owner', owner).eq('slug', value))
    .unique();
  return !!alias && alias.projectId !== projectId;
}
export async function ensureProjectSlug(ctx: MutationCtx, project: Doc<'hostedProjects'>) {
  if (project.slug) return project.slug;
  const value = await uniqueUrlName(slug(project.name), candidate =>
    slugTaken(ctx, project.owner, candidate),
  );
  await ctx.db.insert('projectSlugs', { owner: project.owner, slug: value, projectId: project._id });
  await ctx.db.patch(project._id, { slug: value });
  return value;
}
