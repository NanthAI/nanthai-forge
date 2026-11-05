// SPDX-License-Identifier: Apache-2.0
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import {
  defaultHandle,
  isDefaultHandle,
  placeholderHandle,
  uniqueUrlName,
  type HandleProfile,
} from '../src/readable-urls';
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
/** Create the account on first sign-in. Its handle is the person's username or GitHub login;
 * otherwise a random placeholder and a one-time `handlePrompt` to pick one. An existing account
 * is checked once (`handlePrompt` unset): a handle the person neither chose nor received as that
 * default (older accounts derived it from their real name) gets the same one-time prompt. The
 * handle itself never changes without the person. */
export async function ensureAccount(ctx: MutationCtx, owner: string, profile: HandleProfile = {}) {
  const existing = await accountFor(ctx, owner);
  if (existing) {
    if (existing.handlePrompt !== undefined || !(profile.username || profile.githubLogin)) return existing;
    const [chosen] = await ctx.db
      .query('handleOperations')
      .withIndex('by_owner_and_operation', q => q.eq('owner', owner))
      .take(1);
    const handlePrompt = !chosen && !isDefaultHandle(existing.handle, profile);
    await ctx.db.patch(existing._id, { handlePrompt });
    return { ...existing, handlePrompt };
  }
  const base = defaultHandle(profile);
  const handle = await uniqueUrlName(
    base ?? placeholderHandle(crypto.randomUUID()),
    value => handleTaken(ctx, value),
    39,
  );
  const id = await ctx.db.insert('forgeAccounts', { owner, handle, handlePrompt: !base });
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
