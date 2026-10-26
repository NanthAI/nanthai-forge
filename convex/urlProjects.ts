// SPDX-License-Identifier: Apache-2.0
import { ForgeError } from '../src/errors';
import { v } from 'convex/values';
import { query } from './cliServer';
import { accessibleProject } from './projectAuthority';
import { accountFor } from './urlIdentity';
export const resolve = query({
  args: { handle: v.optional(v.string()), slug: v.optional(v.string()), projectId: v.optional(v.string()) },
  returns: v.union(
    v.object({ id: v.id('hostedProjects'), handle: v.string(), slug: v.string(), name: v.string() }),
    v.null(),
  ),
  handler: async (ctx, input) => {
    let id = input.projectId ? ctx.db.normalizeId('hostedProjects', input.projectId) : null;
    // Old slug~id paths remain valid independently of their old display-name prefix.
    if (!id && input.slug?.includes('~'))
      id = ctx.db.normalizeId('hostedProjects', input.slug.split('~').at(-1)!);
    if (!id && input.handle && input.slug) {
      const account = await ctx.db
        .query('accountHandles')
        .withIndex('by_handle', q => q.eq('handle', input.handle!.toLowerCase()))
        .unique();
      if (account) {
        const alias = await ctx.db
          .query('projectSlugs')
          .withIndex('by_owner_and_slug', q =>
            q.eq('owner', account.owner).eq('slug', input.slug!.toLowerCase()),
          )
          .unique();
        id = alias?.projectId ?? null;
      }
    }
    if (!id) return null;
    const user = await ctx.auth.getUserIdentity();
    let project;
    try {
      project = await accessibleProject(ctx, id, user?.subject ?? '');
    } catch (error) {
      if (error instanceof ForgeError && error.code === 'PROJECT_UNAVAILABLE') return null;
      throw error;
    }
    const account = await accountFor(ctx, project.owner);
    if (!account || !project.slug) return null;
    return { id, handle: account.handle, slug: project.slug, name: project.name };
  },
});
