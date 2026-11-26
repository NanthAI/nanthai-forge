// SPDX-License-Identifier: AGPL-3.0-only
// Copyright 2026 Ferdinando Valsecchi
import { ensureAccount, ensureProjectSlug } from './urlIdentity';
import { policyPreset } from '../src/autonomy-policy';
import type { MutationCtx, QueryCtx } from './_generated/server';
import type { Doc } from './_generated/dataModel';
import { activeOwnedProject } from './projectAuthority';
import { ensurePublicRow } from './publicListing';
import { queueProjectSnapshots } from './publicSnapshotJobs';
import { syncPersonOrder } from './accountProjectOrder';
import { chargeProjectCreation } from './accountLimits';
import { PROJECT_TEAM_LINKS } from './teamGrant';

/** Creation currently has one member. Invitations and linked teams are separate
 * operations. Only new projects with an unanswered offer need this read. */
export async function earnedTrustOffered(ctx: MutationCtx | QueryCtx, project: Doc<'hostedProjects'>) {
  if (
    !project.offerEarnedTrust ||
    project.autonomyPolicy?.trust !== undefined ||
    project.autonomyPolicy?.acceptance.mode !== 'auto-on-pass'
  )
    return false;
  const [writers, readers] = await Promise.all([
    ctx.db
      .query('projectContributors')
      .withIndex('by_project_and_contributor', q => q.eq('projectId', project._id))
      .take(2),
    ctx.db
      .query('projectReaders')
      .withIndex('by_project_and_reader', q => q.eq('projectId', project._id))
      .take(2),
  ]);
  if (
    writers.some(row => row.contributor !== project.owner) ||
    readers.some(row => row.reader !== project.owner)
  )
    return true;
  if (!project.teamLinks) return false;
  const links = await ctx.db
    .query('projectTeams')
    .withIndex('by_projectId_and_teamId', q => q.eq('projectId', project._id))
    .take(PROJECT_TEAM_LINKS);
  for (const link of links) {
    const team = await ctx.db.get(link.teamId);
    if (!team || team.removal || team.owner !== project.owner) continue;
    const members = await ctx.db
      .query('teamMembers')
      .withIndex('by_teamId_and_member', q => q.eq('teamId', team._id))
      .take(2);
    if (members.some(row => row.member !== project.owner)) return true;
  }
  return false;
}

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
      autonomyPolicy: policyPreset('trusted'),
      offerEarnedTrust: true,
      visibility: input.visibility ?? 'private',
      currentBackup: null,
      revision: 0,
      hasCheckDefinitions: false,
      checklessDefault: true,
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
