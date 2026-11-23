// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { ForgeError } from '../src/errors';
import { v } from 'convex/values';
import { query } from './cliServer';
import { accessibleProject } from './projectAuthority';
import { accountFor } from './urlIdentity';
import type { QueryCtx } from './server';
import { landingRow, landingStateFromRow } from './projectHostedLandingStore';
import { queueComposeLanes, queueIntentLanes } from './projectHostedQueueEntries';
import { isSettingKey } from '../src/project-routes';

/** A project id from its id, an old slug~id path or handle/slug. Access is not checked here. */
export async function resolveProjectId(
  ctx: QueryCtx,
  input: { handle?: string; slug?: string; projectId?: string },
) {
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
  return id;
}
/** A project the caller can read, with its current address; null for anything else, so a missing and an unreadable
 * project look the same. */
export async function readableProject(
  ctx: QueryCtx,
  input: { handle?: string; slug?: string; projectId?: string },
) {
  const id = await resolveProjectId(ctx, input);
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
  return { id, handle: account.handle, slug: project.slug, name: project.name, project };
}
export const resolve = query({
  args: { handle: v.optional(v.string()), slug: v.optional(v.string()), projectId: v.optional(v.string()) },
  returns: v.union(
    v.object({ id: v.id('hostedProjects'), handle: v.string(), slug: v.string(), name: v.string() }),
    v.null(),
  ),
  handler: async (ctx, input) => {
    const found = await readableProject(ctx, input);
    return found && { id: found.id, handle: found.handle, slug: found.slug, name: found.name };
  },
});

/** Where an old /approve link opens (Item 0a99ab23): the project's address and the Lane whose page decides it. A
 * settings request (`setting:` key) or a landing whose one Lane is not known opens Needs me (`laneId` null). A reader
 * who cannot open the project gets null, as `resolve` does. Point reads: the project and its owner's handle; for a
 * landing, its row and its solo composition (and the Item's Lanes when it has none). Nothing is written. */
export const approvalTarget = query({
  args: { projectId: v.string(), lane: v.optional(v.string()), submission: v.optional(v.string()) },
  returns: v.union(
    v.object({ handle: v.string(), slug: v.string(), laneId: v.union(v.string(), v.null()) }),
    v.null(),
  ),
  handler: async (ctx, input) => {
    const id = ctx.db.normalizeId('hostedProjects', input.projectId);
    const user = await ctx.auth.getUserIdentity();
    if (!id || !user) return null;
    let project;
    try {
      project = await accessibleProject(ctx, id, user.subject);
    } catch (error) {
      if (error instanceof ForgeError && error.code === 'PROJECT_UNAVAILABLE') return null;
      throw error;
    }
    // Creation assigns the owner's handle and the project's address (convex/projectCreation.ts); without one the new app
    // has no page for the project.
    const account = await accountFor(ctx, project.owner);
    if (!account || !project.slug) return null;
    const address = { handle: account.handle, slug: project.slug };
    if (input.lane) return { ...address, laneId: isSettingKey(input.lane) ? null : input.lane };
    const row = input.submission
      ? await landingRow(ctx, { projectId: id, submissionId: input.submission }, false)
      : null;
    if (!row) return { ...address, laneId: null };
    const composed = await queueComposeLanes(ctx, id, landingStateFromRow(row));
    if (composed.length) return { ...address, laneId: composed.length === 1 ? composed[0]!.key : null };
    const lanes = await queueIntentLanes(ctx, id, row.intentId ?? null);
    return { ...address, laneId: lanes.length === 1 ? lanes[0]!.key : null };
  },
});
