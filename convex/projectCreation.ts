// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { ensureAccount, ensureProjectSlug } from './urlIdentity';
import { policyPreset } from '../src/autonomy-policy';
import type { MutationCtx } from './_generated/server';
import { activeOwnedProject } from './projectAuthority';
import { ensurePublicRow } from './publicListing';
import { queueProjectSnapshots } from './publicSnapshotJobs';
import { syncPersonOrder } from './accountProjectOrder';
import { chargeProjectCreation } from './accountLimits';

/** Shared creation seam: archive upload and CLI hosting use the same owner/key identity. */
export async function createProject(
  ctx: MutationCtx,
  input: { owner: string; key: string; name: string; visibility?: 'private' | 'public' },
) {
  let project = await ctx.db
    .query('hostedProjects')
    .withIndex('by_owner_and_key', q => q.eq('owner', input.owner).eq('key', input.key))
    .unique();
  const isNew = project === null;
  if (!project) {
    // A new project only: the owner's daily rate and active total (a retry of this key is free).
    await chargeProjectCreation(ctx, input.owner);
    const id = await ctx.db.insert('hostedProjects', {
      ...input,
      sourceAuthority: { mode: 'native-owner', epoch: 0 },
      autonomyPolicy: policyPreset('supervised'),
      visibility: input.visibility ?? 'private',
      currentBackup: null,
      revision: 0,
    });
    project = (await ctx.db.get(id))!;
    // A public project can be found from its first moment (explore, profiles); private ones get no row.
    if (project.visibility === 'public') await ensurePublicRow(ctx, project);
  }
  const user = await ctx.auth.getUserIdentity();
  await ensureAccount(
    ctx,
    input.owner,
    user?.subject === input.owner ? { username: user.nickname ?? null } : {},
  );
  await ensureProjectSlug(ctx, project);
  await syncPersonOrder(ctx, project._id, project.owner, project);
  const ready = await activeOwnedProject(ctx, project._id, input.owner);
  if (isNew && ready.visibility === 'public') await queueProjectSnapshots(ctx, ready, true);
  return ready;
}
