// SPDX-License-Identifier: AGPL-3.0-only
import { ensureAccount, ensureProjectSlug } from './urlIdentity';
import { policyPreset } from '../src/autonomy-policy';
import type { MutationCtx } from './_generated/server';
import { activeOwnedProject } from './projectAuthority';

/** Shared creation seam: archive upload and CLI hosting use the same owner/key identity. */
export async function createProject(
  ctx: MutationCtx,
  input: { owner: string; key: string; name: string; visibility?: 'private' | 'public' },
) {
  let project = await ctx.db
    .query('hostedProjects')
    .withIndex('by_owner_and_key', q => q.eq('owner', input.owner).eq('key', input.key))
    .unique();
  if (!project) {
    const id = await ctx.db.insert('hostedProjects', {
      ...input,
      sourceAuthority: { mode: 'native-owner', epoch: 0 },
      autonomyPolicy: policyPreset('supervised'),
      visibility: input.visibility ?? 'private',
      currentBackup: null,
      revision: 0,
    });
    project = (await ctx.db.get(id))!;
  }
  const user = await ctx.auth.getUserIdentity();
  await ensureAccount(
    ctx,
    input.owner,
    user?.subject === input.owner
      ? { username: user.nickname, firstName: user.givenName, lastName: user.familyName }
      : {},
  );
  await ensureProjectSlug(ctx, project);
  return activeOwnedProject(ctx, project._id, input.owner);
}
