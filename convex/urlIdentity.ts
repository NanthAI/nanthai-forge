// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
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
import { syncTeamHandles } from './teamHandles';
import { trimAliases } from './projectAliases';
export { PROJECT_ALIASES } from './projectAliases';
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
  // Memberships added before the account existed (legacy adds by user id) take its handle now.
  await syncTeamHandles(ctx, owner, handle);
  return (await ctx.db.get(id))!;
}
const slugRow = (ctx: Ctx, owner: string, value: string) =>
  ctx.db
    .query('projectSlugs')
    .withIndex('by_owner_and_slug', q => q.eq('owner', owner).eq('slug', value))
    .unique();
/** Item eb631a53: an address belongs to one live project. A removed project (trash, deleting) keeps only a record of
 * it for a restore, never a block: a new or renamed live project may take it, and the removed one gets a free
 * suffix if it is restored later (`restoreProjectSlug`). An address never resolves to a project it does not name. */
export async function slugTaken(ctx: Ctx, owner: string, value: string, projectId?: string) {
  const alias = await slugRow(ctx, owner, value);
  if (!alias || alias.projectId === projectId) return false;
  const holder = await ctx.db.get(alias.projectId);
  return !!holder && !holder.removal;
}
/** Point an address at this project, taking it over from a removed holder, as its newest alias (a fresh row: its
 * creation time is when this project took it), then release aliases past the newest 10 (convex/projectAliases.ts).
 * Callers check `slugTaken` first. A claim of the address that is already the newest writes nothing but still trims. */
export async function claimSlug(ctx: MutationCtx, project: Doc<'hostedProjects'>, value: string) {
  const alias = await slugRow(ctx, project.owner, value);
  const [newest] = await ctx.db
    .query('projectSlugs')
    .withIndex('by_project', q => q.eq('projectId', project._id))
    .order('desc')
    .take(1);
  if (!(alias?.projectId === project._id && newest?._id === alias._id)) {
    if (alias) await ctx.db.delete(alias._id);
    await ctx.db.insert('projectSlugs', { owner: project.owner, slug: value, projectId: project._id });
  }
  await trimAliases(ctx, project._id);
}
export async function ensureProjectSlug(ctx: MutationCtx, project: Doc<'hostedProjects'>) {
  if (project.slug) return project.slug;
  const value = await uniqueUrlName(slug(project.name), candidate =>
    slugTaken(ctx, project.owner, candidate, project._id),
  );
  await claimSlug(ctx, project, value);
  await ctx.db.patch(project._id, { slug: value });
  return value;
}
/** Restore: the project's address, unless a live project took it while this one was removed; then the next free
 * suffix of it, returned so the restore can say where the project now lives. */
export async function restoreProjectSlug(ctx: MutationCtx, project: Doc<'hostedProjects'>) {
  if (!project.slug) return { slug: await ensureProjectSlug(ctx, project), moved: false };
  if (!(await slugTaken(ctx, project.owner, project.slug, project._id))) {
    await claimSlug(ctx, project, project.slug);
    return { slug: project.slug, moved: false };
  }
  const value = await uniqueUrlName(project.slug, candidate =>
    slugTaken(ctx, project.owner, candidate, project._id),
  );
  await claimSlug(ctx, project, value);
  await ctx.db.patch(project._id, { slug: value });
  return { slug: value, moved: true, previousSlug: project.slug };
}
